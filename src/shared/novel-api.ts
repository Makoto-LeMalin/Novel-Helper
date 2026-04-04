import type { WorkspaceInfo, VersionGraph, VersionStatus, AppSettings } from './ipc'
import type { ChatStreamEvent, ChatTurnBlock } from './chat-stream'

export type ChatMessageRow = {
  role: string
  content: string
  seq: number
  blocks?: ChatTurnBlock[] | null
}

export type NovelApi = {
  selectWorkspace: () => Promise<WorkspaceInfo | null>
  getWorkspace: () => Promise<WorkspaceInfo | null>
  setBranch: (branchId: string) => Promise<string>
  readFile: (relPath: string) => Promise<string>
  writeFile: (relPath: string, content: string) => Promise<boolean>
  listTree: () => Promise<string[]>
  versionGraph: () => Promise<VersionGraph>
  checkpoint: (label: string) => Promise<{ nodeId: string }>
  forkBranch: (
    fromNodeId: string,
    name: string
  ) => Promise<{ branchId: string }>
  restoreNode: (
    nodeId: string
  ) => Promise<{ conversationCutSeq: number; branchId: string }>
  clearHistoryView: () => Promise<boolean>
  versionStatus: () => Promise<VersionStatus>
  getMessages: () => Promise<ChatMessageRow[]>
  getSettings: () => Promise<AppSettings>
  setSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  sendChat: (payload: {
    text: string
    filePath: string | null
  }) => Promise<void>
  onChatChunk: (cb: (chunk: string) => void) => () => void
  onChatStreamEvent: (cb: (ev: ChatStreamEvent) => void) => () => void
  onChatDone: (cb: (full: string) => void) => () => void
  onChatError: (cb: (msg: string) => void) => () => void
  /**
   * 注册由主进程在 AI 执行 patch 前通过 invoke 触发的回调：将当前打开文件的编辑器缓冲写入磁盘。
   * 传 null 可清除。
   */
  setEditorFlushHandler: (fn: (() => Promise<void>) | null) => void
}
