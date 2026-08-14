import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  safeAgentResumeCommand,
  stripLegacyTerminalContext
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
      /lineBuf|heurTitle|captureCommand|tabLabel|cardLabel|textContent|lastInputAt|charCodeAt|startsWith/
    )
    expect(source).not.toMatch(/onTitleChange|api\.pulse\.summarize|api\.term\.onCommand/)
  })

  it('uses immutable ordinal labels and exposes no terminal rename path', () => {
    const source = readFileSync(new URL('../src/renderer/terminals.js', import.meta.url), 'utf8')

    expect(source).toContain('const displayName = `Terminal ${counter}`')
    expect(source).not.toMatch(
      /customLabel|renameStart|Rename…|safeAgentLabel|automaticTerminalLabel|persistedCustomLabel|applyTitle/
    )
    expect(source.match(/tabLabel\.textContent\s*=/g)).toHaveLength(1)
    expect(source.match(/cellLabel\.textContent\s*=/g)).toHaveLength(1)
    expect(source.match(/cardLabel\.textContent\s*=/g)).toHaveLength(1)
  })

  it('does not mount the removed beginner controls around terminal panes', () => {
    const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8')
    const terminals = readFileSync(new URL('../src/renderer/terminals.js', import.meta.url), 'utf8')

    expect(html).not.toMatch(/cmd-strip/)
    expect(main).not.toMatch(/mountStrip/)
    expect(terminals).not.toMatch(/mountPaneLauncher/)
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
