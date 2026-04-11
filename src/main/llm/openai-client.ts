import { randomUUID } from 'crypto'
import type { AppSettings } from '../../shared/ipc'
import type { ChatStreamEvent, ChatTurnBlock } from '../../shared/chat-stream'
import {
  NOVEL_TOOLS,
  parsePatchWorkspaceFileArgs,
  pickPatchWorkspaceFields
} from './novel-tools'

const DISK_MUTATING_TOOLS = new Set([
  'patch_workspace_file',
  'write_workspace_file',
  'delete_workspace_file'
])

function parseToolResultJson(
  toolContent: string
): Record<string, unknown> | null {
  try {
    return JSON.parse(toolContent) as Record<string, unknown>
  } catch {
    return null
  }
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ApiChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

const TOOL_ROUNDS_MAX = 16
/** Per-request cap; hung TCP/HTTP otherwise leaves UI stuck on "…" forever. */
const CHAT_COMPLETION_TIMEOUT_MS = 420_000

/** User cancelled generation (stop button); distinct from timeout AbortError. */
export class ChatCancelledError extends Error {
  override readonly name = 'ChatCancelledError'
  constructor() {
    super('Chat cancelled')
  }
}

/** Body reader / stream may reject with native AbortError while user signal is aborted. */
function isAbortDueToUserCancel(
  e: unknown,
  userSignal: AbortSignal | null | undefined
): boolean {
  if (!userSignal?.aborted) return false
  if (e instanceof ChatCancelledError) return true
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    (e as { name: string }).name === 'AbortError'
  )
}

function streamFetchSignal(user: AbortSignal | null | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(CHAT_COMPLETION_TIMEOUT_MS)
  if (!user) return timeout
  return AbortSignal.any([user, timeout])
}

function chatMessagesToApi(msgs: ChatMessage[]): ApiChatMessage[] {
  return msgs.map((m) => ({
    role: m.role,
    content: m.content
  })) as ApiChatMessage[]
}

type StreamToolDelta = {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

function mergeStreamToolShard(
  acc: Map<number, { id: string; name: string; args: string }>,
  tc: StreamToolDelta
): void {
  const idx = tc.index ?? 0
  let slot = acc.get(idx)
  if (!slot) {
    slot = { id: '', name: '', args: '' }
    acc.set(idx, slot)
  }
  if (tc.id) slot.id = tc.id
  if (tc.function?.name) slot.name = tc.function.name
  if (tc.function?.arguments) slot.args += tc.function.arguments
}

function toolCallsFromAcc(
  acc: Map<number, { id: string; name: string; args: string }>
): ToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || `call_${randomUUID()}`,
      type: 'function' as const,
      function: { name: v.name, arguments: v.args }
    }))
}

function emitToolCallsComplete(
  roundIndex: number,
  toolAcc: Map<number, { id: string; name: string; args: string }>,
  onStreamEvent: (e: ChatStreamEvent) => void
): void {
  const list = [...toolAcc.entries()].sort((a, b) => a[0] - b[0])
  for (const [idx, slot] of list) {
    onStreamEvent({
      type: 'tool_call',
      id: slot.id || `pending-r${roundIndex}-i${idx}`,
      name: slot.name || 'function',
      arguments: slot.args,
      phase: 'complete',
      callIndex: idx,
      round: roundIndex
    })
  }
}

/**
 * One streaming chat completion round (tools + SSE).
 */
async function streamChatCompletionRound(
  settings: AppSettings,
  messages: ApiChatMessage[],
  roundIndex: number,
  onStreamEvent: (e: ChatStreamEvent) => void,
  cancelSignal: AbortSignal | null | undefined
): Promise<{
  message: {
    role: string
    content: string | null
    tool_calls?: ToolCall[]
  }
  finish_reason: string
}> {
  const base = normalizeBaseUrl(settings.openAiBaseUrl)
  const url = `${base}/chat/completions`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openAiApiKey}`
      },
      body: JSON.stringify({
        model: settings.chatModel,
        messages,
        tools: NOVEL_TOOLS,
        tool_choice: 'auto',
        stream: true
      }),
      signal: streamFetchSignal(cancelSignal ?? undefined)
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      if (cancelSignal?.aborted) throw new ChatCancelledError()
      throw new Error(
        `Chat request timed out after ${CHAT_COMPLETION_TIMEOUT_MS / 1000}s (no response from ${url}). Check network or API availability.`
      )
    }
    throw e
  }
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Chat failed: ${res.status} ${t}`)
  }
  const body = res.body
  if (!body) throw new Error('No response body')

  let assistantContent = ''
  let finishReason = 'stop'
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    if (cancelSignal?.aborted) throw new ChatCancelledError()
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (payload === '[DONE]') {
        const toolCalls =
          toolAcc.size > 0 ? toolCallsFromAcc(toolAcc) : undefined
        if (toolCalls?.length) {
          emitToolCallsComplete(roundIndex, toolAcc, onStreamEvent)
          return {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: assistantContent.length ? assistantContent : null,
              tool_calls: toolCalls
            }
          }
        }
        return {
          finish_reason: finishReason,
          message: {
            role: 'assistant',
            content: assistantContent.length ? assistantContent : null
          }
        }
      }
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string | null
              tool_calls?: StreamToolDelta[]
            }
            finish_reason?: string | null
          }>
          error?: { message?: string }
        }
        if (json.error?.message) {
          throw new Error(json.error.message)
        }
        const choice = json.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) {
          assistantContent += delta.content
          onStreamEvent({ type: 'text_delta', text: delta.content })
        }
        if (delta?.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            mergeStreamToolShard(toolAcc, tc)
            const idx = tc.index ?? 0
            const slot = toolAcc.get(idx)
            if (slot) {
              onStreamEvent({
                type: 'tool_call',
                id: slot.id || `pending-r${roundIndex}-i${idx}`,
                name: slot.name || 'function',
                arguments: slot.args,
                phase: 'streaming',
                callIndex: idx,
                round: roundIndex
              })
            }
          }
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue
        throw e
      }
    }
  }

  const toolCalls = toolAcc.size > 0 ? toolCallsFromAcc(toolAcc) : undefined
  if (toolCalls?.length) {
    emitToolCallsComplete(roundIndex, toolAcc, onStreamEvent)
    return {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: assistantContent.length ? assistantContent : null,
        tool_calls: toolCalls
      }
    }
  }
  return {
    finish_reason: finishReason,
    message: {
      role: 'assistant',
      content: assistantContent.length ? assistantContent : null
    }
  }
}

