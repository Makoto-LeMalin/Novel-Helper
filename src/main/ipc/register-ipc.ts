import { BrowserWindow, ipcMain, dialog, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { join, relative } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import type { ProjectState } from '../state/project-state'
import { SnapshotVersionStore } from '../version/snapshot-version-store'
import { MemoryService } from '../memory/memory-service'
import { runChatWithToolLoop } from '../llm/openai-client'
import {
  clearActiveChatsOnWorkspaceChange,
  cancelChatForWebContents,
  clearActiveChatAbort,
  setActiveChatAbort
} from './window-sessions'
import {
  pickDeleteWorkspaceFields,
  pickListWorkspaceFields,
  pickPatchWorkspaceFields,
  pickReadWorkspaceFields,
  pickSearchWorkspaceFields,
  pickWriteWorkspaceFields
} from '../llm/novel-tools'
import { saveSettings } from '../persistence/settings-store'
import {
  loadSessionSnapshot,
  saveSessionSnapshot
} from '../persistence/session-store'
import {
  deleteWorkspaceFileIfExists,
  isUnderNovel,
  listWorkspaceFilesWithPrefix,
  patchWorkspaceFile,
  readWorkspaceFileForTool,
  searchWorkspaceLiteral,
  writeWorkspaceFile
} from '../files/file-service'
import {
  CHAT_DONE_CHANNEL,
  CHAT_ERROR_CHANNEL,
  FLUSH_EDITOR_REQUEST_CHANNEL,
  FLUSH_EDITOR_DONE_CHANNEL,
  WORKSPACE_RESTORED_CHANNEL,
  type AppSettings,
  type WorkspaceInfo
} from '../../shared/ipc'
import type {
  SessionRendererPayload,
  SessionRestoreResult,
  SessionSnapshotV1
} from '../../shared/session'
import {
  CHAT_STREAM_EVENT_CHANNEL,
  type ChatStreamEvent
} from '../../shared/chat-stream'
import { randomUUID } from 'crypto'
import { normalizeChatThreadId } from '../../shared/chat-thread'

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

async function openWorkspaceCore(
  project: ProjectState,
  version: SnapshotVersionStore,
  memory: MemoryService,
  absPath: string,
  mode: 'fresh' | 'restore',
  restore?: Pick<
    SessionSnapshotV1,
    | 'currentBranchId'
    | 'conversationViewMaxSeq'
    | 'restoredBaseNodeId'
    | 'pendingForkBeforeNextCommit'
  >
): Promise<WorkspaceInfo> {
  const prevPath = project.workspacePath
  project.setWorkspace(absPath)
  if (prevPath !== absPath) clearActiveChatsOnWorkspaceChange()
  version.open(absPath)
  memory.open(absPath)
  await version.hydrateEmptyInitialSnapshot()
  const branches = version.listBranches()
  if (mode === 'fresh') {
    const main = branches.find((b) => b.name === 'main') ?? branches[0]
    project.setCurrentBranch(main?.id ?? null)
    project.conversationViewMaxSeq = null
    project.restoredBaseNodeId = null
    project.pendingForkBeforeNextCommit = false
    const bid = main?.id ?? null
    const bidStr = bid ?? ''
    return {
      path: absPath,
      currentBranchId: bidStr,
      workspaceBranchId: bidStr,
      currentNodeId: bid ? version.getBranchTip(bid) : '',
      pendingForkBeforeNextCommit: false,
      historyViewActive: false
    }
  }
  let bid = restore?.currentBranchId
  if (!bid || !branches.some((b) => b.id === bid)) {
    const main = branches.find((b) => b.name === 'main') ?? branches[0]
    bid = main?.id ?? null
  }
  project.setCurrentBranch(bid)
  project.conversationViewMaxSeq =
    restore?.conversationViewMaxSeq !== undefined
      ? restore.conversationViewMaxSeq
      : null
  project.restoredBaseNodeId =
    restore?.restoredBaseNodeId !== undefined
      ? restore.restoredBaseNodeId
      : null
  project.pendingForkBeforeNextCommit = project.restoredBaseNodeId
    ? version.nodeHasChild(project.restoredBaseNodeId)
    : false
  const bidStr = bid ?? ''
  return {
    path: absPath,
    currentBranchId: bidStr,
    workspaceBranchId: bidStr,
    currentNodeId: bid ? version.getBranchTip(bid) : '',
    pendingForkBeforeNextCommit: project.pendingForkBeforeNextCommit,
    historyViewActive: project.conversationViewMaxSeq != null
  }
}

function dialogParentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

function broadcastWorkspaceRestored(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(WORKSPACE_RESTORED_CHANNEL)
  }
}

