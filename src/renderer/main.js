import './style.css'
import { createEditor } from './editor.js'
import { createFileTree } from './fileTree.js'
import { createGit } from './git.js'
import { createSearch } from './search.js'
import { createTerminals } from './terminals.js'
import { createWelcome } from './welcome.js'
import { createKeybindings } from './keybindings.js'
import { createCommandPalette } from './commandPalette.js'
import { createStatusBar } from './statusbar.js'
import { icon } from './icons.js'
import { showToastOnce } from './toast.js'

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
  // Expert mode: suppress the terminal tab/cell auto-title pop-over. The label is
  // already visible on the tab/header and the summary can lag the live pane, so the
  // hover card is just noise that covers the terminal. We still migrated the native
  // title away above, so nothing shows at all. Functional tooltips (close buttons,
  // toolbar, status bar) are unaffected since they aren't the tab/cell themselves.
  if (document.documentElement.dataset.mode === 'expert' && el.matches('.term-tab, .term-cell')) return
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

// Bottom status bar: git counts + branch (left), live fleet pulse + clock (right).
// Clicking the git portion opens Source Control.
const statusbar = createStatusBar({
  onOpenScm: () => document.querySelector('.activity-btn[data-view="scm"]')?.click()
})

const git = createGit({
  // Open a git diff as a read-only tab in the editor.
  onOpenDiff: (opts) => editor.openDiff(opts),
  // Keep the explorer's per-file git indicators and the status-bar change counts
  // in sync with repo state on every refresh.
  onStatus: (status) => {
    fileTree.applyGitStatus(status)
    statusbar.setGit(status)
  }
})

const fileTree = createFileTree({
  onOpenFile: (path) => editor.openFile(path)
})

// Live tree: re-read on out-of-app changes (an agent, terminal, or external editor
// touching files). refresh() preserves expansion + selection; git.refresh() re-reads
// status so the explorer's per-file M/A/U/D badges — plus the status bar and beginner
// HUD — track the change in real time, not just on save or when SCM is opened.
api.fs.onChanged(() => {
  fileTree.refresh()
  git.refresh()
})

// Watcher health: if the recursive fs watcher degrades (an OS file-handle limit, a
// transient error), live updates can stall. Tell the user once and offer a manual
// Refresh; recovery to 'watching' is silent. (Was exposed in preload but unconsumed.)
api.fs.onWatchStatus?.((status) => {
  if (status === 'degraded') {
    showToastOnce(
      'File changes may not update automatically. Use Refresh if the tree looks stale.',
      {
        kind: 'warn',
        action: {
          label: 'Refresh',
          onClick: () => {
            fileTree.refresh()
            git.refresh()
          }
        }
      }
    )
  }
})

const search = createSearch({
  getRoot: () => currentRoot,
  // Open the file and jump to the matched line/column.
  onOpenFile: (path, opts) => editor.openFile(path, opts)
})

const terminals = createTerminals({
  getRoot: () => currentRoot,
  // Aggregate pane pulse states into the right side of the status bar.
  onFleet: (fleet) => statusbar.setFleet(fleet),
  // Pulse working→awaiting edge: an agent just came to rest needing you. The pane's own
  // come-look pulse always fires (in terminals.js); when this window is in the
  // BACKGROUND we ALSO post an OS notification, so you get pulled back without having to
  // babysit the bar — the whole point of Pulse (see docs/pulse-engine.md).
  onAwait: (info) => notifyAwait(info),
  // A pane left the awaiting state (resumed working, went idle, or was closed) before
  // you came back: its notification / title flag is now stale, so drop just that one.
  onAwaitClear: (id) => clearAwait(id)
})

