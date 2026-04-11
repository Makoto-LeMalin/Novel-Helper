/** 与旧版 memory 行兼容：同一条版本分支上的默认对话线。 */
export const DEFAULT_CHAT_THREAD_ID = 'default'

export function normalizeChatThreadId(raw: unknown): string {
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t.length > 0 && t.length <= 128) return t
  }
  return DEFAULT_CHAT_THREAD_ID
}

/** 与渲染层一致的短标题（首轮用户消息首行）。 */
export function suggestChatTabTitleFromUserText(text: string): string {
  const line = text.replace(/\r\n/g, '\n').split('\n')[0]?.trim() ?? ''
  const one = line.replace(/\s+/g, ' ')
  if (!one) return '新对话'
  const max = 44
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
