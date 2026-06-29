import '@xterm/xterm/css/xterm.css'
import './terminals.css'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { icon } from './icons.js'
import { coachOnce } from './toast.js'
import { matchesAwaitPrompt } from './pulse-detect.js'
import { RESTING_GRID, STATIC_GRID, MIN_WORKING_GRID, createThinker } from './braille-thinker.js' // working-figure engine
import { makeFigure, paint } from './dot-figure.js' // SVG dot-matrix renderer for the figure
import { colorsFor } from './term-palettes.js'

// The one-time beginner coach mark that explains Pulse the first time a tab starts
// working. Fired from every path that starts an agent (launcher reuse, '+' preset,
// or a user-driven shell going active) — coachOnce makes it once-ever regardless.
const PULSE_COACH =
  'That pulsing tab is Pulse — it means the agent is working. It calms to a steady colour when the agent is done or waiting on you.'

const api = window.api

// xterm color themes, switched together with the app light/dark theme.
const TERM_THEMES = {
  light: { background: '#ffffff', foreground: '#383838', cursor: '#383838', selectionBackground: '#cfe3ff' },
  dark: { background: '#181818', foreground: '#cccccc', cursor: '#cccccc', selectionBackground: '#264f78' }
}

// Per-terminal identity colours come from the active palette (see term-palettes.js
// and the appearance.headerTheme setting). Each new terminal gets the next hue,
// shown on its tab and pane header so you can track which pane is which at a glance
// — vital once you have a wall of them. The palette has a light and a dark variant,
// so the hues re-tune when the app theme toggles (see setTheme/recolorAll).

