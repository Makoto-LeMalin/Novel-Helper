/** In-flight sendChat abort controllers keyed by WebContents.id (one stream per window). */
const activeChatAbort = new Map<number, AbortController>()

export function clearActiveChatsOnWorkspaceChange(): void {
  for (const ac of activeChatAbort.values()) {
    ac.abort()
  }
  activeChatAbort.clear()
}

export function setActiveChatAbort(wcId: number, ac: AbortController): void {
  activeChatAbort.get(wcId)?.abort()
  activeChatAbort.set(wcId, ac)
}

export function clearActiveChatAbort(wcId: number): void {
  activeChatAbort.delete(wcId)
}

export function cancelChatForWebContents(wcId: number): void {
  activeChatAbort.get(wcId)?.abort()
}

/** Window closed: abort any in-flight chat for that WebContents. */
export function removeChatSession(wcId: number): void {
  activeChatAbort.get(wcId)?.abort()
  activeChatAbort.delete(wcId)
}