export type ChatWithToolsOptions = {
  onStreamEvent?: (e: ChatStreamEvent) => void
  signal?: AbortSignal | null
}

export type ChatToolLoopResult = {
  assistantText: string
  writtenPaths: string[]
  turnBlocks: ChatTurnBlock[]
  cancelled: boolean
}

function summarizeToolExecution(
  name: string,
  args: Record<string, unknown>,
  toolContent: string
): { ok: boolean; summary: string; path?: string } {
  const parsed = parseToolResultJson(toolContent)

  if (name === 'patch_workspace_file') {
    if (!parsed) return { ok: false, summary: '工具返回无效' }
    const { path: rel } = pickPatchWorkspaceFields(args)
    const ok = parsed.ok === true
    return {
      ok,
      summary: ok ? `已更新 ${rel}` : String(parsed.error ?? '修补失败'),
      path: rel || undefined
    }
  }

  if (name === 'read_workspace_file') {
    if (!parsed) return { ok: false, summary: '工具返回无效' }
    const ok = parsed.ok === true
    const rel = typeof parsed.path === 'string' ? parsed.path : ''
    return {
      ok,
      summary: ok ? `已读取 ${rel || '文件'}` : String(parsed.error ?? '读取失败'),
      path: rel || undefined
    }
  }

  if (name === 'list_workspace_files') {
    if (!parsed) return { ok: false, summary: '工具返回无效' }
    const ok = parsed.ok === true
    const n = typeof parsed.count === 'number' ? parsed.count : 0
    const truncated = parsed.truncated === true ? '（列表已截断）' : ''
    return {
      ok,
      summary: ok ? `列出 ${n} 个文件${truncated}` : String(parsed.error ?? '列出失败')
    }
  }

  if (name === 'search_workspace') {
    if (!parsed) return { ok: false, summary: '工具返回无效' }
    const ok = parsed.ok === true
    const n = typeof parsed.count === 'number' ? parsed.count : 0
    const truncated = parsed.truncated === true ? '（结果已截断）' : ''
    return {
      ok,
      summary: ok ? `搜索命中 ${n} 处${truncated}` : String(parsed.error ?? '搜索失败')
    }
  }

  if (name === 'write_workspace_file') {
    if (!parsed) return { ok: false, summary: '工具返回无效' }
    const ok = parsed.ok === true
    const rel = typeof parsed.path === 'string' ? parsed.path : ''
    return {
      ok,
      summary: ok ? `已写入 ${rel}` : String(parsed.error ?? '写入失败'),
      path: rel || undefined
    }
  }

  if (name === 'delete_workspace_file') {
    if (!parsed) return { ok: false, summary: '工具返回无效' }
    const ok = parsed.ok === true
    const rel = typeof parsed.path === 'string' ? parsed.path : ''
    return {
      ok,
      summary: ok ? `已删除 ${rel}` : String(parsed.error ?? '删除失败'),
      path: rel || undefined
    }
  }

  return {
    ok: true,
    summary:
      toolContent.length > 240 ? `${toolContent.slice(0, 240)}…` : toolContent
  }
}

/**
 * Streaming chat with tools; runs tool rounds until the model returns without tool_calls.
 */
