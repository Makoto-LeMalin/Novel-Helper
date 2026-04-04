import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import type { AppSettings } from '../../shared/ipc'
import type { ChatTurnBlock } from '../../shared/chat-stream'
import {
  createEmbedding,
  chatCompletionComplete,
  type ChatMessage
} from '../llm/openai-client'

const NOVEL = '.novel'

function memoryDbPath(workspaceRoot: string): string {
  return join(workspaceRoot, NOVEL, 'memory.db')
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

export class MemoryService {
  private db: Database.Database | null = null
  private ws: string | null = null

  open(workspaceRoot: string): void {
    this.close()
    this.ws = workspaceRoot
    const novel = join(workspaceRoot, NOVEL)
    if (!existsSync(novel)) mkdirSync(novel, { recursive: true })
    this.db = new Database(memoryDbPath(workspaceRoot))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_branch_seq ON messages(branch_id, seq);
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        up_to_seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_branch ON summaries(branch_id, up_to_seq);
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        text TEXT NOT NULL,
        vec BLOB NOT NULL,
        dim INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_emb_branch ON embeddings(branch_id);
    `)
    this.ensureBlocksColumn()
  }

  private ensureBlocksColumn(): void {
    const db = this.requireDb()
    const cols = db.prepare(`PRAGMA table_info(messages)`).all() as {
      name: string
    }[]
    if (!cols.some((c) => c.name === 'blocks')) {
      db.exec(`ALTER TABLE messages ADD COLUMN blocks TEXT`)
    }
  }

  private parseBlocks(raw: string | null | undefined): ChatTurnBlock[] | null {
    if (raw == null || raw === '') return null
    try {
      const v = JSON.parse(raw) as unknown
      if (!Array.isArray(v)) return null
      return v as ChatTurnBlock[]
    } catch {
      return null
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.ws = null
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('Memory DB not open')
    return this.db
  }

  nextSeq(branchId: string): number {
    const db = this.requireDb()
    const row = db
      .prepare(`SELECT MAX(seq) as m FROM messages WHERE branch_id = ?`)
      .get(branchId) as { m: number | null }
    return (row.m ?? 0) + 1
  }

  maxSeq(branchId: string): number {
    const db = this.requireDb()
    const row = db
      .prepare(`SELECT MAX(seq) as m FROM messages WHERE branch_id = ?`)
      .get(branchId) as { m: number | null }
    return row.m ?? 0
  }

  /** Copy messages from source branch up to maxSeq into empty target branch. */
  copyMessagesForFork(
    fromBranchId: string,
    toBranchId: string,
    maxSeqInclusive: number
  ): void {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT role, content, created_at, blocks FROM messages WHERE branch_id = ? AND seq <= ? ORDER BY seq ASC`
      )
      .all(fromBranchId, maxSeqInclusive) as Array<{
      role: string
      content: string
      created_at: number
      blocks: string | null
    }>
    let seq = 1
    const ins = db.prepare(
      `INSERT INTO messages (id, branch_id, seq, role, content, created_at, blocks)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const r of rows) {
      ins.run(
        randomUUID(),
        toBranchId,
        seq++,
        r.role,
        r.content,
        r.created_at,
        r.blocks
      )
    }
  }

  appendMessage(
    branchId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    id: string,
    blocks?: ChatTurnBlock[] | null
  ): { seq: number } {
    const db = this.requireDb()
    const seq = this.nextSeq(branchId)
    const blocksJson =
      blocks != null && blocks.length > 0 ? JSON.stringify(blocks) : null
    db.prepare(
      `INSERT INTO messages (id, branch_id, seq, role, content, created_at, blocks)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, branchId, seq, role, content, Date.now(), blocksJson)
    return { seq }
  }

  getRecentMessages(
    branchId: string,
    limit: number
  ): Array<{
    role: string
    content: string
    seq: number
    blocks: ChatTurnBlock[] | null
  }> {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT role, content, seq, blocks FROM messages WHERE branch_id = ?
         ORDER BY seq DESC LIMIT ?`
      )
      .all(branchId, limit)
      .reverse() as Array<{
      role: string
      content: string
      seq: number
      blocks: string | null
    }>
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      seq: r.seq,
      blocks: this.parseBlocks(r.blocks)
    }))
  }

  getMessagesUpToSeq(
    branchId: string,
    maxSeq: number
  ): Array<{
    role: string
    content: string
    seq: number
    blocks: ChatTurnBlock[] | null
  }> {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT role, content, seq, blocks FROM messages WHERE branch_id = ? AND seq <= ?
         ORDER BY seq ASC`
      )
      .all(branchId, maxSeq) as Array<{
      role: string
      content: string
      seq: number
      blocks: string | null
    }>
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      seq: r.seq,
      blocks: this.parseBlocks(r.blocks)
    }))
  }

  latestSummary(branchId: string): { text: string; upToSeq: number } | null {
    const db = this.requireDb()
    const row = db
      .prepare(
        `SELECT text, up_to_seq FROM summaries WHERE branch_id = ?
         ORDER BY up_to_seq DESC LIMIT 1`
      )
      .get(branchId) as { text: string; up_to_seq: number } | undefined
    if (!row) return null
    return { text: row.text, upToSeq: row.up_to_seq }
  }

  saveSummary(branchId: string, upToSeq: number, text: string, id: string): void {
    const db = this.requireDb()
    db.prepare(
      `INSERT INTO summaries (id, branch_id, up_to_seq, text, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, branchId, upToSeq, text, Date.now())
  }

  storeEmbedding(
    branchId: string,
    text: string,
    vec: Float32Array,
    sourceType: string,
    sourceRef: string | null,
    id: string
  ): void {
    const db = this.requireDb()
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
    db.prepare(
      `INSERT INTO embeddings (id, branch_id, text, vec, dim, source_type, source_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      branchId,
      text,
      buf,
      vec.length,
      sourceType,
      sourceRef,
      Date.now()
    )
  }

  retrieveSimilar(
    branchId: string,
    queryVec: Float32Array,
    topK: number
  ): Array<{ text: string; score: number }> {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT text, vec, dim FROM embeddings WHERE branch_id = ?`
      )
      .all(branchId) as Array<{ text: string; vec: Buffer; dim: number }>
    const scored = rows.map((r) => {
      const arr = new Float32Array(
        r.vec.buffer,
        r.vec.byteOffset,
        r.dim
      )
      return { text: r.text, score: cosine(queryVec, arr) }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  clearBranch(branchId: string): void {
    const db = this.requireDb()
    db.prepare(`DELETE FROM messages WHERE branch_id = ?`).run(branchId)
    db.prepare(`DELETE FROM summaries WHERE branch_id = ?`).run(branchId)
    db.prepare(`DELETE FROM embeddings WHERE branch_id = ?`).run(branchId)
  }

  /** After new user message: optionally summarize + embed */
  async onUserMessagePersisted(
    settings: AppSettings,
    branchId: string,
    userContent: string
  ): Promise<void> {
    if (!settings.memoryEnabled || !settings.openAiApiKey) return
    try {
      const emb = await createEmbedding(settings, userContent)
      this.storeEmbedding(
        branchId,
        userContent.slice(0, 2000),
        emb,
        'user_turn',
        null,
        randomUUID()
      )
    } catch {
      /* embedding optional failure */
    }

    const db = this.requireDb()
    const count = db
      .prepare(`SELECT COUNT(*) as c FROM messages WHERE branch_id = ?`)
      .get(branchId) as { c: number }
    const n = settings.memorySummaryEveryN
    if (n > 0 && count.c > 0 && count.c % n === 0) {
      await this.rollSummary(settings, branchId)
    }
  }

  private async rollSummary(
    settings: AppSettings,
    branchId: string
  ): Promise<void> {
    const recent = this.getRecentMessages(branchId, settings.memorySummaryEveryN)
    if (recent.length === 0) return
    const minSeq = Math.min(...recent.map((m) => m.seq))
    const maxSeq = Math.max(...recent.map((m) => m.seq))
    const prev = this.latestSummary(branchId)
    const lines = recent.map((m) => `${m.role}: ${m.content}`).join('\n\n')
    const sys =
      'You consolidate novel-writing chat into a compact memory for future turns. ' +
      'Capture plot facts, character notes, user preferences, and open threads. ' +
      'Use concise bullet points. Respond in the same language as the chat.'
    const messages: ChatMessage[] = [
      { role: 'system', content: sys },
      ...(prev ? [{ role: 'user' as const, content: `Prior memory:\n${prev.text}` }] : []),
      {
        role: 'user',
        content: `Summarize this segment (messages seq ${minSeq}-${maxSeq}):\n\n${lines}`
      }
    ]
    try {
      const text = await chatCompletionComplete(settings, messages)
      this.saveSummary(branchId, maxSeq, text, randomUUID())
      if (settings.openAiApiKey) {
        const emb = await createEmbedding(settings, text.slice(0, 8000))
        this.storeEmbedding(
          branchId,
          text.slice(0, 2000),
          emb,
          'summary',
          String(maxSeq),
          randomUUID()
        )
      }
    } catch {
      /* ignore */
    }
  }

  async buildAugmentedMessages(
    settings: AppSettings,
    branchId: string,
    filePath: string | null,
    fileContext: string,
    userMessage: string
  ): Promise<ChatMessage[]> {
    const recent = this.getRecentMessages(
      branchId,
      settings.memoryRecentMessages
    )
    const summary = this.latestSummary(branchId)
    let memoryBlock = ''
    if (summary) {
      memoryBlock += `Long-term summary (up to message #${summary.upToSeq}):\n${summary.text}\n\n`
    }
    if (settings.memoryEnabled && settings.openAiApiKey) {
      try {
        const q = await createEmbedding(settings, userMessage)
        const hits = this.retrieveSimilar(
          branchId,
          q,
          settings.memoryRetrieveTopK
        )
        if (hits.length) {
          memoryBlock +=
            'Retrieved relevant memories:\n' +
            hits.map((h) => `- ${h.text}`).join('\n') +
            '\n\n'
        }
      } catch {
        /* skip retrieval */
      }
    }
    const pathNorm = filePath ? filePath.replace(/\\/g, '/') : ''
    const fileBlock =
      pathNorm && fileContext
        ? `Current open file path (relative to workspace): \`${pathNorm}\`\n\nExcerpt:\n${fileContext}`
        : pathNorm && !fileContext
          ? `Current open file path (relative to workspace): \`${pathNorm}\`.\n` +
            '(No excerpt was attached — file may be unreadable, under `.novel`, or empty.)'
          : ''

    const systemParts = [
      'You are an AI assistant helping the user write a novel. ' +
        'When you need to change or create chapter/manuscript text in the workspace, you MUST call the tool `patch_workspace_file`: ' +
        'provide path (relative to the workspace folder opened in this app), old_text (exact snippet to replace, or empty string only to create a missing file), new_text, and replace_all only when replacing every occurrence. ' +
        'Paths are relative to that workspace root — if the user uses Git in a parent directory, Git path prefixes may differ until they open the repo root as the workspace. ' +
        'Do not paste entire chapters in chat; reply briefly. If the user only wants discussion without changing files, respond without the tool.',
      memoryBlock && `Memory / context:\n${memoryBlock}`,
      fileBlock
    ].filter(Boolean)
    const messages: ChatMessage[] = [
      { role: 'system', content: systemParts.join('\n\n') }
    ]
    for (const m of recent) {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content
        })
      }
    }
    messages.push({ role: 'user', content: userMessage })
    return messages
  }
}
