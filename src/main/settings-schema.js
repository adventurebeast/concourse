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
        description:
          'Beginner adds guidance (context line, command palette, friendlier prompts). Expert follows standard IDE conventions.',
        type: 'enum',
        default: 'beginner',
        options: [
          { value: 'beginner', label: 'Beginner' },
          { value: 'expert', label: 'Expert' }
        ]
      },
      {
        key: 'appearance.tabStatus',
        label: 'Tab Status Style',
        description:
          'How a terminal tab shows whether its agent is working. Pulse tints the whole tab in its colour and slowly breathes while busy; Dots keeps plain tabs with a small spinning status dot.',
        type: 'enum',
        default: 'pulse',
        options: [
          { value: 'pulse', label: 'Pulse (colour + breathe)' },
          { value: 'dots', label: 'Dots (classic)' }
        ]
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
        description: 'Ask for confirmation before closing a terminal. The dialog’s “Don’t ask me again” checkbox also turns this off.',
        type: 'boolean',
        default: true
      },
      {
        key: 'terminal.scrollback',
        label: 'Scrollback',
        description:
          'History lines kept for the active terminal. Background panes keep proportionally less to save memory.',
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
        description:
          'Pulse reads each pane and labels it (working / awaiting / done). Choosing Local offers a one-click setup that downloads a small on-device model and runs it for you. Auto-detect prefers a reachable local server, then an Anthropic key.',
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
        description:
          'When using a local provider, start the on-device model in the background automatically (your Ollama if installed, otherwise the app’s built-in runtime) — no setup, no localhost URL. Falls back to deterministic Pulse if no local runtime is available.',
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
        description: 'Key for the Claude provider. Stored locally and used only in the main process — never sent back to the UI.',
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
