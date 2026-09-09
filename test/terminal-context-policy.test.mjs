import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  safeAgentResumeCommand,
  terminalPresentation,
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

  it('supports explicit names without any terminal text/title capture', () => {
    const source = readFileSync(new URL('../src/renderer/terminals.js', import.meta.url), 'utf8')

    expect(source).toContain('const ordinalName = `Terminal ${counter}`')
    expect(source).toContain("tabLabel.addEventListener('dblclick'")
    expect(source).toContain('function renameStart(s, labelEl)')
    expect(source).not.toMatch(
      /safeAgentLabel|automaticTerminalLabel|persistedCustomLabel|applyTitle/
    )
  })

  it('builds automatic identity only from fixed keys and an ordinal', () => {
    expect(
      terminalPresentation({
        ordinal: 3,
        context: {
          process: 'claude',
          label: 'password=DO_NOT_DISPLAY',
          kind: 'secret',
          running: true
        },
        state: 'working'
      })
    ).toEqual({ name: 'Claude · 3', detail: 'Working' })
    expect(
      terminalPresentation({
        ordinal: 4,
        context: {
          process: 'password=DO_NOT_DISPLAY',
          label: 'password=DO_NOT_DISPLAY'
        }
      })
    ).toEqual({ name: 'Terminal 4', detail: 'Quiet' })
  })

  it('preserves an explicit task name while process identity and activity change', () => {
    const pane = { ordinal: 2, customLabel: 'Checkout tests' }
    expect(
      terminalPresentation({
        ...pane,
        context: { process: 'codex', running: true },
        state: 'awaiting'
      })
    ).toEqual({ name: 'Checkout tests', detail: 'Codex · Awaiting you' })
    expect(terminalPresentation({ ...pane, context: { process: 'bash' }, state: 'idle' })).toEqual({
      name: 'Checkout tests',
      detail: 'Bash · Shell ready'
    })
    expect(terminalPresentation({ ...pane, status: 'exited' })).toEqual({
      name: 'Checkout tests',
      detail: 'Exited'
    })
  })

  it('does not confuse a quiet foreground process with a ready shell', () => {
    expect(
      terminalPresentation({ ordinal: 1, context: { process: 'bash', running: true } }).detail
    ).toBe('Quiet')
    expect(
      terminalPresentation({ ordinal: 1, context: { process: 'vim', running: true } }).detail
    ).toBe('Quiet')
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
