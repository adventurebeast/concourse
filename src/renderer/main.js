import './style.css'
import { createEditor } from './editor.js'
import { createFileTree } from './fileTree.js'
import { createGit } from './git.js'
import { createSearch } from './search.js'
import { createTerminals } from './terminals.js'
import { createWelcome } from './welcome.js'
import { createKeybindings } from './keybindings.js'
import { icon } from './icons.js'

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

const git = createGit({
  // Open a git diff as a read-only tab in the editor.
  onOpenDiff: (opts) => editor.openDiff(opts)
})

const fileTree = createFileTree({
  onOpenFile: (path) => editor.openFile(path)
})

const search = createSearch({
  getRoot: () => currentRoot,
  // Open the file and jump to the matched line/column.
  onOpenFile: (path, opts) => editor.openFile(path, opts)
})

const terminals = createTerminals({
  getRoot: () => currentRoot
})

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
// Cmd/Ctrl+1..9 jump straight to the Nth terminal tab.
for (let n = 1; n <= 9; n++) {
  keys.register(`mod+${n}`, () => terminals.activateIndex(n - 1))
}
// Cmd/Ctrl+W closes the active terminal (routes through the confirm dialog).
keys.register('mod+w', () => terminals.closeActive())
// Layout modes: a single cycler plus direct keys. tabs/grid/stack/flow sit on
// the adjacent U I O P keys; Cmd+Shift+L taps through them in order.
keys.register('mod+shift+l', () => terminals.cycleLayout(1))
keys.register('mod+u', () => terminals.setLayout('tabs'))
keys.register('mod+i', () => terminals.setLayout('grid'))
keys.register('mod+o', () => terminals.setLayout('stack'))
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
  btn.innerHTML = icon(mode === 'expert' ? 'compass' : 'lifeBuoy')
  const tip = mode === 'expert' ? 'Switch to Beginner Mode' : 'Switch to Expert Mode'
  btn.setAttribute('title', tip)
  btn.dataset.tip = tip
  localStorage.setItem(MODE_KEY, mode)
}
document.getElementById('toggle-mode').addEventListener('click', () => {
  applyMode(mode === 'expert' ? 'beginner' : 'expert')
})
applyMode(mode)

// ---------- Open folder ----------
async function setWorkspace(root) {
  if (!root) return
  if (currentRoot && root !== currentRoot) await saveSession() // persist the outgoing workspace
  currentRoot = root
  welcome.hide()
  setTitle(root)
  terminals.cdInto(root) // cd fresh shells (e.g. Shell 1) into the opened folder
  await fileTree.load(root)
  git.refresh()
  lastSavedJSON = null // new root — don't suppress its first save
}
document.getElementById('open-folder').addEventListener('click', async () => {
  const root = await api.workspace.open()
  await setWorkspace(root)
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

// Snapshot the restorable workbench state for the current workspace.
function gatherSession() {
  const activeBtn = document.querySelector('.activity-btn.active')
  return {
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
// view) without hooking each event; a final best-effort save on unload too.
setInterval(saveSession, 4000)
window.addEventListener('beforeunload', () => {
  if (currentRoot) api.session.save(currentRoot, gatherSession())
})

// Rebuild the workbench from a saved blob. Terminals come back as fresh shells.
async function restoreSession(blob) {
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
;(async () => {
  // Auto-reopen the workspace from last session and restore its layout.
  const lastRoot = await api.session.lastRoot()
  if (lastRoot) {
    const root = await api.workspace.openPath(lastRoot)
    if (root) {
      currentRoot = root
      setTitle(root)
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
