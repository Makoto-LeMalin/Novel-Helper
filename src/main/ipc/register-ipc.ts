import { BrowserWindow, ipcMain, dialog, type WebContents } from 'electron'
import { join, relative } from 'path'
import { readdir, readFile } from 'fs/promises'
import type { ProjectState } from '../state/project-state'
import { SnapshotVersionStore } from '../version/snapshot-version-store'
import { MemoryService } from '../memory/memory-service'
import { runChatWithToolLoop } from '../llm/openai-client'
import { pickPatchWorkspaceFields } from '../llm/novel-tools'
import { saveSettings } from '../persistence/settings-store'
import { isUnderNovel, patchWorkspaceFile, writeWorkspaceFile } from '../files/file-service'
import {
  CHAT_DONE_CHANNEL,
  CHAT_ERROR_CHANNEL,
  FLUSH_EDITOR_REQUEST_CHANNEL,
  FLUSH_EDITOR_DONE_CHANNEL,
  type AppSettings
} from '../../shared/ipc'
import {
  CHAT_STREAM_EVENT_CHANNEL,
  type ChatStreamEvent
} from '../../shared/chat-stream'
import { randomUUID } from 'crypto'

/** 等待渲染进程将当前编辑器缓冲写入磁盘（Electron 无 ipcRenderer.handle，用 send/应答）。 */
function awaitEditorFlushFromRenderer(
  sender: WebContents,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const onDone = (event: Electron.IpcMainEvent, id: string): void => {
      if (event.sender !== sender || id !== requestId) return
      clearTimeout(timer)
      ipcMain.removeListener(FLUSH_EDITOR_DONE_CHANNEL, onDone)
      resolve()
    }
    const timer = setTimeout(() => {
      ipcMain.removeListener(FLUSH_EDITOR_DONE_CHANNEL, onDone)
      resolve()
    }, timeoutMs)
    ipcMain.on(FLUSH_EDITOR_DONE_CHANNEL, onDone)
    sender.send(FLUSH_EDITOR_REQUEST_CHANNEL, requestId)
  })
}

function notifyChatError(sender: WebContents, msg: string): void {
  sender.send(CHAT_ERROR_CHANNEL, msg)
  const bw = BrowserWindow.fromWebContents(sender)
  const opts = {
    type: 'error' as const,
    title: 'Novel Helper',
    message: msg,
    buttons: ['确定'] as const
  }
  if (bw && !bw.isDestroyed()) {
    void dialog.showMessageBox(bw, opts)
  } else {
    void dialog.showMessageBox(opts)
  }
}

