import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { fetchModels, verifyKey } from './openrouter.ts'
import { MatchRunner } from './games/runner.ts'
import {
  configFileLocation,
  getApiKey,
  getSettings,
  hasApiKey,
  keyStorageKind,
  setApiKey
} from './config.ts'
import type { MatchEvent, MatchSettings, ModelInfo } from '../shared/types.ts'

let mainWindow: BrowserWindow | null = null
let runner: MatchRunner | null = null
let modelCache: { at: number; models: ModelInfo[] } | null = null
const MODEL_CACHE_MS = 10 * 60 * 1000

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#0d1117',
    title: 'LLM Cardroom',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Keep external links out of the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function emitToRenderer(event: MatchEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('match:event', event)
  }
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => ({
    hasApiKey: hasApiKey(),
    settings: getSettings(),
    configPath: configFileLocation(),
    keyStorage: keyStorageKind()
  }))

  ipcMain.handle('config:setApiKey', (_event, key: string) => {
    setApiKey(key)
    modelCache = null
    return { hasApiKey: hasApiKey() }
  })

  ipcMain.handle('config:verifyApiKey', async (_event, key?: string) =>
    verifyKey(typeof key === 'string' && key.trim() ? key : getApiKey())
  )

  ipcMain.handle('models:list', async (_event, force?: boolean) => {
    if (!force && modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) {
      return { models: modelCache.models, cached: true }
    }
    const models = await fetchModels(getApiKey())
    modelCache = { at: Date.now(), models }
    return { models, cached: false }
  })

  ipcMain.handle('match:start', async (_event, settings: MatchSettings) => {
    // Any match still running is abandoned in favour of the new one.
    runner?.stop()
    if (!hasApiKey()) throw new Error('Add your OpenRouter API key first.')

    const active = new MatchRunner(settings, getApiKey(), emitToRenderer)
    runner = active
    // Runs in the background; progress reaches the UI through match:event.
    void active.run().finally(() => {
      if (runner === active) runner = null
    })
    return true
  })

  // Applies operator tweaks (stake, pace, roster) to a running match.
  ipcMain.handle('match:updateLive', (_event, settings: MatchSettings) => {
    runner?.applyLiveSettings(settings)
    return true
  })

  ipcMain.handle('match:pause', () => {
    runner?.pause()
    return true
  })

  ipcMain.handle('match:resume', () => {
    runner?.resume()
    return true
  })

  ipcMain.handle('match:stop', () => {
    runner?.stop()
    return true
  })

  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return true
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  runner?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  runner?.stop()
})
