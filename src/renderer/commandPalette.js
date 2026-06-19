import './commandPalette.css'
import { icon } from './icons.js'

// Beginner command palette: a clickable, plain-English launcher of curated shell
// commands. The terminal grid itself isn't clickable (xterm renders to a canvas we
// don't control cell-by-cell), so this is a normal HTML overlay floating above the
// workbench. Picking a command TYPES it onto the active prompt but does NOT run it —
// the user reads it and presses Enter themselves. That keeps the terminal a dumb
// display and never fights the shell's byte stream.
//
// Commands are a hand-curated static list (no folder sniffing) so they're predictable
// and easy to reason about for someone new to a terminal.
const COMMANDS = [
  {
    group: 'Files & folders',
    items: [
      { cmd: 'ls', label: 'See what files are here', icon: 'files' },
      { cmd: 'ls -la', label: 'See everything, including hidden files', icon: 'files' },
      { cmd: 'pwd', label: 'Show which folder I am in', icon: 'folderOpen' },
      { cmd: 'cd ', label: 'Go into a folder', hint: 'type the folder name after it', icon: 'folderOpen' },
      { cmd: 'cd ..', label: 'Go up one folder', icon: 'folderOpen' },
      { cmd: 'mkdir ', label: 'Make a new folder', hint: 'type the folder name after it', icon: 'folderPlus' }
    ]
  },
  {
    group: 'Project',
    items: [
      { cmd: 'npm install', label: 'Install the project’s dependencies', icon: 'box' },
      { cmd: 'npm run dev', label: 'Start the app in development', icon: 'terminal' },
      { cmd: 'npm test', label: 'Run the tests', icon: 'check' }
    ]
  },
  {
    group: 'Git',
    items: [
      { cmd: 'git status', label: 'See what has changed', icon: 'gitBranch' },
      { cmd: 'git add -A', label: 'Stage all my changes', icon: 'plus' },
      { cmd: 'git commit -m ""', label: 'Save my changes with a message', hint: 'type the message inside the quotes', icon: 'check' },
      { cmd: 'git log --oneline', label: 'See recent history', icon: 'gitBranch' }
    ]
  },
  {
    group: 'Housekeeping',
    items: [
      { cmd: 'clear', label: 'Tidy up the screen', icon: 'collapse' }
    ]
  }
]

// Flat list for filtering/keyboard nav (each entry remembers its group).
const FLAT = COMMANDS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })))

// A short, friendly starter set shown in the always-visible strip under the
// terminal (beginner mode). Chips lead with a concise plain-English label (the
// full label from COMMANDS is too long for a chip); the real command is the
// tooltip. The full set lives behind the palette ("More…").
const STARTERS = [
  { cmd: 'ls', short: 'See files' },
  { cmd: 'cd ..', short: 'Go up a folder' },
  { cmd: 'git status', short: 'Check status' },
  { cmd: 'npm run dev', short: 'Start the app' },
  { cmd: 'clear', short: 'Tidy screen' }
]

export function createCommandPalette({ typeInto } = {}) {
  // ---- DOM (built once, appended to body, toggled with [hidden]) -------------
  const overlay = document.createElement('div')
  overlay.id = 'cmd-palette'
  overlay.hidden = true
  overlay.innerHTML = `
    <div class="cmd-card" role="dialog" aria-label="Command palette">
      <div class="cmd-head">
        <span class="cmd-head-icon">${icon('wand', 16)}</span>
        <input class="cmd-search" type="text" placeholder="What do you want to do?" spellcheck="false" />
      </div>
      <div class="cmd-list" role="listbox"></div>
      <div class="cmd-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> put on prompt</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const search = overlay.querySelector('.cmd-search')
  const list = overlay.querySelector('.cmd-list')

  let rows = [] // rendered selectable rows, in display order
  let active = 0 // index into rows of the highlighted item

  // ---- Render the (optionally filtered) list --------------------------------
  function render(filter = '') {
    const q = filter.trim().toLowerCase()
    const match = (it) =>
      !q || it.cmd.toLowerCase().includes(q) || it.label.toLowerCase().includes(q)

    list.innerHTML = ''
    rows = []

    for (const g of COMMANDS) {
      const items = g.items.filter(match)
      if (!items.length) continue
      const head = document.createElement('div')
      head.className = 'cmd-group'
      head.textContent = g.group
      list.appendChild(head)
      for (const it of items) {
        const row = document.createElement('button')
        row.className = 'cmd-row'
        row.type = 'button'
        row.innerHTML = `
          <span class="cmd-row-icon">${icon(it.icon || 'terminal', 16)}</span>
          <span class="cmd-row-text">
            <span class="cmd-row-label">${escapeHtml(it.label)}${it.hint ? `<span class="cmd-row-hint"> — ${escapeHtml(it.hint)}</span>` : ''}</span>
            <span class="cmd-row-cmd">${escapeHtml(it.cmd)}</span>
          </span>`
        const idx = rows.length
        row.addEventListener('mouseenter', () => setActive(idx))
        row.addEventListener('click', () => choose(it))
        list.appendChild(row)
        rows.push({ el: row, item: it })
      }
    }

    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'cmd-empty'
      empty.textContent = 'No matching commands'
      list.appendChild(empty)
    }
    setActive(0)
  }

  function setActive(i) {
    if (!rows.length) return
    active = Math.max(0, Math.min(i, rows.length - 1))
    rows.forEach((r, n) => r.el.classList.toggle('active', n === active))
    rows[active].el.scrollIntoView({ block: 'nearest' })
  }

  // Type the command onto the active prompt (no newline) and close. If there's no
  // active terminal to type into we just close — nothing to do.
  function choose(it) {
    close()
    if (typeInto) typeInto(it.cmd)
  }

  // ---- Open / close ----------------------------------------------------------
  function open() {
    overlay.hidden = false
    search.value = ''
    render('')
    search.focus()
  }
  function close() {
    overlay.hidden = true
  }
  function toggle() {
    overlay.hidden ? open() : close()
  }

  // ---- Wiring ----------------------------------------------------------------
  search.addEventListener('input', () => render(search.value))
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(active + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(active - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[active]) choose(rows[active].item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })
  // Click on the dimmed backdrop (outside the card) closes.
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })

  // ---- Always-visible chip strip (beginner mode) ----------------------------
  // The same curated commands, surfaced as clickable chips under the terminal so a
  // newcomer sees suggestions immediately without opening anything. Clicking a chip
  // types it onto the prompt (no run); the trailing "More…" chip opens the palette.
  function mountStrip(el) {
    if (!el) return
    el.innerHTML = ''
    for (const starter of STARTERS) {
      const it = FLAT.find((f) => f.cmd === starter.cmd)
      if (!it) continue
      const chip = document.createElement('button')
      chip.className = 'cmd-chip'
      chip.type = 'button'
      // Tooltip shows the real command so the label and what-it-runs stay connected.
      chip.title = `${it.label} — runs: ${it.cmd.trim()}`
      chip.innerHTML = `<span class="cmd-chip-icon">${icon(it.icon || 'terminal', 13)}</span><span>${escapeHtml(starter.short)}</span>`
      chip.addEventListener('click', () => choose(it))
      el.appendChild(chip)
    }
    const more = document.createElement('button')
    more.className = 'cmd-chip cmd-chip-more'
    more.type = 'button'
    more.title = 'Browse all commands (⌘K)'
    more.innerHTML = `<span class="cmd-chip-icon">${icon('wand', 13)}</span><span>More…</span>`
    more.addEventListener('click', open)
    el.appendChild(more)
  }

  return { open, close, toggle, mountStrip, isOpen: () => !overlay.hidden }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
