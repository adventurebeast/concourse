import './commandPalette.css'
import { icon } from './icons.js'

// Command palette (⌘K). Two layers:
//   • Dynamic sources from the main process (api.commands), shown in EVERY mode:
//       ♥ Favorites  → pinned commands (project-pinned first, then global)
//       This project → npm scripts / justfile / Makefile of the open folder
//       Frequent     → your shell history, frecency-ranked and de-noised
//     This is the "call up the command I always run" surface — far better than
//     Up-Arrow: visible, searchable, ranked by what you actually use, and you can
//     ♥ the ones that matter so they're always on top.
//   • A hand-curated beginner cheatsheet (below), shown in beginner mode only.
// Picking a command TYPES it onto the active prompt but does NOT run it — the user
// reads it and presses Enter themselves, so the terminal stays a dumb display and
// we never fight the shell's byte stream.
const COMMANDS = [
  {
    group: 'Files & folders',
    items: [
      { cmd: 'ls', label: 'See what files are here', icon: 'files' },
      { cmd: 'ls -la', label: 'See everything, including hidden files', icon: 'files' },
      { cmd: 'pwd', label: 'Show which folder I am in', icon: 'folderOpen' },
      {
        cmd: 'cd ',
        label: 'Go into a folder',
        hint: 'type the folder name after it',
        icon: 'folderOpen'
      },
      { cmd: 'cd ..', label: 'Go up one folder', icon: 'folderOpen' },
      {
        cmd: 'mkdir ',
        label: 'Make a new folder',
        hint: 'type the folder name after it',
        icon: 'folderPlus'
      }
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
      {
        cmd: 'git commit -m ""',
        label: 'Save my changes with a message',
        hint: 'type the message inside the quotes',
        icon: 'check'
      },
      { cmd: 'git log --oneline', label: 'See recent history', icon: 'gitBranch' }
    ]
  },
  {
    group: 'Housekeeping',
    items: [{ cmd: 'clear', label: 'Tidy up the screen', icon: 'collapse' }]
  }
]

// Flat list for the chip strip below the terminal (each entry remembers its group).
const FLAT = COMMANDS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })))

// A short, friendly starter set shown in the always-visible strip under the
// terminal (beginner mode). Chips lead with a concise plain-English label; the
// real command is the tooltip. The full set lives behind the palette ("More…").
const STARTERS = [
  { cmd: 'ls', short: 'See files' },
  { cmd: 'cd ..', short: 'Go up a folder' },
  { cmd: 'git status', short: 'Check status' },
  { cmd: 'npm run dev', short: 'Start the app' },
  { cmd: 'clear', short: 'Tidy screen' }
]

