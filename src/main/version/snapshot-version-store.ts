import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import {
  deleteWorkspaceFile,
  hashContent,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile
} from '../files/file-service'
import type { BranchRecord, NodeRecord, VersionGraph } from '../../shared/ipc'

const NOVEL = '.novel'
const BLOBS = 'blobs'

function novelRoot(workspaceRoot: string): string {
  return join(workspaceRoot, NOVEL)
}

function dbPath(workspaceRoot: string): string {
  return join(novelRoot(workspaceRoot), 'version.db')
}

function blobDir(workspaceRoot: string): string {
  return join(novelRoot(workspaceRoot), BLOBS)
}

function blobPath(workspaceRoot: string, hash: string): string {
  return join(blobDir(workspaceRoot), hash.slice(0, 2), hash.slice(2))
}

export type Manifest = Record<string, string>

export class SnapshotVersionStore {
  private db: Database.Database | null = null
  private ws: string | null = null

  open(workspaceRoot: string): void {
    this.close()
    this.ws = workspaceRoot
    const dir = novelRoot(workspaceRoot)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    mkdirSync(blobDir(workspaceRoot), { recursive: true })
    this.db = new Database(dbPath(workspaceRoot))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        tip_node_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        branch_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        label TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        conversation_cut_seq INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (branch_id) REFERENCES branches(id)
      );
    `)
    try {
      this.db.exec(
        `ALTER TABLE nodes ADD COLUMN conversation_cut_seq INTEGER NOT NULL DEFAULT 0`
      )
    } catch {
      /* column exists */
    }
    this.ensureDefaultBranch()
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.ws = null
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('Version store not open')
    return this.db
  }

  private requireWs(): string {
    if (!this.ws) throw new Error('No workspace')
    return this.ws
  }

  private ensureDefaultBranch(): void {
    const db = this.requireDb()
    const row = db.prepare(`SELECT COUNT(*) as c FROM branches`).get() as {
      c: number
    }
    if (row.c > 0) return
    const rootId = randomUUID()
    const branchId = randomUUID()
    const emptyManifest: Manifest = {}
    /* branches 必须先存在：nodes.branch_id 外键引用 branches.id */
    db.prepare(
      `INSERT INTO branches (id, name, tip_node_id) VALUES (?, 'main', ?)`
    ).run(branchId, rootId)
    db.prepare(
      `INSERT INTO nodes (id, parent_id, branch_id, created_at, label, manifest_json, conversation_cut_seq)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`
    ).run(
      rootId,
      branchId,
      Date.now(),
      'Initial',
      JSON.stringify(emptyManifest),
      0
    )
  }

  /**
   * Seed "Initial" was created with `{}` so the DB/branch graph can bootstrap without async I/O.
   * On first open (or any time main's tip is still that empty Initial node), snapshot current
   * workspace files into it so restore/dirty checks match real files — manifests never store dirs,
   * only files under the workspace (excluding `.novel`).
   */
  async hydrateEmptyInitialSnapshot(): Promise<void> {
    const db = this.requireDb()
    const branches = this.listBranches()
    const main = branches.find((b) => b.name === 'main') ?? branches[0]
    if (!main) return
    const tipId = main.tipNodeId
    const node = this.getNode(tipId)
    if (node.label !== 'Initial') return
    if (Object.keys(node.manifest).length > 0) return
    const manifest = await this.buildManifestFromWorkspace()
    db.prepare(`UPDATE nodes SET manifest_json = ? WHERE id = ?`).run(
      JSON.stringify(manifest),
      tipId
    )
  }

  listBranches(): BranchRecord[] {
    const db = this.requireDb()
    const rows = db
      .prepare(`SELECT id, name, tip_node_id FROM branches ORDER BY name`)
      .all() as { id: string; name: string; tip_node_id: string }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      tipNodeId: r.tip_node_id
    }))
  }

  getBranchTip(branchId: string): string {
    const db = this.requireDb()
    const row = db
      .prepare(`SELECT tip_node_id FROM branches WHERE id = ?`)
      .get(branchId) as { tip_node_id: string } | undefined
    if (!row) throw new Error('Branch not found')
    return row.tip_node_id
  }

  setBranchTip(branchId: string, nodeId: string): void {
    const db = this.requireDb()
    db.prepare(`UPDATE branches SET tip_node_id = ? WHERE id = ?`).run(
      nodeId,
      branchId
    )
  }

  getNode(nodeId: string): NodeRecord & {
    manifest: Manifest
    conversationCutSeq: number
  } {
    const db = this.requireDb()
    const row = db
      .prepare(
        `SELECT id, parent_id, branch_id, created_at, label, manifest_json, conversation_cut_seq FROM nodes WHERE id = ?`
      )
      .get(nodeId) as
      | {
          id: string
          parent_id: string | null
          branch_id: string
          created_at: number
          label: string
          manifest_json: string
          conversation_cut_seq: number
        }
      | undefined
    if (!row) throw new Error('Node not found')
    return {
      id: row.id,
      parentId: row.parent_id,
      branchId: row.branch_id,
      createdAt: row.created_at,
      label: row.label,
      manifest: JSON.parse(row.manifest_json) as Manifest,
      conversationCutSeq: row.conversation_cut_seq
    }
  }

  listNodes(): NodeRecord[] {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT id, parent_id, branch_id, created_at, label, conversation_cut_seq FROM nodes ORDER BY created_at`
      )
      .all() as {
      id: string
      parent_id: string | null
      branch_id: string
      created_at: number
      label: string
      conversation_cut_seq: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      branchId: r.branch_id,
      createdAt: r.created_at,
      label: r.label,
      conversationCutSeq: r.conversation_cut_seq
    }))
  }

  getGraph(): VersionGraph {
    const nodes = this.listNodes()
    const branches = this.listBranches()
    const edges: VersionGraph['edges'] = []
    for (const n of nodes) {
      if (n.parentId) edges.push({ from: n.parentId, to: n.id })
    }
    return { nodes, branches, edges }
  }

  /** True if any commit lists this node as parent (fork / continue from here). */
  nodeHasChild(nodeId: string): boolean {
    const db = this.requireDb()
    const row = db
      .prepare(`SELECT 1 AS x FROM nodes WHERE parent_id = ? LIMIT 1`)
      .get(nodeId) as { x: number } | undefined
    return row != null
  }

  private async storeBlob(content: Buffer): Promise<string> {
    const ws = this.requireWs()
    const h = hashContent(content)
    const path = blobPath(ws, h)
    if (!existsSync(path)) {
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, content)
    }
    return h
  }

  private async readBlob(hash: string): Promise<Buffer> {
    const ws = this.requireWs()
    const path = blobPath(ws, hash)
    return readFile(path)
  }

  async buildManifestFromWorkspace(): Promise<Manifest> {
    const ws = this.requireWs()
    const files = await listWorkspaceFiles(ws)
    const manifest: Manifest = {}
    for (const rel of files) {
      const buf = await readWorkspaceFile(ws, rel)
      const h = await this.storeBlob(buf)
      manifest[rel] = h
    }
    return manifest
  }

  async createCheckpoint(
    branchId: string,
    label: string,
    conversationCutSeq: number,
    parentOverride?: string | null
  ): Promise<{ nodeId: string }> {
    const db = this.requireDb()
    const manifest = await this.buildManifestFromWorkspace()
    const parent =
      parentOverride != null && parentOverride !== ''
        ? parentOverride
        : this.getBranchTip(branchId)
    const nodeId = randomUUID()
    db.prepare(
      `INSERT INTO nodes (id, parent_id, branch_id, created_at, label, manifest_json, conversation_cut_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nodeId,
      parent,
      branchId,
      Date.now(),
      label,
      JSON.stringify(manifest),
      conversationCutSeq
    )
    this.setBranchTip(branchId, nodeId)
    return { nodeId }
  }

  /** Record AI or manual save: same as checkpoint with preset label prefix */
  async recordSnapshot(
    branchId: string,
    kind: 'user' | 'ai',
    conversationCutSeq: number,
    detail?: string,
    parentOverride?: string | null
  ): Promise<{ nodeId: string }> {
    const label =
      kind === 'ai'
        ? `AI: ${detail ?? 'edit'}`
        : `Save: ${detail ?? 'checkpoint'}`
    return this.createCheckpoint(
      branchId,
      label,
      conversationCutSeq,
      parentOverride
    )
  }

  forkBranch(fromNodeId: string, name: string): {
    branchId: string
    sourceBranchId: string
    conversationCutSeq: number
  } {
    const db = this.requireDb()
    const node = this.getNode(fromNodeId)
    const exists = db
      .prepare(`SELECT id FROM branches WHERE name = ?`)
      .get(name) as { id: string } | undefined
    if (exists) throw new Error('Branch name already exists')
    const branchId = randomUUID()
    db.prepare(
      `INSERT INTO branches (id, name, tip_node_id) VALUES (?, ?, ?)`
    ).run(branchId, name, fromNodeId)
    return {
      branchId,
      sourceBranchId: node.branchId,
      conversationCutSeq: node.conversationCutSeq
    }
  }

  /**
   * Make the workspace match the node's manifest exactly: remove files not in the snapshot,
   * then write every path from blobs. Without deletion, older snapshots left "future" files on
   * disk and looked like wrong version / Git mismatch.
   */
  async restoreWorkingTreeToNode(nodeId: string): Promise<void> {
    const ws = this.requireWs()
    const { manifest } = this.getNode(nodeId)
    const keep = new Set(Object.keys(manifest))
    const onDisk = await listWorkspaceFiles(ws)
    for (const rel of onDisk) {
      if (!keep.has(rel)) {
        await deleteWorkspaceFile(ws, rel)
      }
    }
    for (const [rel, hash] of Object.entries(manifest)) {
      const content = await this.readBlob(hash)
      await writeWorkspaceFile(ws, rel, content)
    }
  }

  /** Compare workspace files to a specific version node's manifest (not necessarily branch tip). */
  async isWorkspaceDirtyAgainstNode(nodeId: string): Promise<boolean> {
    this.requireWs()
    const { manifest } = this.getNode(nodeId)
    const current = await this.buildManifestFromWorkspace()
    const keys = new Set([
      ...Object.keys(manifest),
      ...Object.keys(current)
    ])
    for (const k of keys) {
      if (manifest[k] !== current[k]) return true
    }
    return false
  }

  async isDirty(branchId: string): Promise<boolean> {
    const tipId = this.getBranchTip(branchId)
    return this.isWorkspaceDirtyAgainstNode(tipId)
  }

  /**
   * Remove `nodeId` and all descendants (children in the DAG). Repair each branch tip
   * by walking parents until a node outside the deleted set. Cannot delete a root (parent_id IS NULL).
   */
  deleteNodeAndDescendants(nodeId: string): { deletedIds: string[] } {
    const db = this.requireDb()
    const target = this.getNode(nodeId)
    if (target.parentId == null) {
      throw new Error('Cannot delete the root commit')
    }
    const allNodes = this.listNodes()
    const parentByChild = new Map<string, string | null>()
    const childrenByParent = new Map<string, string[]>()
    for (const n of allNodes) {
      parentByChild.set(n.id, n.parentId)
      if (n.parentId) {
        const ch = childrenByParent.get(n.parentId) ?? []
        ch.push(n.id)
        childrenByParent.set(n.parentId, ch)
      }
    }
    const toDelete = new Set<string>()
    const stack = [nodeId]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (toDelete.has(id)) continue
      toDelete.add(id)
      for (const c of childrenByParent.get(id) ?? []) {
        stack.push(c)
      }
    }
    if (toDelete.size >= allNodes.length) {
      throw new Error('Cannot delete all commits')
    }
    const branches = this.listBranches()
    for (const b of branches) {
      if (!toDelete.has(b.tipNodeId)) continue
      let cur: string | null = b.tipNodeId
      let survivor: string | null = null
      while (cur) {
        if (!toDelete.has(cur)) {
          survivor = cur
          break
        }
        cur = parentByChild.get(cur) ?? null
      }
      if (!survivor) {
        throw new Error(
          `Cannot delete: branch "${b.name}" would have no valid tip`
        )
      }
      db.prepare(`UPDATE branches SET tip_node_id = ? WHERE id = ?`).run(
        survivor,
        b.id
      )
    }
    const ids = [...toDelete]
    const ph = ids.map(() => '?').join(',')
    db.prepare(`DELETE FROM nodes WHERE id IN (${ph})`).run(...ids)
    return { deletedIds: ids }
  }

  countNodesOnBranch(branchId: string): number {
    const db = this.requireDb()
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM nodes WHERE branch_id = ?`)
      .get(branchId) as { c: number }
    return row.c
  }

  /**
   * Remove branches (except the named main, or the first branch if missing) that have
   * no `nodes.branch_id` rows — tip only points at another branch’s commit.
   */
  pruneBranchesWithoutOwnedNodes(mainBranchName: string): string[] {
    const db = this.requireDb()
    const branches = this.listBranches()
    if (branches.length === 0) return []
    const main =
      branches.find((b) => b.name === mainBranchName) ?? branches[0]
    const removed: string[] = []
    for (const b of branches) {
      if (b.id === main.id) continue
      if (this.countNodesOnBranch(b.id) > 0) continue
      db.prepare(`DELETE FROM branches WHERE id = ?`).run(b.id)
      removed.push(b.id)
    }
    return removed
  }
}
