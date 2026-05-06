import { createHash } from 'crypto'
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  rm,
  unlink,
  rename,
  stat
} from 'fs/promises'
import { join, relative, sep } from 'path'

const NOVEL_DIR = '.novel'

export function isUnderNovel(rel: string): boolean {
  const n = rel.replace(/\\/g, '/')
  return n === NOVEL_DIR || n.startsWith(`${NOVEL_DIR}/`)
}

/** Reject empty, `..` segments, and `.novel`. */
export function normalizeSafeWorkspaceRelPath(raw: unknown): string | null {
  const s =
    typeof raw === 'string'
      ? raw
      : raw != null && (typeof raw === 'number' || typeof raw === 'boolean')
        ? String(raw)
        : ''
  const n = s.replace(/\\/g, '/').replace(/^\//, '').trim()
  if (!n) return null
  for (const seg of n.split('/')) {
    if (seg === '..') return null
  }
  if (isUnderNovel(n)) return null
  return n
}

export const WORKSPACE_TOOL_MAX_READ_CHARS = 56_000
export const WORKSPACE_TOOL_MAX_FILE_BYTES = 2_000_000
export const WORKSPACE_SEARCH_MAX_HITS = 80
export const WORKSPACE_SEARCH_MAX_FILE_BYTES = 400_000
export const WORKSPACE_LIST_MAX_PATHS = 8_000

export type WorkspaceSearchHit = {
  path: string
  line: number
  excerpt: string
}

export async function readWorkspaceFileForTool(
  workspaceRoot: string,
  relPath: string,
  lineStart?: number | null,
  lineEnd?: number | null
): Promise<
  | {
      ok: true
      path: string
      content: string
      total_lines: number
      range?: { start: number; end: number }
      truncated?: boolean
    }
  | { ok: false; error: string }
> {
  let buf: Buffer
  try {
    buf = await readWorkspaceFile(workspaceRoot, relPath)
  } catch {
    return { ok: false, error: 'File not found or not readable' }
  }
  if (buf.length > WORKSPACE_TOOL_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `File exceeds ${WORKSPACE_TOOL_MAX_FILE_BYTES} bytes; use line_start and line_end to read a range.`
    }
  }
  const text = buf.toString('utf8')
  const lines = text.split(/\r?\n/)
  const total = Math.max(1, lines.length)
  const hasRange =
    (lineStart != null && lineStart >= 1) || (lineEnd != null && lineEnd >= 1)
  let start = 1
  let end = total
  if (hasRange) {
    start =
      lineStart != null && lineStart >= 1 ? Math.min(lineStart, total) : 1
    end = lineEnd != null && lineEnd >= 1 ? Math.min(lineEnd, total) : total
    if (end < start) end = start
  }
  const sliceLines = lines.slice(start - 1, end)
  const body = hasRange
    ? sliceLines
        .map((line, i) => `${String(start + i).padStart(6)}| ${line}`)
        .join('\n')
    : text
  let truncated = false
  let content = body
  if (content.length > WORKSPACE_TOOL_MAX_READ_CHARS) {
    content =
      content.slice(0, WORKSPACE_TOOL_MAX_READ_CHARS) +
      '\n\n…(truncated; narrow line_start/line_end or read in chunks)'
    truncated = true
  }
  return {
    ok: true,
    path: relPath,
    content,
    total_lines: total,
    range: hasRange ? { start, end } : undefined,
    truncated
  }
}

export async function listWorkspaceFilesWithPrefix(
  workspaceRoot: string,
  pathPrefix: string | null | undefined
): Promise<{
  paths: string[]
  truncated: boolean
}> {
  const all = await listWorkspaceFiles(workspaceRoot)
  let paths = all
  if (pathPrefix != null && String(pathPrefix).trim() !== '') {
    const p = String(pathPrefix).replace(/\\/g, '/').replace(/^\//, '').trim()
    const pre = p.endsWith('/') ? p.slice(0, -1) : p
    paths = all.filter(
      (x) => x === pre || x.startsWith(`${pre}/`)
    )
  }
  const truncated = paths.length > WORKSPACE_LIST_MAX_PATHS
  if (truncated) {
    paths = paths.slice(0, WORKSPACE_LIST_MAX_PATHS)
  }
  return { paths, truncated }
}

export async function searchWorkspaceLiteral(
  workspaceRoot: string,
  query: string,
  options?: {
    pathPrefix?: string | null
    caseInsensitive?: boolean
    maxHits?: number
    maxFileBytes?: number
  }
): Promise<
  | { ok: true; hits: WorkspaceSearchHit[]; truncated: boolean }
  | { ok: false; error: string }
> {
  const q = query.trim()
  if (!q) return { ok: false, error: 'query must be non-empty' }
  const maxHits = options?.maxHits ?? WORKSPACE_SEARCH_MAX_HITS
  const maxFileBytes =
    options?.maxFileBytes ?? WORKSPACE_SEARCH_MAX_FILE_BYTES
  const ci = options?.caseInsensitive === true
  const needle = ci ? q.toLowerCase() : q
  const { paths } = await listWorkspaceFilesWithPrefix(
    workspaceRoot,
    options?.pathPrefix
  )
  const hits: WorkspaceSearchHit[] = []
  for (const rel of paths) {
    if (hits.length >= maxHits) break
    let buf: Buffer
    try {
      buf = await readWorkspaceFile(workspaceRoot, rel)
    } catch {
      continue
    }
    if (buf.length > maxFileBytes) continue
    const text = buf.toString('utf8')
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= maxHits) break
      const line = lines[i]
      const hay = ci ? line.toLowerCase() : line
      if (hay.includes(needle)) {
        hits.push({
          path: rel,
          line: i + 1,
          excerpt: line.length > 220 ? `${line.slice(0, 220)}…` : line
        })
      }
    }
  }
  return { ok: true, hits, truncated: hits.length >= maxHits }
}

