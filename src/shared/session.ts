import type { WorkspaceInfo } from './ipc'

export const SESSION_SNAPSHOT_VERSION = 1 as const

/** 单文件在内存中的编辑与阅读位置（用于切换标签与冷启动恢复）。 */
export type FileBufferEntry = {
  content: string
  editorDiskBaseline: string
  scrollTop: number
  scrollLeft: number
  line: number
  column: number
}

export type EditorViewState = {
  scrollTop: number
  scrollLeft: number
  line: number
  column: number
}

/** 写入 userData 的完整会话快照（含未落盘编辑）。 */
export type SessionSnapshotV1 = {
  v: typeof SESSION_SNAPSHOT_VERSION
  workspacePath: string
  currentBranchId: string
  currentNodeId: string
  conversationViewMaxSeq: number | null
  restoredBaseNodeId: string | null
  /** 跳转后待下一次提交时强制新建分支。 */
  pendingForkBeforeNextCommit?: boolean
  historyBanner: boolean
  activeFile: string | null
  editorContent: string
  editorDiskBaseline: string
  /** 各相对路径的缓冲；含切换走但未保存的文件。 */
  fileBuffers?: Record<string, FileBufferEntry>
  /** 旧版仅保存当前文件视口时的兼容字段。 */
  editorView?: EditorViewState | null
}

export type SessionRendererPayload = {
  activeFile: string | null
  editorContent: string
  editorDiskBaseline: string
  historyBanner: boolean
  fileBuffers: Record<string, FileBufferEntry>
}

export type SessionRestoreResult =
  | {
      ok: true
      workspace: WorkspaceInfo
      /** @deprecated 保留旧会话文件兼容；UI 不再使用横幅。 */
      historyBanner: boolean
      activeFile: string | null
      editorContent: string
      editorDiskBaseline: string
      fileBuffers?: Record<string, FileBufferEntry>
      editorView?: EditorViewState | null
    }
  | { ok: false; reason?: string }

function isEditorViewState(x: unknown): x is EditorViewState {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.scrollTop === 'number' &&
    typeof o.scrollLeft === 'number' &&
    typeof o.line === 'number' &&
    typeof o.column === 'number'
  )
}

export function normalizeFileBufferEntry(x: unknown): FileBufferEntry | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o.content !== 'string') return null
  if (typeof o.editorDiskBaseline !== 'string') return null
  return {
    content: o.content,
    editorDiskBaseline: o.editorDiskBaseline,
    scrollTop: typeof o.scrollTop === 'number' ? o.scrollTop : 0,
    scrollLeft: typeof o.scrollLeft === 'number' ? o.scrollLeft : 0,
    line: typeof o.line === 'number' && o.line >= 1 ? o.line : 1,
    column: typeof o.column === 'number' && o.column >= 1 ? o.column : 1
  }
}

export function isSessionSnapshotV1(x: unknown): x is SessionSnapshotV1 {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (o.v !== SESSION_SNAPSHOT_VERSION) return false
  if (typeof o.workspacePath !== 'string' || !o.workspacePath) return false
  if (typeof o.currentBranchId !== 'string') return false
  if (typeof o.currentNodeId !== 'string') return false
  if (
    o.conversationViewMaxSeq != null &&
    typeof o.conversationViewMaxSeq !== 'number'
  )
    return false
  if (
    o.restoredBaseNodeId != null &&
    typeof o.restoredBaseNodeId !== 'string'
  )
    return false
  if (
    o.pendingForkBeforeNextCommit != null &&
    typeof o.pendingForkBeforeNextCommit !== 'boolean'
  )
    return false
  if (typeof o.historyBanner !== 'boolean') return false
  if (o.activeFile != null && typeof o.activeFile !== 'string') return false
  if (typeof o.editorContent !== 'string') return false
  if (typeof o.editorDiskBaseline !== 'string') return false
  if (o.editorView != null && !isEditorViewState(o.editorView)) return false
  if (o.fileBuffers != null) {
    if (typeof o.fileBuffers !== 'object' || Array.isArray(o.fileBuffers))
      return false
    for (const v of Object.values(o.fileBuffers)) {
      if (normalizeFileBufferEntry(v) == null) return false
    }
  }
  return true
}
