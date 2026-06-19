import '@xterm/xterm/css/xterm.css'
import './terminals.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { icon } from './icons.js'

const api = window.api

// xterm color themes, switched together with the app light/dark theme.
const TERM_THEMES = {
  light: { background: '#ffffff', foreground: '#383838', cursor: '#383838', selectionBackground: '#cfe3ff' },
  dark: { background: '#181818', foreground: '#cccccc', cursor: '#cccccc', selectionBackground: '#264f78' }
}

// Spawn presets — the whole point of Concourse: launch many CLI agents fast.
const PRESETS = [
  { key: 'shell', label: 'Shell', name: 'shell', command: null },
  { key: 'claude', label: 'Claude Code', name: 'claude', command: 'claude' },
  { key: 'claude-yolo', label: 'Claude Code (--dangerously-skip-permissions)', name: 'claude', command: 'claude --dangerously-skip-permissions' }
]

// Tabbed + grid terminal multiplexer. Each session is an independent PTY shell;
// run a CLI coding agent in each and watch them all at once in grid view.
export function createTerminals({ getRoot }) {
  const tabBar = document.getElementById('term-tabs')
  const panesEl = document.getElementById('term-panes')
  const controls = document.querySelector('#terminal-region .panel-controls')
  const newBtn = document.getElementById('new-term')

  const sessions = new Map() // id -> session
  let activeId = null
  let counter = 0
  let layout = 'tabs' // 'tabs' | 'grid'
  let themeName = 'light'
  panesEl.classList.add('tabs')

  // ---- inject extra panel controls (layout toggle + preset caret) ----
  const layoutBtn = document.createElement('button')
  layoutBtn.className = 'icon-btn'
  layoutBtn.title = 'Toggle grid / tabs layout'
  layoutBtn.innerHTML = icon('grid')
  controls.insertBefore(layoutBtn, newBtn)

  const caretBtn = document.createElement('button')
  caretBtn.className = 'icon-btn'
  caretBtn.title = 'New terminal / agent…'
  caretBtn.innerHTML = icon('chevronDown')
  controls.appendChild(caretBtn)

  layoutBtn.addEventListener('click', () => setLayout(layout === 'tabs' ? 'grid' : 'tabs'))
  newBtn.addEventListener('click', () => create({}))
  caretBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    openPresetMenu(caretBtn)
  })

  // ---- preset dropdown ----
  function openPresetMenu(anchor) {
    closePresetMenu()
    const menu = document.createElement('div')
    menu.className = 'term-menu'
    menu.id = 'term-preset-menu'
    for (const p of PRESETS) {
      const item = document.createElement('div')
      item.className = 'term-menu-item'
      item.textContent = p.label
      item.addEventListener('click', () => {
        create({ name: p.name, command: p.command })
        closePresetMenu()
      })
      menu.appendChild(item)
    }
    document.body.appendChild(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.top = r.bottom + 4 + 'px'
    menu.style.right = window.innerWidth - r.right + 'px'
    setTimeout(() => document.addEventListener('mousedown', closePresetMenu, { once: true }), 0)
  }
  function closePresetMenu() {
    const m = document.getElementById('term-preset-menu')
    if (m) m.remove()
  }

  // ---- per-terminal right-click menu (rename / close) ----
  function openTabMenu(x, y, s) {
    const existing = document.getElementById('term-tab-menu')
    if (existing) existing.remove()
    const menu = document.createElement('div')
    menu.className = 'term-menu'
    menu.id = 'term-tab-menu'

    const rename = document.createElement('div')
    rename.className = 'term-menu-item'
    rename.textContent = 'Rename…'
    rename.addEventListener('click', () => {
      menu.remove()
      activate(s.id)
      renameStart(s, s.tabLabel)
    })

    const close = document.createElement('div')
    close.className = 'term-menu-item danger'
    close.textContent = 'Close Terminal'
    close.addEventListener('click', () => {
      menu.remove()
      confirmClose(s)
    })

    menu.append(rename, close)
    document.body.appendChild(menu)
    // clamp to viewport
    menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + 'px'
    menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + 'px'
    const dismiss = (e) => {
      if (!menu.contains(e.target)) menu.remove()
    }
    setTimeout(() => document.addEventListener('mousedown', dismiss, { once: true }), 0)
  }

  // ---- confirmation before terminating a shell (no window.confirm) ----
  function confirmClose(s) {
    const overlay = document.createElement('div')
    overlay.className = 'term-confirm-overlay'
    const box = document.createElement('div')
    box.className = 'term-confirm'
    const name = s.tabLabel.textContent
    box.innerHTML =
      `<div class="tc-title">Close “${name}”?</div>` +
      `<div class="tc-msg">The shell and any running agent will be terminated.</div>`
    const actions = document.createElement('div')
    actions.className = 'tc-actions'
    const cancel = document.createElement('button')
    cancel.className = 'btn tc-cancel'
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.className = 'btn tc-danger'
    ok.textContent = 'Close Terminal'
    actions.append(cancel, ok)
    box.appendChild(actions)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    cancel.focus()

    const finish = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') finish()
    }
    document.addEventListener('keydown', onKey)
    cancel.addEventListener('click', finish)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish()
    })
    ok.addEventListener('click', () => {
      finish()
      destroy(s.id)
    })
  }

  // ---- layout ----
  function setLayout(mode) {
    layout = mode
    panesEl.classList.toggle('grid', mode === 'grid')
    panesEl.classList.toggle('tabs', mode === 'tabs')
    layoutBtn.innerHTML = icon(mode === 'grid' ? 'square' : 'grid')
    applyGrid()
    fitAll()
    if (activeId) activate(activeId)
  }
  function applyGrid() {
    // Reset any spans first (keeps tabs mode / relayout clean).
    for (const s of sessions.values()) s.cell.style.gridColumn = ''
    if (layout !== 'grid') return
    const n = sessions.size
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
    panesEl.style.setProperty('--cols', cols)
    // If the last row isn't full, let the final cell fill the gap (no ghost cell).
    const remainder = n % cols
    if (remainder !== 0) {
      const last = [...sessions.values()].pop()
      if (last) last.cell.style.gridColumn = `span ${cols - remainder + 1}`
    }
  }

  // ---- indicator dot ----
  function updateIndicators(s) {
    let cls = 'running'
    if (s.status === 'exited') cls = 'exited'
    else if (s.attention) cls = 'attention'
    else if (s.activity) cls = 'activity'
    s.tabDot.className = 'dot ' + cls
    s.cellDot.className = 'dot ' + cls
  }
  function clearFlags(s) {
    s.activity = false
    s.attention = false
    updateIndicators(s)
  }

  // ---- create / destroy ----
  function create({ name, command } = {}) {
    const id = 'term-' + ++counter
    const displayName = name ? `${name} ${counter}` : `shell ${counter}`

    // Tab
    const tabEl = document.createElement('button')
    tabEl.className = 'term-tab'
    const tabDot = document.createElement('span')
    tabDot.className = 'dot running'
    const tabLabel = document.createElement('span')
    tabLabel.className = 'term-tab-label'
    tabLabel.textContent = displayName
    // No close button on tabs — shells are meant to persist. Close via right-click.
    tabEl.append(tabDot, tabLabel)
    tabBar.appendChild(tabEl)

    // Cell (holds the xterm; lives in both tabs and grid layout)
    const cell = document.createElement('div')
    cell.className = 'term-cell'
    const cellHeader = document.createElement('div')
    cellHeader.className = 'cell-header'
    const cellDot = document.createElement('span')
    cellDot.className = 'dot running'
    const cellLabel = document.createElement('span')
    cellLabel.className = 'cell-label'
    cellLabel.textContent = displayName
    // No close button — persist shells. Close via right-click (with confirm).
    cellHeader.append(cellDot, cellLabel)
    const cellBody = document.createElement('div')
    cellBody.className = 'cell-body'
    cell.append(cellHeader, cellBody)
    panesEl.appendChild(cell)

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "SF Mono", "Courier New", monospace',
      fontSize: 12.5,
      theme: TERM_THEMES[themeName],
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(cellBody)
    fit.fit()

    const s = {
      id, term, fit, cell, tabEl, tabDot, tabLabel, cellLabel, cellDot,
      status: 'running', activity: false, attention: false, custom: false
    }
    sessions.set(id, s)

    api.term.create(id, getRoot())
    term.onData((data) => api.term.input(id, data))
    term.onResize(({ cols, rows }) => api.term.resize(id, cols, rows))
    term.onBell(() => {
      s.attention = true
      updateIndicators(s)
    })

    // focus this cell when clicked
    cell.addEventListener('mousedown', () => activate(id))
    tabEl.addEventListener('click', () => activate(id))
    // Close is intentionally indirect: right-click menu + confirmation.
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openTabMenu(e.clientX, e.clientY, s)
    })
    cellHeader.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openTabMenu(e.clientX, e.clientY, s)
    })
    tabLabel.addEventListener('dblclick', () => renameStart(s, tabLabel))
    cellLabel.addEventListener('dblclick', () => renameStart(s, cellLabel))

    applyGrid()
    activate(id)

    // Fire the preset command once the shell has settled.
    if (command) setTimeout(() => api.term.input(id, command + '\r'), 500)
    return id
  }

  function destroy(id) {
    const s = sessions.get(id)
    if (!s) return
    api.term.kill(id)
    s.term.dispose()
    s.cell.remove()
    s.tabEl.remove()
    sessions.delete(id)
    applyGrid()
    if (activeId === id) {
      const next = sessions.keys().next()
      activeId = null
      if (!next.done) activate(next.value)
    }
    fitAll()
  }

  function activate(id) {
    const s = sessions.get(id)
    if (!s) return
    activeId = id
    for (const [sid, sess] of sessions) {
      const on = sid === id
      sess.cell.classList.toggle('active', on)
      sess.cell.classList.toggle('focused', on)
      sess.tabEl.classList.toggle('active', on)
    }
    clearFlags(s)
    s.fit.fit()
    s.term.focus()
    api.term.resize(id, s.term.cols, s.term.rows)
  }

  // ---- rename ----
  function renameStart(s, labelEl) {
    const input = document.createElement('input')
    input.className = 'rename-input'
    input.value = labelEl.textContent
    labelEl.replaceWith(input)
    input.focus()
    input.select()
    const commit = () => {
      const v = input.value.trim() || labelEl.textContent
      s.custom = true
      s.tabLabel.textContent = v
      s.cellLabel.textContent = v
      input.replaceWith(labelEl === s.tabLabel ? s.tabLabel : s.cellLabel)
      // keep both labels in sync
      s.tabLabel.textContent = v
      s.cellLabel.textContent = v
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') input.replaceWith(labelEl)
    })
    input.addEventListener('blur', commit)
  }

  // ---- fit ----
  function fitAll() {
    for (const s of sessions.values()) {
      try {
        s.fit.fit()
        api.term.resize(s.id, s.term.cols, s.term.rows)
      } catch {
        /* not visible yet */
      }
    }
  }
  function fitActive() {
    if (layout === 'grid') return fitAll()
    const s = sessions.get(activeId)
    if (s) s.fit.fit()
  }

  // ---- pty output -> terminal, with activity/attention tracking ----
  api.term.onData(({ id, data }) => {
    const s = sessions.get(id)
    if (!s) return
    s.term.write(data)
    if (id !== activeId && !s.attention) {
      s.activity = true
      updateIndicators(s)
    }
  })
  api.term.onExit(({ id }) => {
    const s = sessions.get(id)
    if (!s) return
    s.status = 'exited'
    updateIndicators(s)
    s.tabEl.classList.add('exited')
  })

  window.addEventListener('resize', fitAll)

  // Apply a light/dark theme to all existing terminals and future ones.
  function setTheme(name) {
    themeName = TERM_THEMES[name] ? name : 'light'
    for (const s of sessions.values()) s.term.options.theme = TERM_THEMES[themeName]
  }

  return { create, fitActive, fitAll, setLayout, setTheme }
}
