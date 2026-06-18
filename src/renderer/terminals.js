import '@xterm/xterm/css/xterm.css'
import './terminals.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const api = window.api

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
  panesEl.classList.add('tabs')

  // ---- inject extra panel controls (layout toggle + preset caret) ----
  const layoutBtn = document.createElement('button')
  layoutBtn.className = 'icon-btn'
  layoutBtn.title = 'Toggle grid / tabs layout'
  layoutBtn.textContent = '▦'
  controls.insertBefore(layoutBtn, newBtn)

  const caretBtn = document.createElement('button')
  caretBtn.className = 'icon-btn'
  caretBtn.title = 'New terminal / agent…'
  caretBtn.textContent = '▾'
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

  // ---- layout ----
  function setLayout(mode) {
    layout = mode
    panesEl.classList.toggle('grid', mode === 'grid')
    panesEl.classList.toggle('tabs', mode === 'tabs')
    layoutBtn.textContent = mode === 'grid' ? '▭' : '▦'
    applyGrid()
    fitAll()
    if (activeId) activate(activeId)
  }
  function applyGrid() {
    if (layout !== 'grid') return
    const n = sessions.size
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
    panesEl.style.setProperty('--cols', cols)
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
    const tabClose = document.createElement('span')
    tabClose.className = 'close'
    tabClose.textContent = '✕'
    tabEl.append(tabDot, tabLabel, tabClose)
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
    const cellClose = document.createElement('span')
    cellClose.className = 'close'
    cellClose.textContent = '✕'
    cellHeader.append(cellDot, cellLabel, cellClose)
    const cellBody = document.createElement('div')
    cellBody.className = 'cell-body'
    cell.append(cellHeader, cellBody)
    panesEl.appendChild(cell)

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "SF Mono", "Courier New", monospace',
      fontSize: 12.5,
      theme: { background: '#181818', foreground: '#cccccc', cursor: '#cccccc' },
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
    tabEl.addEventListener('click', (e) => {
      if (e.target === tabClose) return
      activate(id)
    })
    tabClose.addEventListener('click', (e) => {
      e.stopPropagation()
      destroy(id)
    })
    cellClose.addEventListener('click', (e) => {
      e.stopPropagation()
      destroy(id)
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

  return { create, fitActive, fitAll, setLayout }
}
