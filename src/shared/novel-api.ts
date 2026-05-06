import type { WorkspaceInfo, VersionGraph, VersionStatus, AppSettings } from './ipc'
import type { ChatStreamEvent, ChatTurnBlock } from './chat-stream'
import type { SessionRendererPayload, SessionRestoreResult } from './session'

export type ChatMessageRow = {
  role: string
  content: string
  seq: number
  blocks?: ChatTurnBlock[] | null
}

export type ChatThreadTabInfo = {
  threadId: string
  title: string
}

export type ChatTabState = {
  branchId: string
  open: ChatThreadTabInfo[]
  closed: ChatThreadTabInfo[]
}

export type NovelApi = {
  selectWorkspace: () => Promise<WorkspaceInfo | null>
  getWorkspace: () => Promise<WorkspaceInfo | null>
  setBranch: (branchId: string) => Promise<string>
  readFile: (relPath: string) => Promise<string>
  writeFile: (relPath: string, content: string) => Promise<boolean>
  listTree: () => Promise<string[]>
  createWorkspaceFile: (
    relPath: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  createWorkspaceFolder: (
    relPath: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  deleteWorkspacePath: (
    relPath: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  renameWorkspacePath: (
    fromRel: string,
    toRel: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  versionGraph: () => Promise<VersionGraph>
  checkpoint: (
    label: string,
    chatBranchId?: string | null
  ) => Promise<{ nodeId: string }>
  checkpointWithNewBranch: (payload: {
    newBranchName: string
    label: string
  }) => Promise<{ nodeId: string }>
  forkAfterJump: (newBranchName: string) => Promise<{ branchId: string }>
  deleteVersionNode: (nodeId: string) => Promise<{ deletedIds: string[] }>
  forkBranch: (
    fromNodeId: string,
    name: string
  ) => Promise<{ branchId: string }>
  restoreNode: (
    nodeId: string
  ) => Promise<{ conversationCutSeq: number; branchId: string }>
  clearHistoryView: () => Promise<boolean>
  versionStatus: () => Promise<VersionStatus>
  getMessages: (
    chatBranchId?: string | null,
    chatThreadId?: string | null
  ) => Promise<ChatMessageRow[]>
  getSettings: () => Promise<AppSettings>
  setSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  sendChat: (payload: {
    text: string
    filePath: string | null
    chatBranchId?: string | null
    chatThreadId?: string | null
  }) => Promise<void>
  cancelChat: () => Promise<void>
  newChatThread: () => Promise<
    | { ok: true; branchId: string; threadId: string }
    | { ok: false; error: string }
  >
  getChatTabState: (chatBranchId?: string | null) => Promise<ChatTabState>
  setChatThreadClosed: (
    branchId: string,
    threadId: string,
    closed: boolean
  ) => Promise<{ ok: true } | { ok: false; error: 'last_open' }>
  updateChatThreadTitle: (
    branchId: string,
    threadId: string,
    title: string
  ) => Promise<{ ok: true }>
  onChatChunk: (cb: (chunk: string) => void) => () => void
  onChatStreamEvent: (cb: (ev: ChatStreamEvent) => void) => () => void
  onChatDone: (cb: (full: string) => void) => () => void
  onChatError: (cb: (msg: string) => void) => () => void
  onWorkspaceRestored: (cb: () => void) => () => void
  /** 工作区文件树在磁盘上发生变化（应用内或外部）。 */
  onWorkspaceTreeChanged: (cb: () => void) => () => void
  /**
   * 注册由主进程在 AI 执行 patch 前通过 invoke 触发的回调：将当前打开文件的编辑器缓冲写入磁盘。
   * 传 null 可清除。
   */
  setEditorFlushHandler: (fn: (() => Promise<void>) | null) => void
  restoreLastSession: () => Promise<SessionRestoreResult>
  saveSessionSnapshot: (payload: SessionRendererPayload) => Promise<void>
}
