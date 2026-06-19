import './style.css'
import { createEditor } from './editor.js'
import { createFileTree } from './fileTree.js'
import { createGit } from './git.js'
import { createTerminals } from './terminals.js'
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

const terminals = createTerminals({
  getRoot: () => currentRoot
})

// Saving a file should refresh git status.
editor.onSave(() => git.refresh())

// ---------- Activity bar (view switching) ----------
const panels = {
  explorer: document.getElementById('explorer-panel'),
  scm: document.getElementById('scm-panel')
}
document.querySelectorAll('.activity-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view
    document.querySelectorAll('.activity-btn').forEach((b) => b.classList.toggle('active', b === btn))
    for (const [name, el] of Object.entries(panels)) el.hidden = name !== view
    if (view === 'scm') git.refresh()
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
  currentRoot = root
  setTitle(root)
  terminals.cdInto(root) // cd fresh shells (e.g. Shell 1) into the opened folder
  await fileTree.load(root)
  git.refresh()
}
document.getElementById('open-folder').addEventListener('click', async () => {
  const root = await api.workspace.open()
  await setWorkspace(root)
})

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
dragH(document.getElementById('drag-y'), document.getElementById('terminal-region'))

// ---------- Boot ----------
;(async () => {
  currentRoot = await api.workspace.get()
  setTitle(currentRoot)
  await fileTree.load(currentRoot)
  git.refresh()
  terminals.create()
  // Launch in terminals-only mode; opening a document reveals the editor.
  setTerminalsOnly(true)
})()
