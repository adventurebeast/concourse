// Declarative settings registry — the single source of truth for every Concourse
// user preference. Both the main-process store (defaults + validation) and the
// Settings window UI are generated from this list, so surfacing a new preference
// is a one-line change here.
//
// Keep this file PURE (no imports, no electron/node): it is read by the main
// process AND shipped to the renderer over IPC, and the shape below is the wire
// contract for the Settings UI.
//
// Each setting:
//   key         dotted id, e.g. 'editor.fontSize' (also the persisted key)
//   label       short title shown in the UI
//   description one-line help text under the label
//   type        'boolean' | 'number' | 'enum' | 'text' | 'secret'
//   default     value used until the user changes it
//   options     [{ value, label }]  (enum only)
//   min/max/step/unit                (number only)
//   placeholder hint text            (text/secret only)
//
// 'secret' values are stored locally but never sent back to a renderer (the UI
// only learns whether one is set) and are read solely by the main process.

export const SETTINGS_GROUPS = [
  {
    id: 'appearance',
    label: 'Appearance',
    settings: [
      {
        key: 'appearance.theme',
        label: 'Color Theme',
        description: 'Light or dark theme for the whole workbench.',
        type: 'enum',
        default: 'light',
        options: [
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' }
        ]
      },
      {
        key: 'appearance.mode',
        label: 'Experience Mode',
        description: 'Beginner adds extra guidance; Expert follows standard IDE conventions.',
        type: 'enum',
        default: 'beginner',
        options: [
          { value: 'beginner', label: 'Beginner' },
          { value: 'expert', label: 'Expert' }
        ]
      },
      {
        key: 'appearance.defaultLayout',
        label: 'Default Layout',
        description: 'Which terminal layout a newly opened workspace starts in. Existing workspaces keep their last-used layout.',
        type: 'enum',
        default: 'tabs',
        options: [
          { value: 'tabs', label: 'Tabs (one terminal)' },
          { value: 'grid', label: 'Grid (all terminals)' },
          { value: 'stack', label: 'Master-stack (primary + rail)' },
          { value: 'flow', label: 'Album flow (centre + side previews)' }
        ]
      },
      {
        key: 'appearance.tabStatus',
        label: 'Tab Status Style',
        description: 'How a tab shows whether its agent is working.',
        type: 'enum',
        default: 'pulse',
        options: [
          { value: 'pulse', label: 'Pulse (colour + breathe)' },
          { value: 'dots', label: 'Dots (classic)' }
        ]
      },
      {
        key: 'appearance.headerTheme',
        label: 'Terminal Header Palette',
        description: 'Colour palette for terminal identity headers. "Custom…" uses the colours below.',
        type: 'enum',
        default: 'default',
        // Mirror of PALETTE_OPTIONS in src/renderer/term-palettes.js — this file
        // must stay import-free, so keep these ids/labels in sync by hand.
        options: [
          { value: 'default', label: 'Default' },
          { value: 'jewelbox', label: 'Jewel Box' },
          { value: 'deep-ocean', label: 'Deep Ocean' },
          { value: 'ember-dusk', label: 'Ember & Dusk' },
          { value: 'slate-nord', label: 'Slate Nord' },
          { value: 'custom', label: 'Custom…' }
        ]
      },
      {
        key: 'appearance.customHeaderColors',
        label: 'Custom Header Colours',
        description:
          'For the "Custom…" palette: paste hex colours (comma or space separated) or JSON {"light":[…],"dark":[…]}. Each must read with white text. Blank or invalid falls back to Default.',
        type: 'text',
        default: '',
        placeholder: '#4f9cff, #f0883e, #3fb950, …'
      }
    ]
  },
  {
    id: 'editor',
    label: 'Editor',
    settings: [
      {
        key: 'editor.fontSize',
        label: 'Font Size',
        description: 'Editor font size in pixels.',
        type: 'number',
        default: 13,
        min: 6,
        max: 40,
        step: 1,
        unit: 'px'
      },
      {
        key: 'editor.fontFamily',
        label: 'Font Family',
        description: 'Editor font family. Leave blank for the built-in default.',
        type: 'text',
        default: '',
        placeholder: 'e.g. "JetBrains Mono", Menlo, monospace'
      },
      {
        key: 'editor.minimap',
        label: 'Minimap',
        description: 'Show the code overview minimap on the right edge.',
        type: 'boolean',
        default: true
      },
      {
        key: 'editor.smoothScrolling',
        label: 'Smooth Scrolling',
        description: 'Animate editor scrolling.',
        type: 'boolean',
        default: true
      },
      {
        key: 'editor.scrollBeyondLastLine',
        label: 'Scroll Beyond Last Line',
        description: 'Allow scrolling past the final line of a file.',
        type: 'boolean',
        default: false
      }
    ]
  },
  {
    id: 'terminal',
    label: 'Terminal',
    settings: [
      {
        key: 'terminal.fontSize',
        label: 'Font Size',
        description: 'Terminal font size in pixels.',
        type: 'number',
        default: 12.5,
        min: 6,
        max: 40,
        step: 0.5,
        unit: 'px'
      },
      {
        key: 'terminal.fontFamily',
        label: 'Font Family',
        description: 'Terminal font family (monospace recommended).',
        type: 'text',
        default: 'Menlo, Monaco, "SF Mono", "Courier New", monospace',
        placeholder: 'Menlo, Monaco, monospace'
      },
      {
        key: 'terminal.cursorBlink',
        label: 'Cursor Blink',
        description: 'Blink the terminal cursor.',
        type: 'boolean',
        default: true
      },
      {
        key: 'terminal.confirmClose',
        label: 'Confirm Before Closing',
        description: 'Ask for confirmation before closing a terminal.',
        type: 'boolean',
        default: true
      },
      {
        key: 'terminal.scrollback',
        label: 'Scrollback',
        description: 'History lines kept for the active terminal.',
        type: 'number',
        default: 10000,
        min: 100,
        max: 100000,
        step: 100,
        unit: 'lines'
      }
    ]
  },
  {
    id: 'ai',
    label: 'AI · Pulse',
    settings: [
      {
        key: 'pulse.provider',
        label: 'Provider',
        description: 'Who labels each pane (working / awaiting / done). Auto-detect prefers a local server, then Claude.',
        type: 'enum',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Auto-detect' },
          { value: 'local', label: 'Local (OpenAI-compatible)' },
          { value: 'claude', label: 'Claude (Anthropic)' },
          { value: 'off', label: 'Off' }
        ]
      },
      {
        key: 'pulse.localAutostart',
        label: 'Auto-start Local Model',
        description: 'Start a local model in the background automatically (Ollama or the built-in runtime).',
        type: 'boolean',
        default: true
      },
      {
        key: 'pulse.model',
        label: 'Model',
        description: 'Override the model for the active provider. Blank uses the provider default.',
        type: 'text',
        default: '',
        placeholder: 'auto (claude-haiku-4-5 / qwen2.5:0.5b)'
      },
      {
        key: 'pulse.baseUrl',
        label: 'Local Base URL',
        description: 'OpenAI-compatible endpoint for the Local provider (Ollama, LM Studio, llama.cpp …).',
        type: 'text',
        default: '',
        placeholder: 'http://localhost:11434/v1'
      },
      {
        key: 'pulse.anthropicApiKey',
        label: 'Anthropic API Key',
        description: 'Key for the Claude provider. Stored locally, never sent to the UI.',
        type: 'secret',
        default: '',
        placeholder: 'sk-ant-…'
      },
      {
        key: 'pulse.localApiKey',
        label: 'Local API Key',
        description: 'Optional key sent to the Local provider (most local servers ignore it).',
        type: 'secret',
        default: '',
        placeholder: 'optional'
      }
    ]
  }
]

// Flat views derived from the grouped registry.
export const SETTINGS_LIST = SETTINGS_GROUPS.flatMap((g) => g.settings)
export const SETTINGS_BY_KEY = Object.fromEntries(SETTINGS_LIST.map((s) => [s.key, s]))
export const SECRET_KEYS = SETTINGS_LIST.filter((s) => s.type === 'secret').map((s) => s.key)

// A fresh defaults object (every key set to its schema default).
export function defaultSettings() {
  const out = {}
  for (const s of SETTINGS_LIST) out[s.key] = s.default
  return out
}
