import './style.css'
import { createEditor } from './editor.js'
import { createFileTree } from './fileTree.js'
import { createGit } from './git.js'
import { createSearch } from './search.js'
import { createTerminals } from './terminals.js'
import { createWelcome } from './welcome.js'
import { createKeybindings } from './keybindings.js'
import { createCommandPalette } from './commandPalette.js'
import { createBeginnerHud } from './beginnerHud.js'
import { createStatusBar } from './statusbar.js'
import { icon } from './icons.js'
import { showToastOnce } from './toast.js'

const api = window.api

// ---------- Icons: fill every [data-icon] button from the shared set ----------
function renderIcons(scope = document) {
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon, +(el.dataset.size || 16))
  })
}
renderIcons()

// ---------- Custom tooltips (works for static + dynamically-added [title]) ----------
const tipEl = document.createElement('div')
tipEl.className = 'tooltip'
document.body.appendChild(tipEl)
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[title], [data-tip]')
  if (!el) return
  const text = el.dataset.tip || el.getAttribute('title')
  if (!text) return
  if (el.hasAttribute('title')) {
    el.dataset.tip = text // migrate so the native tooltip never shows
    el.removeAttribute('title')
  }
  // Expert mode: suppress the terminal tab/cell auto-title pop-over. The label is
  // already visible on the tab/header and the summary can lag the live pane, so the
  // hover card is just noise that covers the terminal. We still migrated the native
  // title away above, so nothing shows at all. Functional tooltips (close buttons,
  // toolbar, status bar) are unaffected since they aren't the tab/cell themselves.
  if (document.documentElement.dataset.mode === 'expert' && el.matches('.term-tab, .term-cell')) return
  tipEl.textContent = text
  tipEl.classList.add('show')
  const r = el.getBoundingClientRect()
  let left = r.left + r.width / 2 - tipEl.offsetWidth / 2
  left = Math.max(6, Math.min(left, window.innerWidth - tipEl.offsetWidth - 6))
  let top = r.bottom + 6
  if (top + tipEl.offsetHeight > window.innerHeight - 6) top = r.top - tipEl.offsetHeight - 6
  tipEl.style.left = left + 'px'
  tipEl.style.top = top + 'px'
})
document.addEventListener('mouseout', (e) => {
  if (e.target.closest('[title], [data-tip]')) tipEl.classList.remove('show')
})

// Authoritative current workspace root in the renderer (mirrors the main process).
let currentRoot = null

// ---------- Modules ----------
const editor = createEditor()

// Beginner heads-up line above the terminal: "you're in <folder>, a git project on
// <branch>, N changes waiting" — ties the prompt to concrete context.
const hud = createBeginnerHud()

// Bottom status bar: git counts + branch (left), live fleet pulse + clock (right).
// Clicking the git portion opens Source Control.
const statusbar = createStatusBar({
  onOpenScm: () => document.querySelector('.activity-btn[data-view="scm"]')?.click()
})

const git = createGit({
  // Open a git diff as a read-only tab in the editor.
  onOpenDiff: (opts) => editor.openDiff(opts),
  // Keep the beginner context line, the explorer's per-file git indicators, and
  // the status-bar change counts in sync with repo state on every refresh.
  onStatus: (status) => {
    hud.setStatus(status)
    fileTree.applyGitStatus(status)
    statusbar.setGit(status)
  }
})

const fileTree = createFileTree({
  onOpenFile: (path) => editor.openFile(path)
})

// Live tree: re-read on out-of-app changes (an agent, terminal, or external editor
// touching files). refresh() preserves expansion + selection; git.refresh() re-reads
// status so the explorer's per-file M/A/U/D badges — plus the status bar and beginner
// HUD — track the change in real time, not just on save or when SCM is opened.
api.fs.onChanged(() => {
  fileTree.refresh()
  git.refresh()
})

