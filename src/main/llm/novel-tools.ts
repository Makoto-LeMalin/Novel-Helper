/** OpenAI Chat Completions `tools` array for novel workspace editing. */

import { normalizeSafeWorkspaceRelPath } from '../files/file-service'

export const NOVEL_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_workspace_file',
      description:
        'Read a UTF-8 text file under the workspace by relative path. ' +
        'Use optional line_start / line_end (1-based, inclusive) to fetch a slice; output includes line numbers in that mode. ' +
        'Large output is truncated (~56k chars) with a hint to narrow the range. ' +
        'Prefer this (or search_workspace) before patch_workspace_file so old_text matches exactly.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path relative to the workspace root (forward slashes). Not inside `.novel`.'
          },
          line_start: {
            type: 'integer',
            description:
              'Optional 1-based start line. If either line bound is set, only that range is returned (with line numbers).'
          },
          line_end: {
            type: 'integer',
            description: 'Optional 1-based end line (inclusive).'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_workspace_files',
      description:
        'List relative paths of all files under the workspace (excluding `.novel`). ' +
        'Optional path_prefix limits to files under that directory prefix.',
      parameters: {
        type: 'object',
        properties: {
          path_prefix: {
            type: 'string',
            description:
              'Optional directory prefix relative to workspace (e.g. `chapters`). Empty or omit for entire workspace.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_workspace',
      description:
        'Literal substring search across workspace UTF-8 text files (excluding `.novel`). ' +
        'Returns path, line, and excerpt per hit; capped (~80 hits). Skips very large files. ' +
        'Use read_workspace_file for full content after locating a path.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Non-empty literal string to search for (not regex).'
          },
          path_prefix: {
            type: 'string',
            description: 'Optional: only search under this relative directory prefix.'
          },
          case_insensitive: {
            type: 'boolean',
            description: 'If true, match case-insensitively.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'patch_workspace_file',
      description:
        'Apply a minimal edit to a UTF-8 text file: replace one exact occurrence of old_text with new_text. ' +
        'Read the current file (or a line range via read_workspace_file) first so old_text matches byte-for-byte. ' +
        'To create a new file, set old_text to "" and new_text to the full initial content. ' +
        'For replacing an entire existing file, prefer write_workspace_file.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'File path relative to the workspace root (forward slashes, e.g. chapters/01.md).'
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
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_workspace_file',
      description:
        'Overwrite an entire workspace file with new UTF-8 content. Creates parent directories if needed. ' +
        'Use for full rewrites; use patch_workspace_file for small targeted edits.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path under the workspace (not `.novel`).'
          },
          content: {
            type: 'string',
            description: 'Full new file body.'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_workspace_file',
      description:
        'Delete a single file under the workspace by relative path. Fails if the file does not exist.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path (not `.novel`).'
          }
        },
        required: ['path']
      }
    }
  }
]

function pathField(args: Record<string, unknown>): unknown {
  return (
    args.path ??
    args.file ??
    args.filePath ??
    args.filepath ??
    args.Path
  )
}

function optionalPositiveInt(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.floor(n)
}

function optionalPathPrefix(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  return normalizeSafeWorkspaceRelPath(s)
}

export function pickReadWorkspaceFields(args: Record<string, unknown>): {
  path: string
  lineStart: number | null
  lineEnd: number | null
} | null {
  const path = normalizeSafeWorkspaceRelPath(pathField(args))
  if (!path) return null
  return {
    path,
    lineStart: optionalPositiveInt(args.line_start ?? args.lineStart),
    lineEnd: optionalPositiveInt(args.line_end ?? args.lineEnd)
  }
}

export function pickListWorkspaceFields(args: Record<string, unknown>): {
  pathPrefix: string | null
} | null {
  const rawPrefix = args.path_prefix ?? args.pathPrefix
  if (rawPrefix == null || String(rawPrefix).trim() === '') {
    return { pathPrefix: null }
  }
  const pathPrefix = optionalPathPrefix(rawPrefix)
  if (!pathPrefix) return null
  return { pathPrefix }
}

const SEARCH_QUERY_MAX = 2000

export function pickSearchWorkspaceFields(args: Record<string, unknown>): {
  query: string
  pathPrefix: string | null
  caseInsensitive: boolean
} | null {
  const qRaw = args.query ?? args.q ?? args.needle
  const query =
    typeof qRaw === 'string'
      ? qRaw
      : qRaw != null
        ? String(qRaw)
        : ''
  const trimmed = query.trim()
  if (!trimmed) return null
  if (trimmed.length > SEARCH_QUERY_MAX) return null
  const rawPrefix = args.path_prefix ?? args.pathPrefix
  let pathPrefix: string | null = null
  if (rawPrefix != null && String(rawPrefix).trim() !== '') {
    pathPrefix = optionalPathPrefix(rawPrefix)
    if (!pathPrefix) return null
  }
  return {
    query: trimmed,
    pathPrefix,
    caseInsensitive:
      args.case_insensitive === true || args.caseInsensitive === true
  }
}

export function pickWriteWorkspaceFields(args: Record<string, unknown>): {
  path: string
  content: string
} | null {
  const path = normalizeSafeWorkspaceRelPath(pathField(args))
  if (!path) return null
  const c = args.content
  const content = typeof c === 'string' ? c : c != null ? String(c) : ''
  return { path, content }
}

export function pickDeleteWorkspaceFields(args: Record<string, unknown>): {
  path: string
} | null {
  const path = normalizeSafeWorkspaceRelPath(pathField(args))
  if (!path) return null
  return { path }
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
  const path = normalizeSafeWorkspaceRelPath(pathField(args)) ?? ''
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
  const path = normalizeSafeWorkspaceRelPath(pathRaw)
  if (!path) return null

  const oldText = extractJsonStringField(s, 'old_text') ?? ''
  const newText = extractJsonStringField(s, 'new_text') ?? ''
  const rm = s.match(/"replace_all"\s*:\s*(true|false)/)
  const replaceAll = rm ? rm[1] === 'true' : false

  return { path, oldText, newText, replaceAll }
}
