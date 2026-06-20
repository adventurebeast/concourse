import { app, shell, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { createContext } from './context.js'
import { registerWorkspace } from './ipc-workspace.js'
import { registerFs } from './ipc-fs.js'
import { registerGit } from './ipc-git.js'
import { registerSearch } from './ipc-search.js'
import { registerSession } from './ipc-session.js'
import { registerPty } from './ipc-pty.js'
import { registerPulse } from './ipc-pulse.js'
import { registerShell } from './ipc-shell.js'
import { createWatchers } from './watcher.js'
import { installAppMenu } from './menu.js'

const ctx = createContext()
// Recursive fs watcher per window — keeps the file tree in sync with on-disk
// changes made outside the app. Started/replaced when a window opens a folder
// (see ipc-workspace.js) and stopped when the window closes.
const watchers = createWatchers()
// Tears down the PTYs owned by one window (set once the PTY layer is registered).
let killPtysForWindow = null

// Create a window. `fresh` opens a blank window (straight to the welcome screen);
// otherwise the renderer reopens the last session's folder. So "New Window" starts
// empty (pick any folder), while the launch / dock-activate window restores where
// you left off. IPC handlers and the PTY layer are registered once, globally, and
// scope themselves to the calling window via event.sender — so every window here
// gets its own workspace root and its own terminals automatically.
function createWindow({ fresh = false } = {}) {
  const win = new BrowserWindow({
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
  // Capture the id now — after 'closed' the WebContents is gone.
  const wcId = win.webContents.id

  win.on('ready-to-show', () => win.show())

  // In dev, forward renderer console + crashes to the terminal for debugging.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      const tag = level >= 3 ? '[renderer:ERROR]' : '[renderer]'
      console.log(tag, message, level >= 3 ? `(${source}:${line})` : '')
    })
    win.webContents.on('render-process-gone', (_e, d) =>
      console.log('[render-process-gone]', JSON.stringify(d))
    )
  }
  // Swallow the browser-style reload shortcuts. This is an app, not a web page —
  // Cmd/Ctrl+R would blow away every terminal and the editor state. The renderer
  // owns all other hotkeys; reload has to die here because menu accelerators fire
  // before the renderer ever sees the keystroke.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.meta || input.control
    if (mod && input.key && input.key.toLowerCase() === 'r') event.preventDefault()
  })
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.on('closed', () => {
    // Tear down only this window's terminals and per-window state; other windows
    // keep running.
    if (killPtysForWindow) killPtysForWindow(wcId)
    watchers.stop(wcId)
    ctx.forget(wcId)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL
    win.loadURL(fresh ? base + (base.includes('?') ? '&' : '?') + 'fresh=1' : base)
  } else {
    win.loadFile(
      join(import.meta.dirname, '../renderer/index.html'),
      fresh ? { query: { fresh: '1' } } : undefined
    )
  }
  return win
}

app.whenReady().then(() => {
  registerWorkspace(ctx, watchers)
  registerFs(ctx)
  registerGit(ctx)
  registerSearch(ctx)
  registerSession()
  killPtysForWindow = registerPty(ctx)
  registerPulse()
  registerShell()

  // App version — read from the packaged app's manifest. Surfaced in the status
  // bar so you can confirm at a glance which build is actually running (the
  // version is auto-bumped by `npm run bump` on every pack/dist build).
  ipcMain.handle('app:version', () => app.getVersion())

  // Open another window. Fresh so it starts at the welcome screen instead of
  // cloning the current folder. Driven by the renderer (titlebar button) and the
  // File ▸ New Window menu item below.
  ipcMain.on('window:open', () => createWindow({ fresh: true }))

  // Application menu: File ▸ New Window / New File / New Folder / Open Folder, plus
  // the standard Edit roles. New Window is handled here; the rest are forwarded to
  // the focused window's renderer (see menu.js).
  installAppMenu({ onNewWindow: () => createWindow({ fresh: true }) })

  createWindow()
  app.on('activate', () => {
    // Clicking the dock icon with no windows open reopens the last session.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
