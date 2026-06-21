import { Menu, BrowserWindow, shell } from 'electron'

// Project links for the Help menu (derived from the git remote).
const REPO_URL = 'https://github.com/adventurebeast/concourse'

// Forward a command to a window's renderer — the menu item's own window, falling
// back to the focused one. The renderer maps it onto the SAME action as the
// matching toolbar button (open folder, new file/folder), so the menu and the
// in-app buttons can never drift apart.
function toRenderer(win, command) {
  const target = win || BrowserWindow.getFocusedWindow()
  if (target && !target.webContents.isDestroyed()) {
    target.webContents.send('menu:command', command)
  }
}

// Build and install the application menu.
//
// The File menu carries the basics — New Window, New File / Folder, Open Folder —
// with the editor-style accelerators people expect (⌘N new file, ⇧⌘N new window,
// ⌘O open). Two deliberate choices:
//   • ⌘W is left to the renderer (it closes the active terminal, not the window);
//     the menu's Close Window sits on ⇧⌘W so the two don't collide.
//   • the Reload / Force-Reload roles are omitted — this is an app, not a web page,
//     and a reload would wipe every terminal and the open editor (the renderer and
//     a per-webContents guard also veto ⌘R).
// The standard Edit roles are kept so cut/copy/paste/undo work in the search box,
// rename field, and commit message on macOS.
export function installAppMenu({ onNewWindow, onOpenSettings }) {
  const isMac = process.platform === 'darwin'
  const isDev = !!process.env.ELECTRON_RENDERER_URL

  // Settings… on the conventional ⌘, — opens (or focuses) the Settings window.
  // On macOS it lives in the app menu (where "Preferences" belongs); on Windows /
  // Linux it sits in the File menu.
  const settingsItem = {
    label: isMac ? 'Settings…' : 'Settings',
    accelerator: 'CmdOrCtrl+,',
    click: () => onOpenSettings && onOpenSettings()
  }

  // macOS app menu, customised so Settings… appears under "Concourse" alongside
  // About / Quit (the default { role: 'appMenu' } has no Preferences entry).
  const appMenu = {
    label: 'Concourse',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }

  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => onNewWindow() },
      { type: 'separator' },
      { label: 'New File', accelerator: 'CmdOrCtrl+N', click: (_i, win) => toRenderer(win, 'new-file') },
      { label: 'New Folder', click: (_i, win) => toRenderer(win, 'new-folder') },
      { type: 'separator' },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: (_i, win) => toRenderer(win, 'open-folder') },
      // Non-mac: Settings lives here (no app menu to host it).
      ...(isMac ? [] : [{ type: 'separator' }, settingsItem]),
      { type: 'separator' },
      // Close the window, but off ⌘W so the renderer keeps that for closing a terminal.
      { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }])
    ]
  }

  const viewMenu = {
    label: 'View',
    submenu: [
      // Zoom the whole UI. These roles were lost when this custom menu replaced
      // Electron's default View menu, which is why ⌘+/⌘-/⌘0 stopped working.
      // The visible Zoom In sits on ⌘+ (Shift+=); the hidden twin also accepts
      // ⌘= without Shift, so the bare +/= key zooms in like it does in a browser.
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : [])
    ]
  }

  // A trimmed Window menu (no Close — that lives in File above on ⇧⌘W).
  const windowMenu = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])
    ]
  }

  // Help menu — the standard slot a Mac/Windows user looks in. External links open
  // in the browser (setWindowOpenHandler already routes external URLs). No
  // Check-for-Updates yet: a dead updater button is worse than none, so it lands
  // with the auto-update epic, not before.
  const helpMenu = {
    role: 'help',
    submenu: [
      { label: 'Documentation', click: () => shell.openExternal(REPO_URL + '#readme') },
      { label: 'Report an Issue…', click: () => shell.openExternal(REPO_URL + '/issues/new') },
      { type: 'separator' },
      { label: 'View Source on GitHub', click: () => shell.openExternal(REPO_URL) }
    ]
  }

  const template = [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    { role: 'editMenu' },
    viewMenu,
    windowMenu,
    helpMenu
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
