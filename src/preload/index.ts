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
  FLUSH_EDITOR_DONE_CHANNEL
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
  checkpoint: (label: string): Promise<{ nodeId: string }> =>
    ipcRenderer.invoke('novel:checkpoint', label),
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
  getMessages: () => ipcRenderer.invoke('novel:getMessages'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('novel:getSettings'),
  setSettings: (partial: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('novel:setSettings', partial),
  sendChat: (payload: {
    text: string
    filePath: string | null
  }): Promise<void> => ipcRenderer.invoke('novel:sendChat', payload),
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
  setEditorFlushHandler: (fn: (() => Promise<void>) | null): void => {
    editorFlushHandler = fn
  },
  restoreLastSession: () => ipcRenderer.invoke('novel:restoreLastSession'),
  saveSessionSnapshot: (payload) =>
    ipcRenderer.invoke('novel:saveSessionSnapshot', payload)
}

contextBridge.exposeInMainWorld('novel', novel)

export type { NovelApi }