// ---------- Pulse awaiting notifications ----------
// Surface the working→awaiting edge OUTSIDE the window — but only when the window is
// unfocused (you've switched away). In-window, the tab/dot come-look pulse already
// carries it and a notification would just nag. Clicking the notification brings the
// window forward and reveals the exact pane. Everything degrades silently: if OS
// notifications are unsupported or denied, the title-bar flag below still flips.
const BASE_DOC_TITLE = document.title
// ONE notification per awaiting pane, keyed by pane id, so several agents finishing
// close together don't clobber each other — the common fleet case Pulse exists for.
// (The old single shared handle force-closed the previous pane's unread note and the
// title showed only the most-recent agent.) The title flag mirrors the whole set: the
// agent's name when one pane awaits, a count when several do.
const awaitNotifs = new Map() // pane id -> Notification
const awaitNames = new Map() // pane id -> agent name (drives the title flag)
// Master alert switch (Settings → Notifications). When off, no OS notification and no
// title/dock flag fire — the only out-of-window alert surfaces — so the app stays
// silent. The in-pane come-look pulse is a quiet visual cue, not an alert, and stays.
let notificationsEnabled = true
function refreshAwaitTitle() {
  if (awaitNames.size === 0) {
    if (document.title !== BASE_DOC_TITLE) document.title = BASE_DOC_TITLE
  } else if (awaitNames.size === 1) {
    document.title = `🔔 ${[...awaitNames.values()][0] || 'Agent'} — awaiting you`
  } else {
    document.title = `🔔 ${awaitNames.size} agents awaiting you`
  }
}
function notifyAwait(info) {
  if (!notificationsEnabled) return // master switch off — stay silent (Settings → Notifications)
  if (document.hasFocus()) return // you're here — the in-pane come-look is enough
  const id = info.id || 'anon'
  const name = info.name || 'Agent'
  // Always-available fallback surface (works even if notifications are blocked): flag
  // the window/dock title until you return. Cleared on focus / when the pane settles.
  awaitNames.set(id, name)
  refreshAwaitTitle()
  try {
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return
    const show = () => {
      awaitNotifs.get(id)?.close?.() // replace only THIS pane's prior note, never another's
      const n = new Notification(`${name} · awaiting you`, {
        body: info.summary || 'It finished its turn and is waiting for you.'
      })
      n.onclick = () => {
        api.window?.focusSelf?.()
        if (info.id) terminals.revealPane(info.id)
        window.focus()
      }
      awaitNotifs.set(id, n)
    }
    if (Notification.permission === 'granted') show()
    else Notification.requestPermission().then((p) => p === 'granted' && show()).catch(() => {})
  } catch {
    /* notifications unsupported — the come-look pulse + title flag still carry it */
  }
}
// One pane stopped awaiting (resumed working / went idle / closed) before you returned —
// drop just its note + title entry, leaving any other awaiting panes' notifications intact.
function clearAwait(id) {
  if (id == null) return
  awaitNotifs.get(id)?.close?.()
  awaitNotifs.delete(id)
  awaitNames.delete(id)
  refreshAwaitTitle()
}
// Returning to the window clears every awaiting flag/note at once.
function clearAllAwait() {
  for (const n of awaitNotifs.values()) n?.close?.()
  awaitNotifs.clear()
  awaitNames.clear()
  if (document.title !== BASE_DOC_TITLE) document.title = BASE_DOC_TITLE
}
window.addEventListener('focus', clearAllAwait)
// Some returns surface as a visibility change without a focus event — cover both, but
// only when we genuinely have focus so a background tab-reveal doesn't clear prematurely.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.hasFocus()) clearAllAwait()
})

// Command palette (⌘K): TYPES a command onto the active prompt (the user presses
// Enter). Surfaces ♥ favorites + this project's commands + frecency-ranked shell
// history, all from the main process; the curated beginner cheatsheet shows below
// in beginner mode. Trigger button lives in the terminal tab bar (beginner only).
const palette = createCommandPalette({
  typeInto: (cmd) => terminals.typeIntoActive(cmd),
  // The palette's three dynamic sources (♥ favorites · project commands · frecency
  // history) and the ♥ toggle, all backed by the main process (api.commands).
  listCommands: () => api.commands.list(),
  favorite: (cmd, label, opts) => api.commands.favorite(cmd, label, opts),
  unfavorite: (id) => api.commands.unfavorite(id)
})
document.getElementById('cmd-trigger')?.addEventListener('click', () => palette.toggle())
palette.mountStrip(document.getElementById('cmd-strip'))
// Favorites can change in another window (or via the heart here) — re-render live.
api.commands.onChanged(() => palette.refresh())

