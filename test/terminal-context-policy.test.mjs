import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  automaticTerminalLabel,
  persistedCustomLabel,
  safeAgentResumeCommand,
  stripLegacyTerminalContext,
  terminalCardSummary
} from '../src/renderer/terminal-context-policy.js'

describe('terminal context privacy policy', () => {
  it('keeps the xterm input handler disconnected from all title state', () => {
    const source = readFileSync(new URL('../src/renderer/terminals.js', import.meta.url), 'utf8')
    const start = source.indexOf('term.onData((data) => {')
    const end = source.indexOf('term.onResize(', start)
    const inputHandler = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(inputHandler).toContain('api.term.input(id, data)')
    expect(inputHandler).not.toMatch(
      /lineBuf|heurTitle|captureCommand|applyTitle|tabLabel|cardLabel/
    )
  })

  it('builds automatic headers only from program/output metadata', () => {
    const state = {
      baseName: 'Tab 1',
      summaryText: 'Running the test suite',
      typedInput: 'correct horse battery staple',
      lineBuf: 'correct horse battery staple',
      lastCommand: 'login --password correct-horse'
    }

    expect(automaticTerminalLabel(state)).toBe('Running the test suite')
    expect(terminalCardSummary(state, 'Tab 1')).toBe('Running the test suite')
  })

  it('persists only labels created by an explicit manual rename', () => {
    expect(persistedCustomLabel(false, 'correct horse battery staple')).toBeNull()
    expect(persistedCustomLabel(true, 'API server')).toBe('API server')
  })

  it('normalizes resumable agents without retaining arguments or secrets', () => {
    expect(safeAgentResumeCommand('claude --api-key correct-horse')).toBe('claude --continue')
    expect(safeAgentResumeCommand('codex --config token=secret')).toBe('codex --no-alt-screen')
    expect(safeAgentResumeCommand('deploy --password correct-horse')).toBeNull()
  })

  it('removes potentially captured context from legacy session tabs', () => {
    const migrated = stripLegacyTerminalContext({
      layout: 'tabs',
      tabs: [
        {
          label: 'correct horse battery staple',
          lastCommand: 'login --password correct-horse',
          cwd: '/workspace'
        }
      ]
    })

    expect(migrated).toEqual({ layout: 'tabs', tabs: [{ cwd: '/workspace' }] })
  })
})
