import { contextBridge, ipcRenderer } from 'electron'
import type { NovelApi } from '../shared/novel-api'
import type {
  WorkspaceInfo,
  VersionGraph,
  VersionStatus,
  AppSettings
} from '../shared/ipc'
import {
  CHAT_STREAM_EVENT_CHANNEL,
  type ChatStreamEvent
} from '../shared/chat-stream'
import {
  CHAT_CHUNK_CHANNEL,
  CHAT_DONE_CHANNEL,
  CHAT_ERROR_CHANNEL,
  FLUSH_EDITOR_REQUEST_CHANNEL,
  FLUSH_EDITOR_DONE_CHANNEL,
  WORKSPACE_RESTORED_CHANNEL
} from '../shared/ipc'

let editorFlushHandler: (() => Promise<void>) | null = null

ipcRenderer.on(
  FLUSH_EDITOR_REQUEST_CHANNEL,
  async (_evt, requestId: unknown) => {
    const id = typeof requestId === 'string' ? requestId : ''
    try {
      if (editorFlushHandler) await editorFlushHandler()
    } catch (e) {
      console.error('[novel preload] editor flush failed', e)
    } finally {
      ipcRenderer.send(FLUSH_EDITOR_DONE_CHANNEL, id)
    }
  }
)

const novel: NovelApi = {
  selectWorkspace: (): Promise<WorkspaceInfo | null> =>
    ipcRenderer.invoke('novel:selectWorkspace'),
  getWorkspace: (): Promise<WorkspaceInfo | null> =>
    ipcRenderer.invoke('novel:getWorkspace'),
  setBranch: (branchId: string): Promise<string> =>
    ipcRenderer.invoke('novel:setBranch', branchId),
  readFile: (relPath: string): Promise<string> =>
    ipcRenderer.invoke('novel:readFile', relPath),
  writeFile: (relPath: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('novel:writeFile', relPath, content),
  listTree: (): Promise<string[]> => ipcRenderer.invoke('novel:listTree'),
  versionGraph: (): Promise<VersionGraph> =>
    ipcRenderer.invoke('novel:versionGraph'),
  checkpoint: (
    label: string,
    chatBranchId?: string | null
  ): Promise<{ nodeId: string }> =>
    ipcRenderer.invoke('novel:checkpoint', label, chatBranchId ?? null),
  checkpointWithNewBranch: (
    payload: { newBranchName: string; label: string }
  ): Promise<{ nodeId: string }> =>
    ipcRenderer.invoke('novel:checkpointWithNewBranch', payload),
  forkAfterJump: (newBranchName: string): Promise<{ branchId: string }> =>
    ipcRenderer.invoke('novel:forkAfterJump', newBranchName),
  deleteVersionNode: (nodeId: string): Promise<{ deletedIds: string[] }> =>
    ipcRenderer.invoke('novel:deleteVersionNode', nodeId),
  forkBranch: (
    fromNodeId: string,
    name: string
  ): Promise<{ branchId: string }> =>
    ipcRenderer.invoke('novel:forkBranch', fromNodeId, name),
  restoreNode: (
    nodeId: string
  ): Promise<{ conversationCutSeq: number; branchId: string }> =>
    ipcRenderer.invoke('novel:restoreNode', nodeId),
  clearHistoryView: (): Promise<boolean> =>
    ipcRenderer.invoke('novel:clearHistoryView'),
  versionStatus: (): Promise<VersionStatus> =>
    ipcRenderer.invoke('novel:versionStatus'),
  getMessages: (chatBranchId?: string | null, chatThreadId?: string | null) =>
    ipcRenderer.invoke(
      'novel:getMessages',
      chatBranchId ?? null,
      chatThreadId ?? null
    ),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('novel:getSettings'),
  setSettings: (partial: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('novel:setSettings', partial),
  sendChat: (payload: {
    text: string
    filePath: string | null
    chatBranchId?: string | null
    chatThreadId?: string | null
  }): Promise<void> => ipcRenderer.invoke('novel:sendChat', payload),
  cancelChat: (): Promise<void> => ipcRenderer.invoke('novel:cancelChat'),
  newChatThread: (): Promise<
    | { ok: true; branchId: string; threadId: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('novel:newChatThread'),
  getChatTabState: (chatBranchId?: string | null) =>
    ipcRenderer.invoke('novel:getChatTabState', chatBranchId ?? null),
  setChatThreadClosed: (
    branchId: string,
    threadId: string,
    closed: boolean
  ): Promise<{ ok: true } | { ok: false; error: 'last_open' }> =>
    ipcRenderer.invoke('novel:setChatThreadClosed', branchId, threadId, closed),
  updateChatThreadTitle: (
    branchId: string,
    threadId: string,
    title: string
  ): Promise<{ ok: true }> =>
    ipcRenderer.invoke(
      'novel:updateChatThreadTitle',
      branchId,
      threadId,
      title
    ),
  onChatChunk: (cb: (chunk: string) => void): (() => void) => {
    const fn = (_: Electron.IpcRendererEvent, chunk: string) => cb(chunk)
    ipcRenderer.on(CHAT_CHUNK_CHANNEL, fn)
    return () => ipcRenderer.removeListener(CHAT_CHUNK_CHANNEL, fn)
  },
  onChatStreamEvent: (cb: (ev: ChatStreamEvent) => void): (() => void) => {
    const fn = (_: Electron.IpcRendererEvent, ev: ChatStreamEvent) => cb(ev)
    ipcRenderer.on(CHAT_STREAM_EVENT_CHANNEL, fn)
    return () => ipcRenderer.removeListener(CHAT_STREAM_EVENT_CHANNEL, fn)
  },
  onChatDone: (cb: (full: string) => void): (() => void) => {
    const fn = (_: Electron.IpcRendererEvent, full: string) => cb(full)
    ipcRenderer.on(CHAT_DONE_CHANNEL, fn)
    return () => ipcRenderer.removeListener(CHAT_DONE_CHANNEL, fn)
  },
  onChatError: (cb: (msg: string) => void): (() => void) => {
    const fn = (_: Electron.IpcRendererEvent, msg: string) => cb(msg)
    ipcRenderer.on(CHAT_ERROR_CHANNEL, fn)
    return () => ipcRenderer.removeListener(CHAT_ERROR_CHANNEL, fn)
  },
  onWorkspaceRestored: (cb: () => void): (() => void) => {
    const fn = () => cb()
    ipcRenderer.on(WORKSPACE_RESTORED_CHANNEL, fn)
    return () => ipcRenderer.removeListener(WORKSPACE_RESTORED_CHANNEL, fn)
  },
  setEditorFlushHandler: (fn: (() => Promise<void>) | null): void => {
    editorFlushHandler = fn
  },
  restoreLastSession: () => ipcRenderer.invoke('novel:restoreLastSession'),
  saveSessionSnapshot: (payload) =>
    ipcRenderer.invoke('novel:saveSessionSnapshot', payload)
}

contextBridge.exposeInMainWorld('novel', novel)

export type { NovelApi }