// Watcher health: if the recursive fs watcher degrades (an OS file-handle limit, a
// transient error), live updates can stall. Tell the user once and offer a manual
// Refresh; recovery to 'watching' is silent. (Was exposed in preload but unconsumed.)
api.fs.onWatchStatus?.((status) => {
  if (status === 'degraded') {
    showToastOnce(
      'File changes may not update automatically. Use Refresh if the tree looks stale.',
      {
        kind: 'warn',
        action: {
          label: 'Refresh',
          onClick: () => {
            fileTree.refresh()
            git.refresh()
          }
        }
      }
    )
  }
})

const search = createSearch({
  getRoot: () => currentRoot,
  // Open the file and jump to the matched line/column.
  onOpenFile: (path, opts) => editor.openFile(path, opts)
})

const terminals = createTerminals({
  getRoot: () => currentRoot,
  // Aggregate pane pulse states into the right side of the status bar.
  onFleet: (fleet) => statusbar.setFleet(fleet)
})

// Beginner command palette: a clickable launcher that TYPES a curated command onto
// the active prompt (the user presses Enter). Trigger lives in the terminal tab bar
// (beginner mode only, gated in CSS); also opens with Cmd/Ctrl+K.
const palette = createCommandPalette({ typeInto: (cmd) => terminals.typeIntoActive(cmd) })
document.getElementById('cmd-trigger').addEventListener('click', () => palette.toggle())
palette.mountStrip(document.getElementById('cmd-strip'))

// Saving a file should refresh git status.
editor.onSave(() => git.refresh())

// ---------- Global keyboard shortcuts ----------
const keys = createKeybindings()
// Cmd/Ctrl+R is also vetoed in the main process (menu accelerators fire first),
// but keep a renderer veto too so the keystroke never leaks into a terminal.
keys.register('mod+r', () => {})
// Cmd/Ctrl+T opens a fresh terminal tab.
keys.register('mod+t', () => terminals.create({}))
// Shift+Cmd/Ctrl+Left / Right cycle the active terminal tab. A modifier is
// required so plain arrow keys still reach the shell inside a terminal.
keys.register('mod+shift+left', () => terminals.stepActive(-1))
keys.register('mod+shift+right', () => terminals.stepActive(1))
// Cmd/Ctrl+; / ' are a single-modifier alias for the same cycle: the two keys
// sit adjacent on the home row, with ; (left) stepping back and ' (right)
// stepping forward, so it reads spatially like prev/next.
keys.register('mod+;', () => terminals.stepActive(-1))
keys.register("mod+'", () => terminals.stepActive(1))
// Cmd/Ctrl+[ / ] are a second alias for the same cycle, matching the
// back/forward muscle memory the bracket keys carry across macOS ([ = back,
// ] = forward). They defer to Monaco when an editor is focused so it keeps its
// native outdent/indent (Cmd+[ / Cmd+]); everywhere else (terminals, panes)
// they switch tabs. The .monaco-host guard is deliberately narrow: xterm holds
// focus in its own helper <textarea>, so a generic input/textarea check would
// wrongly disable switching while you're inside a terminal.
const inEditor = () => !!document.activeElement?.closest('.monaco-host')
keys.register('mod+[', () => {
  if (inEditor()) return false
  terminals.stepActive(-1)
})
keys.register('mod+]', () => {
  if (inEditor()) return false
  terminals.stepActive(1)
})
// Cmd/Ctrl+1..9 jump straight to the Nth terminal tab.
for (let n = 1; n <= 9; n++) {
  keys.register(`mod+${n}`, () => terminals.activateIndex(n - 1))
}
// Cmd/Ctrl+W closes the active terminal (routes through the confirm dialog).
keys.register('mod+w', () => terminals.closeActive())
keys.register('mod+k', () => palette.toggle())
// Layout modes: a single cycler plus direct keys. tabs/grid/flow sit on the
// adjacent U I P keys; Cmd+Shift+L taps through them in order. Stack uses
// Cmd+Shift+O, not Cmd+O: the menu's "Open Folder…" claims Cmd+O, and menu
// accelerators fire before the renderer ever sees the keystroke, so a plain
// mod+o binding here would be permanently dead.
keys.register('mod+shift+l', () => terminals.cycleLayout(1))
keys.register('mod+u', () => terminals.setLayout('tabs'))
keys.register('mod+i', () => terminals.setLayout('grid'))
keys.register('mod+shift+o', () => terminals.setLayout('stack'))
keys.register('mod+p', () => terminals.setLayout('flow'))
// Workbench toggles (VS Code conventions). These drive the existing toolbar
// buttons so the .active states and resizers stay in sync.
keys.register('mod+b', () => document.getElementById('toggle-sidebar').click())
keys.register('mod+j', () => document.getElementById('toggle-panel').click())
// Cmd/Ctrl+Shift+F jumps to the search view. (Cmd+S save and Cmd+F find are
// handled by the editor / Monaco directly when an editor is focused.)
keys.register('mod+shift+f', () => document.querySelector('.activity-btn[data-view="search"]').click())

