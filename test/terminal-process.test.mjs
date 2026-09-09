import { describe, expect, it } from 'vitest'
import { classifyProcessName, processContext } from '../src/shared/terminal-process.js'
import {
  contextForTerminal,
  parseProcessSnapshot,
  processQuery
} from '../src/main/terminal-process.js'

describe('allowlisted terminal process identity', () => {
  it('maps executable names to fixed labels without retaining paths or arguments', () => {
    expect(processContext(classifyProcessName('/private/project/node'))).toEqual({
      process: 'node',
      kind: 'tool',
      label: 'Node.js',
      running: false
    })
    expect(classifyProcessName('python3.12')).toBe('python')
    expect(classifyProcessName('powershell.exe')).toBe('powershell')
    for (const name of [
      'claude --api-key CANARY_SECRET',
      'CANARY_SECRET',
      'claude\nCANARY_SECRET',
      'codex-worker',
      '__proto__'
    ]) {
      expect(classifyProcessName(name)).toBeNull()
      expect(processContext(name, true)).toEqual({
        process: null,
        kind: 'unknown',
        label: 'Terminal',
        running: true
      })
    }
  })

  it('queries only owned PTYs and name-only OS fields, with no Windows title fallback', () => {
    const entries = [
      { term: { ptsName: '/dev/ttys001' } },
      { term: { ptsName: '/dev/ttys001' } },
      { term: { ptsName: '-a' } },
      { term: { ptsName: '/dev/ttys002; command' } }
    ]
    expect(processQuery(entries, 'darwin')).toEqual({
      file: '/bin/ps',
      args: ['-t', '/dev/ttys001', '-o', 'pid=,ppid=,pgid=,tpgid=,tty=,ucomm=']
    })
    expect(processQuery([{ term: { ptsName: '/dev/pts/2' } }], 'linux')).toEqual({
      file: '/bin/ps',
      args: ['-t', '/dev/pts/2', '-o', 'pid=,ppid=,pgid=,tpgid=,tty=,comm=']
    })
    expect(processQuery(entries, 'win32')).toBeNull()
    expect(processQuery([{ term: {} }], 'darwin')).toBeNull()
  })

  it('discards raw process names at the collection boundary', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 CANARY_SECRET\n203 202 202 202 s001 claude --token CANARY_SECRET\n'
    )
    expect(rows).toEqual([
      { pid: 101, parent: 1, group: 101, foreground: 202, tty: 's001', process: 'zsh' },
      { pid: 202, parent: 101, group: 202, foreground: 202, tty: 's001', process: null },
      { pid: 203, parent: 202, group: 202, foreground: 202, tty: 's001', process: null }
    ])
    expect(JSON.stringify(contextForTerminal(rows, 101))).not.toContain('CANARY_SECRET')
  })

  it('recognizes native agents beneath interpreter wrappers and ignores background agents', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 node\n203 202 202 202 s001 codex\n204 203 202 202 s001 git\n300 101 300 202 s001 claude\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual({
      process: 'codex',
      kind: 'agent',
      label: 'Codex',
      running: true
    })
    const returned = parseProcessSnapshot('101 1 101 101 s001 zsh\n300 101 300 101 s001 claude\n')
    expect(contextForTerminal(returned, 101)).toEqual({
      process: 'zsh',
      kind: 'shell',
      label: 'Zsh',
      running: false
    })
  })

  it('keeps identity isolated between panes and handles inaccessible or exited processes honestly', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 claude\n401 1 401 401 s002 bash\n'
    )
    expect(contextForTerminal(rows, 401).process).toBe('bash')
    expect(contextForTerminal(rows, 101).process).toBe('claude')
    expect(contextForTerminal(rows, 999)).toEqual(processContext(null))
    expect(contextForTerminal(parseProcessSnapshot('101 1 101 -1 s001 zsh'), 101)).toEqual(
      processContext(null)
    )
    expect(contextForTerminal(parseProcessSnapshot('101 1 101 202 s001 zsh'), 101)).toEqual(
      processContext(null)
    )
  })

  it.each([
    ['codex', 'claude'],
    ['claude', 'codex']
  ])('keeps the foreground %s owner when it launches a %s helper', (owner, helper) => {
    const rows = parseProcessSnapshot(
      `101 1 101 202 s001 zsh\n203 202 202 202 s001 ${helper}\n202 101 202 202 s001 ${owner}\n`
    )
    expect(contextForTerminal(rows, 101)).toEqual(processContext(owner, true))
    expect(contextForTerminal([...rows].reverse(), 101)).toEqual(processContext(owner, true))
  })

  it('finds Codex beneath wrappers without promoting its nested Claude helper', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n206 205 202 202 s001 claude\n202 101 202 202 s001 npm\n204 202 202 202 s001 node\n205 204 202 202 s001 codex\n'
    )
    for (let offset = 0; offset < rows.length; offset++) {
      const shuffled = [...rows.slice(offset), ...rows.slice(0, offset)]
      expect(contextForTerminal(shuffled, 101)).toEqual(processContext('codex', true))
    }
  })

  it('does not guess a provider when a wrapper has separate agent branches', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 node\n203 202 202 202 s001 claude\n204 202 202 202 s001 sh\n205 204 202 202 s001 codex\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual(processContext(null, true))
    expect(contextForTerminal([...rows].reverse(), 101)).toEqual(processContext(null, true))
  })

  it('ignores unrelated and other-terminal agents instead of trusting their group alone', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 node\n203 202 202 202 s001 codex\n204 999 202 202 s001 claude\n205 202 202 202 s002 claude\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual(processContext('codex', true))
  })

  it('treats exec codex at the original shell PID as a running agent', () => {
    const rows = parseProcessSnapshot('101 1 101 101 s001 codex\n102 101 101 101 s001 claude\n')
    expect(contextForTerminal(rows, 101)).toEqual(processContext('codex', true))
  })

  it('falls back honestly if the foreground owner is missing', () => {
    const rows = parseProcessSnapshot('101 1 101 202 s001 zsh\n203 202 202 202 s001 claude\n')
    expect(contextForTerminal(rows, 101)).toEqual(processContext(null, true))
  })

  it('keeps a tool owner instead of choosing an unrelated recognized helper', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n203 202 202 202 s001 git\n202 101 202 202 s001 node\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual(processContext('node', true))
  })

  it('keeps a foreground tool name when it launches an agent plugin', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 vim\n203 202 202 202 s001 claude\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual(processContext('vim', true))
  })

  it('does not mistake an agent below a wrapper-owned tool for the main application', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 node\n203 202 202 202 s001 vim\n204 203 202 202 s001 claude\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual(processContext('node', true))
  })

  it('does not infer an agent from an unknown application and its helper', () => {
    const rows = parseProcessSnapshot(
      '101 1 101 202 s001 zsh\n202 101 202 202 s001 unknown-app\n203 202 202 202 s001 claude\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual(processContext(null, true))
  })
})
