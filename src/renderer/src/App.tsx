import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import Editor from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import type {
  VersionGraph,
  AppSettings,
  BranchRecord,
  WorkspaceInfo
} from '../../shared/ipc'
import { VersionGraphPanel } from './VersionGraphPanel'
import type { ChatStreamEvent, ChatTurnBlock } from '../../shared/chat-stream'
import type {
  ChatMessageRow,
  ChatThreadTabInfo,
  NovelApi
} from '../../shared/novel-api'
import type { EditorViewState, FileBufferEntry } from '../../shared/session'
import { normalizeFileBufferEntry } from '../../shared/session'
import {
  DEFAULT_CHAT_THREAD_ID,
  suggestChatTabTitleFromUserText
} from '../../shared/chat-thread'

type ChatTab = {
  id: string
  branchId: string
  threadId: string
  title: string
  /** 尚未根据首轮用户消息定标题（仅「新建对话」标签）。 */
  titlePending?: boolean
  /** 尚未写入首条消息：仅存于渲染进程，关闭即丢弃。 */
  ephemeral?: boolean
}

function titleFromMessages(rows: ChatMessageRow[]): string {
  const u = rows.find((m) => m.role === 'user')
  if (!u?.content?.trim()) return '新对话'
  return suggestChatTabTitleFromUserText(u.content)
}

type LiveTool = {
  kind: 'tool'
  round: number
  callIndex: number
  id: string
  name: string
  args: string
  stage: 'streaming' | 'args_ready' | 'executing' | 'done'
  ok?: boolean
  summary?: string
}

type LiveEntry = { kind: 'text'; text: string } | LiveTool

function reduceLiveEntries(prev: LiveEntry[], ev: ChatStreamEvent): LiveEntry[] {
  if (ev.type === 'generating') return prev
  const next = [...prev]
  switch (ev.type) {
    case 'text_delta': {
      const last = next[next.length - 1]
      if (last?.kind === 'text') {
        next[next.length - 1] = { kind: 'text', text: last.text + ev.text }
        return next
      }
      next.push({ kind: 'text', text: ev.text })
      return next
    }
    case 'tool_call': {
      const round = ev.round ?? 0
      const callIndex = ev.callIndex ?? 0
      const idx = next.findIndex(
        (e) =>
          e.kind === 'tool' &&
          e.round === round &&
          e.callIndex === callIndex
      )
      const stage = ev.phase === 'complete' ? 'args_ready' : 'streaming'
      if (idx === -1) {
        next.push({
          kind: 'tool',
          round,
          callIndex,
          id: ev.id,
          name: ev.name,
          args: ev.arguments,
          stage
        })
        return next
      }
      const cur = next[idx] as LiveTool
      const merged: LiveTool = {
        ...cur,
        name: ev.name || cur.name,
        args: ev.arguments,
        stage,
        id: ev.id.startsWith('pending-') ? cur.id : ev.id
      }
      next[idx] = merged
      return next
    }
    case 'tool_executing': {
      const round = ev.round ?? 0
      return next.map((e) => {
        if (e.kind !== 'tool') return e
        if (e.round === round && e.id === ev.id) {
          return { ...e, stage: 'executing' as const }
        }
        return e
      })
    }
    case 'tool_result': {
      const round = ev.round ?? 0
      return next.map((e) => {
        if (e.kind !== 'tool') return e
        if (e.round === round && e.id === ev.id) {
          return {
            ...e,
            stage: 'done' as const,
            ok: ev.ok,
            summary: ev.summary
          }
        }
        return e
      })
    }
    default:
      return prev
  }
}

function tryWritePathPreview(argsJson: string): string | null {
  try {
    const o = JSON.parse(argsJson) as { path?: string }
    return typeof o.path === 'string' ? o.path : null
  } catch {
    return null
  }
}

function renderTurnBlocks(blocks: ChatTurnBlock[]): ReactNode {
  return (
    <div className="msg-blocks">
      {blocks.map((b, i) =>
        b.kind === 'text' ? (
          <div key={i} className="msg-block-text">
            {b.text}
          </div>
        ) : (
          <div
            key={`${b.id}-${i}`}
            className={`chat-tool-card ${b.ok ? 'tool-ok' : 'tool-err'}`}
          >
            <div className="tool-name">{b.name}</div>
            <div className="tool-meta">
              {b.path ? `${b.path}\n` : ''}
              {b.summary}
            </div>
          </div>
        )
      )}
    </div>
  )
}

function liveToolStatus(t: LiveTool): string {
  if (t.stage === 'streaming') return '组装参数中…'
  if (t.stage === 'args_ready') return '等待执行…'
  if (t.stage === 'executing') return '正在执行…'
  return t.summary ?? (t.ok === false ? '失败' : '完成')
}

function renderLiveEntry(e: LiveEntry, i: number): ReactNode {
  if (e.kind === 'text') {
    return (
      <div key={`lt-${i}`} className="msg-block-text">
        {e.text}
      </div>
    )
  }
  const path = tryWritePathPreview(e.args)
  const done = e.stage === 'done'
  const cls =
    done && e.ok === true
      ? 'tool-ok'
      : done && e.ok === false
        ? 'tool-err'
        : ''
  return (
    <div
      key={`tool-${e.round}-${e.callIndex}-${e.id}`}
      className={['chat-tool-card', cls].filter(Boolean).join(' ')}
    >
      <div className="tool-name">{e.name}</div>
      <div className="tool-meta">
        {path ? `${path}\n` : ''}
        {liveToolStatus(e)}
      </div>
    </div>
  )
}

type FsDir = { kind: 'dir'; name: string; rel: string; children: FsNode[] }
type FsFile = { kind: 'file'; name: string; path: string }
type FsNode = FsDir | FsFile

function collectDirPrefixes(paths: string[]): string[] {
  const s = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    for (let i = 0; i < parts.length - 1; i++) {
      s.add(parts.slice(0, i + 1).join('/'))
    }
  }
  return [...s]
}

function buildFileTree(paths: string[]): FsDir {
  const root: FsDir = { kind: 'dir', name: '', rel: '', children: [] }
  const sorted = [...paths].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )
  for (const fp of sorted) {
    const segs = fp.split('/').filter(Boolean)
    if (segs.length === 0) continue
    let cur = root
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const isLast = i === segs.length - 1
      const relHere = segs.slice(0, i + 1).join('/')
      if (isLast) {
        cur.children.push({ kind: 'file', name: seg, path: fp })
      } else {
        let sub = cur.children.find(
          (c): c is FsDir => c.kind === 'dir' && c.name === seg
        )
        if (!sub) {
          sub = { kind: 'dir', name: seg, rel: relHere, children: [] }
          cur.children.push(sub)
        }
        cur = sub
      }
    }
  }
  sortFsChildren(root)
  return root
}

function sortFsChildren(dir: FsDir): void {
  dir.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const c of dir.children) {
    if (c.kind === 'dir') sortFsChildren(c)
  }
}

function FileTreeBranch({
  root,
  expanded,
  toggleDir,
  activeFile,
  onOpenFile,
  onContextMenu
}: {
  root: FsDir
  expanded: Set<string>
  toggleDir: (rel: string) => void
  activeFile: string | null
  onOpenFile: (p: string) => void
  onContextMenu?: (
    e: MouseEvent,
    target: { kind: 'file'; path: string } | { kind: 'dir'; rel: string }
  ) => void
}): React.ReactElement {
  const listClass = root.rel ? 'file-tree-nested file-tree' : 'file-tree'
  return (
    <ul className={listClass}>
      {root.children.map((c) =>
        c.kind === 'file' ? (
          <li
            key={c.path}
            className="file-tree-item"
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onContextMenu?.(e, { kind: 'file', path: c.path })
            }}
          >
            <div
              className={[
                'file-tree-file',
                c.path === activeFile ? 'active' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onOpenFile(c.path)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpenFile(c.path)
                }
              }}
            >
              {c.name}
            </div>
          </li>
        ) : (
          <li
            key={c.rel}
            className="file-tree-item"
            onContextMenu={(e) => {
              /* 嵌套子树内的右键交给子项，勿当成当前文件夹 */
              if ((e.target as HTMLElement).closest('.file-tree-nested')) {
                return
              }
              e.preventDefault()
              e.stopPropagation()
              onContextMenu?.(e, { kind: 'dir', rel: c.rel })
            }}
          >
            <div
              className="file-tree-dir-head"
              onClick={() => toggleDir(c.rel)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleDir(c.rel)
                }
              }}
            >
              <span className="file-tree-chevron" aria-hidden>
                {expanded.has(c.rel) ? '▼' : '▶'}
              </span>
              <span>{c.name}</span>
            </div>
            {expanded.has(c.rel) ? (
              <FileTreeBranch
                root={c}
                expanded={expanded}
                toggleDir={toggleDir}
                activeFile={activeFile}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
              />
            ) : null}
          </li>
        )
      )}
    </ul>
  )
}