// ---------- Activity bar (view switching) ----------
const panels = {
  explorer: document.getElementById('explorer-panel'),
  search: document.getElementById('search-panel'),
  scm: document.getElementById('scm-panel')
}
document.querySelectorAll('.activity-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view
    document.querySelectorAll('.activity-btn').forEach((b) => b.classList.toggle('active', b === btn))
    for (const [name, el] of Object.entries(panels)) el.hidden = name !== view
    if (view === 'scm') git.refresh()
    if (view === 'search') search.focus()
  })
})

// ---------- Title bar ----------
const basename = (p) => (p ? p.split('/').filter(Boolean).pop() || p : 'Concourse')
function setTitle(root) {
  document.getElementById('titlebar-title').textContent = root ? basename(root) : 'Concourse'
  document.getElementById('status-workspace').textContent = root ? basename(root) : ''
}

// Toggle sidebar (explorer/scm + its resizer) and the bottom terminal panel.
document.getElementById('toggle-sidebar').addEventListener('click', (e) => {
  const hidden = document.getElementById('sidebar').classList.toggle('hidden')
  document.getElementById('drag-x').classList.toggle('hidden', hidden)
  e.currentTarget.classList.toggle('active', !hidden)
})
document.getElementById('toggle-panel').addEventListener('click', (e) => {
  const hidden = document.getElementById('terminal-region').classList.toggle('hidden')
  document.getElementById('drag-y').classList.toggle('hidden', hidden)
  e.currentTarget.classList.toggle('active', !hidden)
  if (!hidden) terminals.fitActive()
})

// Terminals-only: hide the editor entirely so terminals fill the workbench.
function setTerminalsOnly(on) {
  const main = document.getElementById('main')
  if (main.classList.contains('terminals-only') === on) return
  main.classList.toggle('terminals-only', on)
  document.getElementById('toggle-terminals').classList.toggle('active', on)
  if (on) {
    // make sure the terminal panel is actually visible
    document.getElementById('terminal-region').classList.remove('hidden')
    document.getElementById('toggle-panel').classList.add('active')
  }
  terminals.fitActive()
}
document.getElementById('toggle-terminals').addEventListener('click', () => {
  setTerminalsOnly(!document.getElementById('main').classList.contains('terminals-only'))
})

// Minimize button in the editor tab bar: drops the editor out of view so the
// terminals fill the workbench, without closing any open tabs. Opening or
// clicking a file from the tree brings the editor straight back (see
// editor.onTabsChange below).
document.getElementById('editor-minimize').addEventListener('click', () => setTerminalsOnly(true))

// Clicking an open document tab while minimized expands the editor back out.
// onTabsChange only fires when the tab COUNT changes, so a plain tab click (no
// open/close) wouldn't otherwise restore the editor. The minimize button isn't
// an .etab so it's naturally excluded; skip the close affordance so closing a
// tab doesn't expand the editor. setTerminalsOnly is a no-op when not minimized.
document.getElementById('editor-tabs').addEventListener('click', (e) => {
  if (!e.target.closest('.etab') || e.target.closest('.etab-close')) return
  setTerminalsOnly(false)
})

// Document viewer follows the open documents: showing the editor when a document
// is open, and reverting to terminals-only mode once every document is closed.
editor.onTabsChange((count) => setTerminalsOnly(count === 0))