/** Conversation branch for memory/chat; must be a known branch id. */
function resolveConversationBranchId(
  version: SnapshotVersionStore,
  project: ProjectState,
  requested: unknown
): string | null {
  const disk = project.currentBranchId
  if (!disk) return null
  if (typeof requested === 'string' && requested.length > 0) {
    const ok = version.listBranches().some((b) => b.id === requested)
    if (ok) return requested
  }
  return disk
}

/** 工作区脏检查基准：跳转查看某节点时与「该节点」快照比，否则与分支 tip 比。 */
function baselineNodeIdForWorkspaceDirty(
  project: ProjectState,
  version: SnapshotVersionStore
): string | null {
  if (!project.currentBranchId) return null
  const rid = project.restoredBaseNodeId
  if (rid != null && !version.nodeExists(rid)) {
    project.restoredBaseNodeId = null
    project.pendingForkBeforeNextCommit = false
  }
  return project.restoredBaseNodeId != null
    ? project.restoredBaseNodeId
    : version.getBranchTip(project.currentBranchId)
}

function trimMemoryToVersionTips(
  memory: MemoryService,
  version: SnapshotVersionStore
): void {
  for (const b of version.listBranches()) {
    if (!version.nodeExists(b.tipNodeId)) continue
    const cut = version.getNode(b.tipNodeId).conversationCutSeq
    memory.trimAfterConversationCut(b.id, cut)
  }
}

