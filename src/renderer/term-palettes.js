// Terminal identity-colour palettes. Each terminal gets one hue from the active
// palette, shown on its tab and pane header so you can track which pane is which
// at a glance — vital once you have a wall of them.
//
// PURE module (no imports): shared by terminals.js (which assigns --term-color)
// and main.js. The Settings dropdown's {value,label} list is mirrored BY HAND in
// src/main/settings-schema.js (appearance.headerTheme) because that file must stay
// import-free — keep the ids/labels here and there in sync.
//
// CONTRAST CONTRACT — load-bearing: a FOCUSED pane header fills the FULL identity
// hue and lays WHITE text over it (see .term-cell.active .cell-header in
// terminals.css), on BOTH light and dark app themes. So every hue in BOTH the
// light[] and dark[] arrays must be dark/saturated enough to hold white text
// (verified ≥ ~3.6:1 here). dark[] is NOT just a lighter light[] — the focused
// header is white-on-hue regardless of app theme, so dark-theme hues must stay
// deep too; they're tuned for the subtle 16% tint on the dark panel background.
// If you hand-edit these, keep that bar. The "custom" palette falls back to
// "default" when the user's input is empty or unparseable, so a bad paste can
// never blank out the headers.

// Default = the original eight identity hues, used for BOTH light and dark so
// existing terminals look exactly as they did before palettes existed.
const DEFAULT_COLORS = [
  '#4f9cff', '#f0883e', '#3fb950', '#db61a2',
  '#a371f7', '#e3b341', '#56d4dd', '#f85149'
]

// Built-in palettes. Each: 8 hues, index-aligned across light[]/dark[] (light[i]
// and dark[i] are the same logical hue tuned per background). Contrast-verified.
export const PALETTES = {
  default: {
    label: 'Default',
    light: DEFAULT_COLORS,
    dark: DEFAULT_COLORS
  },
  jewelbox: {
    label: 'Jewel Box', // deep, confident gemstone tones
    light: ['#b3261e', '#b35c00', '#7a6a00', '#1f7a3d', '#0f6e6e', '#1d5fb3', '#5b3fb3', '#a82a76'],
    dark: ['#d8443c', '#c2701a', '#8f7d12', '#2a9450', '#1f8f8f', '#3f78cf', '#7a5fd6', '#cf4f97']
  },
  'deep-ocean': {
    label: 'Deep Ocean', // cool teals/blues anchored by warm coral
    light: ['#0f6e8c', '#127a7a', '#1c7a52', '#3a6b1e', '#6b6a16', '#9a4a12', '#a83246', '#7a3a8c'],
    dark: ['#1f8aa8', '#199090', '#1f9466', '#4f8f24', '#8f8a1c', '#c25e14', '#d44a5e', '#9a52b0']
  },
  'ember-dusk': {
    label: 'Ember & Dusk', // warm fire fading into twilight, balanced by pine + steel
    light: ['#b32d1a', '#b35a14', '#9a7a0d', '#4d7a1f', '#1f7a6e', '#2a5fa8', '#6a3fb0', '#a82a6e'],
    dark: ['#d84a30', '#c26e1c', '#9a7a0d', '#5a9426', '#1f9485', '#3a6fc2', '#7a4fcc', '#cf4f82']
  },
  'slate-nord': {
    label: 'Slate Nord', // muted frost blues, sage, aurora violet — quiet but distinct
    light: ['#3b5a8c', '#2f6e7a', '#2e7a6a', '#4a7a3a', '#6e6a3a', '#a05a2a', '#9a3a4a', '#7a3f7e'],
    dark: ['#4f74b8', '#2f8a9a', '#2f9480', '#5a9442', '#8a8442', '#bf7034', '#c24f5e', '#9558b0']
  }
}

// Dropdown order for the Settings window. Mirror these ids/labels in
// src/main/settings-schema.js (appearance.headerTheme). "custom" is appended.
export const PALETTE_OPTIONS = [
  ...Object.entries(PALETTES).map(([value, p]) => ({ value, label: p.label })),
  { value: 'custom', label: 'Custom…' }
]

// #rgb or #rrggbb, with or without the leading '#'.
const HEX_RE = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
function normHex(tok) {
  if (typeof tok !== 'string') return null
  let h = tok.trim()
  if (!HEX_RE.test(h)) return null
  if (h[0] !== '#') h = '#' + h
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] // expand #rgb → #rrggbb
  return h.toLowerCase()
}

// Parse a user-supplied "Custom" palette. Accepts EITHER a delimited hex list
// (comma / space / newline separated — used for both light and dark, like
// Default) OR JSON: {"light":[…],"dark":[…]} for separate light/dark tuning, or a
// bare JSON array. Returns { light, dark } (each a non-empty array) or null when
// nothing usable was found, so the caller can fall back to Default.
export function parseCustomColors(raw) {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null

  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t)
      if (Array.isArray(j)) {
        const list = j.map(normHex).filter(Boolean)
        return list.length ? { light: list, dark: list } : null
      }
      if (j && typeof j === 'object') {
        const light = (Array.isArray(j.light) ? j.light : []).map(normHex).filter(Boolean)
        const dark = (Array.isArray(j.dark) ? j.dark : []).map(normHex).filter(Boolean)
        if (light.length || dark.length) {
          return { light: light.length ? light : dark, dark: dark.length ? dark : light }
        }
      }
      return null
    } catch {
      // not valid JSON — fall through to list parsing
    }
  }

  const list = t.split(/[\s,;]+/).map(normHex).filter(Boolean)
  return list.length ? { light: list, dark: list } : null
}

// The hue array for a palette id under the current app theme ('light' | 'dark').
// ALWAYS returns a non-empty array (falls back to Default) so callers never set
// --term-color to undefined — which would silently drop panes onto the accent.
export function colorsFor(themeId, appTheme, customRaw) {
  const dark = appTheme === 'dark'
  if (themeId === 'custom') {
    const c = parseCustomColors(customRaw)
    if (c) return dark ? c.dark : c.light
    // empty / unparseable → fall back to Default below
  }
  const p = PALETTES[themeId] || PALETTES.default
  return dark ? p.dark : p.light
}
