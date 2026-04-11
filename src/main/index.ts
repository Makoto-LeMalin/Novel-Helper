import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { ProjectState } from './state/project-state'
import { SnapshotVersionStore } from './version/snapshot-version-store'
import { MemoryService } from './memory/memory-service'
import { loadSettings } from './persistence/settings-store'
import { registerIpc } from './ipc/register-ipc'
import { removeChatSession } from './ipc/window-sessions'

const project = new ProjectState()
const versionStore = new SnapshotVersionStore()
const memoryService = new MemoryService()

let mainWindow: BrowserWindow | null = null

/** electron-vite emits preload as index.cjs when output.format is cjs. */
function preloadScriptPath(): string {
  const dir = join(__dirname, '../preload')
  const cjs = join(dir, 'index.cjs')
  const js = join(dir, 'index.js')
  if (existsSync(cjs)) return cjs
  if (existsSync(js)) return js
  return cjs
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: {
      preload: preloadScriptPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const mainWebContentsId = mainWindow.webContents.id
  mainWindow.on('closed', () => {
    removeChatSession(mainWebContentsId)
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  project.settings = await loadSettings(userData)

  registerIpc(project, versionStore, memoryService, () => userData)

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  versionStore.close()
  memoryService.close()
  if (process.platform !== 'darwin') app.quit()
})
