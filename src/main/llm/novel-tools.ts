/** OpenAI Chat Completions `tools` array for novel workspace editing. */

export const NOVEL_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'patch_workspace_file',
      description:
        'Apply a minimal edit to a UTF-8 text file under the workspace: replace one exact occurrence of old_text with new_text. ' +
        'Read the current file (or excerpt in chat) first so old_text matches byte-for-byte including whitespace and newlines. ' +
        'To create a new file, set old_text to empty string "" and new_text to the full initial content. ' +
        'Do not paste the whole chapter in chat; use this tool and reply briefly.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'File path relative to the workspace root opened in the app (forward slashes, e.g. chapters/01.md). ' +
              'This is NOT necessarily the same path Git shows if the workspace folder is not the Git repository root.'
          },
          old_text: {
            type: 'string',
            description:
              'Exact snippet to find and replace once. Empty string only when creating a new file that does not exist yet.'
          },
          new_text: {
            type: 'string',
            description: 'Replacement text (may be empty to delete the matched snippet).'
          },
          replace_all: {
            type: 'boolean',
            description:
              'If true, replace every occurrence of old_text; if false (default), old_text must match exactly once.'
          }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  }
]

function normalizeRelPath(v: unknown): string {
  if (typeof v === 'string') {
    return v.replace(/\\/g, '/').replace(/^\//, '').trim()
  }
  if (v != null && (typeof v === 'number' || typeof v === 'boolean')) {
    return String(v).replace(/\\/g, '/').replace(/^\//, '').trim()
  }
  return ''
}

function extractJsonStringField(raw: string, key: string): string | null {
  const needle = `"${key}"`
  const idx = raw.indexOf(needle)
  if (idx === -1) return null
  const afterKey = raw.slice(idx + needle.length)
  const m = afterKey.match(/^\s*:\s*"/)
  if (!m) return null
  const start = idx + needle.length + m[0].length
  let out = ''
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\' && i + 1 < raw.length) {
      const n = raw[i + 1]
      if (n === 'n') out += '\n'
      else if (n === 'r') out += '\r'
      else if (n === 't') out += '\t'
      else out += n
      i += 2
      continue
    }
    if (ch === '"') break
    out += ch
    i++
  }
  return out
}

export function pickPatchWorkspaceFields(args: Record<string, unknown>): {
  path: string
  oldText: string
  newText: string
  replaceAll: boolean
} {
  const path = normalizeRelPath(
    args.path ??
      args.file ??
      args.filePath ??
      args.filepath ??
      args.Path
  )
  const oldText =
    typeof args.old_text === 'string'
      ? args.old_text
      : typeof args.oldText === 'string'
        ? args.oldText
        : ''
  const newText =
    typeof args.new_text === 'string'
      ? args.new_text
      : typeof args.newText === 'string'
        ? args.newText
        : ''
  const replaceAll =
    args.replace_all === true || args.replaceAll === true
  return { path, oldText, newText, replaceAll }
}

/**
 * Parse `patch_workspace_file` arguments from the raw JSON string the model sends.
 */
export function parsePatchWorkspaceFileArgs(raw: string | null | undefined): {
  path: string
  oldText: string
  newText: string
  replaceAll: boolean
} | null {
  const s = String(raw ?? '').trim()
  if (!s) return null

  try {
    const o = JSON.parse(s) as Record<string, unknown>
    const p = pickPatchWorkspaceFields(o)
    if (!p.path) return null
    return p
  } catch {
    /* salvage */
  }

  const pathRaw = extractJsonStringField(s, 'path')
  if (!pathRaw) return null
  const path = normalizeRelPath(pathRaw)
  if (!path) return null

  const oldText = extractJsonStringField(s, 'old_text') ?? ''
  const newText = extractJsonStringField(s, 'new_text') ?? ''
  const rm = s.match(/"replace_all"\s*:\s*(true|false)/)
  const replaceAll = rm ? rm[1] === 'true' : false

  return { path, oldText, newText, replaceAll }
}
