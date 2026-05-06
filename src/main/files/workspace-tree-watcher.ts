import chokidar from 'chokidar'

/**
 * Debounced workspace tree notifications for renderer refresh.
 * Ignores `.novel` and `node_modules` under the workspace root.
 */
export function createWorkspaceTreeWatcher(onChange: () => void): {
  setRoot: (absPath: string | null) => void
  dispose: () => void
} {
  let watcher: chokidar.FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const schedule = (): void => {
    if (debounceTimer != null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      onChange()
    }, 220)
  }

  return {
    setRoot(absPath: string | null): void {
      void watcher?.close()
      watcher = null
      if (!absPath) return
      watcher = chokidar.watch(absPath, {
        ignored: [
          /(^|[\\/])\.novel([\\/]|$)/,
          /(^|[\\/])node_modules([\\/]|$)/
        ],
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 50 }
      })
      watcher.on('all', schedule)
    },
    dispose(): void {
      if (debounceTimer != null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      void watcher?.close()
      watcher = null
    }
  }
}
