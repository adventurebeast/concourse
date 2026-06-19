import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { createContext } from './context.js'
import { registerWorkspace } from './ipc-workspace.js'
import { registerFs } from './ipc-fs.js'
import { registerGit } from './ipc-git.js'
import { registerSearch } from './ipc-search.js'
import { registerSession } from './ipc-session.js'
import { registerPty } from './ipc-pty.js'
import { registerPulse } from './ipc-pulse.js'

const ctx = createContext()
let disposePty = null

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })
  ctx.setWindow(mainWindow)

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // In dev, forward renderer console + crashes to the terminal for debugging.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      const tag = level >= 3 ? '[renderer:ERROR]' : '[renderer]'
      console.log(tag, message, level >= 3 ? `(${source}:${line})` : '')
    })
    mainWindow.webContents.on('render-process-gone', (_e, d) =>
      console.log('[render-process-gone]', JSON.stringify(d))
    )
  }
  // Swallow the browser-style reload shortcuts. This is an app, not a web page —
  // Cmd/Ctrl+R would blow away every terminal and the editor state. The renderer
  // owns all other hotkeys; reload has to die here because menu accelerators fire
  // before the renderer ever sees the keystroke.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.meta || input.control
    if (mod && input.key && input.key.toLowerCase() === 'r') event.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.on('closed', () => {
    if (disposePty) disposePty()
    ctx.setWindow(null)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerWorkspace(ctx)
  registerFs(ctx)
  registerGit(ctx)
  registerSearch(ctx)
  registerSession()
  disposePty = registerPty(ctx)
  registerPulse()

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