export function createCommandPalette({ typeInto, listCommands, favorite, unfavorite } = {}) {
  // ---- DOM (built once, appended to body, toggled with [hidden]) -------------
  const overlay = document.createElement('div')
  overlay.id = 'cmd-palette'
  overlay.hidden = true
  overlay.innerHTML = `
    <div class="cmd-card" role="dialog" aria-label="Command palette">
      <div class="cmd-head">
        <span class="cmd-head-icon">${icon('wand', 16)}</span>
        <input class="cmd-search" type="text" placeholder="Search commands, scripts & history…" spellcheck="false" />
      </div>
      <div class="cmd-list" role="listbox"></div>
      <div class="cmd-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> put on prompt</span>
        <span><kbd>⌥</kbd><kbd>↵</kbd> ♥ favorite</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>`
  document.body.appendChild(overlay)

  const search = overlay.querySelector('.cmd-search')
  const list = overlay.querySelector('.cmd-list')

  let rows = [] // rendered selectable rows, in display order: { el, item, favId }
  let active = 0 // index into rows of the highlighted item
  // Dynamic sources from the main process; empty until load() resolves (and when
  // listCommands isn't wired, e.g. in isolation), so the palette degrades to the
  // curated cheatsheet alone.
  let dynamic = { favorites: [], project: [], history: [] }

  async function load() {
    if (!listCommands) return
    try {
      const d = await listCommands()
      if (d && typeof d === 'object') {
        dynamic = {
          favorites: Array.isArray(d.favorites) ? d.favorites : [],
          project: Array.isArray(d.project) ? d.project : [],
          history: Array.isArray(d.history) ? d.history : []
        }
      }
    } catch {
      /* keep last-known dynamic — a failed fetch must not blank the palette */
    }
  }

  // ---- Render the (optionally filtered) list --------------------------------
  function render(filter = '') {
    const q = filter.trim().toLowerCase()
    const match = (cmd, label) =>
      !q || cmd.toLowerCase().includes(q) || (label && label.toLowerCase().includes(q))

    // command string → favorite id, so a row showing that command (in any group)
    // renders a filled heart and unfavorites by id.
    const favById = new Map()
    for (const f of dynamic.favorites) if (!favById.has(f.cmd)) favById.set(f.cmd, f.id)

    list.innerHTML = ''
    rows = []

    // 1) Favorites — project-pinned first, then global.
    const favs = [...dynamic.favorites].sort(
      (a, b) => (b.projectScoped ? 1 : 0) - (a.projectScoped ? 1 : 0)
    )
    appendGroup(
      'Favorites',
      favs
        .filter((f) => match(f.cmd, f.label))
        .map((f) => ({
          cmd: f.cmd,
          label: f.label || f.cmd,
          icon: 'wand',
          // Carry this record's own id: a command can be favorited both globally AND
          // pinned to the project (two records, same cmd), so the heart must target
          // THIS row's id, not a cmd→id lookup that would collapse the two.
          favId: f.id,
          badge: f.projectScoped ? 'project' : null
        })),
      favById
    )

    // 2) This project's own commands (deduped against favorites).
    appendGroup(
      'This project',
      dynamic.project
        .filter((p) => !favById.has(p.cmd) && match(p.cmd, p.label))
        .map((p) => ({ cmd: p.cmd, label: p.label || p.cmd, icon: 'box', badge: p.source })),
      favById
    )

    // 3) Frequent (history) — deduped against favorites and project commands.
    const projCmds = new Set(dynamic.project.map((p) => p.cmd))
    appendGroup(
      'Frequent',
      dynamic.history
        .filter((h) => !favById.has(h.cmd) && !projCmds.has(h.cmd) && match(h.cmd, h.cmd))
        .map((h) => ({ cmd: h.cmd, label: h.cmd, icon: 'terminal' })),
      favById
    )

    // 4) Beginner-only curated cheatsheet, at the bottom.
    if (document.documentElement.dataset.mode !== 'expert') {
      for (const g of COMMANDS) {
        appendGroup(
          g.group,
          g.items
            .filter((it) => match(it.cmd, it.label))
            .map((it) => ({ cmd: it.cmd, label: it.label, hint: it.hint, icon: it.icon })),
          favById
        )
      }
    }

    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'cmd-empty'
      empty.textContent = q
        ? 'No matching commands'
        : 'No commands yet — run a few and they’ll show up here'
      list.appendChild(empty)
    }
    setActive(0)
  }

  function appendGroup(title, items, favById) {
    if (!items.length) return
    const head = document.createElement('div')
    head.className = 'cmd-group'
    head.textContent = title
    list.appendChild(head)
    for (const it of items) appendRow(it, favById)
  }

  function appendRow(it, favById) {
    const favId = it.favId || favById.get(it.cmd) || null
    const faved = !!favId
    const sameAsCmd = it.label === it.cmd
    const labelHtml = sameAsCmd
      ? `<span class="cmd-row-cmd cmd-row-cmd-lead">${escapeHtml(it.cmd)}</span>`
      : `<span class="cmd-row-label">${escapeHtml(it.label)}${
          it.hint ? `<span class="cmd-row-hint"> — ${escapeHtml(it.hint)}</span>` : ''
        }</span><span class="cmd-row-cmd">${escapeHtml(it.cmd)}</span>`
    const badge = it.badge ? `<span class="cmd-badge">${escapeHtml(it.badge)}</span>` : ''

    const row = document.createElement('div')
    row.className = 'cmd-row'
    row.setAttribute('role', 'option')
    row.innerHTML =
      `<span class="cmd-row-icon">${icon(it.icon || 'terminal', 16)}</span>` +
      `<span class="cmd-row-text">${labelHtml}</span>` +
      badge +
      `<button class="cmd-fav${faved ? ' on' : ''}" type="button" tabindex="-1" title="${
        faved ? 'Remove favorite' : 'Favorite (⇧-click to pin to this project)'
      }" aria-label="favorite">${faved ? '♥' : '♡'}</button>`

    const idx = rows.length
    row.addEventListener('mouseenter', () => setActive(idx))
    row.addEventListener('click', () => choose(it))
    const favBtn = row.querySelector('.cmd-fav')
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation() // never let the heart also "choose" the row
      toggleFavorite(it, favId, e.shiftKey)
    })
    list.appendChild(row)
    rows.push({ el: row, item: it, favId })
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

  // Toggle a ♥. Plain click/⌥↵ → global favorite; ⇧-click → pinned to this
  // project. The main process broadcasts commands:changed → refresh() re-renders
  // (in this and any other open window); we also reload here for instant feedback.
  async function toggleFavorite(it, favId, projectScoped) {
    try {
      if (favId) {
        if (unfavorite) await unfavorite(favId)
      } else if (favorite) {
        await favorite(it.cmd, it.label, { project: !!projectScoped })
      } else {
        return
      }
    } catch {
      return // a failed toggle leaves the list as-is
    }
    await load()
    render(search.value)
  }

  // ---- Open / close ----------------------------------------------------------
  async function open() {
    overlay.hidden = false
    search.value = ''
    render('') // paint cached content immediately
    search.focus()
    await load() // then refresh from disk and repaint
    if (!overlay.hidden) render(search.value)
  }
  function close() {
    overlay.hidden = true
  }
  function toggle() {
    overlay.hidden ? open() : close()
  }
  // Re-fetch when favorites change elsewhere; only repaint if we're open.
  async function refresh() {
    if (overlay.hidden) return
    await load()
    if (!overlay.hidden) render(search.value)
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
      const r = rows[active]
      if (!r) return
      if (e.altKey)
        toggleFavorite(r.item, r.favId, false) // ⌥↵ favorites instead of running
      else choose(r.item)
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

  return { open, close, toggle, refresh, mountStrip, isOpen: () => !overlay.hidden }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  )
}