export async function createWorkspaceFile(
  workspaceRoot: string,
  relPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const n = normalizeSafeWorkspaceRelPath(relPath)
  if (!n) return { ok: false, error: 'Invalid path' }
  const full = join(workspaceRoot, n)
  try {
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, '', { flag: 'wx' })
    return { ok: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      return { ok: false, error: 'File already exists' }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export async function createWorkspaceDir(
  workspaceRoot: string,
  relPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const n = normalizeSafeWorkspaceRelPath(relPath)
  if (!n) return { ok: false, error: 'Invalid path' }
  const full = join(workspaceRoot, n)
  try {
    await mkdir(full, { recursive: true })
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export async function deleteWorkspaceEntry(
  workspaceRoot: string,
  relPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const n = normalizeSafeWorkspaceRelPath(relPath)
  if (!n) return { ok: false, error: 'Invalid path' }
  const full = join(workspaceRoot, n)
  try {
    const st = await stat(full)
    if (st.isDirectory()) {
      await rm(full, { recursive: true, force: true })
    } else {
      await unlink(full)
    }
    return { ok: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, error: 'Path does not exist' }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export async function renameWorkspaceEntry(
  workspaceRoot: string,
  fromRel: string,
  toRel: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const a = normalizeSafeWorkspaceRelPath(fromRel)
  const b = normalizeSafeWorkspaceRelPath(toRel)
  if (!a || !b) return { ok: false, error: 'Invalid path' }
  const fromFull = join(workspaceRoot, a)
  const toFull = join(workspaceRoot, b)
  try {
    await mkdir(join(toFull, '..'), { recursive: true })
    await rename(fromFull, toFull)
    return { ok: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, error: 'Source path does not exist' }
    }
    if (code === 'EEXIST') {
      return { ok: false, error: 'Destination already exists' }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export async function deleteWorkspaceFileIfExists(
  workspaceRoot: string,
  relPath: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const full = join(workspaceRoot, relPath)
  try {
    await unlink(full)
    return { ok: true }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, error: 'File does not exist' }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

async function walkFiles(
  root: string,
  base: string,
  out: string[]
): Promise<void> {
  const entries = await readdir(base, { withFileTypes: true })
  for (const e of entries) {
    const full = join(base, e.name)
    const rel = relative(root, full).split(sep).join('/')
    if (isUnderNovel(rel)) continue
    if (e.isDirectory()) {
      await walkFiles(root, full, out)
    } else if (e.isFile()) {
      out.push(rel)
    }
  }
}

export async function listWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  const out: string[] = []
  await walkFiles(workspaceRoot, workspaceRoot, out)
  return out.sort()
}

export function hashContent(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  relPath: string
): Promise<Buffer> {
  const full = join(workspaceRoot, relPath)
  return readFile(full)
}

export async function writeWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  content: Buffer | string
): Promise<void> {
  const full = join(workspaceRoot, relPath)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content, typeof content === 'string' ? 'utf8' : undefined)
}

/**
 * Replace `oldText` with `newText` in a workspace text file (exact substring match).
 * - New file: file missing and `oldText === ''` → write `newText`.
 * - Existing file: `oldText` must match at least once; if `replaceAll`, all matches are replaced, else exactly one match.
 */
export async function patchWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  oldText: string,
  newText: string,
  replaceAll: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const full = join(workspaceRoot, relPath)
  let current: string
  try {
    current = await readFile(full, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      if (oldText !== '') {
        return {
          ok: false,
          error:
            'File does not exist. To create it, pass old_text as empty string "" and new_text as the full file body.'
        }
      }
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, newText, 'utf8')
      return { ok: true }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }

  if (oldText === '') {
    return {
      ok: false,
      error:
        'File already exists; old_text cannot be empty. Provide the exact span to replace (copy from the file).'
    }
  }

  const occurrences = current.split(oldText).length - 1
  if (occurrences === 0) {
    return {
      ok: false,
      error:
        'old_text not found (exact match). Re-read the file; whitespace, quotes, or line endings must match exactly.'
    }
  }
  if (!replaceAll && occurrences > 1) {
    return {
      ok: false,
      error: `old_text matches ${occurrences} times; use a longer unique snippet or set replace_all to true.`
    }
  }

  const next = replaceAll
    ? current.split(oldText).join(newText)
    : current.replace(oldText, newText)
  await writeFile(full, next, 'utf8')
  return { ok: true }
}

export async function deleteWorkspaceFile(
  workspaceRoot: string,
  relPath: string
): Promise<void> {
  const full = join(workspaceRoot, relPath)
  await unlink(full).catch(() => undefined)
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
