import './welcome.css'
import { icon } from './icons.js'

const api = window.api

// Collapse a home-prefixed path to ~ for compact display. We don't know the
// real home dir in the renderer, so just shorten /Users/<name> and /home/<name>.
function prettyDir(p) {
  const norm = p.replace(/\\/g, '/')
  return norm.replace(/^\/(Users|home)\/[^/]+/, '~')
}

export function createWelcome({ onOpenDialog, onOpenPath } = {}) {
  const overlay = document.getElementById('welcome-overlay')
  const recentsEl = document.getElementById('welcome-recents')
  const openBtn = document.getElementById('welcome-open')

  openBtn.addEventListener('click', async () => {
    if (typeof onOpenDialog === 'function') await onOpenDialog()
  })

  async function renderRecents() {
    recentsEl.innerHTML = ''
    let recents = []
    try {
      recents = await api.workspace.recents()
    } catch {
      recents = []
    }

    if (!recents || recents.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'welcome-empty'
      empty.textContent = 'No recent projects yet.'
      recentsEl.appendChild(empty)
      return
    }

    for (const r of recents) {
      const row = document.createElement('button')
      row.className = 'welcome-recent'
      row.title = r.path

      const ic = document.createElement('span')
      ic.className = 'welcome-recent-icon'
      ic.innerHTML = icon('folderOpen', 15)

      const name = document.createElement('span')
      name.className = 'welcome-recent-name'
      name.textContent = r.name

      const dir = document.createElement('span')
      dir.className = 'welcome-recent-dir'
      dir.textContent = prettyDir(r.path)

      row.append(ic, name, dir)
      row.addEventListener('click', async () => {
        if (typeof onOpenPath === 'function') await onOpenPath(r.path)
      })
      recentsEl.appendChild(row)
    }
  }

  function show() {
    overlay.hidden = false
    renderRecents()
  }

  function hide() {
    overlay.hidden = true
  }

  return { show, hide }
}
