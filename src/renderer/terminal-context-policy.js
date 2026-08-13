// Security boundary for terminal header/session context.
//
// Terminal input is an undifferentiated byte stream: the same channel carries shell
// commands, passwords, REPL input, agent prompts, and pasted secrets. It must never be
// used as label material or persisted for later restoration. Keep the allowed sources
// small and explicit here so UI changes do not accidentally reintroduce input capture.

export function automaticTerminalLabel({ oscTitle, summaryText, baseName } = {}) {
  return oscTitle || summaryText || baseName || ''
}

export function terminalCardSummary({ summaryText } = {}, visibleName = '') {
  return summaryText && summaryText !== visibleName ? summaryText : ''
}

export function persistedCustomLabel(custom, renderedLabel) {
  if (!custom || typeof renderedLabel !== 'string') return null
  const label = renderedLabel.trim()
  return label || null
}

// Fleet resurrection needs only the identity of a supported agent, never the full
// command line. Normalize to commands we own so flags, prompts, tokens, and other
// user-supplied arguments cannot enter the session store or restoration UI.
export function safeAgentResumeCommand(command) {
  const value = typeof command === 'string' ? command.trim() : ''
  if (/^claude(?:\s|$)/.test(value)) return 'claude --continue'
  if (/^codex(?:\s|$)/.test(value)) return 'codex --no-alt-screen'
  if (/^aider(?:\s|$)/.test(value)) return 'aider'
  if (/^gemini(?:\s|$)/.test(value)) return 'gemini'
  if (/^amp(?:\s|$)/.test(value)) return 'amp'
  if (/^goose(?:\s|$)/.test(value)) return 'goose'
  return null
}

// v0-v2 stored the currently rendered automatic label and an arbitrary last shell
// command. Both may contain input captured before this boundary existed. They are
// intentionally discarded rather than guessed at; cwd/layout remain safe and useful.
export function stripLegacyTerminalContext(state) {
  if (!state || !Array.isArray(state.tabs)) return state
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (!tab || typeof tab !== 'object') return tab
      const safe = { ...tab }
      delete safe.label
      delete safe.lastCommand
      delete safe.customLabel
      delete safe.resumeCommand
      return safe
    })
  }
}
