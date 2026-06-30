import { app, shell, ipcMain, BrowserWindow, screen, dialog } from 'electron'
import { join } from 'path'
import { createContext } from './context.js'
import { registerWorkspace } from './ipc-workspace.js'
import { registerFs } from './ipc-fs.js'
import { registerGit } from './ipc-git.js'
import { registerSearch } from './ipc-search.js'
import { registerSession } from './ipc-session.js'
import { registerPty } from './ipc-pty.js'
import { registerPulse } from './ipc-pulse.js'
import { registerModel } from './ipc-model.js'
import { stopLocalServer } from './local-llm.js'
import { registerShell } from './ipc-shell.js'
import { registerSettings, updateSetting } from './ipc-settings.js'
import { registerCommands } from './ipc-commands.js'
import { initSettings, getRaw } from './settings.js'
import { createWatchers } from './watcher.js'
import { installAppMenu } from './menu.js'
import { flushSync, readJson, writeJsonAtomic, enqueue, trackPending, sweepStaleTmp } from './store-io.js'

const ctx = createContext()
// Recursive fs watcher per window — keeps the file tree in sync with on-disk
// changes made outside the app. Started/replaced when a window opens a folder
// (see ipc-workspace.js) and stopped when the window closes.
const watchers = createWatchers()
// Tears down the PTYs owned by one window (set once the PTY layer is registered).
let killPtysForWindow = null

// Open a URL in the user's default browser, but only for safe web schemes.
// Every window's setWindowOpenHandler funnels through here, so a window.open from
// any source (a terminal link, an editor preview, an <a target=_blank>) can only
// ever reach the OS with http/https/mailto — never file:, vscode:, or other
// protocol-handler URLs that could be abused to launch local apps.
function openExternalSafely(url) {
  let scheme
  try {
    scheme = new URL(url).protocol
  } catch {
    return // unparseable URL — ignore
  }
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
    shell.openExternal(url)
  }
}

// Set once the user has confirmed an app quit (Cmd+Q / menu Quit), so the window
// 'close' handlers that fire as part of the quit cascade don't prompt a second time.
let quitConfirmed = false

// "Are you sure?" guard so a stray Cmd+Q or click on the window's close button can't
// silently kill running agents. Async (showMessageBox, not the Sync variant) because
// only the async form returns the "Don't ask me again" checkbox state — when ticked we
// flip the general.confirmQuit setting off so the prompt never shows again. Callers
// preventDefault up front, then re-issue the close/quit if this resolves to proceed.
// Returns true to proceed, false to stay.
async function confirmExit(win, { quitting }) {
  const { response, checkboxChecked } = await dialog.showMessageBox(
    win && !win.isDestroyed() ? win : undefined,
    {
      type: 'warning',
      buttons: ['Cancel', quitting ? 'Quit' : 'Close'],
      defaultId: 0, // Enter = Cancel — the safe choice
      cancelId: 0, // Esc = Cancel
      title: quitting ? 'Quit Concourse?' : 'Close Window?',
      message: quitting ? 'Quit Concourse?' : 'Close this window?',
      detail: `Any running terminals and agents in this ${
        quitting ? 'app' : 'window'
      } will be stopped.`,
      checkboxLabel: "Don't ask me again",
      checkboxChecked: false,
      noLink: true
    }
  )
  // Honour the checkbox regardless of which button was clicked — it's an independent
  // preference. updateSetting persists it and broadcasts so an open Settings window updates.
  if (checkboxChecked) updateSetting('general.confirmQuit', false)
  return response === 1
}

// ---- Window bounds persistence --------------------------------------------
// Remember the window size/position across launches (it reset to 1400x900 every
// time). Stored in its own small file via the same crash-safe store as session;
// restored only when still visible on a connected display (so unplugging an
// external monitor can't strand the window off-screen).
function windowStatePath() {
  return join(app.getPath('userData'), 'window-state.json')
}
let savedBounds = null
async function loadWindowState() {
  const data = await readJson(windowStatePath(), null)
  if (data && Number.isFinite(data.width) && Number.isFinite(data.height)) savedBounds = data
}
function boundsVisible(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false
  return screen.getAllDisplays().some((d) => {
    const w = d.workArea
    return b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y
  })
}
let boundsSaveTimer = null
function persistBounds(win) {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  const data = { ...win.getBounds() }
  trackPending(windowStatePath(), data) // so a quit before the async write still flushes
  enqueue(() => writeJsonAtomic(windowStatePath(), data))
}
function trackWindowBounds(win) {
  const schedule = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
    boundsSaveTimer = setTimeout(() => persistBounds(win), 400)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', () => persistBounds(win))
}

