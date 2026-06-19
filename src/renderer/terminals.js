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

// Per-terminal identity colours. Each new terminal gets the next colour, shown
// on its tab and pane so you can track which pane is which at a glance — vital
// once you have a wall of them. Tuned to read on both light and dark backgrounds.
const TERM_COLORS = [
  '#4f9cff', '#f0883e', '#3fb950', '#db61a2',
  '#a371f7', '#e3b341', '#56d4dd', '#f85149'
]

// Tabbed + grid terminal multiplexer. Each session is an independent PTY shell;
// run a CLI coding agent in each and watch them all at once in grid view.
export function createTerminals({ getRoot }) {
  const tabBar = document.getElementById('term-tabs')
  const panesEl = document.getElementById('term-panes')
  const controls = document.querySelector('#terminal-region .panel-controls')

  const sessions = new Map() // id -> session
  let activeId = null
  let counter = 0
  let layout = 'tabs' // 'tabs' | 'grid' | 'stack' | 'flow'
  let flowIndex = 0 // which session sits in the centre in 'flow' (album) layout
  let themeName = 'light'
  panesEl.classList.add('tabs')

  // ---- inject extra panel controls: one button per layout, always visible ----
  // The button for the current layout is highlighted (.active).
  const LAYOUTS = [
    { mode: 'tabs', icon: 'square', tip: 'Tabs layout (one terminal)' },
    { mode: 'grid', icon: 'grid', tip: 'Grid layout (all terminals)' },
    { mode: 'stack', icon: 'stack', tip: 'Master-stack layout (primary + rail)' },
    { mode: 'flow', icon: 'flow', tip: 'Album flow (centre + side previews · ⌥←/→ to cycle)' }
  ]
  const layoutBtns = new Map()
  for (const def of LAYOUTS) {
    const btn = document.createElement('button')
    btn.className = 'icon-btn'
    btn.innerHTML = icon(def.icon)
    btn.title = def.tip
    btn.dataset.tip = def.tip
    btn.addEventListener('click', () => setLayout(def.mode))
    controls.appendChild(btn)
    layoutBtns.set(def.mode, btn)
  }
  syncLayoutBtn()

  // Inline "+" that always sits just after the last tab, so opening another
  // terminal is one click away no matter how many you have.
  const newTabBtn = document.createElement('button')
  newTabBtn.className = 'term-tab-add'
  newTabBtn.innerHTML = icon('plus', 14)
  newTabBtn.title = 'New Terminal'
  newTabBtn.dataset.tip = 'New Terminal'
  newTabBtn.addEventListener('click', () => create({}))
  tabBar.appendChild(newTabBtn)

  // ---- drag-to-reorder ----
  // Native HTML5 DnD. On drop we rewrite the tab DOM order and rebuild the
  // sessions Map to match, so grid/stack (which iterate the Map) follow suit.
  let dragId = null
  function wireTabDrag(tabEl, s) {
    tabEl.addEventListener('dragstart', (e) => {
      dragId = s.id
      tabEl.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })
    tabEl.addEventListener('dragend', () => {
      dragId = null
      tabEl.classList.remove('dragging')
      reorderFromDom()
    })
    tabEl.addEventListener('dragover', (e) => {
      if (dragId == null || dragId === s.id) return
      e.preventDefault()
      const dragging = sessions.get(dragId)
      if (!dragging) return
      const r = tabEl.getBoundingClientRect()
      const after = e.clientX > r.left + r.width / 2
      tabBar.insertBefore(dragging.tabEl, after ? tabEl.nextSibling : tabEl)
    })
  }
  // Rebuild the sessions Map in the current tab DOM order.
  function reorderFromDom() {
    const ordered = [...tabBar.querySelectorAll('.term-tab')]
      .map((el) => [...sessions.values()].find((s) => s.tabEl === el))
      .filter(Boolean)
    sessions.clear()
    for (const s of ordered) sessions.set(s.id, s)
    applyLayout()
    fitAll()
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
  // Highlight the button matching the current layout.
  function syncLayoutBtn() {
    for (const [mode, btn] of layoutBtns) btn.classList.toggle('active', mode === layout)
  }
  function setLayout(mode) {
    layout = mode
    panesEl.classList.toggle('grid', mode === 'grid')
    panesEl.classList.toggle('tabs', mode === 'tabs')
    panesEl.classList.toggle('stack', mode === 'stack')
    panesEl.classList.toggle('flow', mode === 'flow')
    syncLayoutBtn()
    // Entering flow: centre on whatever is currently active so it doesn't jump.
    if (mode === 'flow') {
      const idx = [...sessions.values()].findIndex((s) => s.id === activeId)
      if (idx >= 0) flowIndex = idx
    }
    applyLayout()
    fitAll()
    if (activeId) activate(activeId)
  }
  function applyLayout() {
    if (layout === 'grid') applyGrid()
    else if (layout === 'stack') applyStack()
    else if (layout === 'flow') applyFlow()
    else resetCellStyles()
  }
  // Clear any inline placement / layout classes so the next layout starts clean.
  function resetCellStyles() {
    for (const s of sessions.values()) {
      s.cell.style.gridColumn = ''
      s.cell.style.gridRow = ''
      s.cell.style.order = ''
      s.cell.classList.remove('flow-center', 'flow-prev', 'flow-next')
    }
  }
  function applyGrid() {
    resetCellStyles()
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
  // Master-stack: the active session fills a big primary column on the left;
  // every other session is a small live tile in a scrollable rail on the right.
  // Clicking a rail tile promotes it (activate() re-runs this). A two-column CSS
  // grid does the layout; we place each cell explicitly so insertion order in the
  // rail is stable and the primary spans the full height.
  function applyStack() {
    resetCellStyles()
    const order = [...sessions.values()]
    const rail = order.filter((s) => s.id !== activeId)
    const rows = Math.max(1, rail.length)
    panesEl.style.setProperty('--stack-rows', rows)
    const primary = sessions.get(activeId) || order[0]
    if (primary) {
      // With no rail tiles the primary takes the whole width (no empty rail gap).
      primary.cell.style.gridColumn = rail.length ? '1' : '1 / -1'
      primary.cell.style.gridRow = `1 / span ${rows}`
    }
    rail.forEach((s, i) => {
      s.cell.style.gridColumn = '2'
      s.cell.style.gridRow = `${i + 1} / span 1`
    })
  }

  // Album flow: the centred session is large and interactive; its neighbours sit
  // as slim previews on either side ([ ][   ][ ]). Click a side preview, or hit
  // ⌥←/→, to bring a neighbour to the centre. Everything else is hidden.
  function applyFlow() {
    resetCellStyles()
    const order = [...sessions.values()]
    const n = order.length
    if (!n) return
    flowIndex = ((flowIndex % n) + n) % n
    const center = order[flowIndex]
    center.cell.classList.add('flow-center')
    center.cell.style.order = '2'
    if (n > 1) {
      const prev = order[(flowIndex - 1 + n) % n]
      const next = order[(flowIndex + 1) % n]
      prev.cell.classList.add('flow-prev')
      prev.cell.style.order = '1'
      // With exactly two terminals prev === next; show it on one side only.
      if (next !== prev) {
        next.cell.classList.add('flow-next')
        next.cell.style.order = '3'
      }
    }
  }
  // Route a click: re-centre in flow mode, otherwise just focus.
  function selectCell(id) {
    if (layout === 'flow') {
      const s = sessions.get(id)
      if (s && !s.cell.classList.contains('flow-center')) return centerOn(id)
    }
    activate(id)
  }
  // Centre a specific session (e.g. a clicked side preview or tab) and focus it
  // so you can type immediately — one click, no second click to focus.
  function centerOn(id) {
    const idx = [...sessions.values()].findIndex((s) => s.id === id)
    if (idx < 0) return
    flowIndex = idx
    applyFlow()
    fitAll()
    activate(id)
    // The pane just became the (newly interactive) centre; focus on the next
    // tick once the reflow has settled so the very first click lands the cursor.
    const s = sessions.get(id)
    if (s) setTimeout(() => s.term.focus(), 0)
  }
  // Step the album flow by ±1 (wraps around) and focus the new centre.
  function stepFlow(dir) {
    const n = sessions.size
    if (!n) return
    flowIndex = ((flowIndex + dir) % n + n) % n
    applyFlow()
    fitAll()
    const center = [...sessions.values()][flowIndex]
    if (center) activate(center.id)
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
    const color = TERM_COLORS[(counter - 1) % TERM_COLORS.length]

    // Tab
    const tabEl = document.createElement('button')
    tabEl.className = 'term-tab'
    tabEl.draggable = true
    tabEl.style.setProperty('--term-color', color)
    const tabDot = document.createElement('span')
    tabDot.className = 'dot running'
    const tabLabel = document.createElement('span')
    tabLabel.className = 'term-tab-label'
    tabLabel.textContent = displayName
    const tabClose = document.createElement('span')
    tabClose.className = 'close'
    tabClose.innerHTML = icon('close', 12)
    tabClose.title = 'Close Terminal'
    tabEl.append(tabDot, tabLabel, tabClose)
    tabBar.insertBefore(tabEl, newTabBtn)

    // Cell (holds the xterm; lives in both tabs and grid layout)
    const cell = document.createElement('div')
    cell.className = 'term-cell'
    cell.style.setProperty('--term-color', color)
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
      id, term, fit, cell, tabEl, tabDot, tabLabel, cellLabel, cellDot, color,
      status: 'running', activity: false, attention: false, custom: false,
      used: false, // true once the user types or a command runs — then we won't auto-cd it
      isShell: !command, // plain shell vs an agent preset — gates command capture
      lineBuf: '', // keystroke accumulator for the last-command heuristic
      baseName: displayName, // fallback label shown when nothing better is known
      oscTitle: null, // last OSC 0/2 title the program emitted (Layer 0)
      heurTitle: null, // last heuristic label (last command + branch)
      titleTimer: null // debounce handle for onTitleChange
    }
    sessions.set(id, s)

    // Beginner mode gets the calmer, friendlier shell prompt; expert mode is left bare.
    const friendlyPrompt = document.documentElement.dataset.mode !== 'expert'
    api.term.create(id, getRoot(), { friendlyPrompt })
    term.onData((data) => {
      s.used = true
      if (s.isShell) captureCommand(s, data)
      api.term.input(id, data)
    })
    term.onResize(({ cols, rows }) => api.term.resize(id, cols, rows))
    term.onBell(() => {
      s.attention = true
      updateIndicators(s)
    })
    // Auto-title: catch the OSC 0/2 title ANY program emits (a shell with a
    // titled prompt, vim, ssh, or an agent that reports its task) and route it
    // into the tab + cell labels. Debounced to coalesce rapid updates; never
    // overrides a manual rename. Harness-agnostic — no assumption about what's
    // running in the pane.
    term.onTitleChange((title) => {
      if (s.custom) return
      clearTimeout(s.titleTimer)
      s.titleTimer = setTimeout(() => setAutoTitle(s, title), 150)
    })

    // Click selects. In flow mode, clicking a side preview brings it to centre;
    // clicking the centre (or any other layout) just focuses it.
    cell.addEventListener('mousedown', () => selectCell(id))
    tabEl.addEventListener('click', (e) => {
      if (tabClose.contains(e.target)) return // close handled separately
      selectCell(id)
    })
    // Visible close button (still confirms before terminating the shell).
    tabClose.addEventListener('click', (e) => {
      e.stopPropagation()
      confirmClose(s)
    })
    // Drag to reorder tabs; the grid/stack order follows the tab order.
    wireTabDrag(tabEl, s)
    // Right-click still offers rename / close.
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

    applyLayout()
    // In album flow a brand-new terminal becomes the centre; elsewhere just focus.
    if (layout === 'flow') centerOn(id)
    else activate(id)
    refreshBranch() // warm the git-branch cache for the last-command heuristic

    // Fire the preset command once the shell has settled (this counts as "used").
    if (command) {
      s.used = true
      setTimeout(() => api.term.input(id, command + '\r'), 500)
    }
    return id
  }

  function destroy(id) {
    const s = sessions.get(id)
    if (!s) return
    clearTimeout(s.titleTimer)
    api.term.kill(id)
    s.term.dispose()
    s.cell.remove()
    s.tabEl.remove()
    sessions.delete(id)
    applyLayout()
    if (layout === 'flow' && sessions.size) {
      // Keep a visible (centred) terminal focused, never a hidden neighbour.
      const n = sessions.size
      flowIndex = ((flowIndex % n) + n) % n
      activeId = null
      activate([...sessions.values()][flowIndex].id)
    } else if (activeId === id) {
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
    // In master-stack the active session IS the primary pane, so re-flow + refit
    // every pane whose size just changed (the promoted one and the demoted one).
    if (layout === 'stack') {
      applyStack()
      fitAll()
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
      const v = input.value.trim()
      input.replaceWith(labelEl === s.tabLabel ? s.tabLabel : s.cellLabel)
      if (!v) {
        // An empty rename clears the custom flag, re-arming auto-titling.
        s.custom = false
        applyTitle(s)
        return
      }
      s.custom = true
      s.tabLabel.textContent = v
      s.cellLabel.textContent = v
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') input.replaceWith(labelEl)
    })
    input.addEventListener('blur', commit)
  }

  // ---- auto-title resolver ----------------------------------------------------
  // Priority: a manual rename (s.custom) wins; else the live OSC title a program
  // emits (Layer 0) wins; else the free heuristic (last command + git branch);
  // else the base name ("shell 2"). One resolver keeps the layers from fighting
  // and is where a model-generated summary would slot in later.
  const MAX_TITLE = 60
  function applyAutoLabels(s, text) {
    // Guard against writing into a label that's mid-rename (detached node).
    if (s.tabLabel.isConnected) s.tabLabel.textContent = text
    if (s.cellLabel.isConnected) s.cellLabel.textContent = text
    s.tabEl.title = text // full untruncated string on hover
    s.cell.title = text
  }
  function applyTitle(s) {
    if (s.custom) return // a manual rename always wins
    let t = s.oscTitle || s.heurTitle || s.baseName
    if (t.length > MAX_TITLE) t = t.slice(0, MAX_TITLE - 1) + '…'
    applyAutoLabels(s, t)
  }
  function setAutoTitle(s, raw) {
    const t = (raw || '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim()
    s.oscTitle = !t || t === s.baseName ? null : t
    applyTitle(s)
  }

  // ---- free heuristic: last command + git branch -----------------------------
  // Zero-cost, harness-agnostic "clue" for shell/command panes. We reconstruct
  // the command line straight from the user's keystrokes — no output parsing, no
  // prompt-format assumptions, no shell integration. Best-effort: bail on escape
  // sequences (arrow keys / history recall) rather than guess.
  let cachedBranch = null
  let branchPending = false
  function refreshBranch() {
    if (branchPending) return
    branchPending = true
    api.git
      .status()
      .then((st) => {
        cachedBranch = st && st.isRepo && st.branch ? st.branch : null
      })
      .catch(() => {})
      .finally(() => {
        branchPending = false
      })
  }
  function captureCommand(s, data) {
    for (const ch of data) {
      const code = ch.charCodeAt(0)
      if (ch === '\r' || ch === '\n') {
        const cmd = s.lineBuf.trim()
        s.lineBuf = ''
        if (cmd) setHeuristic(s, cmd)
      } else if (ch === '\x7f' || ch === '\b') {
        s.lineBuf = s.lineBuf.slice(0, -1)
      } else if (code === 0x1b) {
        s.lineBuf = '' // escape sequence (arrows, history, paste) — don't guess
        return
      } else if (code === 0x03 || code === 0x15) {
        s.lineBuf = '' // Ctrl-C / Ctrl-U: line cancelled
      } else if (code >= 0x20) {
        s.lineBuf += ch
      }
    }
  }
  function setHeuristic(s, cmd) {
    const label = cmd.replace(/\s+/g, ' ').trim().slice(0, 48)
    s.heurTitle = cachedBranch ? `${label} · ${cachedBranch}` : label
    applyTitle(s)
    refreshBranch() // keep the branch cache warm for the next command
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
    if (layout !== 'tabs') return fitAll()
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
    // Clear any stale OSC title (programs may leave one set on exit); the resolver
    // then falls back to the last heuristic label or the base name.
    clearTimeout(s.titleTimer)
    s.oscTitle = null
    applyTitle(s)
  })

  window.addEventListener('resize', fitAll)

  // Album-flow cycling: ⌥←/→ (Alt+Arrow) steps the centre through the terminals.
  // Alt keeps it clear of anything the focused shell would read from the arrows.
  window.addEventListener('keydown', (e) => {
    if (layout !== 'flow' || !e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      stepFlow(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      stepFlow(-1)
    }
  })

  // Apply a light/dark theme to all existing terminals and future ones.
  function setTheme(name) {
    themeName = TERM_THEMES[name] ? name : 'light'
    for (const s of sessions.values()) s.term.options.theme = TERM_THEMES[themeName]
  }

  // cd fresh shells into a newly-opened folder (skip terminals already in use,
  // e.g. running an agent — we don't want to type `cd` into them).
  function cdInto(path) {
    if (!path) return
    const quoted = "'" + String(path).replace(/'/g, "'\\''") + "'"
    for (const s of sessions.values()) {
      if (s.status === 'running' && !s.used) {
        api.term.input(s.id, ` cd ${quoted} && clear\r`)
      }
    }
  }

  return { create, fitActive, fitAll, setLayout, setTheme, cdInto }
}