// Saving a file should refresh git status.
editor.onSave(() => git.refresh())

// ---------- Global keyboard shortcuts ----------
const keys = createKeybindings()
// Cmd/Ctrl+R is also vetoed in the main process (menu accelerators fire first),
// but keep a renderer veto too so the keystroke never leaks into a terminal.
keys.register('mod+r', () => {})
// Cmd/Ctrl+T opens a fresh terminal tab. In beginner mode this offers the agent
// launcher menu (Claude / Codex / plain shell); in expert it spawns a bare shell.
keys.register('mod+t', () => terminals.newTab())
// Shift+Cmd/Ctrl+Left / Right cycle the active terminal tab. A modifier is
// required so plain arrow keys still reach the shell inside a terminal.
keys.register('mod+shift+left', () => terminals.stepActive(-1))
keys.register('mod+shift+right', () => terminals.stepActive(1))
// Cmd/Ctrl+; / ' MOVE the active tab itself left/right to organise the rail
// (vs. mod+shift+arrow / mod+[ ] above, which move the selection). The two keys
// sit adjacent on the home row, with ; (left) nudging the tab back and ' (right)
// nudging it forward, so it reads spatially like drag-left / drag-right.
keys.register('mod+;', () => terminals.moveActive(-1))
keys.register("mod+'", () => terminals.moveActive(1))
// Cmd/Ctrl+[ / ] are a second alias for the same cycle, matching the
// back/forward muscle memory the bracket keys carry across macOS ([ = back,
// ] = forward). They defer to Monaco when an editor is focused so it keeps its
// native outdent/indent (Cmd+[ / Cmd+]); everywhere else (terminals, panes)
// they switch tabs. The .monaco-host guard is deliberately narrow: xterm holds
// focus in its own helper <textarea>, so a generic input/textarea check would
// wrongly disable switching while you're inside a terminal.
// Broadened past .monaco-host so a focused Monaco overflow widget (the find or suggest
// box, which can render in a container appended outside the mount) still counts as
// "in the editor" — there Cmd+[ / Cmd+] keep their native outdent/indent.
const inEditor = () =>
  !!document.activeElement?.closest('.monaco-host, .monaco-editor, .editor-widget')
keys.register('mod+[', () => {
  if (inEditor()) return false
  terminals.stepActive(-1)
})
keys.register('mod+]', () => {
  if (inEditor()) return false
  terminals.stepActive(1)
})
// Cmd/Ctrl+1..9 jump straight to the Nth terminal tab.
for (let n = 1; n <= 9; n++) {
  keys.register(`mod+${n}`, () => terminals.activateIndex(n - 1))
}
// Cmd/Ctrl+W closes the active terminal (routes through the confirm dialog).
keys.register('mod+w', () => terminals.closeActive())
keys.register('mod+k', () => palette.toggle())
// Layout modes: a single cycler plus direct keys. The layout row is U-I-O-P:
// tabs / grid / stack / flow; Cmd+Shift+L cycles through them in that order. The
// menu's "Open Folder…" moved to Cmd+Shift+O so plain Cmd+O stays free for the
// stack layout here (menu accelerators fire before the renderer). Master-deck sits
// off the row on Cmd+J (its rail is the horizontal twin of stack's vertical one).
keys.register('mod+shift+l', () => terminals.cycleLayout(1))
keys.register('mod+u', () => terminals.setLayout('tabs'))
keys.register('mod+i', () => terminals.setLayout('grid'))
keys.register('mod+o', () => terminals.setLayout('stack'))
keys.register('mod+j', () => terminals.setLayout('deck'))
keys.register('mod+p', () => terminals.setLayout('flow'))
// Workbench toggles (VS Code conventions). These drive the existing toolbar
// buttons so the .active states and resizers stay in sync. Panel toggle moved to
// Cmd+Shift+J — plain Cmd+J now switches to the master-deck layout (above).
keys.register('mod+b', () => document.getElementById('toggle-sidebar').click())
keys.register('mod+shift+j', () => document.getElementById('toggle-panel').click())
// Cmd/Ctrl+Shift+F jumps to the search view. (Cmd+S save and Cmd+F find are
// handled by the editor / Monaco directly when an editor is focused.)
keys.register('mod+shift+f', () => document.querySelector('.activity-btn[data-view="search"]').click())

