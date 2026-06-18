import './style.css'
import { createEditor } from './editor.js'
import { createFileTree } from './fileTree.js'
import { createGit } from './git.js'
import { createTerminals } from './terminals.js'

const api = window.api

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

// ---------- Open folder ----------
async function setWorkspace(root) {
  if (!root) return
  currentRoot = root
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
  await fileTree.load(currentRoot)
  git.refresh()
  terminals.create()
})()
