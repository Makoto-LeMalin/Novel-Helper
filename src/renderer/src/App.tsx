import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import Editor from '@monaco-editor/react'
import type {
  VersionGraph,
  AppSettings,
  BranchRecord,
  NodeRecord
} from '../../shared/ipc'
import type { ChatStreamEvent, ChatTurnBlock } from '../../shared/chat-stream'
import type { ChatMessageRow, NovelApi } from '../../shared/novel-api'

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
  onOpenFile
}: {
  root: FsDir
  expanded: Set<string>
  toggleDir: (rel: string) => void
  activeFile: string | null
  onOpenFile: (p: string) => void
}): React.ReactElement {
  const listClass = root.rel ? 'file-tree-nested file-tree' : 'file-tree'
  return (
    <ul className={listClass}>
      {root.children.map((c) =>
        c.kind === 'file' ? (
          <li key={c.path} className="file-tree-item">
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
          <li key={c.rel} className="file-tree-item">
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

function fileTreeExpandedStorageKey(wsPath: string): string {
  return `novel-filetree-expanded:${wsPath}`
}

export default function App(): React.ReactElement {
  const [workspace, setWorkspace] = useState<{
    path: string
    currentBranchId: string
    currentNodeId: string
  } | null>(null)
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
  const [input, setInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [genPhase, setGenPhase] = useState<'idle' | 'model' | 'tools'>('idle')
  const [liveEntries, setLiveEntries] = useState<LiveEntry[]>([])
  const [status, setStatus] = useState('')
  const [historyBanner, setHistoryBanner] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [forkName, setForkName] = useState('')
  const [forkNodeId, setForkNodeId] = useState<string | null>(null)
  /** Electron 下 window.prompt 不可用（恒为 null），检查点说明改用应用内对话框。 */
  const [checkpointModal, setCheckpointModal] = useState<
    { open: false } | { open: true; saveEditorFirst: boolean }
  >({ open: false })
  const [checkpointLabelInput, setCheckpointLabelInput] = useState('')
  const activeFileRef = useRef<string | null>(null)
  /** AI patch 前主进程 invoke 落盘时读取最新编辑器状态（避免闭包陈旧）。 */
  const editorFlushRef = useRef({
    activeFile: null as string | null,
    content: '',
    editorDiskBaseline: ''
  })
  /** 工作区切换后跳过下一次 expanded 持久化，避免把旧工作区的展开状态写入新 key。 */
  const skipFileTreePersistRef = useRef(false)
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

  const editorUnsavedToDisk =
    activeFile != null && content !== editorDiskBaseline

  const refreshGraph = useCallback(async () => {
    if (!window.novel) return
    const g = await novelOrThrow().versionGraph()
    setGraph(g)
  }, [])

  const refreshMessages = useCallback(async () => {
    if (!window.novel) return
    const m = await novelOrThrow().getMessages()
    setMessages(m)
  }, [])

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
    editorFlushRef.current = { activeFile, content, editorDiskBaseline }
  }, [activeFile, content, editorDiskBaseline])

  useEffect(() => {
    if (!window.novel) return
    const api = novelOrThrow()
    api.setEditorFlushHandler(async () => {
      const { activeFile: af, content: c, editorDiskBaseline: b } =
        editorFlushRef.current
      if (!af || c === b) return
      await api.writeFile(af, c)
      setEditorDiskBaseline(c)
    })
    return () => {
      api.setEditorFlushHandler(null)
    }
  }, [])

  useEffect(() => {
    if (!window.novel) return
    const api = novelOrThrow()
    api.getWorkspace().then((w) => {
      if (w) {
        setWorkspace(w)
        refreshFiles()
        refreshGraph()
        refreshMessages()
        refreshStatus()
      }
    })
    api.getSettings().then(setSettings)
  }, [refreshFiles, refreshGraph, refreshMessages, refreshStatus])

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
      await refreshFiles()
      await refreshGraph()
      await refreshStatus()
      const w = await novelOrThrow().getWorkspace()
      if (w) setWorkspace(w)
      const af = activeFileRef.current
      if (af) {
        try {
          const t = await novelOrThrow().readFile(af)
          setContent(t)
          setEditorDiskBaseline(t)
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
    return () => {
      u1()
      u2()
      u3()
    }
  }, [
    refreshFiles,
    refreshGraph,
    refreshMessages,
    refreshStatus
  ])

  const openWorkspace = async (): Promise<void> => {
    const w = await novelOrThrow().selectWorkspace()
    if (!w) return
    setWorkspace(w)
    setFiles([])
    setActiveFile(null)
    setContent('')
    setEditorDiskBaseline('')
    await refreshFiles()
    await refreshGraph()
    await refreshMessages()
    await refreshStatus()
    setHistoryBanner(false)
  }

  const openFile = async (rel: string): Promise<void> => {
    const text = await novelOrThrow().readFile(rel)
    setActiveFile(rel)
    setContent(text)
    setEditorDiskBaseline(text)
    await refreshStatus()
  }

  const saveFile = useCallback(async (): Promise<void> => {
    if (!activeFile) return
    await novelOrThrow().writeFile(activeFile, content)
    setEditorDiskBaseline(content)
    await refreshStatus()
  }, [activeFile, content, refreshStatus])

  const openCheckpointModal = (saveEditorFirst: boolean): void => {
    setCheckpointLabelInput('')
    setCheckpointModal({ open: true, saveEditorFirst })
  }

  const closeCheckpointModal = (): void => {
    setCheckpointModal({ open: false })
  }

  const confirmCheckpointModal = async (): Promise<void> => {
    if (!checkpointModal.open) return
    const saveEditorFirst = checkpointModal.saveEditorFirst
    const label = checkpointLabelInput.trim()
    setCheckpointModal({ open: false })
    try {
      if (saveEditorFirst && activeFile && content !== editorDiskBaseline) {
        await novelOrThrow().writeFile(activeFile, content)
        setEditorDiskBaseline(content)
      }
      await novelOrThrow().checkpoint(label)
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
    openCheckpointModal(false)
  }

  const restoreNode = async (nodeId: string): Promise<void> => {
    const dirty = (await novelOrThrow().versionStatus()).dirty
    if (dirty) {
      const ok = window.confirm(
        '当前工作区与快照不一致，恢复将覆盖未快照的修改。继续？'
      )
      if (!ok) return
    }
    await novelOrThrow().restoreNode(nodeId)
    const w = await novelOrThrow().getWorkspace()
    if (w) setWorkspace(w)
    setHistoryBanner(true)
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
    }
    await refreshFiles()
    await refreshGraph()
    await refreshMessages()
    await refreshStatus()
  }

  const clearHistoryView = async (): Promise<void> => {
    await novelOrThrow().clearHistoryView()
    setHistoryBanner(false)
    await refreshMessages()
  }

  const switchBranch = async (branchId: string): Promise<void> => {
    await novelOrThrow().setBranch(branchId)
    const w = await novelOrThrow().getWorkspace()
    if (w) setWorkspace(w)
    setHistoryBanner(false)
    await novelOrThrow().clearHistoryView()
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
    await refreshMessages()
    await refreshGraph()
    await refreshStatus()
  }

  const sendChat = async (): Promise<void> => {
    const text = input.trim()
    if (!text || chatBusy) return
    setInput('')
    setLiveEntries([])
    setGenPhase('model')
    setChatBusy(true)
    /* Show user line immediately; DB sync happens in main — list was only refreshed on CHAT_DONE before. */
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text, seq: -Date.now() }
    ])
    try {
      await novelOrThrow().sendChat({
        text,
        filePath: activeFile
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
    openCheckpointModal(true)
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

  const confirmFork = async (): Promise<void> => {
    if (!forkNodeId || !forkName.trim()) return
    await novelOrThrow().forkBranch(forkNodeId, forkName.trim())
    setForkNodeId(null)
    setForkName('')
    const w = await novelOrThrow().getWorkspace()
    if (w) setWorkspace(w)
    await refreshGraph()
    await refreshMessages()
    await refreshStatus()
  }

  const branchName = (id: string): string =>
    graph?.branches.find((b: BranchRecord) => b.id === id)?.name ??
    id.slice(0, 8)

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
      {historyBanner ? (
        <div className="banner">
          正在按历史节点查看对话（已恢复该时刻文件）。{' '}
          <button type="button" onClick={() => void clearHistoryView()}>
            恢复显示当前分支全部消息
          </button>
        </div>
      ) : null}
      <div className="app-shell">
      <header className="app-toolbar">
        <button type="button" onClick={() => void openWorkspace()}>
          打开工作区
        </button>
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
        <span className="status">
          {workspace
            ? `${workspace.path} · 分支 ${branchName(workspace.currentBranchId)}`
            : '未打开工作区'}
          {status ? ` · ${status}` : ''}
          {editorUnsavedToDisk ? ' · 编辑器未写入磁盘' : ''}
        </span>
      </header>

      <aside className="sidebar">
        <h3>文件</h3>
        {files.length === 0 ? (
          <p className="sidebar-empty">（无文件）</p>
        ) : (
          <FileTreeBranch
            root={fileTree}
            expanded={expandedDirs}
            toggleDir={toggleDir}
            activeFile={activeFile}
            onOpenFile={(p) => void openFile(p)}
          />
        )}
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
        <h3>版本节点</h3>
        <div>
          {graph?.nodes
            .slice()
            .sort((a: NodeRecord, b: NodeRecord) => b.createdAt - a.createdAt)
            .map((n: NodeRecord) => (
              <div key={n.id} className="graph-node">
                <div>{n.label}</div>
                <div className="meta">
                  {branchName(n.branchId)} ·{' '}
                  {new Date(n.createdAt).toLocaleString()}
                </div>
                <div className="actions-row">
                  <button type="button" onClick={() => void restoreNode(n.id)}>
                    跳转（恢复文件+对话视图）
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setForkNodeId(n.id)
                      setForkName(`fork-${Date.now()}`)
                    }}
                  >
                    从此分叉
                  </button>
                </div>
              </div>
            ))}
        </div>
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
        {chatBusy ? (
          <div className="chat-generating-bar" role="status">
            <span className="chat-generating-dot" aria-hidden />
            {genPhase === 'tools' ? '正在执行工具…' : '模型生成中…'}
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
        </div>
      </section>

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

      {forkNodeId ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setForkNodeId(null)}
        >
          <div
            className="modal"
            role="dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>新分支名称</h2>
            <input
              value={forkName}
              onChange={(e) => setForkName(e.target.value)}
            />
            <div className="actions">
              <button type="button" onClick={() => setForkNodeId(null)}>
                取消
              </button>
              <button type="button" className="primary" onClick={() => void confirmFork()}>
                创建并切换
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </div>
  )
}
