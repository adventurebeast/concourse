import './commandPalette.css'
import { icon } from './icons.js'

// Command palette (⌘K). At rest it shows only explicit Favorites. Searching adds
// model suggestions grounded in declarative project scripts; terminal input and
// command history are never data sources.
// Anything you type that isn't in the list becomes a row of its own, so a novel
// command is one Save-click (or ⌥↵) away from being a pinned favorite.
// Picking a command TYPES it onto the active prompt but does NOT run it — the user
// reads it and presses Enter themselves, so the terminal stays a dumb display and
// we never fight the shell's byte stream. ⌘↵ (or ⌘-click) is the deliberate
// exception: type AND run in one stroke.
export function createCommandPalette({
  typeInto,
  listCommands,
  suggest,
  favorite,
  unfavorite
} = {}) {
  // ---- DOM (built once, appended to body, toggled with [hidden]) -------------
  const overlay = document.createElement('div')
  overlay.id = 'cmd-palette'
  overlay.hidden = true
  overlay.innerHTML = `
    <div class="cmd-card" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="cmd-head">
        <span class="cmd-head-icon">${icon('wand', 16)}</span>
        <input class="cmd-search" type="text" placeholder="Search favorites & project commands…" spellcheck="false" />
      </div>
      <div class="cmd-list" role="listbox"></div>
      <div class="cmd-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> put on prompt</span>
        <span><kbd>⌘</kbd><kbd>↵</kbd> run</span>
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
  // listCommands isn't wired, e.g. in isolation), so the palette degrades gracefully.
  let dynamic = { favorites: [], project: [], thisProject: [], global: [] }
  // Model-curated "Suggested" group ({ cmd, label }), fetched independently of the
  // list so the palette never blocks on the model — it fills in when suggest() lands.
  let suggested = []
  // Bumped on every close(); open() captures it before awaiting load() so a stale
  // in-flight fetch from a previous open can't repaint a freshly-reopened palette.
  let openGen = 0

  async function load() {
    if (!listCommands) return
    try {
      const d = await listCommands()
      if (d && typeof d === 'object') {
        dynamic = {
          favorites: Array.isArray(d.favorites) ? d.favorites : [],
          project: Array.isArray(d.project) ? d.project : [],
          thisProject: Array.isArray(d.thisProject) ? d.thisProject : [],
          global: Array.isArray(d.global) ? d.global : []
        }
      }
    } catch {
      /* keep last-known dynamic — a failed fetch must not blank the palette */
    }
  }

  // The Suggested group is a separate fetch: it may wait on a model call, so it must
  // not hold up the rest of the list. Keeps the last-known set on failure.
  async function loadSuggestions() {
    if (!suggest) return
    try {
      const s = await suggest()
      if (Array.isArray(s)) suggested = s.filter((x) => x && typeof x.cmd === 'string')
    } catch {
      /* keep last-known suggestions — a failed fetch must not blank the group */
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
    // Commands already placed in a higher group — keeps each command in a single
    // group, top-down (favorites are tracked separately via favById).
    const shown = new Set()

    // 1) Favorites — pinned to this project (see commands:favorite). Any older
    // global favorites still surface here too; they just aren't badged.
    appendGroup(
      'Favorites',
      dynamic.favorites
        .filter((f) => match(f.cmd, f.label))
        .map((f) => ({
          cmd: f.cmd,
          label: f.label || f.cmd,
          icon: 'wand',
          // Carry this record's own id so the heart unfavorites exactly this row.
          favId: f.id
        })),
      favById
    )

    // No query means "give me the commands I deliberately kept", not "show me
    // everything Concourse knows". This is the fast repeat-command path.
    if (!q) {
      setActive(0)
      return
    }

    // 2) Suggested — up to 5 quick commands the Pulse model curates from THIS
    // project's declared scripts (see command-suggest.js).
    // Grounded, so it only ever names commands that actually exist. Sits right
    // under your ♥ favorites and de-dupes out of every group below.
    appendGroup(
      'Suggested',
      suggested
        .filter((s) => !favById.has(s.cmd) && match(s.cmd, s.label))
        .map((s) => ({ cmd: s.cmd, label: s.label || s.cmd, icon: 'compass' })),
      favById
    )
    for (const s of suggested) shown.add(s.cmd)

    // 3) Project — named scripts/recipes/targets discovered in the open folder
    // (package.json, justfile, Makefile). Declarative and version-controlled, so
    // they show without ever having been run. De-duped against favorites + Suggested.
    appendGroup(
      'Project',
      dynamic.project
        .filter((p) => !favById.has(p.cmd) && !shown.has(p.cmd) && match(p.cmd, p.label))
        .map((p) => ({ cmd: p.cmd, label: p.label, badge: p.source, icon: 'box' })),
      favById
    )
    for (const p of dynamic.project) shown.add(p.cmd)

    // Whatever you typed, as a row of its own — the "just let me save my
    // command" path. Shown whenever the query isn't already a listed command:
    // ↵ types it, ⌘↵ runs it, and the row's explicit Save button (or ⌥↵) pins
    // it as a favorite. `save: true` swaps this row's faint ♡ for a labelled
    // Save button — the whole point of a novel command is that saving it should
    // be an obvious click, not a hidden shortcut. Uses the RAW query (commands
    // are case-sensitive), not the lowercased match key.
    const typed = filter.trim()
    if (typed && !rows.some((r) => r.item.cmd === typed)) {
      appendGroup(
        'Your command',
        [
          {
            cmd: typed,
            label: 'Use what you typed',
            hint: 'Save it to keep it in ⌘K',
            icon: 'terminal',
            save: true
          }
        ],
        favById
      )
    }

    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'cmd-empty'
      empty.textContent = 'No matching favorites or project commands'
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
    // Every not-yet-favorited row shows an explicit Save button (revealed on
    // hover/active, same as the old ♡) instead of a faint empty heart — saving
    // reads as a real, labelled action rather than a mystery glyph. Clicking it
    // favorites the command, which on the next render lifts it into ♥ Favorites
    // with a filled heart. Already-favorited rows keep the filled ♥ (click to
    // remove).
    const trailing = !faved
      ? `<button class="cmd-save" type="button" tabindex="-1" title="Save to your commands (favorites it)">${icon('plus', 12)}<span>Save</span></button>`
      : `<button class="cmd-fav on" type="button" tabindex="-1" title="Remove favorite" aria-label="favorite">♥</button>`

    const row = document.createElement('div')
    row.className = 'cmd-row'
    row.setAttribute('role', 'option')
    row.innerHTML =
      `<span class="cmd-row-icon">${icon(it.icon || 'terminal', 16)}</span>` +
      `<span class="cmd-row-text">${labelHtml}</span>` +
      badge +
      trailing

    const idx = rows.length
    row.addEventListener('mouseenter', () => setActive(idx))
    row.addEventListener('click', (e) => choose(it, { run: e.metaKey || e.ctrlKey }))
    const toggleBtn = row.querySelector('.cmd-save, .cmd-fav')
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation() // never let the button also "choose" the row
      toggleFavorite(it, favId)
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

  // Type the command onto the active prompt (no newline) and close. With run:true
  // (⌘↵ / ⌘-click) the newline is included, so it types AND executes. If there's
  // no active terminal to type into we just close — nothing to do.
  function choose(it, { run = false } = {}) {
    close()
    if (typeInto) typeInto(it.cmd, { run })
  }

  // Toggle a ♥. Favorites are pinned to the current project (main scopes them to
  // the open folder). The main process broadcasts commands:changed → refresh()
  // re-renders (in this and any other open window); we also reload here for
  // instant feedback.
  async function toggleFavorite(it, favId) {
    try {
      if (favId) {
        if (unfavorite) await unfavorite(favId)
      } else if (favorite) {
        // Save rows carry a generic display label ("Use what you typed") — never
        // persist that; the command itself is its own best name.
        await favorite(it.cmd, it.save ? it.cmd : it.label)
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
  function open() {
    const gen = ++openGen // claim this open; a later close()/open() invalidates it
    overlay.hidden = false
    search.value = ''
    render('') // paint cached content (incl. last-known suggestions) immediately
    search.focus()
    // List (fast) and suggestions (may wait on the model) load independently, each
    // repainting when it lands — so the palette is never blocked on the model. The gen
    // guard drops a repaint from a load that finished after we closed/reopened.
    const repaint = () => {
      if (gen === openGen && !overlay.hidden) render(search.value)
    }
    load().then(repaint)
    loadSuggestions().then(repaint)
  }
  function close() {
    openGen++ // invalidate any in-flight open() so it can't repaint after we close
    overlay.hidden = true
  }
  function toggle() {
    overlay.hidden ? open() : close()
  }
  // Re-fetch when favorites change elsewhere; only repaint if we're open. Suggestions
  // exclude your favorites, so a pin/unpin can shift them too — reload both.
  async function refresh() {
    if (overlay.hidden) return
    await Promise.all([load(), loadSuggestions()])
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
        toggleFavorite(r.item, r.favId) // ⌥↵ favorites instead of typing
      else choose(r.item, { run: e.metaKey || e.ctrlKey }) // ⌘↵ types AND runs
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      // Modal focus trap: the search input is the only real focus target (rows are
      // mouse/arrow-driven, the heart buttons are tabindex="-1"), so Tab/Shift+Tab
      // would walk focus OUT of the card to the workbench behind the backdrop. Keep
      // focus here instead.
      e.preventDefault()
    }
  })
  // Click on the dimmed backdrop (outside the card) closes.
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })

  return { open, close, toggle, refresh, isOpen: () => !overlay.hidden }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  )
}
