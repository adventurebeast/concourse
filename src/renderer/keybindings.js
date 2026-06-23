// Central keyboard-shortcut registry for the app.
//
// One global keydown listener dispatches to registered bindings, so every hotkey
// lives in a single place rather than being scattered across modules. Combos are
// written as strings like "mod+t" or "mod+shift+p", where "mod" means Cmd on
// macOS and Ctrl elsewhere. Register with `keys.register(combo, handler)`.
//
// Notes:
//  - Bindings fire even when focus is inside a terminal (xterm), so app-level
//    shortcuts like new-tab keep working while you're typing in a shell. If a
//    binding should defer to text fields, guard inside its handler.
//  - The handler's return value decides whether the original keystroke is
//    swallowed: returning `false` lets the event through; anything else (incl.
//    undefined) calls preventDefault. This lets a binding act as a pure veto.

const isMac = navigator.platform.toLowerCase().includes('mac')

// Map verbose KeyboardEvent.key names onto the short aliases used in combos.
const KEY_ALIASES = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  escape: 'esc',
  ' ': 'space'
}
const aliasKey = (k) => KEY_ALIASES[k] || k

// Normalise a KeyboardEvent into a canonical "mod+shift+key" string.
function comboFromEvent(e) {
  const parts = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  const key = (e.key || '').toLowerCase()
  // Skip bare modifier presses.
  if (['meta', 'control', 'alt', 'shift'].includes(key)) return null
  parts.push(aliasKey(key))
  return parts.join('+')
}

// Normalise a registered combo string the same way so they compare equal.
function normalize(combo) {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
  const mods = []
  if (parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl')) mods.push('mod')
  if (parts.includes('alt') || parts.includes('option')) mods.push('alt')
  if (parts.includes('shift')) mods.push('shift')
  const key = parts.filter((p) => !['mod', 'cmd', 'ctrl', 'alt', 'option', 'shift'].includes(p)).pop()
  return [...mods, aliasKey(key)].join('+')
}

export function createKeybindings() {
  const bindings = new Map()

  document.addEventListener(
    'keydown',
    (e) => {
      const combo = comboFromEvent(e)
      if (!combo) return
      const handler = bindings.get(combo)
      if (!handler) return
      // App-level chords fire even inside a terminal (xterm) and the code editor
      // (Monaco) — that's deliberate, so new-tab / tab-switch keep working while you
      // type in a shell or a file. But inside the app's OWN form fields (the search
      // box, the SCM commit message, a tab-rename input, the settings inputs) a chord
      // like ⌘W or ⌘1 would yank focus out mid-edit. Defer to the field there: let the
      // keystroke through untouched. xterm/Monaco hold focus in their own helper
      // <textarea>, so they're explicitly exempted from this guard.
      const ae = document.activeElement
      const editable =
        ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
      if (editable && !ae.closest('.xterm, .monaco-host, .monaco-editor')) return
      const result = handler(e)
      if (result !== false) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    // Capture phase so we win against xterm's own key handling.
    true
  )

  return {
    isMac,
    register(combo, handler) {
      bindings.set(normalize(combo), handler)
    },
    unregister(combo) {
      bindings.delete(normalize(combo))
    }
  }
}
