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
      args: ['-t', '/dev/ttys001', '-o', 'pid=,pgid=,tpgid=,ucomm=']
    })
    expect(processQuery([{ term: { ptsName: '/dev/pts/2' } }], 'linux')).toEqual({
      file: '/bin/ps',
      args: ['-t', '/dev/pts/2', '-o', 'pid=,pgid=,tpgid=,comm=']
    })
    expect(processQuery(entries, 'win32')).toBeNull()
    expect(processQuery([{ term: {} }], 'darwin')).toBeNull()
  })

  it('discards raw process names at the collection boundary', () => {
    const rows = parseProcessSnapshot(
      '101 101 202 zsh\n202 202 202 CANARY_SECRET\n203 202 202 claude --token CANARY_SECRET\n'
    )
    expect(rows).toEqual([
      { pid: 101, group: 101, foreground: 202, process: 'zsh' },
      { pid: 202, group: 202, foreground: 202, process: null },
      { pid: 203, group: 202, foreground: 202, process: null }
    ])
    expect(JSON.stringify(contextForTerminal(rows, 101))).not.toContain('CANARY_SECRET')
  })

  it('recognizes native agents beneath interpreter wrappers and ignores background agents', () => {
    const rows = parseProcessSnapshot(
      '101 101 202 zsh\n202 202 202 node\n203 202 202 codex\n204 202 202 git\n300 300 202 claude\n'
    )
    expect(contextForTerminal(rows, 101)).toEqual({
      process: 'codex',
      kind: 'agent',
      label: 'Codex',
      running: true
    })
    const returned = parseProcessSnapshot('101 101 101 zsh\n300 300 101 claude\n')
    expect(contextForTerminal(returned, 101)).toEqual({
      process: 'zsh',
      kind: 'shell',
      label: 'Zsh',
      running: false
    })
  })

  it('keeps identity isolated between panes and handles inaccessible or exited processes honestly', () => {
    const rows = parseProcessSnapshot('101 101 202 zsh\n202 202 202 claude\n401 401 401 bash\n')
    expect(contextForTerminal(rows, 401).process).toBe('bash')
    expect(contextForTerminal(rows, 101).process).toBe('claude')
    expect(contextForTerminal(rows, 999)).toEqual(processContext(null))
    expect(contextForTerminal(parseProcessSnapshot('101 101 -1 zsh'), 101)).toEqual(
      processContext(null)
    )
    expect(contextForTerminal(parseProcessSnapshot('101 101 202 zsh'), 101)).toEqual(
      processContext(null)
    )
  })
})
