import type { AppSettings } from '../../shared/ipc'
import { defaultSettings } from '../../shared/ipc'

export class ProjectState {
  workspacePath: string | null = null
  currentBranchId: string | null = null
  /** When set, UI shows messages with seq <= this value (history browse). */
  conversationViewMaxSeq: number | null = null
  /**
   * After restoring files to a past node, next checkpoint parents from this node
   * instead of the branch tip (avoids attaching to the wrong timeline).
   */
  restoredBaseNodeId: string | null = null
  /**
   * 跳转到「仍有子节点」的历史节点后，下一次对话或提交须先新建分支；复制对话时只带到该节点的 conversationCutSeq。
   */
  pendingForkBeforeNextCommit = false
  settings: AppSettings = { ...defaultSettings }

  setWorkspace(path: string | null): void {
    this.workspacePath = path
  }

  setCurrentBranch(id: string | null): void {
    this.currentBranchId = id
  }

  updateSettings(partial: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...partial }
  }
}
