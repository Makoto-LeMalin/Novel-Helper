import { createHash } from 'crypto'
import { readdir, readFile, writeFile, mkdir, rm, unlink } from 'fs/promises'
import { join, relative, sep } from 'path'

const NOVEL_DIR = '.novel'

export function isUnderNovel(rel: string): boolean {
  const n = rel.replace(/\\/g, '/')
  return n === NOVEL_DIR || n.startsWith(`${NOVEL_DIR}/`)
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