function novelOrThrow(): NovelApi {
  const n = window.novel
  if (!n) throw new Error('preload missing')
  return n
}

function normRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\//, '').trim()
}

function parentRelPath(p: string): string {
  const n = normRelPath(p)
  const i = n.lastIndexOf('/')
  return i === -1 ? '' : n.slice(0, i)
}

function joinRelPath(parent: string, child: string): string {
  const c = normRelPath(child)
  if (!parent) return c
  return `${normRelPath(parent)}/${c}`
}

function basenameRel(p: string): string {
  const n = normRelPath(p)
  const i = n.lastIndexOf('/')
  return i === -1 ? n : n.slice(i + 1)
}

/** 拒绝空段、`.`、`..`；允许 `a/b/c` 形式。 */
function isSafeRelPathInput(rel: string): boolean {
  const n = normRelPath(rel)
  if (!n) return false
  for (const seg of n.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false
  }
  return true
}

function viewFromEditor(
  ed: Monaco.editor.IStandaloneCodeEditor | null
): Pick<FileBufferEntry, 'scrollTop' | 'scrollLeft' | 'line' | 'column'> {
  const pos = ed?.getPosition()
  return {
    scrollTop: ed?.getScrollTop() ?? 0,
    scrollLeft: ed?.getScrollLeft() ?? 0,
    line: pos?.lineNumber ?? 1,
    column: pos?.column ?? 1
  }
}

function applyEditorView(
  ed: Monaco.editor.IStandaloneCodeEditor,
  vs: EditorViewState
): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ed.setScrollTop(vs.scrollTop)
      ed.setScrollLeft(vs.scrollLeft)
      ed.setPosition({ lineNumber: vs.line, column: vs.column })
      ed.revealPositionInCenterIfOutsideViewport({
        lineNumber: vs.line,
        column: vs.column
      })
    })
  })
}

function fileTreeExpandedStorageKey(wsPath: string): string {
  return `novel-filetree-expanded:${wsPath}`
}

