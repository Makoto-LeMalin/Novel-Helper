/** IPC contract: preload exposes `novel` API; channel names for streaming only. */

export type WorkspaceInfo = {
  path: string
  /** Conversation branch for this window (messages / sendChat). */
  currentBranchId: string
  currentNodeId: string
  /** Branch whose tip matches files on disk after last setBranch/restore. */
  workspaceBranchId: string
  pendingForkBeforeNextCommit: boolean
  /** True when conversation list is capped to a restored node's cut. */
  historyViewActive: boolean
}

export type BranchRecord = {
  id: string
  name: string
  tipNodeId: string
}

export type NodeRecord = {
  id: string
  parentId: string | null
  branchId: string
  createdAt: number
  label: string
  conversationCutSeq: number
}

export type GraphEdge = { from: string; to: string }

export type VersionGraph = {
  nodes: NodeRecord[]
  branches: BranchRecord[]
  edges: GraphEdge[]
}

export type VersionStatus = {
  dirty: boolean
  currentBranchId: string
  tipNodeId: string
}

export type AppSettings = {
  openAiBaseUrl: string
  openAiApiKey: string
  chatModel: string
  embeddingModel: string
  memoryRecentMessages: number
  memorySummaryEveryN: number
  memoryRetrieveTopK: number
  memoryEnabled: boolean
}

export const defaultSettings: AppSettings = {
  openAiBaseUrl: 'https://api.openai.com/v1',
  openAiApiKey: '',
  chatModel: 'gpt-4o-mini',
  embeddingModel: 'text-embedding-3-small',
  memoryRecentMessages: 24,
  memorySummaryEveryN: 16,
  memoryRetrieveTopK: 6,
  memoryEnabled: true
}

export const CHAT_CHUNK_CHANNEL = 'novel:chat-chunk'
export const CHAT_DONE_CHANNEL = 'novel:chat-done'
export const CHAT_ERROR_CHANNEL = 'novel:chat-error'

/** 主进程 → 渲染：请在落盘完成后用 novel:flush-editor-done 回传同一 requestId。 */
export const FLUSH_EDITOR_REQUEST_CHANNEL = 'novel:flush-editor-request'
/** 渲染进程 → 主进程：参数为 requestId（与 request 一致）。 */
export const FLUSH_EDITOR_DONE_CHANNEL = 'novel:flush-editor-done'

/** Main → all renderers: on-disk workspace was restored; reload open files if needed. */
export const WORKSPACE_RESTORED_CHANNEL = 'novel:workspace-restored'