export async function runChatWithToolLoop(
  settings: AppSettings,
  initialMessages: ChatMessage[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  options?: ChatWithToolsOptions
): Promise<ChatToolLoopResult> {
  const messages: ApiChatMessage[] = chatMessagesToApi(initialMessages)
  const writtenPaths: string[] = []
  const turnBlocks: ChatTurnBlock[] = []
  const emit = (e: ChatStreamEvent) => options?.onStreamEvent?.(e)
  const signal = options?.signal
  let assistantTextAllRounds = ''

  const bailCancelled = (): ChatToolLoopResult => ({
    assistantText: assistantTextAllRounds,
    writtenPaths: [...new Set(writtenPaths)],
    turnBlocks,
    cancelled: true
  })

  for (let round = 0; round < TOOL_ROUNDS_MAX; round++) {
    if (signal?.aborted) return bailCancelled()
    emit({ type: 'generating', phase: 'model', round })
    let message: {
      role: string
      content: string | null
      tool_calls?: ToolCall[]
    }
    try {
      ;({ message } = await streamChatCompletionRound(
        settings,
        messages,
        round,
        emit,
        signal
      ))
    } catch (e) {
      if (isAbortDueToUserCancel(e, signal)) return bailCancelled()
      throw e
    }
    const toolCalls = message.tool_calls

    if (toolCalls?.length) {
      const piece = message.content ?? ''
      assistantTextAllRounds += piece
      if (piece.trim()) {
        turnBlocks.push({ kind: 'text', text: piece })
      }
      messages.push({
        role: 'assistant',
        content: message.content,
        tool_calls: toolCalls
      })
      emit({ type: 'generating', phase: 'tools', round })
      for (const tc of toolCalls) {
        if (signal?.aborted) return bailCancelled()
        let args: Record<string, unknown> = {}
        if (tc.function.name === 'patch_workspace_file') {
          const salvaged = parsePatchWorkspaceFileArgs(tc.function.arguments)
          if (salvaged) {
            args = {
              path: salvaged.path,
              old_text: salvaged.oldText,
              new_text: salvaged.newText,
              replace_all: salvaged.replaceAll
            }
          } else {
            try {
              args = JSON.parse(tc.function.arguments || '{}') as Record<
                string,
                unknown
              >
            } catch {
              args = {}
            }
          }
        } else {
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<
              string,
              unknown
            >
          } catch {
            args = {}
          }
        }
        emit({
          type: 'tool_executing',
          id: tc.id,
          name: tc.function.name,
          round
        })
        let toolContent: string
        try {
          toolContent = await executeTool(tc.function.name, args)
          if (DISK_MUTATING_TOOLS.has(tc.function.name)) {
            const pr = parseToolResultJson(toolContent)
            const p =
              pr && pr.ok === true && typeof pr.path === 'string' ? pr.path : ''
            if (p) writtenPaths.push(p)
          }
        } catch (err) {
          toolContent = JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
        const { ok, summary, path } = summarizeToolExecution(
          tc.function.name,
          args,
          toolContent
        )
        emit({
          type: 'tool_result',
          id: tc.id,
          name: tc.function.name,
          ok,
          summary,
          path,
          round
        })
        turnBlocks.push({
          kind: 'tool',
          id: tc.id,
          name: tc.function.name,
          ok,
          summary,
          path
        })
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: toolContent
        })
        if (signal?.aborted) return bailCancelled()
      }
      continue
    }

    const text = message.content ?? ''
    assistantTextAllRounds += text
    if (text.trim()) {
      turnBlocks.push({ kind: 'text', text })
    }
    return {
      assistantText: assistantTextAllRounds,
      writtenPaths: [...new Set(writtenPaths)],
      turnBlocks,
      cancelled: false
    }
  }

  const uniq = [...new Set(writtenPaths)]
  const limitMsg =
    uniq.length > 0
      ? `（工具调用轮次已达上限；已写入：${uniq.join(', ')}）`
      : '（工具调用轮次已达上限。）'
  emit({ type: 'text_delta', text: limitMsg })
  turnBlocks.push({ kind: 'text', text: limitMsg })
  return {
    assistantText: limitMsg,
    writtenPaths: uniq,
    turnBlocks,
    cancelled: false
  }
}

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/$/, '')
}

export async function createEmbedding(
  settings: AppSettings,
  input: string
): Promise<Float32Array> {
  const base = normalizeBaseUrl(settings.openAiBaseUrl)
  const url = `${base}/embeddings`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openAiApiKey}`
    },
    body: JSON.stringify({
      model: settings.embeddingModel,
      input
    })
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Embeddings failed: ${res.status} ${t}`)
  }
  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>
  }
  const emb = data.data[0]?.embedding
  if (!emb) throw new Error('No embedding in response')
  return Float32Array.from(emb)
}

export async function* chatCompletionStream(
  settings: AppSettings,
  messages: ChatMessage[]
): AsyncGenerator<string> {
  const base = normalizeBaseUrl(settings.openAiBaseUrl)
  const url = `${base}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openAiApiKey}`
    },
    body: JSON.stringify({
      model: settings.chatModel,
      messages,
      stream: true
    })
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Chat failed: ${res.status} ${t}`)
  }
  const body = res.body
  if (!body) throw new Error('No response body')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const chunk = json.choices?.[0]?.delta?.content
        if (chunk) yield chunk
      } catch {
        /* ignore parse errors for keep-alive lines */
      }
    }
  }
}

export async function chatCompletionComplete(
  settings: AppSettings,
  messages: ChatMessage[]
): Promise<string> {
  let out = ''
  for await (const c of chatCompletionStream(settings, messages)) {
    out += c
  }
  return out
}