export function registerIpc(
  project: ProjectState,
  version: SnapshotVersionStore,
  memory: MemoryService,
  getUserData: () => string,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('novel:selectWorkspace', async () => {
    const win = getWindow()
    /* Workspace root = all relative paths (files, AI tool `path`, tree) are under this folder.
       If this is a subfolder of a Git repo, `git status` paths are often prefixed with that
       subfolder name; opening the repository root as workspace aligns app paths with Git. */
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openDirectory']
    })
    if (canceled || !filePaths[0]) return null
    const p = filePaths[0]
    project.setWorkspace(p)
    version.open(p)
    memory.open(p)
    await version.hydrateEmptyInitialSnapshot()
    const branches = version.listBranches()
    const main = branches.find((b) => b.name === 'main') ?? branches[0]
    project.setCurrentBranch(main?.id ?? null)
    project.conversationViewMaxSeq = null
    project.restoredBaseNodeId = null
    return {
      path: p,
      currentBranchId: main?.id ?? '',
      currentNodeId: main ? version.getBranchTip(main.id) : ''
    }
  })

  ipcMain.handle('novel:getWorkspace', async () => {
    if (!project.workspacePath || !project.currentBranchId) return null
    return {
      path: project.workspacePath,
      currentBranchId: project.currentBranchId,
      currentNodeId: version.getBranchTip(project.currentBranchId)
    }
  })

  ipcMain.handle('novel:setBranch', async (_e, branchId: string) => {
    const brs = version.listBranches()
    if (!brs.some((b) => b.id === branchId)) throw new Error('Unknown branch')
    const tip = version.getBranchTip(branchId)
    await version.restoreWorkingTreeToNode(tip)
    project.setCurrentBranch(branchId)
    project.conversationViewMaxSeq = null
    project.restoredBaseNodeId = null
    return tip
  })

  ipcMain.handle('novel:readFile', async (_e, relPath: string) => {
    if (!project.workspacePath) throw new Error('No workspace')
    if (isUnderNovel(relPath)) throw new Error('Access denied')
    const full = join(project.workspacePath, relPath)
    return readFile(full, 'utf8')
  })

  ipcMain.handle(
    'novel:writeFile',
    async (_e, relPath: string, content: string) => {
      if (!project.workspacePath) throw new Error('No workspace')
      if (isUnderNovel(relPath)) throw new Error('Access denied')
      await writeWorkspaceFile(project.workspacePath, relPath, content)
      return true
    }
  )

  ipcMain.handle('novel:listTree', async () => {
    if (!project.workspacePath) return []
    const root = project.workspacePath
    async function walk(dir: string): Promise<string[]> {
      const out: string[] = []
      const entries = await readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = join(dir, e.name)
        const rel = relative(root, full).split(/[/\\]/).join('/')
        if (isUnderNovel(rel)) continue
        if (e.isDirectory()) {
          out.push(...(await walk(full)))
        } else {
          out.push(rel)
        }
      }
      return out
    }
    return walk(root).then((r) => r.sort())
  })

  ipcMain.handle('novel:versionGraph', async () => version.getGraph())

  ipcMain.handle(
    'novel:checkpoint',
    async (_e, label: string) => {
      if (!project.workspacePath || !project.currentBranchId) {
        throw new Error('No workspace or branch')
      }
      const cut = memory.maxSeq(project.currentBranchId)
      const parent = project.restoredBaseNodeId
      const res = await version.createCheckpoint(
        project.currentBranchId,
        label || 'Checkpoint',
        cut,
        parent
      )
      project.restoredBaseNodeId = null
      return res
    }
  )

  ipcMain.handle(
    'novel:forkBranch',
    async (_e, fromNodeId: string, name: string) => {
      const { branchId, sourceBranchId, conversationCutSeq } =
        version.forkBranch(fromNodeId, name)
      memory.copyMessagesForFork(sourceBranchId, branchId, conversationCutSeq)
      project.setCurrentBranch(branchId)
      project.conversationViewMaxSeq = null
      await version.restoreWorkingTreeToNode(version.getBranchTip(branchId))
      project.restoredBaseNodeId = null
      return { branchId }
    }
  )

  ipcMain.handle('novel:restoreNode', async (_e, nodeId: string) => {
    await version.restoreWorkingTreeToNode(nodeId)
    const node = version.getNode(nodeId)
    project.setCurrentBranch(node.branchId)
    project.conversationViewMaxSeq = node.conversationCutSeq
    project.restoredBaseNodeId = nodeId
    return {
      conversationCutSeq: node.conversationCutSeq,
      branchId: node.branchId
    }
  })

  ipcMain.handle('novel:clearHistoryView', async () => {
    project.conversationViewMaxSeq = null
    return true
  })

  ipcMain.handle('novel:versionStatus', async () => {
    if (!project.workspacePath || !project.currentBranchId) {
      return { dirty: false, currentBranchId: '', tipNodeId: '' }
    }
    const dirty = await version.isDirty(project.currentBranchId)
    return {
      dirty,
      currentBranchId: project.currentBranchId,
      tipNodeId: version.getBranchTip(project.currentBranchId)
    }
  })

  ipcMain.handle('novel:getMessages', async () => {
    if (!project.currentBranchId) throw new Error('No branch')
    const maxSeq = project.conversationViewMaxSeq
    if (maxSeq != null) {
      return memory.getMessagesUpToSeq(project.currentBranchId, maxSeq)
    }
    return memory.getRecentMessages(project.currentBranchId, 8000)
  })

  ipcMain.handle('novel:getSettings', async () => project.settings)

  ipcMain.handle(
    'novel:setSettings',
    async (_e, partial: Partial<AppSettings>) => {
      project.updateSettings(partial)
      await saveSettings(getUserData(), project.settings)
      return project.settings
    }
  )

  ipcMain.handle(
    'novel:sendChat',
    async (event, payload: { text: string; filePath: string | null }) => {
      const reply = event.sender
      if (!project.workspacePath || !project.currentBranchId) {
        notifyChatError(reply, 'Open a workspace first.')
        return
      }
      const { text, filePath } = payload
      const settings = project.settings
      if (!settings.openAiApiKey) {
        notifyChatError(reply, 'Set API key in Settings.')
        return
      }

      let fileContext = ''
      if (filePath && project.workspacePath) {
        try {
          if (!isUnderNovel(filePath)) {
            const full = join(project.workspacePath, filePath)
            const raw = await readFile(full, 'utf8')
            fileContext =
              raw.length > 12000
                ? raw.slice(0, 12000) + '\n…(truncated)'
                : raw
          }
        } catch {
          fileContext = ''
        }
      }

      const userId = randomUUID()
      memory.appendMessage(project.currentBranchId, 'user', text, userId)
      await memory.onUserMessagePersisted(settings, project.currentBranchId, text)

      const messages = await memory.buildAugmentedMessages(
        settings,
        project.currentBranchId,
        filePath,
        fileContext,
        text
      )

      try {
        let didPrePatchDirtySnapshot = false
        const executeTool = async (
          name: string,
          args: Record<string, unknown>
        ): Promise<string> => {
          if (name !== 'patch_workspace_file') {
            return JSON.stringify({
              ok: false,
              error: `Unknown tool: ${name}`
            })
          }
          const { path: rel, oldText, newText, replaceAll } =
            pickPatchWorkspaceFields(args)
          if (!rel || !project.workspacePath) {
            return JSON.stringify({
              ok: false,
              error: 'Invalid path or workspace'
            })
          }
          if (isUnderNovel(rel)) {
            return JSON.stringify({
              ok: false,
              error: 'Cannot write under .novel'
            })
          }
          try {
            /* 编辑器缓冲未落盘时 isDirty 只看磁盘；先让渲染进程落盘再预检/打补丁。 */
            await awaitEditorFlushFromRenderer(reply, 12_000)
            if (!didPrePatchDirtySnapshot) {
              didPrePatchDirtySnapshot = true
              if (await version.isDirty(project.currentBranchId)) {
                const cut = memory.maxSeq(project.currentBranchId)
                await version.recordSnapshot(
                  project.currentBranchId,
                  'user',
                  cut,
                  'AI写入前自动保存',
                  project.restoredBaseNodeId
                )
                project.restoredBaseNodeId = null
              }
            }
            const result = await patchWorkspaceFile(
              project.workspacePath,
              rel,
              oldText,
              newText,
              replaceAll
            )
            if (result.ok) {
              return JSON.stringify({ ok: true, path: rel })
            }
            return JSON.stringify({ ok: false, error: result.error })
          } catch (e) {
            return JSON.stringify({
              ok: false,
              error: e instanceof Error ? e.message : String(e)
            })
          }
        }

        const sendStream = (ev: ChatStreamEvent) =>
          reply.send(CHAT_STREAM_EVENT_CHANNEL, ev)

        const { assistantText, writtenPaths, turnBlocks } =
          await runChatWithToolLoop(settings, messages, executeTool, {
            onStreamEvent: sendStream
          })

        const uniq = [...new Set(writtenPaths)]

        let full = assistantText
        if (uniq.length > 0) {
          full +=
            (full.trim() ? '\n\n' : '') +
            `[已写入工作区: ${uniq.join(', ')}]`
        }
        if (!full.trim()) {
          full =
            uniq.length > 0
              ? `已更新文件：${uniq.join(', ')}`
              : '（模型未返回正文。）'
        }

        const blocksForDb = [...turnBlocks]
        if (!full.startsWith(assistantText)) {
          sendStream({ type: 'text_delta', text: full })
          blocksForDb.length = 0
          blocksForDb.push({ kind: 'text', text: full })
        } else {
          const tail = full.slice(assistantText.length)
          if (tail) {
            sendStream({ type: 'text_delta', text: tail })
            const last = blocksForDb[blocksForDb.length - 1]
            if (last?.kind === 'text') {
              last.text += tail
            } else {
              blocksForDb.push({ kind: 'text', text: tail })
            }
          }
        }

        const asstId = randomUUID()
        memory.appendMessage(
          project.currentBranchId,
          'assistant',
          full,
          asstId,
          blocksForDb.length > 0 ? blocksForDb : null
        )

        if (uniq.length > 0 && project.currentBranchId) {
          const cut = memory.maxSeq(project.currentBranchId)
          await version.recordSnapshot(
            project.currentBranchId,
            'ai',
            cut,
            `tool:${uniq.join(', ')}`,
            project.restoredBaseNodeId
          )
          project.restoredBaseNodeId = null
        }

        /* Text streamed via CHAT_STREAM_EVENT (text_delta); CHAT_DONE triggers refresh. */
        reply.send(CHAT_DONE_CHANNEL, full)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        notifyChatError(reply, msg)
      }
    }
  )
}