// Tabbed + grid terminal multiplexer. Each session is an independent PTY shell;
// run a CLI coding agent in each and watch them all at once in grid view.
export function createTerminals({ getRoot, onFleet, onAwait, onAwaitClear }) {
  const tabBar = document.getElementById('term-tabs')
  const panesEl = document.getElementById('term-panes')
  const controls = document.querySelector('#terminal-region .panel-controls')

  const sessions = new Map() // id -> session

  // Live terminal preferences (from the Settings window). create() reads these for
  // every new pane; applySettings() updates them and pushes the change to existing
  // panes. Defaults match the historical hardcoded values. `scrollback` here is the
  // PRIMARY-pane budget; preview/hidden panes are tiered below it (see scrollbackFor).
  const termSettings = {
    fontSize: 12.5,
    fontFamily: 'Menlo, Monaco, "SF Mono", "Courier New", monospace',
    cursorBlink: true,
    scrollback: 10000,
    confirmClose: true, // show the close-confirmation dialog (terminal.confirmClose)
    // Master-stack / master-deck: how many secondary terminals fit in the rail before
    // it scrolls. Tiles are sized to track/visible so they never shrink below a readable
    // floor — past this count the rail scrolls instead (appearance.railVisibleTiles).
    railVisibleTiles: 6
  }
  let activeId = null
  let counter = 0
  // Initial layout for a brand-new workspace follows the user's saved default
  // (appearance.defaultLayout, cached to localStorage by main.js so the first paint
  // has it with no flash). A restored workspace overrides this via setLayout() with
  // its own last-used layout, so per-workspace memory still wins.
  const DEFAULT_LAYOUT_KEY = 'concourse-default-layout'
  const VALID_LAYOUTS = ['tabs', 'grid', 'stack', 'deck', 'flow']
  const savedDefaultLayout = localStorage.getItem(DEFAULT_LAYOUT_KEY)
  let layout = VALID_LAYOUTS.includes(savedDefaultLayout) ? savedDefaultLayout : 'tabs'
  let flowIndex = 0 // which session sits in the centre in 'flow' (album) layout
  let themeName = 'light'
  // Active identity-colour palette (appearance.headerTheme). `activeColors` is the
  // 8-hue array for the CURRENT palette + app theme; it's recomputed (and existing
  // panes recoloured) whenever either changes — see setHeaderTheme / setTheme.
  let headerPalette = 'default'
  let headerCustom = '' // raw user input for the 'custom' palette
  let activeColors = colorsFor(headerPalette, themeName, headerCustom)
  panesEl.classList.add(layout)
  // The rail: a dedicated scroll container that holds the secondary terminal tiles in
  // the master-stack (vertical, right) and master-deck (horizontal, bottom) layouts.
  // It lives as a child of panesEl but stays display:none (CSS) until one of those
  // layouts moves tiles into it — so the primary pane can stay put while the rail
  // scrolls independently. Created once; resetCellStyles re-empties it on every switch.
  const railEl = document.createElement('div')
  railEl.className = 'term-rail'
  panesEl.appendChild(railEl)

  // ---- pulse ----
  // Byte flow drives the base state: bytes ⇒ `working`; IDLE_AFTER_MS of silence after
  // the last byte ⇒ the pane has settled. IDLE_AFTER_MS is long enough to bridge the
  // sub-second gaps between an agent's tokens/tool calls (its animated TUI keeps
  // emitting frames) so it doesn't flicker mid-turn, short enough that a finished
  // command settles promptly. See the PTY onData handler. Tune if it feels twitchy.
  const IDLE_AFTER_MS = 800
  // On settle we classify (Layer 1 — deterministic, free, offline). If the visible tail
  // shows an explicit input prompt, the pane is `awaiting` YOU: the agent's resting
  // state — a y/N, a password, a permission, or just parked at its input box. This is
  // the high-value signal — ~90% of fleet-driving is waiting to catch an agent back at
  // rest, so the working→awaiting EDGE is the moment worth a notification (see setState).
  // Otherwise the pane is calm `idle`, and Layer B (and the slow alt-screen tell below)
  // may still refine it. False positives are the cardinal sin: every pattern is anchored
  // to the END of the tail (where a parked cursor sits), so mid-output mentions of "y/n"
  // or "password" in flowing text don't trip it.
  const QUIET_MS = 8000 // conservative window for the implicit (alt-screen) awaiting tell
  // Local prompt echo of a keystroke lands within a few ms of the key. Output arriving
  // within this window of the user's last keystroke is treated as that echo — typing your
  // own command line isn't the agent "thinking", so it must not start the spinner. Measured
  // from EACH keystroke (which resets it), so continuous typing never trips working, however
  // slow; a real command/agent keeps emitting past the window and pulses normally. Only gates
  // the idle→working ENTRY — once working, keystrokes don't disturb the settle timers.
  const ECHO_GRACE_MS = 250
  // Does the settled pane show an explicit input affordance in its visible tail? Reads
  // the last few rendered rows (the cursor parks at the prompt) and runs the anchored
  // patterns in pulse-detect.js. Pure/synchronous — the deterministic floor, no model.
  function looksAwaitingPrompt(s) {
    return matchesAwaitPrompt(tailOf(s, 6))
  }
  // Layer B only runs when a provider is configured in main AND reachable (an
  // Anthropic key, or a live local OpenAI-compatible endpoint); without it the
  // deterministic Layer A still works. Re-polled on an interval so a local model
  // server that Concourse auto-starts (or that you bring up later) turns Layer B on
  // without a restart — the probe is a single cheap localhost request.
  let pulseEnabled = false
  const refreshPulseStatus = () =>
    api.pulse
      ?.status?.()
      .then((st) => {
        pulseEnabled = !!(st && st.enabled && st.reachable)
      })
      .catch(() => {})
  refreshPulseStatus()
  const pulseStatusTimer = setInterval(refreshPulseStatus, 15000)

  // ---- inject extra panel controls: one button per layout, always visible ----
  // The button for the current layout is highlighted (.active).
  const LAYOUTS = [
    { mode: 'tabs', icon: 'square', tip: 'Tabs layout (one terminal)' },
    { mode: 'grid', icon: 'grid', tip: 'Grid layout (all terminals)' },
    { mode: 'stack', icon: 'stack', tip: 'Master-stack layout (primary + side rail)' },
    { mode: 'deck', icon: 'deck', tip: 'Master-deck layout (primary + bottom rail · ⌘J)' },
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
  newTabBtn.title = 'New terminal (⌘T)'
  newTabBtn.dataset.tip = 'New terminal (⌘T)'
  newTabBtn.addEventListener('click', () => newTab())
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
    // Accept the drop. The DOM is already reordered by dragover; without a drop
    // handler that preventDefaults, the browser thinks the drop was rejected and
    // animates the drag image back to its origin — the "ghost tab" that snaps
    // back even though the tabs are already in their new spots.
    tabEl.addEventListener('drop', (e) => {
      if (dragId == null) return
      e.preventDefault()
    })
  }
  // Rebuild the sessions Map in the current tab DOM order. Each tab carries its
  // session id in dataset.id, so we look the session up by id rather than by a
  // best-effort element match. Before mutating the Map we assert the reordered
  // list is a faithful permutation of the existing sessions — same count, and
  // every live session id accounted for. If anything is off (a tab is missing
  // its dataset.id, or a session vanished from the DOM), clearing + rebuilding
  // would DROP that session and orphan its live PTY, so we BAIL with a warning
  // and re-apply from the untouched Map instead.
  function reorderFromDom() {
    const ordered = []
    for (const el of tabBar.querySelectorAll('.term-tab')) {
      const s = sessions.get(el.dataset.id)
      if (s) ordered.push(s)
    }
    const intact =
      ordered.length === sessions.size &&
      [...sessions.values()].every((s) => ordered.includes(s))
    if (!intact) {
      console.warn('reorderFromDom: tab/session mismatch — leaving sessions Map intact')
      applyLayout()
      fitAll()
      return
    }
    sessions.clear()
    for (const s of ordered) sessions.set(s.id, s)
    // flowIndex is positional (an index into the rebuilt Map), so after a reorder the
    // flow centre must be re-derived from activeId — otherwise the centred, interactive,
    // PTY-driving pane silently swaps to a different agent. Same recompute setLayout('flow')
    // does on entry, keeping the centred pane and activeId in agreement across reorders.
    const ai = [...sessions.values()].findIndex((s) => s.id === activeId)
    if (ai >= 0) flowIndex = ai
    applyLayout()
    fitAll()
  }

  // ---- drag files in: drop a file/folder onto a pane to type its path ----
  // Works in every layout (each pane wires its own listeners), and on every pane —
  // not just the active one — so you can drop straight onto whichever terminal in
  // the grid/flow you mean. The path is inserted as text only (no Enter); the user
  // decides what to do with it (e.g. an agent reads the image at that path).
  // Files from Finder resolve to their real path; an image dragged from a web page
  // has no on-disk path, so the drop handler first writes its bytes to a temp file
  // and inserts that path instead. Internal tab-reorder drags carry no files, so
  // the `dragHasFiles` guard keeps them from triggering any of this.
  function dragHasFiles(e) {
    const t = e.dataTransfer && e.dataTransfer.types
    return !!t && (t.includes ? t.includes('Files') : [...t].includes('Files'))
  }
  // Bare path when it only uses shell-safe characters; otherwise single-quote it
  // (escaping embedded quotes) so spaces and metacharacters survive — same scheme
  // as cdInto().
  function shellEscapePath(p) {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p)) return p
    return "'" + p.replace(/'/g, "'\\''") + "'"
  }
  function wireCellDrop(cell, s) {
    cell.addEventListener('dragover', (e) => {
      if (!dragHasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      cell.classList.add('drop-target')
    })
    cell.addEventListener('dragleave', (e) => {
      // Ignore the dragleave that fires when crossing between child elements.
      if (e.relatedTarget && cell.contains(e.relatedTarget)) return
      cell.classList.remove('drop-target')
    })
    cell.addEventListener('drop', async (e) => {
      // Capture the File handles synchronously — the DataTransfer is only live
      // during synchronous event handling, so we must read it (and preventDefault)
      // before any await below.
      const files = e.dataTransfer ? [...e.dataTransfer.files] : []
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation()
      cell.classList.remove('drop-target')
      const paths = []
      for (const f of files) {
        // A real file from Finder/desktop (screenshot thumbnail, Preview, Photos)
        // resolves to its absolute path directly.
        const p = api.pathForFile?.(f)
        if (p) { paths.push(p); continue }
        // No path means an in-memory image dragged from a web page/app. Persist
        // its bytes to a temp file so the agent has a real file to read, then use
        // that path. (Non-image pathless drags are skipped — nothing to point at.)
        if (f.type.startsWith('image/')) {
          try {
            const bytes = new Uint8Array(await f.arrayBuffer())
            const saved = await api.fs.saveDrop?.(f.name, f.type, bytes)
            if (saved) paths.push(saved)
          } catch { /* unreadable drop — skip this file */ }
        }
      }
      if (!paths.length) return
      // Trailing space so the next dropped/typed token doesn't run into this one.
      const text = paths.map(shellEscapePath).join(' ') + ' '
      activate(s.id)
      s.used = true // hands-on now — don't auto-cd this pane later
      api.term.input(s.id, text)
      s.term.focus()
    })
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

  // The new-tab affordance ('+' button and Cmd+T): just open a new tab — no menu.
  // The very first pane still greets beginners with the empty-pane agent launcher
  // (gated on sessions.size === 0 in create()); a plain new pane is all the '+' owes.
  function newTab() {
    return create({})
  }

  // ---- empty-pane agent launcher (beginner mode) ----
  // A fresh, unused shell in beginner mode is a dead end for a newcomer: a mute
  // prompt with no hint that the whole point is to run an agent here. This overlay
  // turns that first pane into the moment they learn the core move — by doing it.
  // Shown only on the FIRST pane (sessions.size 0 → 1), never on restored panes,
  // never in expert. Dismissed the instant the user acts (a button, or typing into
  // the pane); crucially NOT on PTY output, so the cd-into-folder chrome can't make
  // it vanish before the user has chosen.
  function mountPaneLauncher(s) {
    const el = document.createElement('div')
    el.className = 'pane-launcher'
    const agentBtn = (glyph, label, command, primary) =>
      `<button class="pl-btn${primary ? ' primary' : ''}" data-command="${command}">` +
      `<span class="pl-btn-icon">${icon(glyph, 15)}</span>${label}</button>`
    el.innerHTML =
      `<div class="pane-launcher-card">` +
      `<div class="pl-title">Launch an agent here</div>` +
      `<div class="pl-sub">Concourse runs your CLI coding agents side by side. Start one in this pane:</div>` +
      `<div class="pl-actions">` +
      agentBtn('wand', 'Run Claude Code', 'claude', true) +
      agentBtn('code', 'Run Codex', 'codex', false) +
      `</div>` +
      `<button class="pl-link" data-shell="1">Just open a shell</button>` +
      `</div>`
    el.querySelectorAll('.pl-btn').forEach((btn) => {
      btn.addEventListener('click', () => launchAgentInPane(s, btn.dataset.command))
    })
    el.querySelector('.pl-link').addEventListener('click', () => {
      dismissPaneLauncher(s)
      s.term.focus()
    })
    s.body.appendChild(el)
    s.launcher = el
  }
  function dismissPaneLauncher(s) {
    if (!s.launcher) return
    s.launcher.remove()
    s.launcher = null
  }
  // Run an agent in an existing (empty) pane — the launcher's reuse path. Mirrors the
  // create({command}) preset seam: mark used, start the pulse immediately for instant
  // feedback, then send the command. A missing binary just prints "command not
  // found" harmlessly, which is why the copy never promises success.
  function launchAgentInPane(s, command) {
    dismissPaneLauncher(s)
    s.used = true
    setState(s, 'working') // pulse the tab the instant they click — immediate feedback
    if (document.documentElement.dataset.mode !== 'expert') coachOnce('pulse', PULSE_COACH)
    api.term.input(s.id, command + '\r')
    s.term.focus()
  }

  // ---- confirmation before terminating a shell (no window.confirm) ----
  // Only one dialog at a time. A second confirmClose() while one is open would
  // stack a second overlay AND install a second global keydown listener (the
  // first one would leak — finish() only removes its own), and a stray Enter
  // could route through both and double-enter destroy(). The closure-level guard
  // re-focuses the open dialog and returns instead.
  let confirmOverlay = null
  function confirmClose(s) {
    // Preference off (user ticked "Don't ask me again", or toggled it in Settings) →
    // skip the dialog and close immediately.
    if (!termSettings.confirmClose) {
      destroy(s.id)
      return
    }
    if (confirmOverlay) {
      confirmOverlay.querySelector('.tc-danger')?.focus()
      return
    }
    const overlay = document.createElement('div')
    overlay.className = 'term-confirm-overlay'
    const box = document.createElement('div')
    box.className = 'term-confirm'
    const name = s.tabLabel.textContent
    // The tab label is agent-influenced (an OSC title / heuristic), so it must never be
    // interpolated into innerHTML — a label like `<img onerror=...>` would execute. Build
    // the title with textContent so the name renders as literal text.
    const title = document.createElement('div')
    title.className = 'tc-title'
    title.textContent = `Close “${name}”?`
    const msg = document.createElement('div')
    msg.className = 'tc-msg'
    msg.textContent = 'The shell and any running agent will be terminated.'
    box.append(title, msg)
    // "Don't ask me again" — when ticked AND the user proceeds, persist
    // terminal.confirmClose = false so future closes skip this dialog (and the
    // Settings panel reflects it via the broadcast). Ticking it has no effect if the
    // user cancels — the choice only commits alongside the close it's attached to.
    const dontAsk = document.createElement('label')
    dontAsk.className = 'tc-dontask'
    const dontAskBox = document.createElement('input')
    dontAskBox.type = 'checkbox'
    dontAskBox.className = 'tc-dontask-box'
    const dontAskText = document.createElement('span')
    dontAskText.textContent = 'Don’t ask me again'
    dontAsk.append(dontAskBox, dontAskText)
    box.appendChild(dontAsk)
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
    confirmOverlay = overlay
    // Focus the destructive action so Return confirms the closure immediately —
    // Escape (or clicking away / Cancel) backs out.
    ok.focus()

    // Idempotent: overlay-click, Cancel, Escape and Enter all route here, but only
    // the first call tears down (removes the overlay + the one global listener and
    // clears the guard); later calls are no-ops so the listener can't leak.
    const finish = () => {
      if (confirmOverlay !== overlay) return
      confirmOverlay = null
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const confirm = () => {
      if (dontAskBox.checked) {
        termSettings.confirmClose = false
        Promise.resolve(api.settings?.set?.('terminal.confirmClose', false)).catch(() => {})
      }
      finish()
      destroy(s.id)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        confirm()
      }
    }
    document.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', finish)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish()
    })
    ok.addEventListener('click', confirm)
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
    panesEl.classList.toggle('deck', mode === 'deck')
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
  // Cycle through the layouts in their on-screen button order. Used by the
  // single-key layout cycler hotkey.
  const LAYOUT_ORDER = ['tabs', 'grid', 'stack', 'deck', 'flow']
  function cycleLayout(dir = 1) {
    const i = LAYOUT_ORDER.indexOf(layout)
    const next = LAYOUT_ORDER[((i + dir) % LAYOUT_ORDER.length + LAYOUT_ORDER.length) % LAYOUT_ORDER.length]
    setLayout(next)
  }
  // Close the active terminal through the same confirm dialog as the X button.
  function closeActive() {
    const s = sessions.get(activeId)
    if (s) confirmClose(s)
  }
  function applyLayout() {
    if (layout === 'grid') applyGrid()
    else if (layout === 'stack') applyStack()
    else if (layout === 'deck') applyDeck()
    else if (layout === 'flow') applyFlow()
    else resetCellStyles()
  }
  // Clear any inline placement / layout classes so the next layout starts clean. Also
  // flattens every cell + stub back to being a direct child of panesEl in session order
  // (the master-stack/deck rail reparents some of them into railEl) and re-empties the
  // rail. Re-appending in Map order preserves the DOM-order == tab-order invariant that
  // grid/flow rely on; railEl is parked last so it never lands between cells.
  function resetCellStyles() {
    for (const s of sessions.values()) {
      s.cell.style.gridColumn = ''
      s.cell.style.gridRow = ''
      s.cell.style.order = ''
      s.cell.style.flex = ''
      s.cell.classList.remove('flow-center', 'flow-prev', 'flow-next')
      s.stub.style.gridColumn = ''
      s.stub.style.gridRow = ''
      s.stub.classList.remove('on')
      panesEl.appendChild(s.cell)
      panesEl.appendChild(s.stub)
    }
    panesEl.appendChild(railEl) // empty now → CSS :empty hides it outside stack/deck
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
  // Master-stack (vertical rail, right) and master-deck (horizontal rail, bottom) are
  // the same layout on different axes: the active session maximizes into the primary
  // area (flex:1) and every other session is a small live tile in a scrollable rail.
  // The active session keeps its slot in the rail too — a compact stub holds it so the
  // order never reshuffles when you promote a tile (activate() re-runs this). The rail
  // is its own scroll container (railEl), so the primary stays put while it scrolls;
  // sizeRail() fixes each tile to track/visible px so tiles never shrink below a floor.
  function applyStack() {
    applyRail()
  }
  function applyDeck() {
    applyRail()
  }
  function applyRail() {
    resetCellStyles()
    const order = [...sessions.values()]
    const n = order.length
    if (!n) return
    const active = sessions.get(activeId) || order[0]
    // Alone: the primary fills everything and the rail stays empty (CSS :empty hides it).
    if (n < 2) return
    // The active session's live cell becomes the primary (a direct child of panesEl,
    // sitting before the rail). Every session — including the active one, via its stub
    // — gets a tile in the rail, in stable session order, so selecting never reshuffles.
    panesEl.insertBefore(active.cell, railEl)
    for (const s of order) {
      if (s === active) {
        s.stub.classList.add('on')
        railEl.appendChild(s.stub)
      } else {
        railEl.appendChild(s.cell)
      }
    }
    sizeRail()
  }
  // Fix each rail tile to track/visible px along the scroll axis so exactly
  // railVisibleTiles fit before the rail scrolls — past that, tiles keep their size and
  // the rail overflows instead of shrinking everything. Re-run on layout change, pane
  // add/remove, settings change, and container resize (panesResizeObserver below).
  const RAIL_TILE_MIN = { stack: 70, deck: 150 } // px floor per axis (vertical/horizontal)
  function sizeRail() {
    if (layout !== 'stack' && layout !== 'deck') return
    const n = sessions.size
    if (n < 2) return
    const horizontal = layout === 'deck'
    const track = horizontal ? panesEl.clientWidth : panesEl.clientHeight
    if (!track) return // panel collapsed / not yet measurable — RO re-runs us later
    const visible = Math.max(1, Math.round(termSettings.railVisibleTiles) || 1)
    const slots = Math.min(visible, n)
    const gap = 1 // matches the rail's CSS gap
    const tile = Math.max(RAIL_TILE_MIN[layout], Math.floor((track - (slots - 1) * gap) / slots))
    panesEl.style.setProperty('--rail-tile', tile + 'px')
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
    if (s) setTimeout(() => {
      // It may have been closed within this tick (a fast Cmd+W / agent exit racing the
      // reflow); focus() on a disposed xterm throws — re-check it's still live.
      const live = sessions.get(id)
      if (live) live.term.focus()
    }, 0)
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

  // Move the active terminal selection by ±1 in tab order (wraps around). In the
  // album/flow layout this is the same as stepping the flow; in every other
  // layout it just activates the neighbouring tab.
  function stepActive(dir) {
    const order = [...sessions.values()]
    if (!order.length) return
    if (layout === 'flow') return stepFlow(dir)
    let idx = order.findIndex((s) => s.id === activeId)
    if (idx < 0) idx = 0
    const next = order[((idx + dir) % order.length + order.length) % order.length]
    if (next) selectCell(next.id)
  }

  // Move the ACTIVE tab itself by ±1 in tab order, reordering it among its
  // siblings — as opposed to stepActive, which moves the SELECTION. Clamps at the
  // ends (nudging past the first/last slot does nothing) rather than wrapping, so
  // it reads like dragging the tab. The active pane stays active and keeps driving
  // its PTY; grid/stack/flow follow the new order the same way a drag-reorder does.
  function moveActive(dir) {
    const order = [...sessions.values()]
    if (order.length < 2) return
    const idx = order.findIndex((s) => s.id === activeId)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= order.length) return
    const [moved] = order.splice(idx, 1)
    order.splice(target, 0, moved)
    // Rebuild the Map and DOM to match, mirroring reorderFromDom. Re-inserting each
    // tab before the trailing "+" button keeps that button last.
    sessions.clear()
    for (const s of order) {
      sessions.set(s.id, s)
      tabBar.insertBefore(s.tabEl, newTabBtn)
    }
    flowIndex = target
    applyLayout()
    fitAll()
  }

  // Jump straight to the Nth terminal (0-based) in tab order. Out-of-range
  // indices are ignored, so Cmd+9 with only three tabs does nothing.
  function activateIndex(i) {
    const order = [...sessions.values()]
    const s = order[i]
    if (s) selectCell(s.id)
  }

  // Every semantic state change goes through here so the working→awaiting EDGE — the
  // moment an agent comes to rest needing you — can't be missed. On that edge, if you
  // aren't already looking at the pane, flag it `unseen` (a come-look pulse on the
  // tab/dot) and fire onAwait so a surface OUTSIDE the pane (an OS notification) can pull
  // you back. Returning to `working` clears the come-look. This is the one seam the spec
  // (docs/pulse-engine.md) hangs the notify behaviour on — keep all transitions routed
  // through it.
  function setState(s, next) {
    const prev = s.state
    if (prev === next) return
    s.state = next
    if (next === 'awaiting' && prev !== 'awaiting') {
      // Only a "come-look" if you're not already on this pane in a focused window.
      const looking = document.hasFocus() && activeId === s.id
      if (!looking) {
        s.unseen = true
        onAwait?.({ id: s.id, name: visibleLabel(s) || s.baseName, summary: s.summaryText || '' })
      }
    } else if (next === 'working') {
      s.unseen = false
      // Fresh working phase → pick the ONE pattern this stint will show, and restart its clock.
      // (A pane created already-working uses the thinker's initial pick; this covers re-waking.)
      s.thinker.pick()
      s.workT = 0
      // Paint frame 0 NOW so the rest→work edge shows an actual working frame immediately,
      // not the stale full resting block until the ticker's next tick (up to FRAME_MS later) —
      // and so a pane that wakes while the window is hidden (ticker paused) is already correct
      // the instant the window returns. updateIndicators below skips the figure while working.
      paintWorking(s)
      // Always have a scheduled path back to rest. classifyOutput re-arms this on each visible
      // burst, but a preset/launcher pane (or any working entry that produces no further visible
      // change) would otherwise animate forever with no timer ever armed.
      armSettle(s)
    }
    // Leaving the awaiting state (resumed working, settled to idle) makes any awaiting
    // notification + title flag posted for this pane stale — tell the host to clear that
    // one pane's surface (it tracks them per-id, so other awaiting panes are untouched).
    if (prev === 'awaiting' && next !== 'awaiting') onAwaitClear?.(s.id)
    updateIndicators(s)
  }

  // ---- pulse indicator ----
  // Three states: `working` (output flowing), `awaiting` (at rest, your move) or `idle`
  // (gone quiet, nothing pending). Drives BOTH tab status styles at once (CSS shows
  // whichever the user picked, see appearance.tabStatus):
  //   • "pulse" (default) — the whole tab tints in its identity hue and slowly
  //     *breathes* while working; holds a steady tint when awaiting/idle.
  //   • "dots" — a compact dot in the tab spins while working, rests when quiet.
  // The grid / stack / flow pane headers always use the dot (no tab strip there). The same
  // value feeds both AND the fleet summary, so they always agree. (An `awaiting` pane that
  // came to rest while you were elsewhere still fires the OS notification via onAwait below;
  // it no longer paints any amber "come-look" cue on the tab — that was removed.)
  function updateIndicators(s) {
    s.tabEl.dataset.state = s.state // pulse style: breathing vs steady tab tint
    s.cell.dataset.state = s.state // grid/stack/flow: unfocused header breathes while working
    s.stub.dataset.state = s.state
    const cls = 'dot ' + s.state
    s.tabDot.className = cls // dots style: the in-tab status dot
    s.cellDot.className = cls
    s.stubDot.className = cls
    // Two states, that's it: working (the spinner loop animates the figure) or resting (the
    // static full figure, painted here on the edge). The spinner loop only repaints
    // `.dot.working` and early-returns when nothing is working, so the LAST pane to settle
    // would otherwise keep a stale animation frame — this is the one funnel every state change
    // routes through, so paint the resting figure here.
    if (s.state !== 'working') paintFigure(s, RESTING_GRID)
    // A just-in-time reminder of what the state means, surfaced on hover — beginner
    // only, so Expert stays a bare shell. The status-bar fleet count carries the full
    // Pulse legend; this is just the hover gloss.
    if (document.documentElement.dataset.mode !== 'expert') {
      const tip = s.state === 'working' ? 'Working' : s.state === 'awaiting' ? 'Awaiting you' : 'Idle'
      s.cellDot.dataset.tip = tip
      s.tabEl.dataset.tip = tip
    } else {
      delete s.cellDot.dataset.tip
      delete s.tabEl.dataset.tip
    }
    emitFleet()
  }

  // Aggregate every pane's state into working/idle counts for the status bar.
  // Coalesced through rAF so a burst of output (many updateIndicators calls)
  // produces at most one summary per frame.
  let fleetRaf = 0
  function emitFleet() {
    if (fleetRaf) return
    fleetRaf = requestAnimationFrame(() => {
      fleetRaf = 0
      const counts = {}
      for (const s of sessions.values()) {
        counts[s.state] = (counts[s.state] || 0) + 1
      }
      if (onFleet) onFleet({ total: sessions.size, counts })
    })
  }

  // ---- create / destroy ----
  function create({ name, command, label, bare, restored } = {}) {
    const id = 'term-' + ++counter
    // Is this the first pane in an otherwise-empty workbench? Gates the one-time
    // beginner launcher overlay so it only greets a genuinely fresh start, not every
    // '+'-spawned shell.
    const firstPane = sessions.size === 0
    // Beginner mode uses the plainest possible default ("Tab 1"); expert mode
    // keeps the conventional "shell N". A preset name (e.g. an agent) wins either way.
    // `label` is used verbatim (session restore) — it skips the counter suffix.
    const beginner = document.documentElement.dataset.mode !== 'expert'
    const defaultName = beginner ? `Tab ${counter}` : `shell ${counter}`
    const displayName = label || (name ? `${name} ${counter}` : defaultName)
    // Stable per-pane colour slot: store the raw ordinal so recolorAll() can re-pick
    // this pane's hue from any palette/theme (modulo its length) and keep it on its
    // OWN slot across palette swaps, light/dark toggles and drag-reorders.
    const colorIndex = counter - 1
    const color = activeColors[colorIndex % activeColors.length]

    // Tab
    const tabEl = document.createElement('button')
    tabEl.className = 'term-tab'
    tabEl.draggable = true
    tabEl.dataset.id = id // reorderFromDom() maps DOM order back to sessions by id
    tabEl.style.setProperty('--term-color', color)
    // Status dot for the "dots" Pulse style. CSS hides it in the default "pulse"
    // style (where the whole tab tints + breathes instead); it's always kept in the
    // DOM and updated so flipping the setting needs no re-render. See updateIndicators.
    const tabDot = document.createElement('span')
    tabDot.className = 'dot idle'
    tabDot.appendChild(makeFigure()) // SVG dot matrix; the animation ticker drives it while working
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
    cellDot.className = 'dot idle'
    cellDot.appendChild(makeFigure())
    const cellLabel = document.createElement('span')
    cellLabel.className = 'cell-label'
    cellLabel.textContent = displayName
    // Close button on the pane itself — the only X you can reach in grid/stack/flow,
    // where you're looking at the panes, not the tab bar. Still confirms before
    // terminating the shell, same as the tab close.
    const cellClose = document.createElement('span')
    cellClose.className = 'close'
    cellClose.innerHTML = icon('close', 12)
    cellClose.title = 'Close Terminal'
    cellHeader.append(cellDot, cellLabel, cellClose)
    const cellBody = document.createElement('div')
    cellBody.className = 'cell-body'
    cell.append(cellHeader, cellBody)
    panesEl.appendChild(cell)

    // Rail stub: a compact, non-live entry that holds this terminal's slot in the
    // master-stack rail while its live view is maximized in the primary column.
    // Keeps the rail order stable (no reshuffle on select) and means the active
    // terminal is still visible/clickable in the sidebar. Only shown in 'stack'
    // layout for the active session (CSS gates it); hidden everywhere else.
    const stub = document.createElement('div')
    stub.className = 'term-stub'
    stub.style.setProperty('--term-color', color)
    const stubDot = document.createElement('span')
    stubDot.className = 'dot idle'
    stubDot.appendChild(makeFigure())
    const stubLabel = document.createElement('span')
    stubLabel.className = 'stub-label'
    stubLabel.textContent = displayName
    const stubMax = document.createElement('span')
    stubMax.className = 'stub-max'
    stubMax.innerHTML = icon('square', 12)
    stubMax.title = 'Maximized'
    stub.append(stubDot, stubLabel, stubMax)
    panesEl.appendChild(stub)

    const term = new Terminal({
      fontFamily: termSettings.fontFamily,
      fontSize: termSettings.fontSize,
      theme: TERM_THEMES[themeName],
      cursorBlink: termSettings.cursorBlink,
      scrollback: termSettings.scrollback,
      // Default-true, but pinned explicitly because the onData handler now LEANS on
      // it: it re-pins to the bottom only on genuine user input (never on a running
      // program's query answers), which is how ESC-led keys re-engage sticky-bottom
      // without us mistaking the terminal's auto-answers for typing. See onData.
      scrollOnUserInput: true,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Make plain http(s):// URLs in output clickable. Gated on ⌘/Ctrl (like VS Code)
    // so an ordinary click still places the cursor / selects text without opening a
    // browser. window.open routes through the main process's setWindowOpenHandler,
    // which opens the URL externally and denies any in-app window.
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) window.open(uri)
    }))
    term.open(cellBody)
    fit.fit()

    const s = {
      id, term, fit, cell, body: cellBody, tabEl, tabDot, tabLabel, cellLabel, cellDot, color, colorIndex,
      stub, stubDot, stubLabel,
      status: 'running', custom: false,
      // Three states: `working` (output flowing — pulsing), `awaiting` (at rest, your
      // move) or `idle` (gone quiet, nothing pending). An agent preset (command)
      // auto-fires on open, so it starts working. A plain shell just sits at its prompt,
      // so it starts idle and won't pulse until the user drives it (see PTY onData).
      state: command ? 'working' : 'idle',
      thinker: createThinker(), // this pane's working animator — one pattern per working phase
      workT: 0, // frames since the current working phase began (drives thinker.draw); reset on pick
      unseen: false, // came to rest (awaiting) while you were looking elsewhere → come-look
      idleTimer: null, // debounce handle: classifies the pane on settle after IDLE_AFTER_MS
      quietTimer: null, // slower settle timer for the conservative alt-screen awaiting tell
      follow: true, // sticky-bottom intent: keep the newest line (prompt / agent input box)
      //              visible. True until the user scrolls up to read history (see onScroll),
      //              re-armed when they actually type/paste (see onData — NOT on the running
      //              program's query answers). Every write/fit re-asserts the bottom while it's
      //              set — fixing "the prompt sits below the fold until I hit Enter".
      pinning: false, // guard: true only while WE scroll programmatically, so the onScroll
      //               below never mistakes our own re-pin (or a reflow) for a user scroll-up.
      summaryText: null, // last Layer-B label (the model's one-line summary)
      lastScreenSig: null, // signature of the last VISIBLE screen — drives the settle debounce
      //                      so output that doesn't change what's on screen (a blinking cursor,
      //                      OSC-title pings, a no-op redraw) can't pin the pane in `working`
      lastSummaryHash: null, // hash of the last tail summarised at rest — skip no-op repeats
      lastLiveHash: null, // hash of the last tail the working heartbeat summarised — kept
      //                     separate from lastSummaryHash so a live re-label never suppresses
      //                     the at-rest verdict (and its awaiting-edge promotion) that follows
      summarizing: false, // a Layer-B request is in flight for this pane
      lastSummaryAt: 0, // timestamp of the last Layer-B call — drives the settle cooldown
      summaryDeferTimer: null, // coalesces a burst of settles into one trailing summary call
      used: false, // true once the user types or a command runs — then we won't auto-cd it
      lastInputAt: 0, // timestamp of the last genuine keystroke; PTY output arriving right
      //                 after it is the prompt ECHOING what you typed, not work (see onData)
      isShell: !command, // plain shell vs an agent preset — gates command capture
      lineBuf: '', // keystroke accumulator for the last-command heuristic
      baseName: displayName, // fallback label shown when nothing better is known
      oscTitle: null, // last OSC 0/2 title the program emitted (Layer 0) — always leads the label
      heurTitle: null, // last heuristic label (the typed command line; branch not shown)
      titleTimer: null // debounce handle for onTitleChange
    }
    sessions.set(id, s)
    // Watch this pane's body so it refits itself on any size change (see the
    // ResizeObserver above). Tag the element so the observer can find the session.
    cellBody.__session = s
    resizeObserver.observe(cellBody)
    labelResizeObserver.observe(tabLabel) // re-measure the hover-marquee on width changes
    labelResizeObserver.observe(cellLabel)
    updateIndicators(s) // paint the initial working/idle tab tint
    // A preset pane starts `working` by literal (not via setState), so give it what the
    // rest→work edge gives every other working pane: an actual first frame (else it shows the
    // full resting block until the ticker's first tick) and an armed settle (else a preset
    // whose screen never changes again — a hung or silent command — would animate forever with
    // no timer to ever bring it to rest). classifyOutput re-arms this on real output.
    if (command) {
      paintWorking(s)
      armSettle(s)
    }

    // Beginner-only empty-pane launcher: greet a brand-new user's first pane with
    // "Launch an agent here" instead of a mute prompt. Never on restored panes
    // (returning users), never on a preset (it's already running an agent), never
    // when the user explicitly asked for a plain shell, never in expert.
    if (
      firstPane &&
      !command &&
      !bare &&
      !restored &&
      document.documentElement.dataset.mode !== 'expert'
    ) {
      mountPaneLauncher(s)
    }

    // Beginner mode gets the calmer, friendlier shell prompt; expert mode is left bare.
    const friendlyPrompt = document.documentElement.dataset.mode !== 'expert'
    api.term.create(id, getRoot(), { friendlyPrompt })
    // Cmd+Backspace clears the whole input line — the macOS "delete to start of
    // line" gesture, mapped onto the shell's kill-line. We send Ctrl+E (jump to
    // end) then Ctrl+U (kill from cursor to start) so the line is wiped no matter
    // where the cursor sits. Returning false stops xterm sending a literal
    // backspace as well. Works in shells and readline-based agent TUIs alike.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Backspace') {
        s.used = true
        api.term.input(id, '\x05\x15')
        return false
      }
      return true
    })
    term.onData((data) => {
      // xterm's onData carries TWO different things on one channel: (1) genuine
      // user input — keys typed, text pasted (a bracketed paste arrives wrapped as
      // \x1b[200~…\x1b[201~); and (2) the terminal's own automatic ANSWERS to
      // queries the running program emits — cursor-position reports (\x1b[…R),
      // device attributes (\x1b[?…c), OSC colour answers, mode reports, etc. Both
      // must reach the PTY, but only (1) is the user driving the pane.
      //
      // Conflating them was the "can't scroll up while an agent streams" bug:
      // agents probe the terminal continuously as they output, and every probe
      // ANSWER was being treated as "the user typed" — re-arming sticky-bottom
      // (s.follow) so the very next write snapped the viewport back to the bottom,
      // making it impossible to hold a scrolled-up position to read history. (It
      // also marked never-touched shells "used" — so a shell whose prompt probes
      // the terminal at startup would pulse unbidden — and wiped the command-title
      // buffer mid-line.)
      //
      // Program answers are always ESC-introduced control strings; real typed text
      // never is. A bracketed paste is ESC-led but IS user input, so admit the
      // \x1b[200~ paste marker. ESC-led special keys (arrows, Esc, F-keys) fall
      // through as "not input" here, but xterm's native scrollOnUserInput (set in
      // the Terminal options) still re-pins them — it fires only for genuine input,
      // never for these answers, and routes through onScroll below to set s.follow.
      const userInput = data.charCodeAt(0) !== 0x1b || data.startsWith('\x1b[200~')
      api.term.input(id, data) // forward EVERYTHING to the PTY — answers included
      if (!userInput) return
      s.used = true
      s.lastInputAt = Date.now() // mark "just typed" so the echo of these keys doesn't pulse
      s.follow = true // typing/paste means "show me what I'm doing" — re-engage sticky-bottom
      if (s.launcher) dismissPaneLauncher(s) // typing into the pane = "I'll drive it myself"
      if (s.isShell) captureCommand(s, data)
    })
    term.onResize(({ cols, rows }) => api.term.resize(id, cols, rows))
    // Track the user's scroll intent so sticky-bottom never fights them. Every scroll —
    // wheel, scrollbar drag, Shift+PageUp — fires onScroll; if they've parked the view
    // above the buffer bottom they're reading history, so stop following. Back at the
    // bottom re-engages it. Our own re-pins set s.pinning first, so a programmatic scroll
    // (or the transient one a reflow emits) is ignored here and can't flip the intent.
    term.onScroll(() => {
      if (s.pinning) return
      const buf = s.term.buffer.active
      s.follow = buf.viewportY >= buf.baseY
    })
    // Wheel-scroll the scrollback even while an agent grabs the mouse. Interactive
    // programs (an agent's thinking UI, vim, etc.) enable mouse tracking, which tells
    // xterm to forward the wheel to the program AS mouse events — so the wheel stops
    // scrolling our history. That's correct in a full-screen (alternate-buffer) TUI,
    // but in the NORMAL buffer it's the "can't scroll up while the agent is thinking"
    // bug: the conversation is sitting right there in the scrollback, unreachable.
    // Match iTerm/Terminal.app — in the normal buffer the wheel ALWAYS scrolls OUR
    // scrollback; only the alternate buffer hands it to the program. When nothing is
    // tracking the mouse we fall through to xterm's own native wheel handling.
    cellBody.addEventListener('wheel', (e) => {
      if (term.buffer.active.type === 'alternate') return
      const tracking = term.modes && term.modes.mouseTrackingMode
      if (!tracking || tracking === 'none') return
      e.preventDefault()
      e.stopPropagation()
      const perRow = (term.element && term.rows) ? term.element.clientHeight / term.rows : 16
      let lines
      if (e.deltaMode === 1) lines = e.deltaY // already in lines
      else if (e.deltaMode === 2) lines = e.deltaY * term.rows // pages
      else lines = e.deltaY / (perRow || 16) // pixels → rows
      term.scrollLines(Math.round(lines) || (e.deltaY > 0 ? 1 : -1))
    }, { capture: true })
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

    // Drop files from Finder onto this pane to insert their paths as text.
    wireCellDrop(cell, s)
    // Click selects. In flow mode, clicking a side preview brings it to centre;
    // clicking the centre (or any other layout) just focuses it.
    cell.addEventListener('mousedown', () => selectCell(id))
    // The pane's own X. Swallow the mousedown so the cell doesn't select/centre
    // the pane out from under the confirm dialog, then confirm on click.
    cellClose.addEventListener('mousedown', (e) => e.stopPropagation())
    cellClose.addEventListener('click', (e) => {
      e.stopPropagation()
      confirmClose(s)
    })
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

    // Just-in-time layout teaching: the moment a beginner has TWO agents and is still
    // in the single-pane tabs view, point them at Grid so they can watch both at once.
    // Fires once ever (coachOnce persists across launches) — never nags, never expert,
    // and never during a session restore (which recreates panes with restored:true).
    if (
      !restored &&
      document.documentElement.dataset.mode !== 'expert' &&
      sessions.size === 2 &&
      layout === 'tabs'
    ) {
      coachOnce('grid', 'You have two agents now — press ⌘I to watch them side by side (Grid).')
    }

    // Fire the preset command once the shell has settled (this counts as "used").
    if (command) {
      s.used = true
      // A preset pane starts in the 'working' state, so it never crosses the
      // idle→working edge that fires the Pulse coach in onData — explain it here too.
      if (document.documentElement.dataset.mode !== 'expert') coachOnce('pulse', PULSE_COACH)
      setTimeout(() => api.term.input(id, command + '\r'), 500)
    }
    return id
  }

  // ---- session restore (Tier A: fresh shells, same layout) ----
  // Snapshot the terminal set for persistence: tab labels, layout, active index.
  // Live process state and scrollback are intentionally not captured.
  function getState() {
    const list = [...sessions.values()]
    const tabs = list.map((s) => ({ label: s.tabLabel.textContent || s.baseName }))
    const active = Math.max(0, list.findIndex((s) => s.id === activeId))
    return { layout, active, tabs }
  }

  // Recreate terminals from a snapshot. Returns true if anything was restored.
  function restore(state) {
    if (!state || !Array.isArray(state.tabs) || state.tabs.length === 0) return false
    for (const t of state.tabs) create({ label: t && t.label, restored: true })
    if (state.layout) setLayout(state.layout)
    if (Number.isInteger(state.active)) activateIndex(state.active)
    return true
  }

  function destroy(id) {
    const s = sessions.get(id)
    if (!s) return
    // The right-click tab menu closed over this session would act on a dead pane
    // after it's gone — dismiss it now.
    document.getElementById('term-tab-menu')?.remove()
    // The pane is going away; clear any awaiting notification/title flag it posted.
    onAwaitClear?.(id)
    clearTimeout(s.titleTimer)
    clearTimeout(s.idleTimer)
    clearTimeout(s.quietTimer)
    resizeObserver.unobserve(s.body)
    dirty.delete(s)
    api.term.kill(id)
    s.term.dispose()
    labelResizeObserver.unobserve(s.tabLabel)
    labelResizeObserver.unobserve(s.cellLabel)
    s.cell.remove()
    s.stub.remove()
    s.tabEl.remove()
    sessions.delete(id)
    emitFleet() // the fleet shrank — refresh the status-bar summary
    // When the last pane closes, reset the counter so numbering starts at 1
    // again rather than climbing forever (Tab 31, 32, …).
    if (sessions.size === 0) counter = 0
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
    // A genuine switch (different pane becoming active) vs. a re-click on the pane
    // you're already in. The two need opposite scroll behaviour — see the s.follow
    // note below — so capture the distinction before we overwrite activeId.
    const switching = activeId !== id
    activeId = id
    // Looking at this pane clears the awaiting come-look (set on the working→awaiting
    // edge while you were elsewhere). Repaint so the pulse stops immediately.
    if (s.unseen) {
      s.unseen = false
      updateIndicators(s)
    }
    // Re-clicking the pane you're already in (e.g. mousedown to start a text selection up
    // in the scrollback) changed nothing about which pane is active — it's already primary,
    // already fitted, already followed-or-not per your own scrolling. Don't re-flow or
    // re-fit: a fit can round-trip a resize/SIGWINCH to the program, whose repaint can yank
    // a scrolled-up viewport back to the bottom. Just (re)focus so typing lands, and leave
    // the scroll position exactly where the click found it.
    if (!switching) {
      s.term.focus()
      return
    }
    for (const [sid, sess] of sessions) {
      const on = sid === id
      sess.cell.classList.toggle('active', on)
      sess.cell.classList.toggle('focused', on)
      sess.tabEl.classList.toggle('active', on)
    }
    // In master-stack/deck the active session IS the primary pane, so re-flow first so
    // paneRole sees it as primary when the fit below runs.
    if (layout === 'stack' || layout === 'deck') {
      applyLayout()
      // The clicked tile just became the primary pane; focus on the next tick once the
      // reflow has settled so a single click lands the cursor (same as album flow's
      // centerOn). Re-check the pane is still live — it may be closed within this tick.
      setTimeout(() => {
        const live = sessions.get(id)
        if (live) live.term.focus()
      }, 0)
    }
    // Switching TO a pane means "show me what's happening here" — and agents stream
    // output into background panes constantly. Re-engage sticky-bottom so the fit
    // below (and every subsequent write) snaps to the live line. Without this, a pane
    // whose follow was dropped while it sat as a hidden/preview tile — its off-screen
    // reflow or an alt-screen transition parks the viewport above baseY, and onScroll
    // reads that as a user scroll-up — would open stranded above the fold, invisible
    // until you typed a key. fitPane/pinBottom both gate their scrollToBottom on
    // s.follow, so resetting it here is what makes the switch land at the bottom.
    //
    // (Same-pane re-clicks returned early above, so this only runs on a real switch — a
    // re-click must leave a scrolled-up viewport alone rather than be yanked to the bottom.)
    s.follow = true
    // Activation changed which pane is primary (and may have flipped one from
    // hidden→visible). Re-fit whatever is primary once the layout settles; fitPane
    // leaves previews/hidden panes untouched so their agents keep their width. Focus
    // stays synchronous so typing lands immediately.
    fitSoon()
    s.term.focus()
  }

  // ---- rename ----
  function renameStart(s, labelEl) {
    const input = document.createElement('input')
    input.className = 'rename-input'
    // Prefill with the lead label only (.lbl-main), not the dim "— summary" tail.
    input.value = labelEl.querySelector('.lbl-main')?.textContent ?? labelEl.textContent
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
      s.stubLabel.textContent = v
      // The label was detached (replaced by the input) during the edit and its content
      // just changed; re-measure so a stale hover-marquee shift from before the rename
      // doesn't persist on the restored label.
      requestAnimationFrame(() => {
        measureMarquee(s.tabLabel)
        measureMarquee(s.cellLabel)
      })
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
  // The REAL, width-aware truncation is CSS's job: every label (.cell-label, .term-tab-label,
  // .stub-label) is `overflow:hidden; text-overflow:ellipsis`, each bounded to its own width —
  // so a full-width cell header shows far more than a 180px tab, and each ellipsises exactly at
  // its own pixel edge. MAX_TITLE is only a sanity bound so a pathologically long typed line
  // never becomes a giant DOM text node / tooltip; it should stay well above any width we render.
  const MAX_TITLE = 200
  // The auto label carries TWO writers on ONE line, deliberately split into two spans so
  // they never fight over a single text node (the old single-string race flickered between
  // a program's live title and our model summary):
  //   • primary (.lbl-main) — a program's OWN title ALWAYS leads and is shown verbatim:
  //     Claude Code's (or any agent's) live OSC header, vim, ssh, a shell's titled prompt.
  //     We never replace it. Only a pane that sets NO title at all leads with our summary.
  //   • secondary (.lbl-sub) — our Pulse summary APPENDED as a dim "— summary" tail on the
  //     SAME line, so we ADD context to the program's title instead of overriding it. It
  //     just clips at rest; hover marquees it (below).
  // Shown identically in every view — tabs, stack (MS), flow (AF) — the roomier views just
  // reveal more before the clip. A manual rename (s.custom) still trumps both.
  const clamp = (v) => (v && v.length > MAX_TITLE ? v.slice(0, MAX_TITLE - 1) + '…' : v || '')
  function visibleLabel(s) {
    return s.oscTitle || s.summaryText || s.heurTitle || s.baseName
  }
  // Write [primary] + optional dim [— secondary] into a clip element, reusing a single
  // .lbl-inner track (the marquee transforms this child; the clip element stays put).
  function setTwoPart(clipEl, primary, secondary) {
    if (!clipEl || !clipEl.isConnected) return
    let inner = clipEl.firstElementChild
    if (!inner || !inner.classList.contains('lbl-inner')) {
      clipEl.replaceChildren()
      inner = document.createElement('span')
      inner.className = 'lbl-inner'
      clipEl.appendChild(inner)
    }
    const main = document.createElement('span')
    main.className = 'lbl-main'
    main.textContent = primary // textContent keeps agent-influenced text literal (no HTML)
    if (secondary) {
      const sub = document.createElement('span')
      sub.className = 'lbl-sub'
      sub.textContent = ' — ' + secondary
      inner.replaceChildren(main, sub)
    } else {
      inner.replaceChildren(main)
    }
  }
  // Mark a clip as overflowing (so :hover can marquee it) and hand the keyframes the exact
  // pixel distance + a distance-scaled duration. Read-only layout query; safe in rAF/RO.
  function measureMarquee(clipEl) {
    if (!clipEl || !clipEl.isConnected) return
    const inner = clipEl.firstElementChild
    if (!inner) return clipEl.classList.remove('is-overflow')
    const over = inner.scrollWidth - clipEl.clientWidth
    if (over > 4) {
      clipEl.classList.add('is-overflow')
      clipEl.style.setProperty('--marquee-shift', `-${over}px`)
      clipEl.style.setProperty('--marquee-dur', `${Math.min(14, Math.max(3, over / 28)).toFixed(1)}s`)
    } else {
      clipEl.classList.remove('is-overflow')
    }
  }
  function applyTitle(s) {
    if (s.custom) return // a manual rename always wins
    const primary = clamp(visibleLabel(s))
    // Append the summary only when the program supplied its OWN title (so we ADD to it).
    // With no OSC title the summary IS the lead, and a tail would just repeat it.
    const secondary = s.oscTitle && s.summaryText && s.summaryText !== s.oscTitle ? clamp(s.summaryText) : null
    setTwoPart(s.tabLabel, primary, secondary)
    setTwoPart(s.cellLabel, primary, secondary)
    if (s.stubLabel.isConnected) s.stubLabel.textContent = primary // slim rail stub: single-line
    const tip = secondary ? `${primary} — ${secondary}` : primary
    s.tabEl.title = tip
    s.cell.title = tip
    requestAnimationFrame(() => {
      measureMarquee(s.tabLabel)
      measureMarquee(s.cellLabel)
    })
  }
  // Strip a leading decorative status glyph that some agents prefix to their OSC title.
  // We already render our OWN Pulse indicator (the braille spinner / amber dot) to the left
  // of the label, so the agent's glyph reads as a SECOND, untrusted indicator wedged between
  // ours and the text — exactly the "indicators all over the place" problem. The strip covers
  // the families agents actually use as title leads:
  //   • bullets / middle-dots / leaders   ·  •  ‣  ․  ‧  ⁃  ∙  ⋅  ・  ･   (U+00B7, U+2022…, etc.)
  //   • geometric shapes                  ●  ○  ◦  ▪  ▸  …               (U+25A0–U+25FF)
  //   • dingbats / sparkles               ✳  ✻  ✶  ➤  …                 (U+2300–U+27BF)
  //   • misc symbols & arrows             ⬆  ⯈  …                       (U+2B00–U+2BFF)
  //   • any emoji + its variation selector / ZWJ joiners
  // Only a LEADING run (plus trailing space) is removed; an interior dot or a normal title is
  // untouched. Keep this in sync with the spinner glyphs so we never strip our own output.
  const LEAD_GLYPH =
    /^(?:[·•‣․‧⁃∙⋅■-◿⌀-➿⬀-⯿・･️‍]|\p{Extended_Pictographic})+\s*/u
  function setAutoTitle(s, raw) {
    const t = (raw || '')
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(LEAD_GLYPH, '')
      .trim()
    // Any title a program sets leads the label verbatim; our summary appends to it.
    s.oscTitle = !t || t === s.baseName ? null : t
    applyTitle(s)
  }

  // ---- free heuristic: the last typed command line ---------------------------
  // Zero-cost, harness-agnostic "clue" for shell/command panes. We reconstruct
  // the command line straight from the user's keystrokes — no output parsing, no
  // prompt-format assumptions, no shell integration. Best-effort: bail on escape
  // sequences (arrow keys / history recall) rather than guess. The branch is NOT
  // shown in the label (it's elsewhere in the UI); we still cache it as Pulse model
  // context, since an agent may be working in a different worktree than you expect.
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
    // Just the typed line — no " · branch" tail. The branch is already shown elsewhere in
    // the UI, so repeating it here only ate header room; CSS truncates the line to the
    // label's own width. Generous bound (CSS does the visible cut); keeps storage sane.
    s.heurTitle = cmd.replace(/\s+/g, ' ').trim().slice(0, 160)
    applyTitle(s)
    refreshBranch() // still warm the branch cache — Pulse passes it to the model as context
  }

  // ---- fit ----
  // A pane's ROLE in the current layout decides whether it drives its PTY size.
  // Only a "primary" pane — the surface you actually work in — is fitted and has its
  // size pushed to the PTY. A "preview" pane (a flow side-preview, a stack rail tile)
  // is a small glanceable thumbnail: fitting it would SIGWINCH the agent down to ~15
  // cols and reflow its output into a narrow column — and, worse, leave its scrollback
  // wrapped narrow even after you promote it (xterm only reflows the live screen, not
  // history). So previews keep the PTY at its last primary width and simply clip; the
  // moment one is promoted it re-fits cleanly with its history intact. Hidden panes
  // aren't measurable. This single rule keeps every layout — and every view we add
  // later — from ever mangling an agent's display.
  function paneRole(s) {
    if (layout === 'tabs') return s.id === activeId ? 'primary' : 'hidden'
    if (layout === 'grid') return 'primary' // every grid cell is a real working surface
    if (layout === 'stack' || layout === 'deck') return s.id === activeId ? 'primary' : 'preview'
    if (layout === 'flow') {
      if (s.cell.classList.contains('flow-center')) return 'primary'
      if (s.cell.classList.contains('flow-prev') || s.cell.classList.contains('flow-next')) return 'preview'
      return 'hidden'
    }
    return 'hidden'
  }
  // Scrollback is the single biggest per-pane memory cost (each retained row is a full
  // line buffer). A preview/hidden pane doesn't need the full history — you can't
  // scroll it — so we tier it by role off the user's primary budget (termSettings
  // .scrollback): primary gets the full budget, preview/hidden are capped below it,
  // and the larger value is restored the moment a pane is promoted back to primary.
  // xterm keeps existing rows when scrollback shrinks (it only trims as new output
  // arrives), so a promotion never loses history that's already there. Called from
  // fitSoon so every layout/role change re-tiers in one pass.
  function scrollbackFor(role) {
    const base = termSettings.scrollback
    if (role === 'primary') return base
    if (role === 'preview') return Math.min(2000, base)
    return Math.min(1000, base)
  }
  function applyScrollbackTiers() {
    if (sessions.size > 12) {
      console.warn(`[terminals] ${sessions.size} panes open — high memory footprint`)
    }
    for (const s of sessions.values()) {
      const want = scrollbackFor(paneRole(s))
      if (s.term.options.scrollback !== want) s.term.options.scrollback = want
    }
  }
  // Low-level fit for ONE pane. Fits and pushes the new size to the PTY only when the
  // pane is primary AND actually measurable (a hidden/0×0 body would push a bogus
  // 1-row size). Every resize path funnels through here, so the primary-only rule
  // can't be bypassed and previews are never dragged narrow.
  function fitPane(s) {
    if (paneRole(s) !== 'primary') return 'skip' // previews/hidden keep their PTY width
    // A primary pane whose box hasn't reached its final geometry yet (clientHeight 0 — a
    // tab/panel un-hidden this very frame, a CSS transition mid-flight, the monospace font
    // still loading) can't be measured; fitting it would push a bogus 1-row size. Report
    // it as 'deferred' so fitSoon retries next frame rather than silently dropping BOTH the
    // fit and the re-pin — otherwise a quiescent pane that then settles to an already-
    // observed size (no ResizeObserver callback, no output to pin) opens stranded above
    // the bottom: the original "stuck until a keypress" symptom.
    if (!s.body.isConnected || s.body.clientWidth === 0 || s.body.clientHeight === 0) return 'deferred'
    try {
      // A resize reflows the buffer and can leave the viewport a row or two above the
      // bottom — so the newest line (an agent's input box / prompt) renders just below
      // the fold, invisible until a keypress scrolls down. Re-pin after the fit whenever
      // the user is following the bottom (s.follow). The pinning guard wraps the whole
      // fit so the transient onScroll the reflow emits can't be read as a user scroll-up.
      s.pinning = true
      s.fit.fit()
      api.term.resize(s.id, s.term.cols, s.term.rows)
      if (s.follow) s.term.scrollToBottom()
      return 'fitted'
    } catch {
      /* measured mid-layout; retry next frame via the deferred path */
      return 'deferred'
    } finally {
      s.pinning = false
    }
  }
  // Re-assert the bottom after output, guarded so onScroll ignores it. xterm only
  // auto-scrolls on write when the viewport is ALREADY at the bottom — but a reflow,
  // an alt-screen exit, or the async SIGWINCH repaint that follows a resize can park
  // it one row high, and from there xterm stops following and the prompt stays hidden
  // until you type. Called from each write's parse-complete callback so following panes
  // snap back to the live line on the next frame, not the next keypress.
  function pinBottom(s) {
    if (!s.follow) return
    s.pinning = true
    s.term.scrollToBottom()
    s.pinning = false
  }
  // Fit every primary pane AFTER the browser has settled the new layout. Toggling
  // layout classes doesn't reach final geometry until the next layout pass, so fitting
  // synchronously measures a transient box — the root of the "squished into a narrow
  // column" bug. Deferring one frame measures the settled size. Coalesced so a burst
  // of layout calls costs a single pass; the per-pane ResizeObserver below is the
  // continuous net (drags, window/font changes), this is the discrete "I just changed
  // the layout" nudge.
  let settleScheduled = false
  let settleRetries = 0
  // ~10 frames (~160ms) of retrying is plenty for a box to reach final geometry; the
  // bound stops a permanently-0-size primary (e.g. the terminal panel collapsed) from
  // spinning the rAF loop forever.
  const MAX_SETTLE_RETRIES = 10
  function fitSoon() {
    if (settleScheduled) return
    settleScheduled = true
    requestAnimationFrame(() => {
      settleScheduled = false
      applyScrollbackTiers() // re-tier history to each pane's new role before fitting
      let deferred = false
      for (const s of sessions.values()) {
        if (fitPane(s) === 'deferred') deferred = true
      }
      // A primary pane skipped because its box wasn't measurable yet lost both its fit
      // and its scroll-to-bottom this frame. The ResizeObserver only recovers it if the
      // box LATER changes size, so a pane that settles to an already-reported size would
      // stay stranded above the bottom. Re-arm for the next frame (bounded) so the fit
      // and re-pin retry until the geometry is real — closing the switch-while-quiescent
      // stranding the single-rAF settle used to leave behind.
      if (deferred && settleRetries < MAX_SETTLE_RETRIES) {
        settleRetries++
        fitSoon()
      } else {
        settleRetries = 0
      }
    })
  }
  // Public API kept stable for the callers in main.js (panel/editor toggles, splitter
  // drag, restore). Both now mean the same thing — re-fit whatever is primary in the
  // current layout once it settles. The old tabs-vs-all split is obsolete: paneRole
  // already scopes the work correctly for every layout.
  function fitAll() {
    fitSoon()
  }
  function fitActive() {
    fitSoon()
  }

  // ---- auto-fit on ANY size change ----
  // FitAddon only recomputes a terminal's cols/rows when something calls fit(), so
  // historically every resize path had to remember to call it by hand — and any it
  // missed (e.g. dragging the sidebar wider) left the text at the old size until the
  // next manual fit. A ResizeObserver on each pane's body removes that whole class of
  // bug: it fires whenever the element's box actually changes — the OS window
  // resizing, either splitter dragging, the sidebar toggling, a layout switch, the
  // monospace font finishing loading — and we re-fit the PRIMARY panes (fitPane skips
  // previews/hidden, so a pane shrinking into a preview slot never drags its agent
  // narrow). Callbacks are coalesced through rAF so a drag (a burst of size changes)
  // costs at most one fit per frame per pane.
  const dirty = new Set()
  let fitScheduled = false
  function flushFits() {
    fitScheduled = false
    const batch = [...dirty]
    dirty.clear()
    for (const s of batch) fitPane(s)
  }
  function scheduleRefit(s) {
    dirty.add(s)
    if (fitScheduled) return
    fitScheduled = true
    requestAnimationFrame(flushFits)
  }
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const s = entry.target.__session
      if (s) scheduleRefit(s)
    }
  })
  // Re-check label overflow whenever a label's own width changes — a layout switch
  // (tabs→stack→flow), a window resize, or more tabs squeezing the bar. This keeps the
  // hover-marquee's "is it overflowing / by how much" state correct without re-running
  // applyTitle. Reading scrollWidth/clientWidth inside an RO callback is the standard
  // (no-thrash) place to do it.
  const labelResizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) measureMarquee(entry.target)
  })
  // The rail's tile size is a function of the panes container's size, so re-derive it
  // whenever that box changes — window resize, panel drag, sidebar toggle. sizeRail()
  // is a cheap no-op outside stack/deck, so observing unconditionally is fine.
  const panesResizeObserver = new ResizeObserver(() => sizeRail())
  panesResizeObserver.observe(panesEl)

  // ---- pty output -> terminal: drives the two-state (working/idle) indicator ----
  api.term.onData(({ id, data }) => {
    const s = sessions.get(id)
    if (!s) return
    // Classify AFTER the write is parsed into the buffer (the callback), so the working /
    // settle decision reads the post-write screen. pinBottom keeps scroll-follow regardless.
    s.term.write(data, () => {
      pinBottom(s)
      classifyOutput(s)
    })
  })
  // Decide what an output burst means for the pane's state. Driven off VISIBLE screen change,
  // not raw bytes: an agent parked at its prompt keeps emitting bytes that don't alter the
  // rendered screen (a blinking cursor, OSC-title pings, a no-op repaint), and if every such
  // byte reset the settle debounce the pane would stay `working` forever — the braille spinner
  // that never rests. So a burst that leaves the screen identical is ignored entirely: no
  // working entry, no timer reset, letting the already-armed idle timer fire and settle.
  function classifyOutput(s) {
    // A deferred write callback can land AFTER the pane exited (xterm flushes its parse queue
    // async; onExit may have run in between). The exit handler owns the final state — never let
    // a late burst relight the spinner or arm a timer on a dead pane.
    if (s.status === 'exited') return
    // A fresh, untouched shell only emits startup chrome — its prompt, or an
    // auto-injected `cd … && clear` from cdInto(). That isn't work, so don't let it
    // start the indicator. Only a pane the user has driven (s.used) or an agent preset
    // (!isShell) counts as working; an unused shell stays idle until used.
    if (s.isShell && !s.used) return
    // The settle debounce is keyed to the SCREEN, not the byte stream. An unchanged screen
    // means the program isn't actually doing anything visible (cursor blink / OSC ping /
    // no-op redraw) — don't keep it working and don't postpone the settle.
    const sig = screenSig(s)
    if (sig === s.lastScreenSig) return
    s.lastScreenSig = sig
    // A parked decision prompt (y/N, password, a numbered menu) is REST by definition — even
    // if a counter/clock keeps ticking BESIDE it (an agent's "esc to interrupt · 12s" status,
    // a live token meter). Such a tail keeps screenSig changing every burst, which would
    // otherwise re-arm the debounce forever and pin the pane in `working`. Treat it like a
    // no-change burst: don't re-arm. Just guarantee a settle is scheduled so the idle timer
    // classifies it as awaiting. (looksAwaitingPrompt is end-anchored — it won't match an
    // agent's empty input box mid-work, so this can't false-rest an actively working pane.)
    if (looksAwaitingPrompt(s)) {
      if (!s.idleTimer) armSettle(s)
      return
    }
    if (s.state !== 'working') {
      // Don't let the prompt's echo of your own keystrokes start the spinner: output within
      // ECHO_GRACE_MS of the last key you pressed is almost certainly that echo, not work.
      // This is the fix for "the spinner flickers as I type and vanishes when I stop" — typing
      // a command line isn't the agent thinking. A real command/agent keeps emitting past the
      // window and pulses then. Only the idle→working ENTRY is gated (we're not yet working,
      // so there are no settle timers to preserve by falling through).
      if (Date.now() - s.lastInputAt < ECHO_GRACE_MS) return
      // Keep the last summary visible through the new working stint. It's a "what is this
      // pane on" hint, and a few seconds stale beats blinking the "— summary" tail off on
      // EVERY output burst (an agent works in sub-heartbeat bursts, so clearing here made
      // the label fumble in and out of view). The heartbeat replaces it within
      // WORKING_PULSE_MS; reset its hash so it re-labels this stint from scratch.
      s.lastLiveHash = null
      setState(s, 'working') // repaints; also clears any awaiting come-look
      // The first time a beginner ever sees a tab start pulsing, explain it — Pulse
      // finally names itself at the exact moment it has meaning. Once ever, never expert.
      if (document.documentElement.dataset.mode !== 'expert') coachOnce('pulse', PULSE_COACH)
    }
    // Visible change ⇒ not at rest: (re-)arm the fast settle debounce.
    armSettle(s)
  }
  // Arm (or re-arm) the settle debounce: IDLE_AFTER_MS after the last VISIBLE activity, classify
  // the pane at rest. Shared by every visible-change burst (classifyOutput) AND the working-entry
  // edge (setState), so a pane that enters `working` ALWAYS has a scheduled path back to rest —
  // even a preset/launcher whose screen never changes again would otherwise animate forever with
  // no timer ever armed (the lazy per-burst arm never fires if nothing visible changes).
  function armSettle(s) {
    clearTimeout(s.idleTimer)
    clearTimeout(s.quietTimer)
    s.quietTimer = null
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null
      if (s.status === 'exited') return // the exit handler owns the final state
      // Layer 1 classify on settle. An explicit prompt in the tail ⇒ awaiting you now
      // (fast path, high confidence). Otherwise calm: settle to idle, and for a
      // full-screen TUI arm the conservative QUIET_MS alt-screen tell (the no-LLM floor).
      if (looksAwaitingPrompt(s)) {
        setState(s, 'awaiting')
      } else {
        setState(s, 'idle')
        if (s.term.buffer.active.type === 'alternate') {
          s.quietTimer = setTimeout(() => {
            s.quietTimer = null
            if (s.status !== 'exited' && s.state === 'idle' && s.term.buffer.active.type === 'alternate') {
              setState(s, 'awaiting') // a TUI silent past QUIET_MS is almost certainly at rest
            }
          }, QUIET_MS - IDLE_AFTER_MS)
        }
      }
      summarize(s) // Layer B: refine the label, and may promote idle→awaiting
    }, IDLE_AFTER_MS)
  }
  api.term.onExit(({ id }) => {
    const s = sessions.get(id)
    if (!s) return
    s.status = 'exited'
    s.state = 'idle' // a finished process isn't working/awaiting; the faded .exited tab marks "ended"
    s.unseen = false // never leave a dead pane nagging for a come-look
    onAwaitClear?.(id) // a finished process isn't awaiting — drop any stale notification
    clearTimeout(s.idleTimer) // settled — never leave it pulsing
    s.idleTimer = null
    clearTimeout(s.quietTimer)
    s.quietTimer = null
    clearTimeout(s.summaryDeferTimer) // no trailing summary for a dead pane
    s.summaryDeferTimer = null
    updateIndicators(s)
    s.tabEl.classList.add('exited')
    // Clear any stale OSC title (programs may leave one set on exit); the resolver
    // then falls back to the last heuristic label or the base name.
    clearTimeout(s.titleTimer)
    s.oscTitle = null
    applyTitle(s)
  })

  // ---- pulse Layer B: model summary of quiet panes ----
  // Pure-decoration glyphs that survive xterm's translateToString (which already drops
  // ANSI) but carry NO meaning for Pulse: spinner animation frames (Braille U+2800–28FF),
  // TUI box borders (U+2500–257F), and progress-bar block/shade elements (U+2580–259F).
  // Stripping them does three things: packs more real signal into the 2500-char tail,
  // lets Layer-1 match permission prompts that were buried in a box border, and — because
  // a spinner advancing changes the raw tail every frame — STABILISES the dedup hash, so a
  // pane just animating a spinner no longer burns a model call per frame. The meaningful
  // Claude Code status bullet ● (U+25CF) and the menu cursors ❯➤▶ sit OUTSIDE these ranges
  // and are preserved, so the few-shot prompt and the await detector keep working.
  const PULSE_NOISE_RE = /[\u2500-\u259f\u2800-\u28ff]/g
  function cleanTailLine(str) {
    return str.replace(PULSE_NOISE_RE, ' ').replace(/\s{2,}/g, ' ').trim()
  }
  // Read the last lines the pane shows (clean text straight from the xterm buffer,
  // no ANSI), hashed so we never re-ask about an unchanged screen. The model call
  // itself lives in main (the key never touches the renderer); we just send the tail.
  function tailOf(s, maxLines) {
    const buf = s.term.buffer.active
    // Default tail: 24 lines is plenty for a settled shell verdict and keeps the model
    // payload small. A full-screen TUI on the alternate buffer (vim, a dashboard, an
    // agent's alt-screen UI) packs meaning across the whole screen, so give it a larger
    // window (~40) or its verdict degrades.
    if (maxLines == null) maxLines = buf.type === 'alternate' ? 40 : 24
    const end = buf.baseY + buf.cursorY
    const lines = []
    // Count CONTENT lines toward the budget, not decoration/blank rows: a clean line that
    // reduces to nothing (a horizontal rule, a lone spinner, padding) is skipped so the
    // window fills with real output instead of TUI chrome.
    for (let i = end; i >= 0 && lines.length < maxLines; i--) {
      const line = buf.getLine(i)
      if (!line) continue
      const clean = cleanTailLine(line.translateToString(true))
      if (clean) lines.push(clean)
    }
    return lines.reverse().join('\n').trim()
  }
  function hashStr(str) {
    let h = 0
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
    return h
  }
  // A cheap signature of what's CURRENTLY ON SCREEN: every visible viewport row, hashed.
  // Used to decide whether an output burst is real work or just noise. An agent parked at
  // its prompt keeps emitting bytes that DON'T change the rendered screen — a blinking
  // cursor (drawn by the terminal, not a buffer cell), OSC-title updates, a periodic no-op
  // repaint — and if every byte reset the settle debounce the pane would stay `working`
  // forever (the spinner that never rests). The cursor's blink and position aren't part of
  // the cell text translateToString returns, so a stable screen hashes the same every burst.
  function screenSig(s) {
    const buf = s.term.buffer.active
    const top = buf.baseY // hash the visible viewport (alt-screen TUIs repaint across it)
    // Seed with the absolute cursor line so output that SCROLLS the buffer counts as activity
    // even when the visible rows repeat byte-for-byte (a program redrawing the same bottom line
    // in place while real work scrolls above it). A blinking cursor doesn't move baseY/cursorY,
    // so this doesn't reintroduce the cursor-blink false-change the screen hash exists to avoid.
    let h = (buf.baseY + buf.cursorY) | 0
    for (let i = 0; i < s.term.rows; i++) {
      const line = buf.getLine(top + i)
      if (!line) continue
      const str = line.translateToString(true)
      for (let j = 0; j < str.length; j++) h = (h * 31 + str.charCodeAt(j)) | 0
      h = (h * 31 + 10) | 0 // row delimiter so shifted content can't alias to the same hash
    }
    return h
  }
  // Sends the pane's visible tail to the model and writes back a one-line label. Called
  // two ways: (1) when a pane comes to rest (the working→idle edge) — the resting verdict,
  // which may also promote idle→awaiting; and (2) on the working heartbeat with
  // { live: true } — a present-tense label for a pane that's STILL working, so a long turn's
  // header tracks what it's doing instead of freezing on the program's own (often static)
  // title. The live path only paints a label; it never touches the working/idle state.
  async function summarize(s, { live = false } = {}) {
    if (!pulseEnabled || !api.pulse?.summarize) return
    if (s.summarizing) return // one request per pane at a time
    if (live && s.state !== 'working') return // heartbeat only labels panes still working
    // Per-pane settle cooldown. The settle path fires on EVERY >800ms quiet gap, and a busy
    // agent pauses constantly (between tool calls, while thinking), so without this a single
    // working pane drives ~15 model calls a minute — frequent enough to keep a local GPU/CPU
    // from ever idling (the heat users hit; the model being "free" in dollars misled us into
    // calling it freely). The label doesn't need refreshing that often. Throttle settle
    // re-labels to one per MIN_SUMMARY_GAP_MS and coalesce a burst into ONE trailing call, so
    // the final at-rest verdict (and its awaiting promotion) still lands — just deferred a few
    // seconds. The 30s heartbeat is already slow, so it's exempt (it only stamps the clock).
    if (!live) {
      const since = performance.now() - s.lastSummaryAt
      if (since < MIN_SUMMARY_GAP_MS) {
        clearTimeout(s.summaryDeferTimer)
        s.summaryDeferTimer = setTimeout(() => {
          s.summaryDeferTimer = null
          // Only worth a call if the pane is still at rest; resumed work re-labels via heartbeat.
          if (s.status !== 'exited' && s.state !== 'working') summarize(s)
        }, MIN_SUMMARY_GAP_MS - since)
        return
      }
    }
    const tail = tailOf(s)
    if (!tail) return
    const h = hashStr(tail)
    // The heartbeat dedups on its OWN hash so a no-op live re-label never marks the screen
    // as "summarised" and suppresses the at-rest verdict (with its awaiting promotion).
    if (h === (live ? s.lastLiveHash : s.lastSummaryHash)) return
    s.lastSummaryAt = performance.now() // stamp every real call so a settle waits behind a heartbeat too
    s.summarizing = true
    let res = null
    try {
      res = await api.pulse.summarize({
        id: s.id,
        tail,
        baseName: s.baseName,
        lastCommand: s.heurTitle || null,
        branch: cachedBranch || null
      })
    } catch {
      res = null
    } finally {
      s.summarizing = false
    }
    if (!res) return // failed/empty: leave the hash unset so we retry next rest
    if (s.status === 'exited') return // process ended while we waited — the exit handler owns it
    if (live) s.lastLiveHash = h
    // A heartbeat whose call returned while the pane is STILL working: paint the live label
    // and stop — never set lastSummaryHash, never change state (the at-rest verdict, with
    // its awaiting edge, stays the settle path's job).
    if (live && s.state === 'working') {
      const label = res.summary
      s.summaryText = label && label.trim() ? label.trim() : null
      applyTitle(s)
      return
    }
    // At-rest verdict — reached by the settle path, OR by a heartbeat whose call landed right
    // as the pane came to rest (s.state !== 'working' now), which makes it a valid settle read.
    // If the pane has since resumed working, don't paint a resting label over live output.
    if (s.state === 'working') return
    s.lastSummaryHash = h
    const label = res.summary
    s.summaryText = label && label.trim() ? label.trim() : null
    // Layer B can recognise a rest the deterministic regex missed — most importantly an
    // agent parked at its OWN input box (end-of-turn await). Promote idle→awaiting so the
    // come-look edge fires; we set summaryText first so the notification carries the
    // summary label. Never demote a deterministic `awaiting` on a model's say-so.
    if (res.state === 'awaiting' && s.state !== 'awaiting') setState(s, 'awaiting')
    applyTitle(s)
  }

  // Minimum gap between settle-path model calls for one pane. The settle debounce
  // (IDLE_AFTER_MS) only smooths sub-second output bursts; this throttles the much coarser
  // "agent paused to run a tool" gaps that otherwise fire a fresh call every few seconds.
  // Comfortably under the heartbeat so a still-working pane's label stays live, but high
  // enough to collapse the settle storm that was driving the heat.
  const MIN_SUMMARY_GAP_MS = 12000

  // Pulse working heartbeat. A pane that keeps emitting output never hits the settle path,
  // so without this its header would sit frozen — for an agent, on the program's static OSC
  // title ("claude") — for the whole turn. On a slow tick, re-summarise every pane that's
  // still working so the label tracks what it's doing live. Kept light: an unchanged screen
  // is skipped by the per-pane hash (lastLiveHash), the settle cooldown thins the call
  // stream, and main caps global concurrency (MAX_CONCURRENT) and supersedes stale queued
  // calls. Tune the period for liveness vs. call volume. (The fast settle path still owns
  // the at-rest / awaiting edge.)
  const WORKING_PULSE_MS = 30000
  const heartbeatTimer = setInterval(() => {
    if (!pulseEnabled) return
    for (const s of sessions.values()) {
      if (s.status !== 'exited' && s.state === 'working') summarize(s, { live: true })
    }
  }, WORKING_PULSE_MS)

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  // Paint one grid into a pane's three dot figures (tab / cell-header / stub) at once — the
  // single place that writes the figure, so resting (updateIndicators), the rest→work edge
  // (setState) and the animation tick all stay in lock-step.
  function paintFigure(s, grid) {
    paint(s.tabDot.firstElementChild, grid)
    paint(s.cellDot.firstElementChild, grid)
    paint(s.stubDot.firstElementChild, grid)
  }
  // Paint the CURRENT working frame for a pane (does not advance the clock — the ticker owns
  // s.workT++). Reduced motion shows the static figure; otherwise the thinker's frame, with a
  // single-dot floor so an effect's all-off ticks (heartbeat is blank most of its cycle) never
  // blink the indicator to "nothing" while the pane is genuinely working.
  function paintWorking(s) {
    if (reduceMotion.matches) { paintFigure(s, STATIC_GRID); return }
    let grid = s.thinker.draw(s.workT)
    if (!grid.some((v) => v)) grid = MIN_WORKING_GRID
    paintFigure(s, grid)
  }

  // ---- working-figure animation ticker ----
  // One global ticker advances every WORKING pane's own thinker and paints the frame into its
  // three dot figures (tab / cell-header / stub). Each pane shows the ONE pattern picked for
  // this working phase (in setState on the rest→work edge); resting figures are painted once on
  // the edge (updateIndicators), not here. Reduced motion freezes on the static figure.
  const FRAME_MS = 130 // animation cadence — slowed slightly for a calmer, more readable figure
  const animTimer = setInterval(() => {
    if (document.hidden) return // background window: don't burn CPU
    for (const s of sessions.values()) {
      if (s.state !== 'working') continue
      s.workT++
      paintWorking(s)
    }
  }, FRAME_MS)

  // OS window resizes need no special handling: shrinking/growing the window
  // changes every visible pane's body size, which the per-pane ResizeObserver above
  // already picks up. (One coalesced fit per frame, vs the old un-debounced fitAll.)

  // Album-flow cycling: ⌥←/→ (Alt+Arrow) steps the centre through the terminals.
  // Alt keeps it clear of anything the focused shell would read from the arrows.
  const onFlowArrowKey = (e) => {
    if (layout !== 'flow' || !e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      stepFlow(1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      stepFlow(-1)
    }
  }
  window.addEventListener('keydown', onFlowArrowKey)

  // Safety net: a file dropped anywhere a handler didn't claim would otherwise make
  // Electron navigate the window to that file (blanking the app). Swallow such stray
  // file drops globally. We defer to anything that already handled the drop (a pane,
  // or the editor) via defaultPrevented, so real drop zones still work.
  const swallowStrayFileDrag = (e) => {
    if (e.defaultPrevented || !dragHasFiles(e)) return
    e.preventDefault()
  }
  window.addEventListener('dragover', swallowStrayFileDrag)
  window.addEventListener('drop', swallowStrayFileDrag)

  // Apply a light/dark theme to all existing terminals and future ones. The
  // identity palette has a light and a dark variant, so re-derive the active hues
  // and recolour every pane's header — without this the dark-tuned hues would never
  // take effect on a toggle (setTheme historically only touched xterm's own colours).
  function setTheme(name) {
    themeName = TERM_THEMES[name] ? name : 'light'
    for (const s of sessions.values()) s.term.options.theme = TERM_THEMES[themeName]
    activeColors = colorsFor(headerPalette, themeName, headerCustom)
    recolorAll()
  }

  // Switch the identity-colour palette (appearance.headerTheme). `id` is a palette
  // key; `customRaw` is the raw user input used only when id === 'custom'. Existing
  // panes are recoloured immediately, future ones inherit the new activeColors.
  function setHeaderTheme(id, customRaw) {
    if (typeof id === 'string' && id) headerPalette = id
    if (typeof customRaw === 'string') headerCustom = customRaw
    activeColors = colorsFor(headerPalette, themeName, headerCustom)
    recolorAll()
  }

  // Re-apply --term-color to every existing pane (tab + cell + rail stub) from the
  // current activeColors, keeping each pane on its own stored slot. Also refreshes
  // s.color so any code reading it stays in sync. The Pulse tint/breathe and status
  // dots all derive from --term-color, so they pick up the new hue live.
  function recolorAll() {
    if (!activeColors || !activeColors.length) return
    for (const s of sessions.values()) {
      const c = activeColors[s.colorIndex % activeColors.length]
      if (!c) continue
      s.color = c
      s.tabEl.style.setProperty('--term-color', c)
      s.cell.style.setProperty('--term-color', c)
      s.stub.style.setProperty('--term-color', c)
    }
  }

  // Apply central terminal preferences (from the Settings window). Updates the
  // defaults future panes inherit and pushes the change to every live pane. A font
  // change alters cell metrics, so we re-fit (and re-push the PTY size) afterwards;
  // scrollback re-tiers through the role-aware path so previews stay capped.
  function applySettings(opts = {}) {
    let fontChanged = false
    if (typeof opts.fontSize === 'number' && opts.fontSize !== termSettings.fontSize) {
      termSettings.fontSize = opts.fontSize
      fontChanged = true
    }
    if (typeof opts.fontFamily === 'string' && opts.fontFamily.trim() && opts.fontFamily !== termSettings.fontFamily) {
      termSettings.fontFamily = opts.fontFamily
      fontChanged = true
    }
    if (typeof opts.cursorBlink === 'boolean') termSettings.cursorBlink = opts.cursorBlink
    if (typeof opts.scrollback === 'number') termSettings.scrollback = opts.scrollback
    if (typeof opts.confirmClose === 'boolean') termSettings.confirmClose = opts.confirmClose
    if (typeof opts.railVisibleTiles === 'number' && opts.railVisibleTiles > 0) {
      termSettings.railVisibleTiles = opts.railVisibleTiles
      sizeRail() // re-derive rail tile size live (no-op outside stack/deck)
    }
    for (const s of sessions.values()) {
      if (fontChanged) {
        s.term.options.fontSize = termSettings.fontSize
        s.term.options.fontFamily = termSettings.fontFamily
      }
      s.term.options.cursorBlink = termSettings.cursorBlink
    }
    applyScrollbackTiers()
    if (fontChanged) fitAll()
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

  // Type text into the active terminal WITHOUT running it — no trailing newline.
  // The user reads the command on the prompt and presses Enter themselves. Used by
  // the beginner command palette ("type, don't run"). Focusing the pane afterwards
  // means they can immediately edit or run it. Marks the pane "used" so cdInto()
  // won't later type a cd into a terminal the user has started driving.
  function typeIntoActive(text) {
    const s = sessions.get(activeId)
    if (!s || !text) return false
    s.used = true
    api.term.input(s.id, text)
    s.term.focus()
    return true
  }

  // Tear down every per-pane timer this module owns (the idle-debounce and title
  // debounce handles) so a backgrounded/recreated view leaves nothing running.
  // clearTimeout on an already-fired/null handle is a no-op, so this is safe to call
  // regardless of state.
  function dispose() {
    for (const s of sessions.values()) {
      clearTimeout(s.idleTimer)
      clearTimeout(s.titleTimer)
      clearTimeout(s.quietTimer)
      clearTimeout(s.summaryDeferTimer)
      s.idleTimer = s.titleTimer = s.quietTimer = s.summaryDeferTimer = null
    }
    // Module-owned intervals and window-level listeners. Without clearing these a
    // re-instantiation (a future multi-window / workspace refactor) would stack a second
    // pulse poll, heartbeat, flow-arrow handler and stray-drop swallower — double-stepping
    // the flow and re-running drop swallowing N times. dispose() promises "nothing
    // running", so honor it for these too, not just the per-pane timers.
    clearInterval(pulseStatusTimer)
    clearInterval(heartbeatTimer)
    clearInterval(animTimer)
    panesResizeObserver.disconnect()
    window.removeEventListener('keydown', onFlowArrowKey)
    window.removeEventListener('dragover', swallowStrayFileDrag)
    window.removeEventListener('drop', swallowStrayFileDrag)
  }

  // Bring a pane to the foreground by id — used by the awaiting OS-notification's click
  // handler to jump straight to the agent that needs you. activate() handles focus,
  // sticky-bottom and the come-look clear; in grid/flow the pane is already visible.
  function revealPane(id) {
    if (sessions.has(id)) activate(id)
  }

  return { create, newTab, fitActive, fitAll, setLayout, setTheme, setHeaderTheme, applySettings, cdInto, typeIntoActive, stepActive, moveActive, activateIndex, cycleLayout, closeActive, getState, restore, revealPane, dispose }
}