// Create a window. `fresh` opens a blank window (straight to the welcome screen);
// otherwise the renderer reopens the last session's folder. So "New Window" starts
// empty (pick any folder), while the launch / dock-activate window restores where
// you left off. IPC handlers and the PTY layer are registered once, globally, and
// scope themselves to the calling window via event.sender — so every window here
// gets its own workspace root and its own terminals automatically.
function createWindow({ fresh = false } = {}) {
  // Restore the last window's size/position when it's still on a connected display;
  // otherwise fall back to a centered 1400x900 (also the genuine first-run default).
  const restore = !fresh && boundsVisible(savedBounds) ? savedBounds : null
  const win = new BrowserWindow({
    width: restore ? restore.width : 1400,
    height: restore ? restore.height : 900,
    ...(restore ? { x: restore.x, y: restore.y } : {}),
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
  trackWindowBounds(win)
  // Confirm before the window's close button (X) tears down its terminals. The dialog
  // is async, so we cancel this close, ask, and only re-issue win.close() (now flagged
  // to pass straight through) if confirmed. Skipped during a confirmed app quit (Cmd+Q
  // already asked once — see before-quit below) and when the setting is off.
  let allowClose = false
  win.on('close', (e) => {
    if (allowClose || quitConfirmed || !getRaw('general.confirmQuit')) return
    e.preventDefault()
    confirmExit(win, { quitting: false }).then((ok) => {
      if (ok && !win.isDestroyed()) {
        allowClose = true
        win.close()
      }
    })
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
    openExternalSafely(details.url)
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

// The Settings window is a single shared instance (like macOS Preferences): a
// second request just focuses the existing one. It loads its own settings.html
// (a second renderer entry point) but reuses the same preload, so window.api —
// including the settings bridge — is identical to the workbench.
let settingsWin = null
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return settingsWin
  }
  // Paint the window in the persisted theme's base colour so it doesn't flash
  // white/dark before the renderer applies the theme.
  const dark = getRaw('appearance.theme') === 'dark'
  settingsWin = new BrowserWindow({
    width: 760,
    height: 660,
    minWidth: 540,
    minHeight: 440,
    show: false,
    title: 'Settings',
    parent: BrowserWindow.getFocusedWindow() || undefined,
    backgroundColor: dark ? '#1e1e1e' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })
  settingsWin.on('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => {
    settingsWin = null
  })
  settingsWin.webContents.setWindowOpenHandler((details) => {
    openExternalSafely(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')
    settingsWin.loadURL(base + '/settings.html')
  } else {
    settingsWin.loadFile(join(import.meta.dirname, '../renderer/settings.html'))
  }
  return settingsWin
}

app.whenReady().then(async () => {
  // Warm the settings cache before any window or the Pulse resolver reads it, so
  // synchronous getters (getRaw) and the new Settings window's background colour
  // reflect the persisted values from the first frame.
  await initSettings()
  // Load the persisted window bounds before the first window is created.
  await loadWindowState()

  // Reap atomic-write temp files orphaned by a previous run that died mid-write
  // (force-quit/crash/dev relaunch). Stores live in userData and its sessions/
  // subdir. Fire-and-forget — never let cleanup delay the first window.
  const userData = app.getPath('userData')
  sweepStaleTmp(userData)
  sweepStaleTmp(join(userData, 'sessions'))

  registerWorkspace(ctx, watchers)
  registerFs(ctx)
  registerGit(ctx)
  registerSearch(ctx)
  registerSession()
  killPtysForWindow = registerPty(ctx)
  registerPulse()
  registerModel()
  registerShell()
  registerSettings()
  registerCommands(ctx)

  // App version — read from the packaged app's manifest. Surfaced in the status
  // bar so you can confirm at a glance which build is actually running (the
  // version is auto-bumped by `npm run bump` on every pack/dist build).
  ipcMain.handle('app:version', () => app.getVersion())

  // Open another window. Fresh so it starts at the welcome screen instead of
  // cloning the current folder. Driven by the renderer (titlebar button) and the
  // File ▸ New Window menu item below.
  ipcMain.on('window:open', () => createWindow({ fresh: true }))

  // Open (or focus) the shared Settings window — from the titlebar gear and the
  // Settings… menu item (⌘,).
  ipcMain.on('window:openSettings', () => openSettingsWindow())

  // Bring the calling window to the foreground — clicking a Pulse "awaiting you"
  // notification pulls you back to the agent that needs you. app.focus({steal}) lifts
  // the whole app above other apps on macOS; un-minimise + focus handles the rest.
  ipcMain.on('window:focusSelf', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  })

  // Application menu: File ▸ New Window / New File / New Folder / Open Folder, the
  // Settings… item, plus the standard Edit roles. New Window and Settings are
  // handled here; the rest are forwarded to the focused window's renderer (menu.js).
  installAppMenu({
    onNewWindow: () => createWindow({ fresh: true }),
    onOpenSettings: () => openSettingsWindow()
  })

  createWindow()
  app.on('activate', () => {
    // Clicking the dock icon with no windows open reopens the last session.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Synchronously drain any staged session/recents writes before we exit, so a
// force-quit shortly after a layout change still persists it (the async write
// queue may not get a turn during teardown). See store-io flushSync().
app.on('before-quit', (e) => {
  // Confirm the quit once, here, before any window is torn down. The dialog is async,
  // so we cancel this quit, ask, and re-issue app.quit() (now flagged so the second
  // pass skips the prompt and the cascading window 'close' events stay silent) only if
  // confirmed. Gate on having a live window so the non-macOS "last window closed →
  // app.quit()" path (already prompted via the window's own close handler) and the
  // setting being off don't prompt here.
  if (!quitConfirmed && getRaw('general.confirmQuit') && BrowserWindow.getAllWindows().length > 0) {
    e.preventDefault()
    confirmExit(BrowserWindow.getFocusedWindow(), { quitting: true }).then((ok) => {
      if (ok) {
        quitConfirmed = true
        app.quit()
      }
    })
    return
  }
  flushSync()
  // Stop the Pulse model server, but only if WE launched it (an externally-owned
  // Ollama — the menubar app, or one you started — is left running).
  stopLocalServer()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