export default function App(): React.ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(
    () => new Set()
  )
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [content, setContent] = useState('')
  /** 当前打开文件在磁盘上的基线；与 content 比较可判断编辑器是否已写入磁盘。 */
  const [editorDiskBaseline, setEditorDiskBaseline] = useState('')
  const [graph, setGraph] = useState<VersionGraph | null>(null)
  const [messages, setMessages] = useState<ChatMessageRow[]>([])
  const [chatTabs, setChatTabs] = useState<ChatTab[]>([])
  const [closedChatThreads, setClosedChatThreads] = useState<ChatThreadTabInfo[]>(
    []
  )
  const [activeChatTabId, setActiveChatTabId] = useState<string | null>(null)
  const chatTabsRef = useRef<ChatTab[]>([])
  const activeChatTabIdRef = useRef<string | null>(null)
  /** 尚未发送首条消息的标签（按 branchId 分组），不入库。 */
  const ephemeralDraftTabsRef = useRef<Map<string, ChatTab[]>>(new Map())
  const [input, setInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [genPhase, setGenPhase] = useState<'idle' | 'model' | 'tools'>('idle')
  const [liveEntries, setLiveEntries] = useState<LiveEntry[]>([])
  const [status, setStatus] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  /** Electron 下 window.prompt 不可用（恒为 null），检查点说明改用应用内对话框。 */
  const [checkpointModal, setCheckpointModal] = useState<
    { open: false } | { open: true; saveEditorFirst: boolean }
  >({ open: false })
  const [checkpointLabelInput, setCheckpointLabelInput] = useState('')
  const [checkpointBranchInput, setCheckpointBranchInput] = useState('')
  const [chatForkModal, setChatForkModal] = useState<{
    open: boolean
    defaultName: string
  }>({ open: false, defaultName: '' })
  const chatForkInputRef = useRef<HTMLInputElement>(null)
  const [fileTreeCtx, setFileTreeCtx] = useState<{
    x: number
    y: number
    target:
      | { kind: 'file'; path: string }
      | { kind: 'dir'; rel: string }
  } | null>(null)
  const fileNameModalKeyRef = useRef(0)
  const [fileNameModal, setFileNameModal] = useState<
    | { open: false }
    | { open: true; title: string; initialValue: string; inputKey: number }
  >({ open: false })
  const fileNameSubmitRef = useRef<(value: string) => Promise<void> | void>(
    null
  )
  const fileNameInputRef = useRef<HTMLInputElement>(null)
  const [fileDeleteConfirm, setFileDeleteConfirm] = useState<{
    path: string
    isDir: boolean
  } | null>(null)
  const fileDeletePendingRef = useRef<{
    path: string
    isDir: boolean
  } | null>(null)
  const [fileTreeBanner, setFileTreeBanner] = useState<string | null>(null)
  const fileTreeBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const pendingChatPayloadRef = useRef<{
    text: string
    filePath: string | null
    chatThreadId: string
  } | null>(null)
  const dirtyProceedRef = useRef<(() => Promise<void>) | null>(null)
  const [dirtyConfirmModal, setDirtyConfirmModal] = useState<{
    open: boolean
    message: string
  }>({ open: false, message: '' })
  const activeFileRef = useRef<string | null>(null)
  const contentRef = useRef('')
  const editorDiskBaselineRef = useRef('')
  /** 切换文件时保留各文件的未保存内容与阅读位置。 */
  const fileBuffersRef = useRef<Map<string, FileBufferEntry>>(new Map())
  const monacoEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(
    null
  )
  const pendingViewRestoreRef = useRef<EditorViewState | null>(null)
  /** AI patch 前主进程 invoke 落盘时读取最新编辑器状态（避免闭包陈旧）。 */
  const editorFlushRef = useRef({
    activeFile: null as string | null,
    content: '',
    editorDiskBaseline: ''
  })
  /** 工作区切换后跳过下一次 expanded 持久化，避免把旧工作区的展开状态写入新 key。 */
  const skipFileTreePersistRef = useRef(false)
  /** 关闭窗口时同步保存会话（pagehide 用 ref 取最新正文与缓冲）。 */
  const sessionSaveRef = useRef({
    path: null as string | null
  })
  const [electronError, setElectronError] = useState<string | null>(() =>
    typeof window !== 'undefined' && !window.novel
      ? '未加载 Electron 预加载脚本（window.novel 不可用）。主进程可能指向了错误的 preload 路径；请重新执行 npm run dev 或 npm run build:app。'
      : null
  )

  const refreshFiles = useCallback(async () => {
    if (!window.novel) return
    const list = await novelOrThrow().listTree()
    setFiles(list)
  }, [])

  const showFileTreeBanner = useCallback((msg: string) => {
    if (fileTreeBannerTimerRef.current != null) {
      clearTimeout(fileTreeBannerTimerRef.current)
    }
    setFileTreeBanner(msg)
    fileTreeBannerTimerRef.current = setTimeout(() => {
      setFileTreeBanner(null)
      fileTreeBannerTimerRef.current = null
    }, 4800)
  }, [])

  const fileTree = useMemo(() => buildFileTree(files), [files])

  useEffect(() => {
    const p = workspace?.path
    if (!p) {
      setExpandedDirs(new Set())
      return
    }
    skipFileTreePersistRef.current = true
    try {
      const raw = localStorage.getItem(fileTreeExpandedStorageKey(p))
      if (raw) {
        const arr = JSON.parse(raw) as unknown
        if (Array.isArray(arr)) {
          setExpandedDirs(
            new Set(arr.filter((x): x is string => typeof x === 'string'))
          )
          return
        }
      }
      setExpandedDirs(new Set())
    } catch {
      setExpandedDirs(new Set())
    }
  }, [workspace?.path])

  useEffect(() => {
    if (files.length === 0) return
    const valid = new Set(collectDirPrefixes(files))
    setExpandedDirs((prev) => {
      const next = new Set<string>()
      for (const p of prev) {
        if (valid.has(p)) next.add(p)
      }
      if (next.size === prev.size) {
        for (const p of prev) {
          if (!next.has(p)) return next
        }
        return prev
      }
      return next
    })
  }, [files])

  useEffect(() => {
    const p = workspace?.path
    if (!p) return
    if (skipFileTreePersistRef.current) {
      skipFileTreePersistRef.current = false
      return
    }
    try {
      localStorage.setItem(
        fileTreeExpandedStorageKey(p),
        JSON.stringify([...expandedDirs])
      )
    } catch {
      /* ignore quota / private mode */
    }
  }, [workspace?.path, expandedDirs])

  const toggleDir = useCallback((rel: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }, [])

  const ensureDirExpanded = useCallback((rel: string) => {
    if (!rel) return
    setExpandedDirs((prev) => new Set([...prev, rel]))
  }, [])

  const openFileNameModal = useCallback(
    (
      title: string,
      initialValue: string,
      onSubmit: (value: string) => Promise<void> | void
    ): void => {
      fileNameModalKeyRef.current += 1
      fileNameSubmitRef.current = onSubmit
      setFileNameModal({
        open: true,
        title,
        initialValue,
        inputKey: fileNameModalKeyRef.current
      })
    },
    []
  )

  const closeFileNameModal = useCallback((): void => {
    setFileNameModal({ open: false })
    fileNameSubmitRef.current = null
  }, [])

  const confirmFileNameModal = useCallback(async (): Promise<void> => {
    if (!fileNameModal.open) return
    const raw = fileNameInputRef.current?.value?.trim() ?? ''
    if (!raw) {
      showFileTreeBanner('名称不能为空')
      return
    }
    const fn = fileNameSubmitRef.current
    if (fn) await fn(raw)
    closeFileNameModal()
  }, [fileNameModal.open, closeFileNameModal, showFileTreeBanner])

  const pruneBuffersUnderPrefix = useCallback((dirRel: string): void => {
    const d = normRelPath(dirRel)
    if (!d) return
    const pre = `${d}/`
    for (const k of [...fileBuffersRef.current.keys()]) {
      if (k === d || k.startsWith(pre)) {
        fileBuffersRef.current.delete(k)
      }
    }
  }, [])

  const renameBuffersTreePrefix = useCallback(
    (fromDir: string, toDir: string): void => {
      const a = normRelPath(fromDir)
      const b = normRelPath(toDir)
      if (!a || !b) return
      const pre = `${a}/`
      for (const [k, v] of [...fileBuffersRef.current.entries()]) {
        if (k === a || k.startsWith(pre)) {
          const rest = k === a ? '' : k.slice(a.length + 1)
          const nk = rest ? `${b}/${rest}` : b
          fileBuffersRef.current.delete(k)
          fileBuffersRef.current.set(nk, v)
        }
      }
    },
    []
  )

  const startNewFileInDir = useCallback(
    (parentRel: string) => {
      setFileTreeCtx(null)
      ensureDirExpanded(parentRel)
      openFileNameModal(
        '新建文件（可含子路径，例如 notes/ch1.md）',
        '',
        async (name) => {
          const rel = joinRelPath(parentRel, name)
          if (!isSafeRelPathInput(rel)) {
            showFileTreeBanner('路径无效：不得包含 .. 或空段')
            return
          }
          const r = await novelOrThrow().createWorkspaceFile(rel)
          if (!r.ok) {
            showFileTreeBanner(r.error)
            return
          }
          await refreshFiles()
        }
      )
    },
    [
      ensureDirExpanded,
      openFileNameModal,
      refreshFiles,
      showFileTreeBanner
    ]
  )

  const startNewFolderInDir = useCallback(
    (parentRel: string) => {
      setFileTreeCtx(null)
      ensureDirExpanded(parentRel)
      openFileNameModal(
        '新建文件夹（可含子路径）',
        '',
        async (name) => {
          const rel = joinRelPath(parentRel, name)
          if (!isSafeRelPathInput(rel)) {
            showFileTreeBanner('路径无效：不得包含 .. 或空段')
            return
          }
          const r = await novelOrThrow().createWorkspaceFolder(rel)
          if (!r.ok) {
            showFileTreeBanner(r.error)
            return
          }
          await refreshFiles()
        }
      )
    },
    [
      ensureDirExpanded,
      openFileNameModal,
      refreshFiles,
      showFileTreeBanner
    ]
  )

  const startRenameTarget = useCallback(
    (path: string, isDir: boolean) => {
      setFileTreeCtx(null)
      const base = basenameRel(path)
      const parent = parentRelPath(path)
      openFileNameModal('重命名', base, async (newName) => {
        if (!isSafeRelPathInput(newName)) {
          showFileTreeBanner('名称无效')
          return
        }
        const toRel = joinRelPath(parent, newName)
        if (!isSafeRelPathInput(toRel)) {
          showFileTreeBanner('路径无效')
          return
        }
        const r = await novelOrThrow().renameWorkspacePath(path, toRel)
        if (!r.ok) {
          showFileTreeBanner(r.error)
          return
        }
        const af = activeFileRef.current
        if (af) {
          const a = normRelPath(af)
          const op = normRelPath(path)
          if (isDir) {
            if (a === op || a.startsWith(`${op}/`)) {
              if (a === op) {
                setActiveFile(null)
                setContent('')
                setEditorDiskBaseline('')
              } else {
                const suffix = a.slice(op.length + 1)
                setActiveFile(joinRelPath(toRel, suffix))
              }
            }
          } else if (a === op) {
            setActiveFile(toRel)
          }
        }
        if (isDir) renameBuffersTreePrefix(path, toRel)
        else {
          const oldKey = normRelPath(path)
          if (fileBuffersRef.current.has(oldKey)) {
            const ent = fileBuffersRef.current.get(oldKey)!
            fileBuffersRef.current.delete(oldKey)
            fileBuffersRef.current.set(normRelPath(toRel), ent)
          }
        }
        await refreshFiles()
      })
    },
    [
      openFileNameModal,
      refreshFiles,
      renameBuffersTreePrefix,
      showFileTreeBanner
    ]
  )

  const openDeleteConfirm = useCallback((path: string, isDir: boolean) => {
    setFileTreeCtx(null)
    const payload = { path, isDir }
    fileDeletePendingRef.current = payload
    setFileDeleteConfirm(payload)
  }, [])

  const cancelDeleteConfirm = useCallback((): void => {
    fileDeletePendingRef.current = null
    setFileDeleteConfirm(null)
  }, [])

  const runDeleteConfirmed = useCallback(async (): Promise<void> => {
    const cur = fileDeletePendingRef.current
    fileDeletePendingRef.current = null
    setFileDeleteConfirm(null)
    if (!cur) return
    const { path, isDir } = cur
    const r = await novelOrThrow().deleteWorkspacePath(path)
    if (!r.ok) {
      showFileTreeBanner(r.error)
      return
    }
    const p = normRelPath(path)
    const af = activeFileRef.current
    if (af) {
      const a = normRelPath(af)
      if (isDir) {
        if (a === p || a.startsWith(`${p}/`)) {
          setActiveFile(null)
          setContent('')
          setEditorDiskBaseline('')
        }
      } else if (a === p) {
        setActiveFile(null)
        setContent('')
        setEditorDiskBaseline('')
      }
    }
    if (isDir) pruneBuffersUnderPrefix(path)
    else fileBuffersRef.current.delete(p)
    await refreshFiles()
  }, [pruneBuffersUnderPrefix, refreshFiles, showFileTreeBanner])

  useEffect(() => {
    if (!fileTreeCtx) return
    const close = (): void => setFileTreeCtx(null)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close()
    }
    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== 0) return
      close()
    }
    const t = window.setTimeout(() => {
      document.addEventListener('keydown', onKey, true)
      /* 冒泡阶段：避免捕获先于菜单内 stopPropagation，导致一点击就关掉 */
      document.addEventListener('pointerdown', onPointerDown, false)
    }, 200)
    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointerDown, false)
    }
  }, [fileTreeCtx])

  useEffect(() => {
    return () => {
      if (fileTreeBannerTimerRef.current != null) {
        clearTimeout(fileTreeBannerTimerRef.current)
      }
    }
  }, [])

  const editorUnsavedToDisk =
    activeFile != null && content !== editorDiskBaseline

  const stashActiveFileBuffer = useCallback(() => {
    const af = activeFileRef.current
    if (!af) return
    fileBuffersRef.current.set(normRelPath(af), {
      content: contentRef.current,
      editorDiskBaseline: editorDiskBaselineRef.current,
      ...viewFromEditor(monacoEditorRef.current)
    })
  }, [])

  const clearFileBuffers = useCallback(() => {
    fileBuffersRef.current.clear()
    pendingViewRestoreRef.current = null
  }, [])

  const refreshGraph = useCallback(async () => {
    if (!window.novel) return
    const g = await novelOrThrow().versionGraph()
    setGraph(g)
  }, [])

  useEffect(() => {
    chatTabsRef.current = chatTabs
  }, [chatTabs])

  useEffect(() => {
    activeChatTabIdRef.current = activeChatTabId
  }, [activeChatTabId])

  const refreshMessagesForTab = useCallback(
    async (
      branchId: string,
      threadId: string,
      tabIdForTitleSync: string | null
    ): Promise<void> => {
      if (!window.novel) return
      const m = await novelOrThrow().getMessages(branchId, threadId)
      setMessages(m)
      if (tabIdForTitleSync == null) return
      const auto = titleFromMessages(m)
      setChatTabs((prev) =>
        prev.map((t) => {
          if (t.threadId !== tabIdForTitleSync) return t
          if (t.titlePending) {
            if (auto !== '新对话')
              return { ...t, title: auto, titlePending: false }
            return t
          }
          if (auto !== '新对话') return { ...t, title: auto }
          return t
        })
      )
      void novelOrThrow().updateChatThreadTitle(
        branchId,
        tabIdForTitleSync,
        auto
      )
    },
    []
  )

  const loadChatTabsForBranch = useCallback(
    async (
      branchId: string,
      preferredActiveThreadId?: string | null
    ): Promise<void> => {
      if (!window.novel) return
      const st = await novelOrThrow().getChatTabState(branchId)
      setClosedChatThreads(st.closed)
      const serverTabs: ChatTab[] = st.open.map((o) => ({
        id: o.threadId,
        branchId: st.branchId,
        threadId: o.threadId,
        title: o.title,
        titlePending: o.title === '新对话'
      }))
      const sidSet = new Set(serverTabs.map((s) => s.threadId))
      const extra = (ephemeralDraftTabsRef.current.get(branchId) ?? []).filter(
        (e) => !sidSet.has(e.threadId)
      )
      ephemeralDraftTabsRef.current.set(branchId, extra)
      const tabs = [...serverTabs, ...extra]
      setChatTabs(tabs)
      const pref = preferredActiveThreadId ?? null
      const active =
        pref && tabs.some((x) => x.threadId === pref)
          ? pref
          : tabs[0]?.threadId ?? null
      setActiveChatTabId(active)
      if (active) {
        await refreshMessagesForTab(st.branchId, active, active)
      } else {
        setMessages([])
      }
    },
    [refreshMessagesForTab]
  )

  const refreshMessages = useCallback(async () => {
    if (!window.novel) return
    const tabs = chatTabsRef.current
    const aid = activeChatTabIdRef.current
    const t = tabs.find((x) => x.id === aid) ?? tabs[0]
    if (!t) return
    await refreshMessagesForTab(t.branchId, t.threadId, t.id)
  }, [refreshMessagesForTab])

  const refreshStatus = useCallback(async () => {
    if (!window.novel) return
    const s = await novelOrThrow().versionStatus()
    setStatus(
      s.dirty ? '未保存快照（相对当前节点有变更）' : '与当前节点一致'
    )
  }, [])

  useEffect(() => {
    activeFileRef.current = activeFile
  }, [activeFile])

  useEffect(() => {
    contentRef.current = content
  }, [content])

  useEffect(() => {
    editorDiskBaselineRef.current = editorDiskBaseline
  }, [editorDiskBaseline])

  useEffect(() => {
    editorFlushRef.current = { activeFile, content, editorDiskBaseline }
  }, [activeFile, content, editorDiskBaseline])

  useEffect(() => {
    sessionSaveRef.current = {
      path: workspace?.path ?? null
    }
  }, [workspace?.path])

  useEffect(() => {
    if (!window.novel) return
    const flushSession = (): void => {
      const s = sessionSaveRef.current
      if (!s.path) return
      stashActiveFileBuffer()
      void novelOrThrow().saveSessionSnapshot({
        activeFile: activeFileRef.current,
        editorContent: contentRef.current,
        editorDiskBaseline: editorDiskBaselineRef.current,
        historyBanner: false,
        fileBuffers: Object.fromEntries(fileBuffersRef.current.entries())
      })
    }
    window.addEventListener('pagehide', flushSession)
    return () => window.removeEventListener('pagehide', flushSession)
  }, [stashActiveFileBuffer])

  useEffect(() => {
    if (!window.novel || !workspace?.path) return
    const t = window.setTimeout(() => {
      stashActiveFileBuffer()
      void novelOrThrow().saveSessionSnapshot({
        activeFile: activeFileRef.current,
        editorContent: contentRef.current,
        editorDiskBaseline: editorDiskBaselineRef.current,
        historyBanner: false,
        fileBuffers: Object.fromEntries(fileBuffersRef.current.entries())
      })
    }, 450)
    return () => clearTimeout(t)
  }, [
    workspace?.path,
    workspace?.currentBranchId,
    activeFile,
    content,
    editorDiskBaseline,
    stashActiveFileBuffer
  ])

  useEffect(() => {
    if (!window.novel) return
    const api = novelOrThrow()
    api.setEditorFlushHandler(async () => {
      const { activeFile: af, content: c, editorDiskBaseline: b } =
        editorFlushRef.current
      if (!af || c === b) return
      await api.writeFile(af, c)
      setEditorDiskBaseline(c)
      const v = viewFromEditor(monacoEditorRef.current)
      fileBuffersRef.current.set(normRelPath(af), {
        content: c,
        editorDiskBaseline: c,
        ...v
      })
    })
    return () => {
      api.setEditorFlushHandler(null)
    }
  }, [])

  useEffect(() => {
    if (!window.novel) return
    const api = novelOrThrow()
    void (async () => {
      const r = await api.restoreLastSession()
      if (r.ok) {
        fileBuffersRef.current.clear()
        if (r.fileBuffers) {
          for (const [k, raw] of Object.entries(r.fileBuffers)) {
            const ent = normalizeFileBufferEntry(raw)
            if (ent) fileBuffersRef.current.set(normRelPath(k), ent)
          }
        }
        setWorkspace(r.workspace)
        ephemeralDraftTabsRef.current.clear()
        await loadChatTabsForBranch(r.workspace.currentBranchId)
        setActiveFile(r.activeFile)
        setContent(r.editorContent)
        setEditorDiskBaseline(r.editorDiskBaseline)
        let pv: EditorViewState | null = null
        if (r.activeFile) {
          const ent = fileBuffersRef.current.get(normRelPath(r.activeFile))
          if (ent) {
            pv = {
              scrollTop: ent.scrollTop,
              scrollLeft: ent.scrollLeft,
              line: ent.line,
              column: ent.column
            }
          }
        }
        if (!pv && r.editorView) pv = r.editorView
        pendingViewRestoreRef.current = pv
        await refreshFiles()
        await refreshGraph()
        await refreshStatus()
      } else {
        const w = await api.getWorkspace()
        if (w) {
          setWorkspace(w)
          ephemeralDraftTabsRef.current.clear()
          refreshFiles()
          refreshGraph()
          void loadChatTabsForBranch(w.currentBranchId)
          refreshStatus()
        }
      }
      api.getSettings().then(setSettings)
    })()
    /* refresh* 为稳定 useCallback；此处仅应用启动时恢复一次，避免依赖变化重复 restore。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once bootstrap
  }, [])

  useEffect(() => {
    if (!window.novel) return
    const api = novelOrThrow()
    const u1 = api.onChatStreamEvent((ev) => {
      if (ev.type === 'generating') {
        setGenPhase(ev.phase)
        return
      }
      if (ev.type === 'tool_result' && ev.ok && ev.path) {
        void (async () => {
          await refreshFiles()
          await refreshGraph()
          await refreshStatus()
          const af = activeFileRef.current
          if (
            af &&
            normRelPath(af) === normRelPath(ev.path!)
          ) {
            try {
              const t = await novelOrThrow().readFile(af)
              setContent(t)
              setEditorDiskBaseline(t)
              fileBuffersRef.current.set(normRelPath(af), {
                content: t,
                editorDiskBaseline: t,
                ...viewFromEditor(monacoEditorRef.current)
              })
            } catch {
              setActiveFile(null)
              setContent('')
              setEditorDiskBaseline('')
            }
          }
        })()
      }
      setLiveEntries((prev) => reduceLiveEntries(prev, ev))
    })
    const u2 = api.onChatDone(async () => {
      setLiveEntries([])
      setGenPhase('idle')
      setChatBusy(false)
      await refreshMessages()
      const w = await novelOrThrow().getWorkspace()
      if (w) {
        setWorkspace(w)
        await loadChatTabsForBranch(
          w.currentBranchId,
          activeChatTabIdRef.current
        )
      }
      await refreshFiles()
      await refreshGraph()
      await refreshStatus()
      const af = activeFileRef.current
      if (af) {
        try {
          const t = await novelOrThrow().readFile(af)
          setContent(t)
          setEditorDiskBaseline(t)
          fileBuffersRef.current.set(normRelPath(af), {
            content: t,
            editorDiskBaseline: t,
            ...viewFromEditor(monacoEditorRef.current)
          })
        } catch {
          setActiveFile(null)
          setContent('')
          setEditorDiskBaseline('')
        }
      }
    })
    const u3 = api.onChatError((e) => {
      setLiveEntries([])
      setGenPhase('idle')
      setChatBusy(false)
      /* 错误弹窗由主进程 dialog.showMessageBox 负责；此处只恢复 UI */
      console.error('[novel chat error]', e)
    })
    const u4 = api.onWorkspaceRestored(async () => {
      await refreshFiles()
      await refreshGraph()
      await refreshStatus()
      const w = await novelOrThrow().getWorkspace()
      if (w) {
        setWorkspace(w)
        ephemeralDraftTabsRef.current.clear()
        await loadChatTabsForBranch(w.currentBranchId)
      }
      const af = activeFileRef.current
      if (af) {
        try {
          const t = await novelOrThrow().readFile(af)
          setContent(t)
          setEditorDiskBaseline(t)
          fileBuffersRef.current.set(normRelPath(af), {
            content: t,
            editorDiskBaseline: t,
            ...viewFromEditor(monacoEditorRef.current)
          })
        } catch {
          setActiveFile(null)
          setContent('')
          setEditorDiskBaseline('')
        }
      }
    })
    const u5 = api.onWorkspaceTreeChanged(async () => {
      await refreshFiles()
      const af = activeFileRef.current
      if (!af) return
      const dirty =
        contentRef.current !== editorDiskBaselineRef.current
      if (dirty) {
        showFileTreeBanner(
          '磁盘上的文件已变更；当前编辑器有未写入修改，未自动重载。'
        )
        return
      }
      try {
        const t = await novelOrThrow().readFile(af)
        setContent(t)
        setEditorDiskBaseline(t)
        fileBuffersRef.current.set(normRelPath(af), {
          content: t,
          editorDiskBaseline: t,
          ...viewFromEditor(monacoEditorRef.current)
        })
      } catch {
        setActiveFile(null)
        setContent('')
        setEditorDiskBaseline('')
      }
    })
    return () => {
      u1()
      u2()
      u3()
      u4()
      u5()
    }
  }, [
    refreshFiles,
    refreshGraph,
    refreshMessages,
    refreshMessagesForTab,
    refreshStatus,
    loadChatTabsForBranch,
    showFileTreeBanner
  ])

  const openWorkspace = async (): Promise<void> => {
    const w = await novelOrThrow().selectWorkspace()
    if (!w) return
    clearFileBuffers()
    ephemeralDraftTabsRef.current.clear()
    setWorkspace(w)
    await loadChatTabsForBranch(w.currentBranchId)
    setFiles([])
    setActiveFile(null)
    setContent('')
    setEditorDiskBaseline('')
    await refreshFiles()
    await refreshGraph()
    await refreshStatus()
  }

  const openFile = async (rel: string): Promise<void> => {
    const nextKey = normRelPath(rel)
    if (
      activeFileRef.current &&
      normRelPath(activeFileRef.current) === nextKey
    ) {
      return
    }
    stashActiveFileBuffer()
    const cached = fileBuffersRef.current.get(nextKey)
    if (cached) {
      setActiveFile(rel)
      setContent(cached.content)
      setEditorDiskBaseline(cached.editorDiskBaseline)
      pendingViewRestoreRef.current = {
        scrollTop: cached.scrollTop,
        scrollLeft: cached.scrollLeft,
        line: cached.line,
        column: cached.column
      }
      await refreshStatus()
      return
    }
    const text = await novelOrThrow().readFile(rel)
    setActiveFile(rel)
    setContent(text)
    setEditorDiskBaseline(text)
    pendingViewRestoreRef.current = null
    await refreshStatus()
  }

  const saveFile = useCallback(async (): Promise<void> => {
    if (!activeFile) return
    await novelOrThrow().writeFile(activeFile, content)
    setEditorDiskBaseline(content)
    const v = viewFromEditor(monacoEditorRef.current)
    fileBuffersRef.current.set(normRelPath(activeFile), {
      content,
      editorDiskBaseline: content,
      ...v
    })
    await refreshStatus()
  }, [activeFile, content, refreshStatus])

  const openCheckpointModal = (): void => {
    setCheckpointLabelInput('')
    setCheckpointBranchInput('')
    void novelOrThrow()
      .getWorkspace()
      .then((w) => {
        if (w) setWorkspace(w)
      })
      .catch(() => {
        /* ignore */
      })
    setCheckpointModal({ open: true, saveEditorFirst: false })
  }

  const openCommitSnapshotModal = (): void => {
    setCheckpointLabelInput('')
    setCheckpointBranchInput('')
    void novelOrThrow()
      .getWorkspace()
      .then((w) => {
        if (w) setWorkspace(w)
      })
      .catch(() => {
        /* ignore */
      })
    setCheckpointModal({ open: true, saveEditorFirst: true })
  }

  const closeCheckpointModal = (): void => {
    setCheckpointModal({ open: false })
  }

  const confirmCheckpointModal = async (): Promise<void> => {
    if (!checkpointModal.open) return
    const saveEditorFirst = checkpointModal.saveEditorFirst
    const label = checkpointLabelInput.trim()
    const branchNameInput = checkpointBranchInput.trim()
    try {
      if (saveEditorFirst && activeFile && content !== editorDiskBaseline) {
        await novelOrThrow().writeFile(activeFile, content)
        setEditorDiskBaseline(content)
        const v = viewFromEditor(monacoEditorRef.current)
        fileBuffersRef.current.set(normRelPath(activeFile), {
          content,
          editorDiskBaseline: content,
          ...v
        })
      }
      const wPre = await novelOrThrow().getWorkspace()
      const pending = wPre?.pendingForkBeforeNextCommit ?? false
      if (pending && !branchNameInput) {
        alert('跳转后首次提交需要先填写新分支名称')
        return
      }
      setCheckpointModal({ open: false })
      if (pending) {
        await novelOrThrow().checkpointWithNewBranch({
          newBranchName: branchNameInput,
          label: label || 'Checkpoint'
        })
      } else {
        try {
          const tabs = chatTabsRef.current
          const aid = activeChatTabIdRef.current
          const tab = tabs.find((x) => x.id === aid) ?? tabs[0]
          await novelOrThrow().checkpoint(label, tab?.branchId ?? null)
        } catch (e) {
          if (
            e instanceof Error &&
            e.message === 'NEXT_COMMIT_REQUIRES_NEW_BRANCH_NAME'
          ) {
            alert('跳转后须使用新分支提交，请填写分支名称后重试')
            setCheckpointModal({ open: true, saveEditorFirst })
            const w2 = await novelOrThrow().getWorkspace()
            if (w2) setWorkspace(w2)
            return
          }
          throw e
        }
      }
      const w = await novelOrThrow().getWorkspace()
      if (w) setWorkspace(w)
      await refreshGraph()
      await refreshStatus()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[checkpoint]', e)
      alert(`创建检查点失败：${msg}`)
    }
  }

  const requestToolbarCheckpoint = (): void => {
    if (!workspace) return
    openCheckpointModal()
  }

  const cancelDirtyConfirm = (): void => {
    dirtyProceedRef.current = null
    setDirtyConfirmModal({ open: false, message: '' })
  }

  const runDirtyConfirm = async (): Promise<void> => {
    const fn = dirtyProceedRef.current
    dirtyProceedRef.current = null
    setDirtyConfirmModal({ open: false, message: '' })
    if (fn) await fn()
  }

  const restoreNode = async (nodeId: string): Promise<void> => {
    const runRestore = async (): Promise<void> => {
      clearFileBuffers()
      await novelOrThrow().restoreNode(nodeId)
      const w = await novelOrThrow().getWorkspace()
      if (w) {
        setWorkspace(w)
        ephemeralDraftTabsRef.current.clear()
        await loadChatTabsForBranch(w.currentBranchId)
      }
      const af = activeFileRef.current
      if (af) {
        try {
          const t = await novelOrThrow().readFile(af)
          setContent(t)
          setEditorDiskBaseline(t)
          pendingViewRestoreRef.current = null
        } catch {
          setActiveFile(null)
          setContent('')
          setEditorDiskBaseline('')
        }
      }
      await refreshFiles()
      await refreshGraph()
      await refreshStatus()
    }
    const dirty = (await novelOrThrow().versionStatus()).dirty
    if (dirty) {
      dirtyProceedRef.current = runRestore
      setDirtyConfirmModal({
        open: true,
        message:
          '当前工作区与当前查看节点快照不一致，恢复将覆盖未相对该快照保存的修改。继续？'
      })
      return
    }
    await runRestore()
  }

  const deleteVersionNodeFromGraph = async (nodeId: string): Promise<void> => {
    const runDelete = async (): Promise<void> => {
      try {
        await novelOrThrow().deleteVersionNode(nodeId)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        alert(`删除失败：${msg}`)
        return
      }
      const w = await novelOrThrow().getWorkspace()
      if (w) {
        setWorkspace(w)
        ephemeralDraftTabsRef.current.clear()
        await loadChatTabsForBranch(w.currentBranchId)
      }
      const af = activeFileRef.current
      if (af) {
        try {
          const t = await novelOrThrow().readFile(af)
          setContent(t)
          setEditorDiskBaseline(t)
          pendingViewRestoreRef.current = null
        } catch {
          setActiveFile(null)
          setContent('')
          setEditorDiskBaseline('')
        }
      }
      await refreshFiles()
      await refreshGraph()
      await refreshStatus()
    }
    const dirty = (await novelOrThrow().versionStatus()).dirty
    if (dirty) {
      dirtyProceedRef.current = runDelete
      setDirtyConfirmModal({
        open: true,
        message:
          '当前工作区与当前查看节点快照不一致，删除后磁盘上未相对该快照保存的修改仍会保留。继续？'
      })
      return
    }
    await runDelete()
  }

  const clearHistoryView = async (): Promise<void> => {
    await novelOrThrow().clearHistoryView()
    const w = await novelOrThrow().getWorkspace()
    if (w) setWorkspace(w)
    await refreshMessages()
  }

  const runForkThenSendChat = useCallback(async (): Promise<void> => {
    const name = chatForkInputRef.current?.value.trim() ?? ''
    if (!name) {
      alert('请填写分支名称')
      return
    }
    const payload = pendingChatPayloadRef.current
    if (!payload) return
    try {
      await novelOrThrow().forkAfterJump(name)
      const w = await novelOrThrow().getWorkspace()
      if (!w) {
        alert('分支已创建，但无法读取工作区，请重试发送。')
        return
      }
      setWorkspace(w)
      ephemeralDraftTabsRef.current.clear()
      const bid = w.currentBranchId
      const tid = payload.chatThreadId
      const tabState = await novelOrThrow().getChatTabState(bid)
      const threadAlreadyOpen = tabState.open.some((o) => o.threadId === tid)
      if (!threadAlreadyOpen) {
        ephemeralDraftTabsRef.current.set(bid, [
          {
            id: tid,
            branchId: bid,
            threadId: tid,
            title: '新对话（未发送）',
            titlePending: true,
            ephemeral: true
          }
        ])
      }
      await loadChatTabsForBranch(bid, tid)
      pendingChatPayloadRef.current = null
      setChatForkModal({ open: false, defaultName: '' })
      const text = payload.text
      const filePath = payload.filePath
      setLiveEntries([])
      setGenPhase('model')
      setChatBusy(true)
      const base = await novelOrThrow().getMessages(bid, tid)
      setMessages([
        ...base,
        { role: 'user', content: text, seq: -Date.now() }
      ])
      const tl = suggestChatTabTitleFromUserText(text)
      setChatTabs((prev) =>
        prev.map((t) => {
          if (t.threadId !== tid) return t
          const firstTurnHere =
            t.ephemeral === true ||
            t.titlePending === true ||
            t.title === '新对话' ||
            t.title === '新对话（未发送）'
          if (!firstTurnHere) return t
          return {
            ...t,
            title: tl,
            titlePending: false,
            ephemeral: false
          }
        })
      )
      try {
        await novelOrThrow().sendChat({
          text,
          filePath,
          chatBranchId: w.currentBranchId,
          chatThreadId: tid
        })
      } catch (sendErr) {
        setLiveEntries([])
        setGenPhase('idle')
        setChatBusy(false)
        setInput(text)
        if (w) {
          const tabs = chatTabsRef.current
          const aid = activeChatTabIdRef.current
          const tab = tabs.find((x) => x.id === aid) ?? tabs[0]
          if (tab)
            await refreshMessagesForTab(
              w.currentBranchId,
              tab.threadId,
              tab.id
            )
        }
        const sm =
          sendErr instanceof Error ? sendErr.message : String(sendErr)
        alert(`分支已创建，但发送失败：${sm}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`创建分支失败：${msg}`)
    }
  }, [refreshMessagesForTab, loadChatTabsForBranch])

  const closeChatForkModal = (): void => {
    const p = pendingChatPayloadRef.current
    pendingChatPayloadRef.current = null
    setChatForkModal({ open: false, defaultName: '' })
    if (p) setInput(p.text)
  }

  const switchBranch = async (branchId: string): Promise<void> => {
    clearFileBuffers()
    await novelOrThrow().setBranch(branchId)
    const w = await novelOrThrow().getWorkspace()
    if (w) setWorkspace(w)
    ephemeralDraftTabsRef.current.clear()
    await novelOrThrow().clearHistoryView()
    await loadChatTabsForBranch(branchId)
    if (activeFile) {
      try {
        const t = await novelOrThrow().readFile(activeFile)
        setContent(t)
        setEditorDiskBaseline(t)
      } catch {
        setActiveFile(null)
        setContent('')
        setEditorDiskBaseline('')
      }
    } else {
      setContent('')
      setEditorDiskBaseline('')
    }
    await refreshGraph()
    await refreshStatus()
  }

  const newChatTab = useCallback(async (): Promise<void> => {
    if (!workspace) return
    const r = await novelOrThrow().newChatThread()
    if (!r.ok) {
      alert(`无法新建对话：${r.error}`)
      return
    }
    const tab: ChatTab = {
      id: r.threadId,
      branchId: r.branchId,
      threadId: r.threadId,
      title: '新对话（未发送）',
      titlePending: true,
      ephemeral: true
    }
    const cur = ephemeralDraftTabsRef.current.get(r.branchId) ?? []
    ephemeralDraftTabsRef.current.set(r.branchId, [...cur, tab])
    await loadChatTabsForBranch(r.branchId, r.threadId)
  }, [workspace, loadChatTabsForBranch])

  const reopenClosedChatThread = useCallback(
    async (threadId: string): Promise<void> => {
      if (!workspace) return
      const r = await novelOrThrow().setChatThreadClosed(
        workspace.currentBranchId,
        threadId,
        false
      )
      if (!r.ok) {
        alert('无法重新打开该对话')
        return
      }
      await loadChatTabsForBranch(workspace.currentBranchId, threadId)
    },
    [workspace, loadChatTabsForBranch]
  )

  const selectChatTab = useCallback(
    (tab: ChatTab): void => {
      if (tab.id === activeChatTabIdRef.current) return
      setActiveChatTabId(tab.id)
      void refreshMessagesForTab(tab.branchId, tab.threadId, tab.id)
    },
    [refreshMessagesForTab]
  )

  const closeChatTab = useCallback(
    async (threadId: string, e?: React.MouseEvent): Promise<void> => {
      e?.stopPropagation()
      const prev = chatTabsRef.current
      const closing = prev.find((t) => t.threadId === threadId)
      if (!closing) return
      if (closing.ephemeral) {
        const cur = ephemeralDraftTabsRef.current.get(closing.branchId) ?? []
        ephemeralDraftTabsRef.current.set(
          closing.branchId,
          cur.filter((t) => t.threadId !== threadId)
        )
        const idx = prev.findIndex((t) => t.threadId === threadId)
        const wasActive = activeChatTabIdRef.current === threadId
        const neighbour =
          prev[idx + 1]?.threadId ?? prev[idx - 1]?.threadId ?? null
        const pref = wasActive ? neighbour : activeChatTabIdRef.current
        await loadChatTabsForBranch(closing.branchId, pref)
        return
      }
      const nonEphemeral = prev.filter((t) => !t.ephemeral)
      if (nonEphemeral.length <= 1) return
      const r = await novelOrThrow().setChatThreadClosed(
        closing.branchId,
        threadId,
        true
      )
      if (!r.ok) {
        alert('至少需要保留一个打开的对话标签')
        return
      }
      const idx = prev.findIndex((t) => t.threadId === threadId)
      const wasActive = activeChatTabIdRef.current === threadId
      const neighbour =
        prev[idx + 1]?.threadId ?? prev[idx - 1]?.threadId ?? null
      const pref = wasActive ? neighbour : activeChatTabIdRef.current
      await loadChatTabsForBranch(closing.branchId, pref)
    },
    [loadChatTabsForBranch]
  )

  const stopChatGeneration = useCallback(async (): Promise<void> => {
    await novelOrThrow().cancelChat()
  }, [])

  const sendChat = async (): Promise<void> => {
    const text = input.trim()
    if (!text || chatBusy) return
    const w = await novelOrThrow().getWorkspace()
    if (w?.pendingForkBeforeNextCommit) {
      const tabs = chatTabsRef.current
      const aid = activeChatTabIdRef.current
      const tab = tabs.find((x) => x.id === aid) ?? tabs[0]
      pendingChatPayloadRef.current = {
        text,
        filePath: activeFile,
        chatThreadId: tab?.threadId ?? DEFAULT_CHAT_THREAD_ID
      }
      setChatForkModal({
        open: true,
        defaultName: `branch-${Date.now()}`
      })
      setInput('')
      return
    }
    setInput('')
    setLiveEntries([])
    setGenPhase('model')
    setChatBusy(true)
    /* Show user line immediately; DB sync happens in main — list was only refreshed on CHAT_DONE before. */
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, seq: -Date.now() }
    ])
    const tabs = chatTabsRef.current
    const aid = activeChatTabIdRef.current
    const tab = tabs.find((x) => x.id === aid) ?? tabs[0]
    if (
      tab &&
      (tab.titlePending === true ||
        tab.title === '新对话' ||
        tab.title === '新对话（未发送）')
    ) {
      const nt = suggestChatTabTitleFromUserText(text)
      setChatTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id
            ? { ...t, title: nt, titlePending: false, ephemeral: false }
            : t
        )
      )
      if (!tab.ephemeral) {
        void novelOrThrow().updateChatThreadTitle(
          tab.branchId,
          tab.threadId,
          nt
        )
      }
    }
    try {
      await novelOrThrow().sendChat({
        text,
        filePath: activeFile,
        chatBranchId: tab?.branchId,
        chatThreadId: tab?.threadId ?? DEFAULT_CHAT_THREAD_ID
      })
    } catch (err) {
      setLiveEntries([])
      setGenPhase('idle')
      setChatBusy(false)
      console.error('[novel sendChat]', err)
    }
  }

  /**
   * 人类提交：在对话框中确认说明后，先将当前文件的未落盘编辑写入磁盘，再创建检查点。
   */
  const requestCommitWorkspaceSnapshot = (): void => {
    if (!workspace) return
    openCommitSnapshotModal()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 's') return
      if (!activeFile || !workspace) return
      e.preventDefault()
      void saveFile()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeFile, workspace, saveFile])

  useEffect(() => {
    if (!activeFile) return
    const vs = pendingViewRestoreRef.current
    if (!vs) return
    const ed = monacoEditorRef.current
    if (!ed) return
    pendingViewRestoreRef.current = null
    applyEditorView(ed, vs)
  }, [activeFile, content])

  const saveSettingsForm = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const next = await novelOrThrow().setSettings({
      openAiBaseUrl: String(fd.get('openAiBaseUrl') ?? ''),
      openAiApiKey: String(fd.get('openAiApiKey') ?? ''),
      chatModel: String(fd.get('chatModel') ?? ''),
      embeddingModel: String(fd.get('embeddingModel') ?? ''),
      memoryRecentMessages: Number(fd.get('memoryRecentMessages') ?? 24),
      memorySummaryEveryN: Number(fd.get('memorySummaryEveryN') ?? 16),
      memoryRetrieveTopK: Number(fd.get('memoryRetrieveTopK') ?? 6),
      memoryEnabled: fd.get('memoryEnabled') === 'on'
    })
    setSettings(next)
    setSettingsOpen(false)
  }

  const branchName = (id: string): string =>
    graph?.branches.find((b: BranchRecord) => b.id === id)?.name ??
    id.slice(0, 8)

  const activeChatTab =
    chatTabs.find((t) => t.id === activeChatTabId) ?? chatTabs[0]
  const displayChatBranchId =
    activeChatTab?.branchId ?? workspace?.currentBranchId ?? null

  if (electronError) {
    return (
      <div
        style={{
          padding: 24,
          maxWidth: 560,
          margin: '10vh auto',
          lineHeight: 1.6,
          color: '#e6e9ef'
        }}
      >
        <h1 style={{ fontSize: 18 }}>无法连接主进程 API</h1>
        <p>{electronError}</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="app-shell">
      <header className="app-toolbar">
        <button type="button" onClick={() => void openWorkspace()}>
          打开工作区
        </button>
        {workspace ? (
          <>
            <span className="toolbar-sep" aria-hidden />
            <button
              type="button"
              title="在工作区根目录新建文件（侧栏「文件」下也可使用）"
              onClick={() => startNewFileInDir('')}
            >
              ＋ 新建文件
            </button>
            <button
              type="button"
              title="在工作区根目录新建文件夹"
              onClick={() => startNewFolderInDir('')}
            >
              ＋ 新建文件夹
            </button>
          </>
        ) : null}
        <button
          type="button"
          title="将编辑器内容写入磁盘（Ctrl+S / ⌘S）"
          onClick={() => void saveFile()}
          disabled={!activeFile}
        >
          保存到磁盘
        </button>
        <button
          type="button"
          onClick={() => requestToolbarCheckpoint()}
          disabled={!workspace}
        >
          检查点
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        <button
          type="button"
          title="在当前版本分支上新建一条独立对话线程（不增加 DAG 分支）。若查看的历史节点之后仍有版本，首次发送或检查点前仍须「发送前新建分支」；新建空标签不受此限制。首轮发送后根据首句自动生成标签标题。"
          disabled={!workspace}
          onClick={() => void newChatTab()}
        >
          新对话
        </button>
        <span className="status">
          {workspace
            ? `${workspace.path} · 当前对话分支 ${branchName(
                displayChatBranchId ?? workspace.currentBranchId
              )}${
                workspace.workspaceBranchId &&
                workspace.workspaceBranchId !== workspace.currentBranchId
                  ? ` · 磁盘 ${branchName(workspace.workspaceBranchId)}`
                  : ''
              }`
            : '未打开工作区'}
          {workspace?.pendingForkBeforeNextCommit
            ? ' · 该节点后有版本：发送或提交前须新建分支'
            : ''}
          {status ? ` · ${status}` : ''}
          {editorUnsavedToDisk ? ' · 编辑器未写入磁盘' : ''}
        </span>
      </header>

      <aside className="sidebar">
        <h3>文件</h3>
        <div className="file-tree-toolbar">
          <button
            type="button"
            disabled={!workspace}
            title="在工作区根目录新建文件"
            onClick={() => startNewFileInDir('')}
          >
            新建文件
          </button>
          <button
            type="button"
            disabled={!workspace}
            title="在工作区根目录新建文件夹"
            onClick={() => startNewFolderInDir('')}
          >
            新建文件夹
          </button>
        </div>
        {fileTreeBanner ? (
          <p className="sidebar-banner">{fileTreeBanner}</p>
        ) : null}
        {files.length === 0 ? (
          <p className="sidebar-empty">
            {workspace ? '（无文件，可用上方按钮新建）' : '（未打开工作区）'}
          </p>
        ) : (
          <FileTreeBranch
            root={fileTree}
            expanded={expandedDirs}
            toggleDir={toggleDir}
            activeFile={activeFile}
            onOpenFile={(p) => void openFile(p)}
            onContextMenu={(e, target) => {
              setFileTreeCtx({
                x: e.clientX,
                y: e.clientY,
                target
              })
            }}
          />
        )}
        {fileTreeCtx
          ? createPortal(
              <div
                className="file-tree-ctx-root"
                role="menu"
                style={{
                  position: 'fixed',
                  left: Math.max(
                    4,
                    Math.min(
                      fileTreeCtx.x,
                      (typeof window !== 'undefined' ? window.innerWidth : 400) -
                        200
                    )
                  ),
                  top: Math.max(
                    4,
                    Math.min(
                      fileTreeCtx.y,
                      (typeof window !== 'undefined' ? window.innerHeight : 400) -
                        180
                    )
                  ),
                  zIndex: 200000
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {fileTreeCtx.target.kind === 'dir' ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      startNewFileInDir(fileTreeCtx.target.rel)
                    }}
                  >
                    在此处新建文件
                  </button>
                ) : null}
                {fileTreeCtx.target.kind === 'dir' ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      startNewFolderInDir(fileTreeCtx.target.rel)
                    }}
                  >
                    在此处新建文件夹
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const t = fileTreeCtx.target
                    startRenameTarget(
                      t.kind === 'file' ? t.path : t.rel,
                      t.kind === 'dir'
                    )
                  }}
                >
                  重命名
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    const t = fileTreeCtx.target
                    openDeleteConfirm(
                      t.kind === 'file' ? t.path : t.rel,
                      t.kind === 'dir'
                    )
                  }}
                >
                  删除…
                </button>
              </div>,
              document.body
            )
          : null}
        <h3>分支</h3>
        <ul>
          {graph?.branches.map((b: BranchRecord) => (
            <li
              key={b.id}
              className={b.id === workspace?.currentBranchId ? 'active' : ''}
              onClick={() => void switchBranch(b.id)}
            >
              {b.name}
            </li>
          ))}
        </ul>
        <h3>版本图</h3>
        {graph && workspace ? (
          <VersionGraphPanel
            graph={graph}
            currentNodeId={workspace.currentNodeId}
            branchName={branchName}
            onJump={(id) => void restoreNode(id)}
            onDelete={(id) => void deleteVersionNodeFromGraph(id)}
          />
        ) : (
          <p className="sidebar-empty">（无数据）</p>
        )}
      </aside>

      <main className="editor-area">
        <div className="path-bar">{activeFile ?? '未选择文件'}</div>
        <div className="monaco-wrap">
          <Editor
            height="100%"
            theme="vs-dark"
            path={activeFile ?? 'untitled'}
            defaultLanguage="markdown"
            value={content}
            onChange={(v) => setContent(v ?? '')}
            onMount={(ed) => {
              monacoEditorRef.current = ed
              const vs = pendingViewRestoreRef.current
              if (vs) {
                pendingViewRestoreRef.current = null
                applyEditorView(ed, vs)
              }
            }}
            options={{
              minimap: { enabled: false },
              wordWrap: 'on',
              fontSize: 14
            }}
          />
        </div>
      </main>

      <section className="chat-panel">
        <h3>AI 对话</h3>
        {workspace && chatTabs.length > 0 ? (
          <div className="chat-tabs" role="tablist" aria-label="对话标签">
            {chatTabs.map((tab) => (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeChatTabId}
                className={`chat-tab ${
                  tab.id === activeChatTabId ? 'active' : ''
                }`}
                onClick={() => selectChatTab(tab)}
                title={tab.title}
              >
                <span className="chat-tab-title">{tab.title}</span>
                <button
                  type="button"
                  className="chat-tab-close"
                  title="关闭此对话（可从下方「已关闭」再次打开）"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(e) => void closeChatTab(tab.threadId, e)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {workspace && closedChatThreads.length > 0 ? (
          <div className="chat-closed-picker">
            <span className="chat-closed-label">已关闭</span>
            <select
              aria-label="打开已关闭的对话"
              defaultValue=""
              onChange={(ev) => {
                const v = ev.target.value
                if (v) void reopenClosedChatThread(v)
                ev.target.selectedIndex = 0
              }}
            >
              <option value="">打开已关闭对话…</option>
              {closedChatThreads.map((c) => (
                <option key={c.threadId} value={c.threadId}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {chatBusy ? (
          <div className="chat-generating-bar" role="status">
            <span className="chat-generating-dot" aria-hidden />
            {genPhase === 'tools' ? '正在执行工具…' : '模型生成中…'}
            <button
              type="button"
              className="chat-stop-btn"
              title="停止后续输出；已落盘的工具写入保留，且不会创建本轮 AI 快照"
              onClick={() => void stopChatGeneration()}
            >
              停止生成
            </button>
          </div>
        ) : null}
        <div className="chat-messages">
          {messages.map((m) => (
            <div
              key={`${m.seq}-${m.role}`}
              className={`msg ${m.role === 'user' ? 'user' : 'assistant'}`}
            >
              <div className="role">{m.role}</div>
              {m.role === 'assistant' && m.blocks?.length
                ? renderTurnBlocks(m.blocks)
                : m.content}
            </div>
          ))}
          {chatBusy && liveEntries.length > 0 ? (
            <div className="msg assistant">
              <div className="role">assistant（进行中）</div>
              <div className="msg-blocks">
                {liveEntries.map((e, i) => renderLiveEntry(e, i))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="chat-input-row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入消息…（会将当前打开文件作为上下文）"
            disabled={chatBusy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void sendChat()
              }
            }}
          />
          <button
            type="button"
            disabled={chatBusy}
            onClick={() => void sendChat()}
          >
            发送
          </button>
        </div>
        <div className="chat-panel-footer">
          <button
            type="button"
            disabled={!workspace}
            title="在对话框中填写说明；若有未保存到磁盘的编辑会先落盘，再创建版本节点"
            onClick={() => requestCommitWorkspaceSnapshot()}
          >
            保存并提交快照
          </button>
          {workspace?.historyViewActive ? (
            <p className="chat-history-hint">
              对话列表已对齐到跳转节点的截取位置。{' '}
              <button type="button" onClick={() => void clearHistoryView()}>
                显示本分支全部消息
              </button>
            </p>
          ) : null}
        </div>
      </section>

      {dirtyConfirmModal.open ? (
        <div
          className="modal-backdrop modal-backdrop-priority"
          role="presentation"
          onClick={() => cancelDirtyConfirm()}
        >
          <div
            className="modal"
            role="alertdialog"
            aria-labelledby="dirty-confirm-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelDirtyConfirm()
            }}
          >
            <h2 id="dirty-confirm-title">工作区与快照不一致</h2>
            <p className="modal-hint">{dirtyConfirmModal.message}</p>
            <div className="actions">
              <button type="button" onClick={() => cancelDirtyConfirm()}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void runDirtyConfirm()}
              >
                继续
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen && settings ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="modal"
            role="dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>API 与记忆</h2>
            <form onSubmit={(e) => void saveSettingsForm(e)}>
              <label>OpenAI 兼容 Base URL</label>
              <input
                name="openAiBaseUrl"
                defaultValue={settings.openAiBaseUrl}
              />
              <label>API Key</label>
              <input
                name="openAiApiKey"
                type="password"
                autoComplete="off"
                defaultValue={settings.openAiApiKey}
              />
              <label>对话模型</label>
              <input name="chatModel" defaultValue={settings.chatModel} />
              <label>Embedding 模型</label>
              <input
                name="embeddingModel"
                defaultValue={settings.embeddingModel}
              />
              <label>近期完整消息条数（送入模型）</label>
              <input
                name="memoryRecentMessages"
                type="number"
                defaultValue={settings.memoryRecentMessages}
              />
              <label>每 N 条消息触发滚动摘要</label>
              <input
                name="memorySummaryEveryN"
                type="number"
                defaultValue={settings.memorySummaryEveryN}
              />
              <label>向量检索 Top-K</label>
              <input
                name="memoryRetrieveTopK"
                type="number"
                defaultValue={settings.memoryRetrieveTopK}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  name="memoryEnabled"
                  defaultChecked={settings.memoryEnabled}
                />
                启用长期记忆（摘要 + 向量）
              </label>
              <div className="actions">
                <button type="button" onClick={() => setSettingsOpen(false)}>
                  取消
                </button>
                <button type="submit" className="primary">
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {checkpointModal.open ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => closeCheckpointModal()}
        >
          <div
            className="modal"
            role="dialog"
            aria-labelledby="checkpoint-modal-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeCheckpointModal()
            }}
          >
            <h2 id="checkpoint-modal-title">创建检查点</h2>
            {checkpointModal.saveEditorFirst ? (
              <p className="modal-hint">
                若有未写入磁盘的当前文件编辑，将在创建节点前先保存到磁盘。
              </p>
            ) : null}
            {workspace?.pendingForkBeforeNextCommit ? (
              <>
                <label htmlFor="checkpoint-branch-input">
                  新分支名称（该节点之后仍有版本时必填；对话仅继承到该节点）
                </label>
                <input
                  id="checkpoint-branch-input"
                  value={checkpointBranchInput}
                  onChange={(e) => setCheckpointBranchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void confirmCheckpointModal()
                    }
                  }}
                />
              </>
            ) : null}
            <label htmlFor="checkpoint-label-input">说明（可选，留空则使用默认名称）</label>
            <input
              id="checkpoint-label-input"
              value={checkpointLabelInput}
              onChange={(e) => setCheckpointLabelInput(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void confirmCheckpointModal()
                }
              }}
            />
            <div className="actions">
              <button type="button" onClick={() => closeCheckpointModal()}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void confirmCheckpointModal()}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {chatForkModal.open ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => closeChatForkModal()}
        >
          <div
            className="modal"
            role="dialog"
            aria-labelledby="chat-fork-modal-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeChatForkModal()
            }}
          >
            <h2 id="chat-fork-modal-title">发送前新建分支</h2>
            <p className="modal-hint">
              当前跳转到的节点之后仍有版本记录。请先命名新分支，对话历史将只继承到该节点为止，再发送本条消息。
            </p>
            <label htmlFor="chat-fork-branch-input">分支名称</label>
            <input
              key={chatForkModal.defaultName}
              ref={chatForkInputRef}
              id="chat-fork-branch-input"
              defaultValue={chatForkModal.defaultName}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void runForkThenSendChat()
                }
              }}
            />
            <div className="actions">
              <button type="button" onClick={() => closeChatForkModal()}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void runForkThenSendChat()}
              >
                创建并发送
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {fileNameModal.open ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => closeFileNameModal()}
        >
          <div
            className="modal"
            role="dialog"
            aria-labelledby="file-name-modal-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeFileNameModal()
            }}
          >
            <h2 id="file-name-modal-title">{fileNameModal.title}</h2>
            <label htmlFor="file-name-modal-input">名称</label>
            <input
              key={fileNameModal.inputKey}
              ref={fileNameInputRef}
              id="file-name-modal-input"
              defaultValue={fileNameModal.initialValue}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void confirmFileNameModal()
                }
              }}
            />
            <div className="actions">
              <button type="button" onClick={() => closeFileNameModal()}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void confirmFileNameModal()}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {fileDeleteConfirm ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => cancelDeleteConfirm()}
        >
          <div
            className="modal"
            role="dialog"
            aria-labelledby="file-delete-modal-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelDeleteConfirm()
            }}
          >
            <h2 id="file-delete-modal-title">确认删除</h2>
            <p className="modal-hint">
              确定删除「{fileDeleteConfirm.path}」
              {fileDeleteConfirm.isDir ? '（含其下全部内容）' : ''}？此操作不可撤销。
            </p>
            <div className="actions">
              <button type="button" onClick={() => cancelDeleteConfirm()}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void runDeleteConfirmed()}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  )
}