function resolveMainBranchRecord(
  version: SnapshotVersionStore
): { id: string; tipNodeId: string } {
  const branches = version.listBranches()
  if (branches.length === 0) throw new Error('No branches')
  const main =
    branches.find((b) => b.name === 'main') ?? branches[0]
  return { id: main.id, tipNodeId: main.tipNodeId }
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
  getUserData: () => string
): void {
  ipcMain.handle('novel:selectWorkspace', async () => {
    const win = dialogParentWindow()
    /* Workspace root = all relative paths (files, AI tool `path`, tree) are under this folder.
       If this is a subfolder of a Git repo, `git status` paths are often prefixed with that
       subfolder name; opening the repository root as workspace aligns app paths with Git. */
    const { canceled, filePaths } = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openDirectory']
    })
    if (canceled || !filePaths[0]) return null
    return openWorkspaceCore(project, version, memory, filePaths[0], 'fresh')
  })

  ipcMain.handle(
    'novel:restoreLastSession',
    async (): Promise<SessionRestoreResult> => {
      const snap = await loadSessionSnapshot(getUserData())
      if (!snap) return { ok: false, reason: 'no_session' }
      if (!existsSync(snap.workspacePath)) {
        return { ok: false, reason: 'path_missing' }
      }
      try {
        const st = await stat(snap.workspacePath)
        if (!st.isDirectory()) return { ok: false, reason: 'not_dir' }
      } catch {
        return { ok: false, reason: 'stat_failed' }
      }
      try {
        const w = await openWorkspaceCore(
          project,
          version,
          memory,
          snap.workspacePath,
          'restore',
          {
            currentBranchId: snap.currentBranchId,
            conversationViewMaxSeq: snap.conversationViewMaxSeq,
            restoredBaseNodeId: snap.restoredBaseNodeId,
            pendingForkBeforeNextCommit:
              snap.pendingForkBeforeNextCommit ?? false
          }
        )
        return {
          ok: true,
          workspace: w,
          historyBanner: snap.historyBanner,
          activeFile: snap.activeFile,
          editorContent: snap.editorContent,
          editorDiskBaseline: snap.editorDiskBaseline,
          fileBuffers: snap.fileBuffers,
          editorView: snap.editorView
        }
      } catch {
        return { ok: false, reason: 'open_failed' }
      }
    }
  )

  ipcMain.handle(
    'novel:saveSessionSnapshot',
    async (_e, rendererPart: SessionRendererPayload): Promise<void> => {
      if (!project.workspacePath || !project.currentBranchId) return
      const tip = version.getBranchTip(project.currentBranchId)
      const full: SessionSnapshotV1 = {
        v: 1,
        workspacePath: project.workspacePath,
        currentBranchId: project.currentBranchId,
        currentNodeId: tip,
        conversationViewMaxSeq: project.conversationViewMaxSeq,
        restoredBaseNodeId: project.restoredBaseNodeId,
        pendingForkBeforeNextCommit: project.pendingForkBeforeNextCommit,
        historyBanner: rendererPart.historyBanner,
        activeFile: rendererPart.activeFile,
        editorContent: rendererPart.editorContent,
        editorDiskBaseline: rendererPart.editorDiskBaseline,
        fileBuffers: rendererPart.fileBuffers
      }
      await saveSessionSnapshot(getUserData(), full)
    }
  )

  ipcMain.handle('novel:getWorkspace', async () => {
    if (!project.workspacePath || !project.currentBranchId) return null
    const disk = project.currentBranchId
    return {
      path: project.workspacePath,
      currentBranchId: disk,
      workspaceBranchId: disk,
      currentNodeId: version.getBranchTip(disk),
      pendingForkBeforeNextCommit: project.pendingForkBeforeNextCommit,
      historyViewActive: project.conversationViewMaxSeq != null
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
    project.pendingForkBeforeNextCommit = false
    broadcastWorkspaceRestored()
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
    async (_e, label: string, chatBranchId?: string | null) => {
      if (!project.workspacePath || !project.currentBranchId) {
        throw new Error('No workspace or branch')
      }
      if (project.pendingForkBeforeNextCommit) {
        throw new Error('NEXT_COMMIT_REQUIRES_NEW_BRANCH_NAME')
      }
      const chatBranch = resolveConversationBranchId(
        version,
        project,
        chatBranchId
      )
      if (!chatBranch) throw new Error('No branch')
      const cut = memory.maxSeq(chatBranch)
      const parent = project.restoredBaseNodeId
      const res = await version.createCheckpoint(
        chatBranch,
        label || 'Checkpoint',
        cut,
        parent
      )
      project.restoredBaseNodeId = null
      return res
    }
  )

  ipcMain.handle(
    'novel:checkpointWithNewBranch',
    async (
      _e,
      payload: { newBranchName: string; label: string }
    ): Promise<{ nodeId: string }> => {
      if (!project.workspacePath || !project.currentBranchId) {
        throw new Error('No workspace or branch')
      }
      if (!project.pendingForkBeforeNextCommit || !project.restoredBaseNodeId) {
        throw new Error('No pending fork for this commit')
      }
      const name = payload.newBranchName.trim()
      if (!name) throw new Error('Branch name required')
      const baseNodeId = project.restoredBaseNodeId
      const curBranch = project.currentBranchId
      const { conversationCutSeq: msgCut } = version.getNode(baseNodeId)
      const { branchId: newBranchId } = version.forkBranch(baseNodeId, name)
      memory.copyMessagesForFork(curBranch, newBranchId, msgCut)
      project.setCurrentBranch(newBranchId)
      project.conversationViewMaxSeq = null
      project.pendingForkBeforeNextCommit = false
      project.restoredBaseNodeId = null
      const cut = memory.maxSeq(newBranchId)
      return version.createCheckpoint(
        newBranchId,
        payload.label.trim() || 'Checkpoint',
        cut,
        null
      )
    }
  )

  ipcMain.handle(
    'novel:forkAfterJump',
    async (_e, newBranchName: string): Promise<{ branchId: string }> => {
      if (!project.workspacePath || !project.currentBranchId) {
        throw new Error('No workspace or branch')
      }
      if (!project.pendingForkBeforeNextCommit || !project.restoredBaseNodeId) {
        throw new Error('No pending fork')
      }
      const baseNodeId = project.restoredBaseNodeId
      const curBranch = project.currentBranchId
      const { conversationCutSeq: msgCut } = version.getNode(baseNodeId)
      const name = newBranchName.trim()
      if (!name) throw new Error('Branch name required')
      const { branchId: newBranchId } = version.forkBranch(baseNodeId, name)
      memory.copyMessagesForFork(curBranch, newBranchId, msgCut)
      project.setCurrentBranch(newBranchId)
      project.conversationViewMaxSeq = null
      project.pendingForkBeforeNextCommit = false
      project.restoredBaseNodeId = null
      return { branchId: newBranchId }
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
      project.pendingForkBeforeNextCommit = false
      broadcastWorkspaceRestored()
      return { branchId }
    }
  )

  ipcMain.handle('novel:restoreNode', async (_e, nodeId: string) => {
    await version.restoreWorkingTreeToNode(nodeId)
    const node = version.getNode(nodeId)
    project.setCurrentBranch(node.branchId)
    project.conversationViewMaxSeq = node.conversationCutSeq
    project.restoredBaseNodeId = nodeId
    project.pendingForkBeforeNextCommit = version.nodeHasChild(nodeId)
    broadcastWorkspaceRestored()
    return {
      conversationCutSeq: node.conversationCutSeq,
      branchId: node.branchId
    }
  })

  ipcMain.handle(
    'novel:deleteVersionNode',
    async (_e, nodeId: string): Promise<{ deletedIds: string[] }> => {
      const { deletedIds } = version.deleteNodeAndDescendants(nodeId)
      trimMemoryToVersionTips(memory, version)
      const pruned = version.pruneBranchesWithoutOwnedNodes('main')
      for (const bid of pruned) {
        memory.clearBranch(bid)
      }
      if (
        project.restoredBaseNodeId &&
        deletedIds.includes(project.restoredBaseNodeId)
      ) {
        project.restoredBaseNodeId = null
        project.pendingForkBeforeNextCommit = false
      }
      const cur = project.currentBranchId
      if (cur && pruned.includes(cur)) {
        const { id: mainId, tipNodeId } = resolveMainBranchRecord(version)
        await version.restoreWorkingTreeToNode(tipNodeId)
        project.setCurrentBranch(mainId)
        project.conversationViewMaxSeq = null
        project.restoredBaseNodeId = null
        project.pendingForkBeforeNextCommit = false
        broadcastWorkspaceRestored()
      }
      return { deletedIds }
    }
  )

  ipcMain.handle('novel:clearHistoryView', async () => {
    project.conversationViewMaxSeq = null
    return true
  })

  ipcMain.handle('novel:versionStatus', async () => {
    if (!project.workspacePath || !project.currentBranchId) {
      return { dirty: false, currentBranchId: '', tipNodeId: '' }
    }
    const baseline = baselineNodeIdForWorkspaceDirty(project, version)
    const dirty =
      baseline != null
        ? await version.isWorkspaceDirtyAgainstNode(baseline)
        : false
    return {
      dirty,
      currentBranchId: project.currentBranchId,
      tipNodeId: version.getBranchTip(project.currentBranchId)
    }
  })

  ipcMain.handle(
    'novel:getMessages',
    async (_e, chatBranchId?: string | null, chatThreadId?: string | null) => {
      const bid = resolveConversationBranchId(version, project, chatBranchId)
      if (!bid) throw new Error('No branch')
      const tid = normalizeChatThreadId(chatThreadId)
      const maxSeq = project.conversationViewMaxSeq
      if (maxSeq != null) {
        return memory.getMessagesUpToSeq(bid, maxSeq, tid)
      }
      return memory.getRecentMessages(bid, tid, 8000)
    }
  )

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
    async (
      event,
      payload: {
        text: string
        filePath: string | null
        chatBranchId?: string | null
        chatThreadId?: string | null
      }
    ) => {
      const reply = event.sender
      if (!project.workspacePath || !project.currentBranchId) {
        notifyChatError(reply, 'Open a workspace first.')
        return
      }
      if (project.pendingForkBeforeNextCommit) {
        notifyChatError(
          reply,
          '该历史节点之后仍有版本：请先在界面中新建分支，再发送消息。'
        )
        return
      }
      const {
        text,
        filePath,
        chatBranchId: requestedBranch,
        chatThreadId: requestedThread
      } = payload
      const chatThreadId = normalizeChatThreadId(requestedThread)
      const settings = project.settings
      if (!settings.openAiApiKey) {
        notifyChatError(reply, 'Set API key in Settings.')
        return
      }

      /* 新发送表示继续当前对话，不应再按历史截取隐藏本轮 user/assistant（否则 seq 大于旧 cut 的消息在 getMessages 中被滤掉）。 */
      project.conversationViewMaxSeq = null

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

      const chatBranchId = resolveConversationBranchId(
        version,
        project,
        requestedBranch
      )
      if (!chatBranchId) {
        notifyChatError(reply, 'Invalid conversation branch.')
        return
      }

      memory.ensureChatThreadForFirstUserMessage(
        chatBranchId,
        chatThreadId,
        text
      )

      const userId = randomUUID()
      memory.appendMessage(chatBranchId, chatThreadId, 'user', text, userId)
      await memory.onUserMessagePersisted(
        settings,
        chatBranchId,
        chatThreadId,
        text
      )

      const messages = await memory.buildAugmentedMessages(
        settings,
        chatBranchId,
        chatThreadId,
        filePath,
        fileContext,
        text
      )

      const wcId = reply.id
      const ac = new AbortController()
      setActiveChatAbort(wcId, ac)
      try {
        let didPreMutateDirtySnapshot = false
        const beforeMutatingWorkspaceOnDisk = async (): Promise<void> => {
          await awaitEditorFlushFromRenderer(reply, 12_000)
          if (!didPreMutateDirtySnapshot) {
            didPreMutateDirtySnapshot = true
            const baseline = baselineNodeIdForWorkspaceDirty(project, version)
            if (
              baseline != null &&
              (await version.isWorkspaceDirtyAgainstNode(baseline))
            ) {
              const cut = memory.maxSeq(chatBranchId)
              await version.recordSnapshot(
                chatBranchId,
                'user',
                cut,
                'AI写入前自动保存',
                project.restoredBaseNodeId
              )
              if (!project.pendingForkBeforeNextCommit) {
                project.restoredBaseNodeId = null
              }
            }
          }
        }

        const executeTool = async (
          name: string,
          args: Record<string, unknown>
        ): Promise<string> => {
          const ws = project.workspacePath
          if (!ws) {
            return JSON.stringify({ ok: false, error: 'No workspace' })
          }

          try {
            switch (name) {
              case 'read_workspace_file': {
                const picked = pickReadWorkspaceFields(args)
                if (!picked) {
                  return JSON.stringify({
                    ok: false,
                    error: 'Invalid or forbidden path'
                  })
                }
                const r = await readWorkspaceFileForTool(
                  ws,
                  picked.path,
                  picked.lineStart,
                  picked.lineEnd
                )
                if (!r.ok) {
                  return JSON.stringify({ ok: false, error: r.error })
                }
                return JSON.stringify({
                  ok: true,
                  path: r.path,
                  content: r.content,
                  total_lines: r.total_lines,
                  range: r.range,
                  truncated: r.truncated ?? false
                })
              }
              case 'list_workspace_files': {
                const listPicked = pickListWorkspaceFields(args)
                if (listPicked === null) {
                  return JSON.stringify({
                    ok: false,
                    error: 'Invalid or forbidden path_prefix'
                  })
                }
                const { pathPrefix } = listPicked
                const { paths, truncated } =
                  await listWorkspaceFilesWithPrefix(ws, pathPrefix)
                return JSON.stringify({
                  ok: true,
                  paths,
                  truncated,
                  count: paths.length
                })
              }
              case 'search_workspace': {
                const picked = pickSearchWorkspaceFields(args)
                if (!picked) {
                  return JSON.stringify({
                    ok: false,
                    error:
                      'Invalid query (empty or too long) or forbidden path_prefix'
                  })
                }
                const r = await searchWorkspaceLiteral(ws, picked.query, {
                  pathPrefix: picked.pathPrefix,
                  caseInsensitive: picked.caseInsensitive
                })
                if (!r.ok) {
                  return JSON.stringify({ ok: false, error: r.error })
                }
                return JSON.stringify({
                  ok: true,
                  hits: r.hits,
                  truncated: r.truncated,
                  count: r.hits.length
                })
              }
              case 'patch_workspace_file': {
                const { path: rel, oldText, newText, replaceAll } =
                  pickPatchWorkspaceFields(args)
                if (!rel) {
                  return JSON.stringify({
                    ok: false,
                    error: 'Invalid or forbidden path'
                  })
                }
                await beforeMutatingWorkspaceOnDisk()
                const result = await patchWorkspaceFile(
                  ws,
                  rel,
                  oldText,
                  newText,
                  replaceAll
                )
                if (result.ok) {
                  return JSON.stringify({ ok: true, path: rel })
                }
                return JSON.stringify({ ok: false, error: result.error })
              }
              case 'write_workspace_file': {
                const picked = pickWriteWorkspaceFields(args)
                if (!picked) {
                  return JSON.stringify({
                    ok: false,
                    error: 'Invalid or forbidden path'
                  })
                }
                await beforeMutatingWorkspaceOnDisk()
                await writeWorkspaceFile(ws, picked.path, picked.content)
                return JSON.stringify({ ok: true, path: picked.path })
              }
              case 'delete_workspace_file': {
                const picked = pickDeleteWorkspaceFields(args)
                if (!picked) {
                  return JSON.stringify({
                    ok: false,
                    error: 'Invalid or forbidden path'
                  })
                }
                await beforeMutatingWorkspaceOnDisk()
                const del = await deleteWorkspaceFileIfExists(ws, picked.path)
                if (!del.ok) {
                  return JSON.stringify({ ok: false, error: del.error })
                }
                return JSON.stringify({ ok: true, path: picked.path })
              }
              default:
                return JSON.stringify({
                  ok: false,
                  error: `Unknown tool: ${name}`
                })
            }
          } catch (e) {
            return JSON.stringify({
              ok: false,
              error: e instanceof Error ? e.message : String(e)
            })
          }
        }

        const sendStream = (ev: ChatStreamEvent) =>
          reply.send(CHAT_STREAM_EVENT_CHANNEL, ev)

        const { assistantText, writtenPaths, turnBlocks, cancelled } =
          await runChatWithToolLoop(settings, messages, executeTool, {
            onStreamEvent: sendStream,
            signal: ac.signal
          })

        const uniq = [...new Set(writtenPaths)]

        let full = assistantText
        if (uniq.length > 0) {
          full +=
            (full.trim() ? '\n\n' : '') +
            `[已写入工作区: ${uniq.join(', ')}]`
        }
        if (cancelled) {
          full = full.trim() ? `${full}\n\n（输出已停止）` : '（输出已停止）'
        } else if (!full.trim()) {
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
          chatBranchId,
          chatThreadId,
          'assistant',
          full,
          asstId,
          blocksForDb.length > 0 ? blocksForDb : null
        )

        if (!cancelled && uniq.length > 0) {
          const cut = memory.maxSeq(chatBranchId)
          await version.recordSnapshot(
            chatBranchId,
            'ai',
            cut,
            `tool:${uniq.join(', ')}`,
            project.restoredBaseNodeId
          )
          if (!project.pendingForkBeforeNextCommit) {
            project.restoredBaseNodeId = null
          }
        }

        /* Text streamed via CHAT_STREAM_EVENT (text_delta); CHAT_DONE triggers refresh. */
        reply.send(CHAT_DONE_CHANNEL, full)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        notifyChatError(reply, msg)
      } finally {
        clearActiveChatAbort(wcId)
      }
    }
  )

  ipcMain.handle('novel:cancelChat', async (event) => {
    cancelChatForWebContents(event.sender.id)
  })

  ipcMain.handle('novel:newChatThread', async () => {
    if (!project.workspacePath || !project.currentBranchId) {
      return { ok: false as const, error: 'no_workspace' }
    }
    /* 跳转历史节点后 pendingFork 只约束「发送 / 检查点」写 DAG，不阻止新建对话线程。 */
    const branchId = project.currentBranchId
    const threadId = randomUUID()
    return {
      ok: true as const,
      branchId,
      threadId
    }
  })

  ipcMain.handle(
    'novel:getChatTabState',
    async (_e, chatBranchId?: string | null) => {
      const bid = resolveConversationBranchId(version, project, chatBranchId)
      if (!bid) throw new Error('No branch')
      return memory.getChatTabState(bid)
    }
  )

  ipcMain.handle(
    'novel:setChatThreadClosed',
    async (_e, branchId: string, threadId: string, closed: boolean) => {
      const bid = resolveConversationBranchId(version, project, branchId)
      if (!bid) throw new Error('No branch')
      try {
        memory.setChatThreadClosed(bid, threadId, !!closed)
        return { ok: true as const }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg === 'LAST_OPEN_CHAT_THREAD') {
          return { ok: false as const, error: 'last_open' as const }
        }
        throw e
      }
    }
  )

  ipcMain.handle(
    'novel:updateChatThreadTitle',
    async (_e, branchId: string, threadId: string, title: string) => {
      const bid = resolveConversationBranchId(version, project, branchId)
      if (!bid) throw new Error('No branch')
      memory.updateChatThreadTitle(bid, threadId, title)
      return { ok: true as const }
    }
  )
}