// ---------- Activity bar (view switching) ----------
const panels = {
  explorer: document.getElementById('explorer-panel'),
  search: document.getElementById('search-panel'),
  scm: document.getElementById('scm-panel')
}
document.querySelectorAll('.activity-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view
    document.querySelectorAll('.activity-btn').forEach((b) => b.classList.toggle('active', b === btn))
    for (const [name, el] of Object.entries(panels)) el.hidden = name !== view
    if (view === 'scm') git.refresh()
    if (view === 'search') search.focus()
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

// Minimize button in the editor tab bar: drops the editor out of view so the
// terminals fill the workbench, without closing any open tabs. Opening or
// clicking a file from the tree brings the editor straight back (see
// editor.onTabsChange below).
document.getElementById('editor-minimize').addEventListener('click', () => setTerminalsOnly(true))

// Clicking an open document tab while minimized expands the editor back out.
// onTabsChange only fires when the tab COUNT changes, so a plain tab click (no
// open/close) wouldn't otherwise restore the editor. The minimize button isn't
// an .etab so it's naturally excluded; skip the close affordance so closing a
// tab doesn't expand the editor. setTerminalsOnly is a no-op when not minimized.
document.getElementById('editor-tabs').addEventListener('click', (e) => {
  if (!e.target.closest('.etab') || e.target.closest('.etab-close')) return
  setTerminalsOnly(false)
})

// Document viewer follows the open documents: showing the editor when a document
// is open, and reverting to terminals-only mode once every document is closed.
// Suppressed during restoreSession: each restored file fires onTabsChange (0→1, 1→2…),
// which would force the editor visible mid-restore and fight the saved terminalsOnly
// preference applied at the very end. The explicit call there is authoritative.
let restoringSession = false
editor.onTabsChange((count) => {
  if (!restoringSession) setTerminalsOnly(count === 0)
})

// ---------- Theme (light default, dark optional, persisted) ----------
const THEME_KEY = 'concourse-theme'
let theme = localStorage.getItem(THEME_KEY) || 'light'
function applyTheme(mode, { persist = true } = {}) {
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
  // Mirror into the central settings store so the Settings window and any other
  // window reflect the change. Skipped on the boot application (persist:false) — there
  // localStorage is authoritative, so writing it back would only fire a redundant
  // cross-window settings:changed broadcast (and let the last-booted window's value win
  // over the store). The store only broadcasts on a real change and applyTheme is a
  // no-op when the value already matches, so a user-driven change can't loop.
  if (persist) Promise.resolve(api.settings?.set?.('appearance.theme', theme)).catch(() => {})
}
document.getElementById('toggle-theme').addEventListener('click', () => {
  applyTheme(theme === 'dark' ? 'light' : 'dark')
})
applyTheme(theme, { persist: false })

// ---------- Experience mode (beginner default, expert optional, persisted) ----------
// Two "lanes": beginner is calmer and more guided for people new to IDEs; expert
// follows standard IDE conventions. Foundation only for now — the flag lives on
// <html data-mode> (like data-theme) so CSS and feature code can branch off it.
// The one behavioral hook today: beginner terminals get a friendlier prompt.
const MODE_KEY = 'concourse-mode'
let mode = localStorage.getItem(MODE_KEY) || 'beginner'
function applyMode(next, { persist = true } = {}) {
  mode = next === 'expert' ? 'expert' : 'beginner'
  document.documentElement.dataset.mode = mode
  const btn = document.getElementById('toggle-mode')
  // Show the CURRENT mode as a labelled, colour-coded pill: a wand (guided "magic")
  // for beginner, a terminal glyph (raw shell) for expert. Clicking switches.
  const beginner = mode !== 'expert'
  btn.innerHTML =
    icon(beginner ? 'wand' : 'terminal', 14) +
    `<span class="mode-toggle-label">${beginner ? 'Beginner' : 'Expert'}</span>`
  btn.classList.toggle('beginner', beginner)
  btn.classList.toggle('expert', !beginner)
  const tip = beginner ? 'Switch to Expert Mode' : 'Switch to Beginner Mode'
  btn.setAttribute('title', tip)
  btn.dataset.tip = tip
  localStorage.setItem(MODE_KEY, mode)
  // Mirror into the central settings store (see applyTheme above for why this is
  // loop-safe and why the boot call skips the write).
  if (persist) Promise.resolve(api.settings?.set?.('appearance.mode', mode)).catch(() => {})
}
document.getElementById('toggle-mode').addEventListener('click', () => {
  applyMode(mode === 'expert' ? 'beginner' : 'expert')
})
applyMode(mode, { persist: false })

// ---------- Tab status style (pulse default, dots optional, persisted) ----------
// How a terminal tab signals "working": the default 'pulse' tints the whole tab and
// breathes it; 'dots' keeps the classic small status dot. Lives on <html
// data-tab-status> so the switch is pure CSS (terminals.css / style.css branch off it).
// Mirrors theme/mode: localStorage is boot-authoritative (no flash) and the value is
// echoed into the central store so the Settings window stays in sync.
const TAB_STATUS_KEY = 'concourse-tab-status'
let tabStatus = localStorage.getItem(TAB_STATUS_KEY) || 'pulse'
function applyTabStatus(next, { persist = true } = {}) {
  tabStatus = next === 'dots' ? 'dots' : 'pulse'
  document.documentElement.dataset.tabStatus = tabStatus
  localStorage.setItem(TAB_STATUS_KEY, tabStatus)
  // Boot call skips the write (localStorage is authoritative); see applyTheme above.
  if (persist) Promise.resolve(api.settings?.set?.('appearance.tabStatus', tabStatus)).catch(() => {})
}
applyTabStatus(tabStatus, { persist: false })

// ---------- Terminal header palette (identity colours, persisted) ----------
// Which palette the terminal identity headers use (appearance.headerTheme) and the
// raw input for the 'custom' palette (appearance.customHeaderColors). Changed only
// from the Settings window, but cached in localStorage so the FIRST paint at boot
// already uses the saved palette (no flash): the boot reconcile below deliberately
// skips appearance settings, so without this cache a saved palette wouldn't apply
// until the first settings broadcast. The light/dark VARIANT is handled inside
// terminals.setTheme, which recolours every pane on a theme toggle.
const HEADER_THEME_KEY = 'concourse-header-theme'
const HEADER_CUSTOM_KEY = 'concourse-header-custom'
let headerTheme = localStorage.getItem(HEADER_THEME_KEY) || 'default'
let headerCustom = localStorage.getItem(HEADER_CUSTOM_KEY) || ''
function applyHeaderTheme(next, customRaw) {
  if (typeof next === 'string' && next) headerTheme = next
  if (typeof customRaw === 'string') headerCustom = customRaw
  terminals.setHeaderTheme(headerTheme, headerCustom)
  localStorage.setItem(HEADER_THEME_KEY, headerTheme)
  localStorage.setItem(HEADER_CUSTOM_KEY, headerCustom)
}
applyHeaderTheme(headerTheme, headerCustom)

// ---------- Central settings (Settings window) ----------
// The Settings window writes to a main-process store; every window then receives a
// settings:changed broadcast. Editor/terminal preferences are applied live here;
// theme/mode are mirrored INTO the store by applyTheme/applyMode above (so the panel
// always shows the current state) and applied live when changed from the panel or
// another window.
function applyNotificationSettings(v) {
  if (!v || typeof v['notifications.enabled'] !== 'boolean') return
  notificationsEnabled = v['notifications.enabled']
  // Flipping the master switch off mid-flight should also drop any standing alert/flag
  // so the silence is immediate, not "from the next agent onward".
  if (!notificationsEnabled) clearAllAwait()
}
function applyEditorTerminalSettings(v) {
  if (!v) return
  editor.applySettings({
    fontSize: v['editor.fontSize'],
    fontFamily: v['editor.fontFamily'],
    minimap: v['editor.minimap'],
    smoothScrolling: v['editor.smoothScrolling'],
    scrollBeyondLastLine: v['editor.scrollBeyondLastLine']
  })
  terminals.applySettings({
    fontSize: v['terminal.fontSize'],
    fontFamily: v['terminal.fontFamily'],
    cursorBlink: v['terminal.cursorBlink'],
    scrollback: v['terminal.scrollback'],
    confirmClose: v['terminal.confirmClose'],
    railVisibleTiles: v['appearance.railVisibleTiles']
  })
}
function applyAppearanceSettings(v, { skipTheme = false } = {}) {
  if (!v) return
  if (!skipTheme && v['appearance.theme'] && v['appearance.theme'] !== theme) applyTheme(v['appearance.theme'])
  if (v['appearance.mode'] && v['appearance.mode'] !== mode) applyMode(v['appearance.mode'])
  if (v['appearance.tabStatus'] && v['appearance.tabStatus'] !== tabStatus)
    applyTabStatus(v['appearance.tabStatus'])
  // Default terminal layout is a "next time you open a workspace" preference, not a
  // live switch — cache it so terminals.js reads it (flash-free) at the next boot /
  // workspace open. The current workspace keeps its layout; the layout buttons remain
  // the live, per-workspace control.
  if (v['appearance.defaultLayout'])
    localStorage.setItem('concourse-default-layout', v['appearance.defaultLayout'])
  const ht = v['appearance.headerTheme']
  const hc = v['appearance.customHeaderColors']
  if ((ht && ht !== headerTheme) || (typeof hc === 'string' && hc !== headerCustom))
    applyHeaderTheme(ht || headerTheme, typeof hc === 'string' ? hc : headerCustom)
}
// Initial load: localStorage drove the FIRST paint (authoritative, no flash), but
// it's only a per-window cache — the central store is the real cross-window source
// of truth. So once getAll resolves, reconcile every appearance pref from the store
// (mode, tabStatus, header palette…) so a choice made in the Settings window or
// another window actually defaults THIS window. Theme is skipped to avoid a jarring
// full-background flash; localStorage stays authoritative for it (and is kept in
// sync by the live onChanged mirror below).
Promise.resolve(api.settings?.getAll?.())
  .then((snap) => {
    applyEditorTerminalSettings(snap?.values)
    applyAppearanceSettings(snap?.values, { skipTheme: true })
    applyNotificationSettings(snap?.values)
  })
  .catch(() => {})
// Live changes (Settings panel or another window) apply everything.
api.settings?.onChanged?.((payload) => {
  applyEditorTerminalSettings(payload?.values)
  applyAppearanceSettings(payload?.values)
  applyNotificationSettings(payload?.values)
})
// Titlebar gear opens (or focuses) the Settings window; the Settings… menu item
// (⌘,) routes through the same main-process handler.
document.getElementById('open-settings')?.addEventListener('click', () => api.window?.openSettings?.())

// ---------- Open folder ----------
async function setWorkspace(root) {
  if (!root) return
  if (currentRoot && root !== currentRoot) await saveSession() // persist the outgoing workspace
  currentRoot = root
  welcome.hide()
  setTitle(root)
  terminals.cdInto(root) // cd fresh shells (e.g. Shell 1) into the opened folder
  await fileTree.load(root)
  git.refresh()
  lastSavedJSON = null // new root — don't suppress its first save
}
document.getElementById('open-folder').addEventListener('click', async () => {
  const root = await api.workspace.open()
  await setWorkspace(root)
})

// Open another, independent app window (also on File ▸ New Window / ⇧⌘N).
document.getElementById('new-window')?.addEventListener('click', () => api.window?.open())

// Application-menu commands run the SAME action as the matching toolbar button,
// so the menu and the in-app buttons stay in lockstep (see src/main/menu.js).
api.menu?.onCommand?.((command) => {
  if (command === 'open-folder') document.getElementById('open-folder')?.click()
  else if (command === 'new-file') document.getElementById('ft-new-file')?.click()
  else if (command === 'new-folder') document.getElementById('ft-new-folder')?.click()
})

// Launch / start screen: opens a folder via the dialog or a recent project.
const welcome = createWelcome({
  onOpenDialog: async () => {
    const root = await api.workspace.open()
    await setWorkspace(root)
  },
  onOpenPath: async (dir) => {
    const root = await api.workspace.openPath(dir)
    if (root) await setWorkspace(root)
    else welcome.show() // path was stale and got pruned — re-render recents
  },
  // Dismiss the launch screen without a workspace — land in an empty window and
  // drive agents from the terminal.
  onEmptyWindow: () => welcome.hide()
})

// ---------- Session save / restore (Tier A: layout + tabs, fresh shells) ----------
const $ = (id) => document.getElementById(id)

// Current session-blob schema version. Bumped when the blob shape changes; old
// blobs are upgraded by migrateSession() on restore.
const SESSION_VERSION = 1

// Snapshot the restorable workbench state for the current workspace.
function gatherSession() {
  const activeBtn = document.querySelector('.activity-btn.active')
  return {
    version: SESSION_VERSION,
    editor: editor.listOpenFiles(),
    terminals: terminals.getState(),
    ui: {
      view: activeBtn ? activeBtn.dataset.view : 'explorer',
      sidebarHidden: $('sidebar').classList.contains('hidden'),
      panelHidden: $('terminal-region').classList.contains('hidden'),
      terminalsOnly: $('main').classList.contains('terminals-only'),
      sidebarWidth: $('sidebar').offsetWidth,
      editorHeight: $('editor-region').offsetHeight
    }
  }
}

// Persist only when something changed (cheap dirty check), and never with no folder.
let lastSavedJSON = null
async function saveSession() {
  if (!currentRoot) return
  const json = JSON.stringify(gatherSession())
  if (json === lastSavedJSON) return
  lastSavedJSON = json
  try {
    await api.session.save(currentRoot, JSON.parse(json))
  } catch {
    // best-effort
  }
}
// A periodic dirty-check catches every kind of change (layout, resize, tabs,
// view) without hooking each event. Paused while the window is hidden — there's
// nothing the user can change off-screen — and resumed (with an immediate save to
// catch anything that slipped through) when it becomes visible again. NOTE: this
// only gates the SAVE timer; the Pulse tick lives in terminals.js and keeps
// running while hidden by design.
let saveTimer = setInterval(saveSession, 4000)
// Mirror the hidden state onto <html> so CSS can pause purely-decorative, always-on
// animations (the working-label shimmer) while the window is off-screen — a hidden window
// has no reason to keep re-rastering. Foreground behaviour is identical; this only stops
// frames nobody can see. Set once now in case we launch hidden, then kept in sync below.
document.documentElement.classList.toggle('win-hidden', document.hidden)
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('win-hidden', document.hidden)
  if (document.hidden) {
    clearInterval(saveTimer)
    saveTimer = null
  } else if (!saveTimer) {
    saveSession()
    saveTimer = setInterval(saveSession, 4000)
  }
})
// Final save on unload. The async save can't be relied on to complete during
// unload, so push the blob over the synchronous channel; the main process stages
// it and the before-quit flush drains it (see ipc-session.js + index.js).
window.addEventListener('beforeunload', (e) => {
  if (currentRoot) api.session.saveSync(currentRoot, gatherSession())
  // The session blob persists only path/line, never in-memory edits — so a quit/reload
  // with a dirty editor tab would silently drop the changes. Trigger the native
  // "unsaved changes" confirmation so the user can cancel and save first.
  if (editor.hasUnsavedTabs()) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// Upgrade an older session blob to the current schema. A versionless blob is
// treated as v0; the v0->v1 step is a no-op seam (the shape is unchanged) so old
// and v1 blobs restore identically — but future shape changes hang off here.
function migrateSession(blob) {
  if (!blob || typeof blob !== 'object') return blob
  const version = blob.version || 0
  if (version < 1) {
    // v0 -> v1: no shape change yet; just stamp the version.
    blob = { ...blob, version: 1 }
  }
  return blob
}

// Rebuild the workbench from a saved blob. Terminals come back as fresh shells.
async function restoreSession(blob) {
  blob = migrateSession(blob)
  const ts = blob && blob.terminals
  if (!ts || !terminals.restore(ts)) terminals.create()

  // Each restored file fires onTabsChange; suppress the terminals-only reaction to those
  // (see the onTabsChange wiring above) so the saved preference applied at the end wins.
  restoringSession = true
  try {
    const files = (blob && blob.editor && blob.editor.files) || []
    let activePath = null
    for (const f of files) {
      if (!f || !f.path) continue
      await editor.openFile(f.path, { line: f.line || 1 })
      if (f.active) activePath = f.path
    }
    if (activePath) await editor.openFile(activePath) // re-focus the tab that was active

    const ui = (blob && blob.ui) || {}
    // Clamp restored sizes against the CURRENT window — a blob saved on a larger display
    // (or before the window shrank) could otherwise restore a sidebar/editor bigger than
    // the viewport, pushing the terminal region out of view. The drag handlers enforce
    // these floors live (170 / 60); a restored blob must respect them too.
    if (ui.sidebarWidth) {
      const maxW = Math.max(170, Math.floor(window.innerWidth * 0.6))
      $('sidebar').style.width = Math.min(Math.max(170, ui.sidebarWidth), maxW) + 'px'
    }
    if (ui.editorHeight) {
      const maxH = Math.max(60, $('main').offsetHeight - 100)
      $('editor-region').style.height = Math.min(Math.max(60, ui.editorHeight), maxH) + 'px'
    }
    if (ui.view && ui.view !== 'explorer') {
      document.querySelector(`.activity-btn[data-view="${ui.view}"]`)?.click()
    }
    if (ui.sidebarHidden) $('toggle-sidebar').click()
    if (ui.panelHidden) $('toggle-panel').click()
    // Opening files flips terminals-only off; honor the saved preference last.
    setTerminalsOnly(ui.terminalsOnly !== undefined ? ui.terminalsOnly : files.length === 0)
    terminals.fitAll()
  } finally {
    restoringSession = false
  }
}

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
// Terminals dominate the top; the document viewer is the resizable bottom panel.
dragH(document.getElementById('drag-y'), document.getElementById('editor-region'))

// ---------- Boot ----------
// A window opened via "New Window" carries ?fresh=1 and always starts blank (welcome
// screen) so you can pick a different folder. The launch / dock-activate window obeys
// the "On Startup" preference: 'welcome' (default) shows the start screen, while
// 'last-project' reopens the last session.
const isFreshWindow = new URLSearchParams(location.search).get('fresh') === '1'
;(async () => {
  // Resolve the startup preference from the central store (default: show the start
  // screen). Only 'last-project' triggers the auto-reopen path below.
  let startupPref = 'welcome'
  try {
    const snap = await api.settings?.getAll?.()
    startupPref = snap?.values?.['appearance.startup'] || 'welcome'
  } catch {
    startupPref = 'welcome'
  }
  // Auto-reopen the workspace from last session and restore its layout — skipped for
  // a fresh window (so it doesn't clone the last folder) and when the user prefers the
  // start screen on launch.
  const reopenLast = !isFreshWindow && startupPref === 'last-project'
  const lastRoot = reopenLast ? await api.session.lastRoot() : null
  if (lastRoot) {
    const root = await api.workspace.openPath(lastRoot)
    if (root) {
      currentRoot = root
      setTitle(root)
      await fileTree.load(root)
      git.refresh()
      let blob = null
      try {
        blob = await api.session.load(root)
      } catch {
        blob = null
      }
      await restoreSession(blob)
      return
    }
  }

  // No saved/last folder — greet with the start screen (recents + Open Folder).
  setTitle(null)
  await fileTree.load(null)
  git.refresh()
  terminals.create()
  setTerminalsOnly(true) // launch in terminals-only mode; opening a doc reveals the editor
  welcome.show()
})()