// ---------- Theme (light default, dark optional, persisted) ----------
const THEME_KEY = 'concourse-theme'
let theme = localStorage.getItem(THEME_KEY) || 'light'
function applyTheme(mode) {
  theme = mode === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
  terminals.setTheme(theme)
  const btn = document.getElementById('toggle-theme')
  btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon')
  const tip = theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'
  btn.setAttribute('title', tip)
  btn.dataset.tip = tip
  localStorage.setItem(THEME_KEY, theme)
  // Mirror into the central settings store so the Settings window and any other
  // window reflect the change. The store only broadcasts on a real change and
  // applyTheme is a no-op when the value already matches, so this can't loop.
  Promise.resolve(api.settings?.set?.('appearance.theme', theme)).catch(() => {})
}
document.getElementById('toggle-theme').addEventListener('click', () => {
  applyTheme(theme === 'dark' ? 'light' : 'dark')
})
applyTheme(theme)

// ---------- Experience mode (beginner default, expert optional, persisted) ----------
// Two "lanes": beginner is calmer and more guided for people new to IDEs; expert
// follows standard IDE conventions. Foundation only for now — the flag lives on
// <html data-mode> (like data-theme) so CSS and feature code can branch off it.
// The one behavioral hook today: beginner terminals get a friendlier prompt.
const MODE_KEY = 'concourse-mode'
let mode = localStorage.getItem(MODE_KEY) || 'beginner'
function applyMode(next) {
  mode = next === 'expert' ? 'expert' : 'beginner'
  document.documentElement.dataset.mode = mode
  const btn = document.getElementById('toggle-mode')
  // Show the CURRENT mode as a labelled, colour-coded pill: a wand (guided "magic")
  // for beginner, a terminal glyph (raw shell) for expert. Clicking switches.
  const beginner = mode !== 'expert'
  btn.innerHTML =
    icon(beginner ? 'wand' : 'terminal', 14) +
    `<span class="mode-toggle-label">${beginner ? 'Beginner' : 'Expert'}</span>`
  btn.classList.toggle('beginner', beginner)
  btn.classList.toggle('expert', !beginner)
  const tip = beginner ? 'Switch to Expert Mode' : 'Switch to Beginner Mode'
  btn.setAttribute('title', tip)
  btn.dataset.tip = tip
  localStorage.setItem(MODE_KEY, mode)
  // Mirror into the central settings store (see applyTheme above for why this is loop-safe).
  Promise.resolve(api.settings?.set?.('appearance.mode', mode)).catch(() => {})
}
document.getElementById('toggle-mode').addEventListener('click', () => {
  applyMode(mode === 'expert' ? 'beginner' : 'expert')
})
applyMode(mode)

// ---------- Central settings (Settings window) ----------
// The Settings window writes to a main-process store; every window then receives a
// settings:changed broadcast. Editor/terminal preferences are applied live here;
// theme/mode are mirrored INTO the store by applyTheme/applyMode above (so the panel
// always shows the current state) and applied live when changed from the panel or
// another window.
function applyEditorTerminalSettings(v) {
  if (!v) return
  editor.applySettings({
    fontSize: v['editor.fontSize'],
    fontFamily: v['editor.fontFamily'],
    minimap: v['editor.minimap'],
    smoothScrolling: v['editor.smoothScrolling'],
    scrollBeyondLastLine: v['editor.scrollBeyondLastLine']
  })
  terminals.applySettings({
    fontSize: v['terminal.fontSize'],
    fontFamily: v['terminal.fontFamily'],
    cursorBlink: v['terminal.cursorBlink'],
    scrollback: v['terminal.scrollback']
  })
}
function applyAppearanceSettings(v) {
  if (!v) return
  if (v['appearance.theme'] && v['appearance.theme'] !== theme) applyTheme(v['appearance.theme'])
  if (v['appearance.mode'] && v['appearance.mode'] !== mode) applyMode(v['appearance.mode'])
}
// Initial load: localStorage already drove theme/mode (authoritative at boot, no
// flash), so only reconcile editor/terminal prefs here — this avoids a load-race
// where a stale store theme could briefly override the user's saved choice.
Promise.resolve(api.settings?.getAll?.())
  .then((snap) => applyEditorTerminalSettings(snap?.values))
  .catch(() => {})
