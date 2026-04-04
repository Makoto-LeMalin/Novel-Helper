/** Typed chat stream events (main → renderer), aligned with common AI SDK patterns. */

export type ChatStreamEvent =
  | {
      type: 'generating'
      phase: 'model' | 'tools'
      round?: number
      detail?: string
    }
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      arguments: string
      phase: 'streaming' | 'complete'
      callIndex?: number
      round?: number
    }
  | { type: 'tool_executing'; id: string; name: string; round?: number }
  | {
      type: 'tool_result'
      id: string
      name: string
      ok: boolean
      summary: string
      /** Workspace-relative path touched by the tool (e.g. patch target). */
      path?: string
      round?: number
    }

/** Persisted assistant turn fragments (JSON in `messages.blocks`). */
export type ChatTurnBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      ok: boolean
      summary: string
      path?: string
    }

export const CHAT_STREAM_EVENT_CHANNEL = 'novel:chat-stream-event'
