const SAFE_RESUME_COMMANDS = new Set([
  'claude --continue',
  'codex --no-alt-screen',
  'aider',
  'gemini',
  'amp',
  'goose',
  'opencode'
])

// Main-process allowlist for persisted terminal state. This is intentionally
// independent from renderer policy: future renderer changes cannot quietly add
// terminal text, generated summaries, or command arguments to a session file.
export function sanitizeSessionBlob(blob) {
  const tabs = blob?.terminals?.tabs
  if (!Array.isArray(tabs)) return blob || {}
  return {
    ...blob,
    terminals: {
      ...blob.terminals,
      tabs: tabs.map((tab) => {
        if (!tab || typeof tab !== 'object') return {}
        const safe = {}
        if (typeof tab.cwd === 'string' && tab.cwd) safe.cwd = tab.cwd
        if (SAFE_RESUME_COMMANDS.has(tab.resumeCommand)) safe.resumeCommand = tab.resumeCommand
        // This field is written only by the explicit rename UI. It is never derived
        // from PTY input/output, commands, OSC titles, or model-generated text.
        if (blob?.version >= 3 && typeof tab.customLabel === 'string') {
          const label = tab.customLabel
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, 80)
          if (label) safe.customLabel = label
        }
        return safe
      })
    }
  }
}