// Live changes (Settings panel or another window) apply everything.
api.settings?.onChanged?.((payload) => {
  applyEditorTerminalSettings(payload?.values)
  applyAppearanceSettings(payload?.values)
})
// Titlebar gear opens (or focuses) the Settings window; the Settings… menu item
// (⌘,) routes through the same main-process handler.
document.getElementById('open-settings')?.addEventListener('click', () => api.window?.openSettings?.())

// ---------- Open folder ----------
async function setWorkspace(root) {
  if (!root) return
  if (currentRoot && root !== currentRoot) await saveSession() // persist the outgoing workspace
  currentRoot = root
  welcome.hide()
  setTitle(root)
  hud.setRoot(root)
  terminals.cdInto(root) // cd fresh shells (e.g. Shell 1) into the opened folder
  await fileTree.load(root)
  git.refresh()
  lastSavedJSON = null // new root — don't suppress its first save
}
document.getElementById('open-folder').addEventListener('click', async () => {
  const root = await api.workspace.open()
  await setWorkspace(root)
})

// Open another, independent app window (also on File ▸ New Window / ⇧⌘N).
document.getElementById('new-window')?.addEventListener('click', () => api.window?.open())

// Application-menu commands run the SAME action as the matching toolbar button,
// so the menu and the in-app buttons stay in lockstep (see src/main/menu.js).
api.menu?.onCommand?.((command) => {
  if (command === 'open-folder') document.getElementById('open-folder')?.click()
  else if (command === 'new-file') document.getElementById('ft-new-file')?.click()
  else if (command === 'new-folder') document.getElementById('ft-new-folder')?.click()
})

// Launch / start screen: opens a folder via the dialog or a recent project.
const welcome = createWelcome({
  onOpenDialog: async () => {
    const root = await api.workspace.open()
    await setWorkspace(root)
  },
  onOpenPath: async (dir) => {
    const root = await api.workspace.openPath(dir)
    if (root) await setWorkspace(root)
    else welcome.show() // path was stale and got pruned — re-render recents
  }
})

// ---------- Session save / restore (Tier A: layout + tabs, fresh shells) ----------
const $ = (id) => document.getElementById(id)

// Current session-blob schema version. Bumped when the blob shape changes; old
// blobs are upgraded by migrateSession() on restore.
const SESSION_VERSION = 1

// Snapshot the restorable workbench state for the current workspace.
function gatherSession() {
  const activeBtn = document.querySelector('.activity-btn.active')
  return {
    version: SESSION_VERSION,
    editor: editor.listOpenFiles(),
    terminals: terminals.getState(),
    ui: {
      view: activeBtn ? activeBtn.dataset.view : 'explorer',
      sidebarHidden: $('sidebar').classList.contains('hidden'),
      panelHidden: $('terminal-region').classList.contains('hidden'),
      terminalsOnly: $('main').classList.contains('terminals-only'),
      sidebarWidth: $('sidebar').offsetWidth,
      editorHeight: $('editor-region').offsetHeight
    }
  }
}

// Persist only when something changed (cheap dirty check), and never with no folder.
let lastSavedJSON = null
async function saveSession() {
  if (!currentRoot) return
  const json = JSON.stringify(gatherSession())
  if (json === lastSavedJSON) return
  lastSavedJSON = json
  try {
    await api.session.save(currentRoot, JSON.parse(json))
  } catch {
    // best-effort
  }
}
// A periodic dirty-check catches every kind of change (layout, resize, tabs,
// view) without hooking each event. Paused while the window is hidden — there's
// nothing the user can change off-screen — and resumed (with an immediate save to
// catch anything that slipped through) when it becomes visible again. NOTE: this
// only gates the SAVE timer; the Pulse tick lives in terminals.js and keeps
// running while hidden by design.
let saveTimer = setInterval(saveSession, 4000)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(saveTimer)
    saveTimer = null
  } else if (!saveTimer) {
    saveSession()
    saveTimer = setInterval(saveSession, 4000)
  }
})
// Final save on unload. The async save can't be relied on to complete during
// unload, so push the blob over the synchronous channel; the main process stages
// it and the before-quit flush drains it (see ipc-session.js + index.js).
window.addEventListener('beforeunload', () => {
  if (currentRoot) api.session.saveSync(currentRoot, gatherSession())
})

