import { Menu, BrowserWindow, shell, app } from 'electron'

// Project links for the Help menu (derived from the git remote).
const REPO_URL = 'https://github.com/adventurebeast/concourse'

// Forward a command to a window's renderer — the menu item's own window, falling
// back to the focused one. The renderer maps it onto the SAME action as the
// matching toolbar button / keyboard shortcut (open folder, new terminal, layout
// switch…), so the menu and the in-app controls can never drift apart. `arg`
// carries an optional payload (e.g. the path of an Open Recent entry).
function toRenderer(win, command, arg) {
  const target = win || BrowserWindow.getFocusedWindow()
  if (target && !target.webContents.isDestroyed()) {
    target.webContents.send('menu:command', command, arg)
  }
}

// installAppMenu wires the callbacks once; refreshAppMenu() rebuilds the menu in
// place (Electron menus are static, so dynamic content like Open Recent needs a
// rebuild — ipc-workspace calls refreshAppMenu() after every folder open).
let menuOpts = null

export function installAppMenu(opts) {
  menuOpts = opts
  refreshAppMenu()
}

export function refreshAppMenu() {
  if (!menuOpts) return
  buildMenu(menuOpts).catch(() => {
    // A failed recents read must never cost us the whole menu — rebuild without it.
    buildMenuSync(menuOpts, [])
  })
}

async function buildMenu(opts) {
  const recents = opts.getRecents ? await opts.getRecents() : []
  buildMenuSync(opts, recents)
}

// Build and install the application menu.
//
// Accelerator ground rules (the renderer registers its own shortcuts, but a menu
// accelerator fires FIRST, so putting a key here transfers ownership to the menu):
//   • Keys that are safe app-wide chords live on their menu item (⌘T, ⌘K, ⌘B,
//     the U-I-O-P layout row…) — the click handler runs the same renderer action,
//     so behaviour is identical and the shortcut becomes discoverable in the menu.
//   • ⌘W stays renderer-owned (it closes the active TERMINAL, with a confirm
//     dialog, not the window) — Close Terminal shows no accelerator. Close Window
//     sits on ⇧⌘W so the two don't collide.
//   • Next/Previous/Move Terminal stay renderer-owned too: their chords (⌘⇧←/→,
//     ⌘[ ]) double as text-selection / indent keys in the editor, and the
//     renderer arbitrates that context — a global menu accelerator can't.
//   • Open Folder is on ⇧⌘O, not ⌘O — ⌘O is the Stack layout (U-I-O-P row).
//   • the Reload / Force-Reload roles are omitted — this is an app, not a web page,
//     and a reload would wipe every terminal and the open editor (the renderer and
//     a per-webContents guard also veto ⌘R).
// The standard Edit roles are kept so cut/copy/paste/undo work in the search box,
// rename field, and commit message on macOS.
function buildMenuSync({ onNewWindow, onOpenSettings }, recents) {
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

  // Open Recent — the same list the welcome screen shows (recents.js, pruned to
  // folders that still exist), capped so the submenu stays scannable. Labels are
  // home-relative paths: unambiguous when two projects share a folder name.
  const home = app.getPath('home')
  const tildify = (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p)
  const recentItems = recents.slice(0, 12).map((r) => ({
    label: tildify(r.path),
    click: (_i, win) => toRenderer(win, 'open-recent', r.path)
  }))
  const openRecent = {
    label: 'Open Recent',
    submenu: recentItems.length
      ? recentItems
      : [{ label: 'No Recent Folders', enabled: false }]
  }

  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => onNewWindow() },
      { type: 'separator' },
      { label: 'New File', accelerator: 'CmdOrCtrl+N', click: (_i, win) => toRenderer(win, 'new-file') },
      { label: 'New Folder', click: (_i, win) => toRenderer(win, 'new-folder') },
      { type: 'separator' },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: (_i, win) => toRenderer(win, 'open-folder') },
      openRecent,
      { type: 'separator' },
      // Reveal the current workspace root in the OS file browser — same action as the
      // file-tree's reveal button, so menu and toolbar can't drift. No-ops (in the
      // renderer) when no folder is open.
      { label: isMac ? 'Reveal in Finder' : 'Show in File Explorer', click: (_i, win) => toRenderer(win, 'reveal-in-finder') },
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
      { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: (_i, win) => toRenderer(win, 'palette') },
      { type: 'separator' },
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: (_i, win) => toRenderer(win, 'toggle-sidebar') },
      { label: 'Toggle Terminal Panel', accelerator: 'CmdOrCtrl+Shift+J', click: (_i, win) => toRenderer(win, 'toggle-panel') },
      { label: 'Terminals Only (Hide Editor)', click: (_i, win) => toRenderer(win, 'toggle-terminals') },
      { type: 'separator' },
      { label: 'Explorer', click: (_i, win) => toRenderer(win, 'view-explorer') },
      { label: 'Search', accelerator: 'CmdOrCtrl+Shift+F', click: (_i, win) => toRenderer(win, 'view-search') },
      { label: 'Source Control', click: (_i, win) => toRenderer(win, 'view-scm') },
      { type: 'separator' },
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

  // The heart of the app: everything you can do to the terminal fleet, in one
  // menu. Layouts mirror the U-I-O-P row (see src/renderer/main.js keybindings).
  const terminalMenu = {
    label: 'Terminal',
    submenu: [
      { label: 'New Terminal', accelerator: 'CmdOrCtrl+T', click: (_i, win) => toRenderer(win, 'term-new') },
      // No accelerator: ⌘W is renderer-owned (close-terminal + confirm dialog).
      { label: 'Close Terminal', click: (_i, win) => toRenderer(win, 'term-close') },
      { type: 'separator' },
      // Selection / ordering keys stay renderer-owned (see ground rules above).
      { label: 'Next Terminal', click: (_i, win) => toRenderer(win, 'term-next') },
      { label: 'Previous Terminal', click: (_i, win) => toRenderer(win, 'term-prev') },
      { label: 'Move Terminal Left', click: (_i, win) => toRenderer(win, 'term-move-left') },
      { label: 'Move Terminal Right', click: (_i, win) => toRenderer(win, 'term-move-right') },
      { type: 'separator' },
      {
        label: 'Layout',
        submenu: [
          { label: 'Tabs', accelerator: 'CmdOrCtrl+U', click: (_i, win) => toRenderer(win, 'layout-tabs') },
          { label: 'Grid', accelerator: 'CmdOrCtrl+I', click: (_i, win) => toRenderer(win, 'layout-grid') },
          { label: 'Stack', accelerator: 'CmdOrCtrl+O', click: (_i, win) => toRenderer(win, 'layout-stack') },
          { label: 'Deck', accelerator: 'CmdOrCtrl+J', click: (_i, win) => toRenderer(win, 'layout-deck') },
          { label: 'Flow', accelerator: 'CmdOrCtrl+P', click: (_i, win) => toRenderer(win, 'layout-flow') },
          { type: 'separator' },
          { label: 'Cycle Layout', accelerator: 'CmdOrCtrl+Shift+L', click: (_i, win) => toRenderer(win, 'layout-cycle') }
        ]
      }
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
    terminalMenu,
    windowMenu,
    helpMenu
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