// Upgrade an older session blob to the current schema. A versionless blob is
// treated as v0; the v0->v1 step is a no-op seam (the shape is unchanged) so old
// and v1 blobs restore identically — but future shape changes hang off here.
function migrateSession(blob) {
  if (!blob || typeof blob !== 'object') return blob
  const version = blob.version || 0
  if (version < 1) {
    // v0 -> v1: no shape change yet; just stamp the version.
    blob = { ...blob, version: 1 }
  }
  return blob
}

// Rebuild the workbench from a saved blob. Terminals come back as fresh shells.
async function restoreSession(blob) {
  blob = migrateSession(blob)
  const ts = blob && blob.terminals
  if (!ts || !terminals.restore(ts)) terminals.create()

  const files = (blob && blob.editor && blob.editor.files) || []
  let activePath = null
  for (const f of files) {
    if (!f || !f.path) continue
    await editor.openFile(f.path, { line: f.line || 1 })
    if (f.active) activePath = f.path
  }
  if (activePath) await editor.openFile(activePath) // re-focus the tab that was active

  const ui = (blob && blob.ui) || {}
  if (ui.sidebarWidth) $('sidebar').style.width = ui.sidebarWidth + 'px'
  if (ui.editorHeight) $('editor-region').style.height = ui.editorHeight + 'px'
  if (ui.view && ui.view !== 'explorer') {
    document.querySelector(`.activity-btn[data-view="${ui.view}"]`)?.click()
  }
  if (ui.sidebarHidden) $('toggle-sidebar').click()
  if (ui.panelHidden) $('toggle-panel').click()
  // Opening files flips terminals-only off; honor the saved preference last.
  setTerminalsOnly(ui.terminalsOnly !== undefined ? ui.terminalsOnly : files.length === 0)
  terminals.fitAll()
}

// ---------- Resizable panes ----------
function dragV(bar, target) {
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = target.offsetWidth
    const move = (ev) => (target.style.width = Math.max(170, startW + ev.clientX - startX) + 'px')
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}
function dragH(bar, target) {
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = target.offsetHeight
    const move = (ev) => {
      target.style.height = Math.max(60, startH + (startY - ev.clientY)) + 'px'
      terminals.fitActive()
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}
dragV(document.getElementById('drag-x'), document.getElementById('sidebar'))
// Terminals dominate the top; the document viewer is the resizable bottom panel.
dragH(document.getElementById('drag-y'), document.getElementById('editor-region'))

// ---------- Boot ----------
// A window opened via "New Window" carries ?fresh=1 and starts blank (welcome
// screen) so you can pick a different folder; the launch / dock-activate window
// reopens the last session.
const isFreshWindow = new URLSearchParams(location.search).get('fresh') === '1'
;(async () => {
  // Auto-reopen the workspace from last session and restore its layout (skipped
  // for a fresh window so it doesn't clone the last folder).
  const lastRoot = isFreshWindow ? null : await api.session.lastRoot()
  if (lastRoot) {
    const root = await api.workspace.openPath(lastRoot)
    if (root) {
      currentRoot = root
      setTitle(root)
      // Mirror setWorkspace(): the boot/restore path must also seed the beginner
      // HUD, or its render() early-returns (null root) and the heads-up line stays
      // blank for a returning user — the default launch path in the default mode.
      hud.setRoot(root)
      await fileTree.load(root)
      git.refresh()
      let blob = null
      try {
        blob = await api.session.load(root)
      } catch {
        blob = null
      }
      await restoreSession(blob)
      return
    }
  }

  // No saved/last folder — greet with the start screen (recents + Open Folder).
  setTitle(null)
  await fileTree.load(null)
  git.refresh()
  terminals.create()
  setTerminalsOnly(true) // launch in terminals-only mode; opening a doc reveals the editor
  welcome.show()
})()
