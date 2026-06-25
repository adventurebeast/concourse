import { describe, it, expect } from 'vitest'
import { extractCommands, keepCommand, rankProjectStats } from '../src/main/command-capture.js'

// command-capture.js is pure (no electron), so the OSC marker parsing and the
// per-project frecency ranking — the riskiest logic behind capture — are
// unit-testable directly.

const NOW = 1_700_000_000_000 // fixed "now" (ms) so recency math is deterministic
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

// Build the marker the shell hook emits: ESC ] 5151 ; base64(cmd) BEL.
const mark = (cmd, term = '\x07') => `\x1b]5151;${Buffer.from(cmd, 'utf8').toString('base64')}${term}`

describe('extractCommands — OSC marker parsing', () => {
  it('pulls a single command out of surrounding terminal output', () => {
    const { cmds, rest } = extractCommands(`some prompt$ ${mark('git status')}\r\n`)
    expect(cmds).toEqual(['git status'])
    expect(rest).toBe('') // nothing left to carry
  })

  it('pulls multiple commands from one chunk', () => {
    const { cmds } = extractCommands(`${mark('npm run dev')}${mark('git push')}`)
    expect(cmds).toEqual(['npm run dev', 'git push'])
  })

  it('accepts the ST terminator (ESC \\) as well as BEL', () => {
    const { cmds } = extractCommands(mark('make build', '\x1b\\'))
    expect(cmds).toEqual(['make build'])
  })

  it('decodes commands with quotes, spaces and unicode safely', () => {
    const cmd = 'git commit -m "fix: ❯ café"'
    expect(extractCommands(mark(cmd)).cmds).toEqual([cmd])
  })

  it('carries an incomplete marker across chunks and completes it', () => {
    const full = mark('npm install')
    const a = extractCommands(full.slice(0, 12))
    expect(a.cmds).toEqual([])
    expect(a.rest).not.toBe('') // the partial marker is held
    const b = extractCommands(a.rest + full.slice(12))
    expect(b.cmds).toEqual(['npm install'])
  })

  it('keeps only a partial marker-prefix tail, not arbitrary output', () => {
    const { cmds, rest } = extractCommands('just normal output ending in \x1b]51')
    expect(cmds).toEqual([])
    expect(rest).toBe('\x1b]51') // a possible marker start, nothing more
  })

  it('does not hoard normal output with no marker', () => {
    const { cmds, rest } = extractCommands('plain line with no markers at all\r\n')
    expect(cmds).toEqual([])
    expect(rest).toBe('')
  })

  it('drops a malformed (undecodable-as-empty) payload without throwing', () => {
    const { cmds } = extractCommands('\x1b]5151;\x07') // empty payload → nothing recorded
    expect(cmds).toEqual([])
  })
})

describe('keepCommand — what is worth storing', () => {
  it('keeps real commands', () => {
    expect(keepCommand('git status')).toBe(true)
    expect(keepCommand('cd /srv/app')).toBe(true) // a real cd target, not noise
  })
  it('drops bare navigation/tidy noise and empties', () => {
    for (const n of ['ls', 'cd ..', 'pwd', 'clear', '', '  ']) expect(keepCommand(n)).toBe(false)
  })
  it('drops absurdly long bodies', () => {
    expect(keepCommand('x'.repeat(2000))).toBe(false)
  })
})

describe('rankProjectStats — frecency over per-project counts', () => {
  it('ranks by frequency when timestamps are equal', () => {
    const stats = {
      'git status': { count: 3, lastTs: NOW },
      'git push': { count: 1, lastTs: NOW }
    }
    const ranked = rankProjectStats(stats, NOW)
    expect(ranked[0].cmd).toBe('git status')
    expect(ranked[0].count).toBe(3)
  })

  it('recency outweighs raw frequency', () => {
    const stats = {
      'deploy old': { count: 5, lastTs: NOW - 30 * DAY }, // boost 0.4 → score 2
      'claude --resume': { count: 2, lastTs: NOW - 30 * MIN } // boost 4 → score 8
    }
    expect(rankProjectStats(stats, NOW)[0].cmd).toBe('claude --resume')
  })

  it('drops noise entries even if they were somehow recorded', () => {
    const stats = { ls: { count: 9, lastTs: NOW }, 'just deploy': { count: 1, lastTs: NOW } }
    const cmds = rankProjectStats(stats, NOW).map((r) => r.cmd)
    expect(cmds).not.toContain('ls')
    expect(cmds).toContain('just deploy')
  })

  it('caps the list to the requested limit', () => {
    const stats = {}
    for (let i = 0; i < 50; i++) stats[`cmd-number-${i}`] = { count: 1, lastTs: NOW }
    expect(rankProjectStats(stats, NOW, 40)).toHaveLength(40)
  })

  it('tolerates an empty / missing stats object', () => {
    expect(rankProjectStats(undefined, NOW)).toEqual([])
    expect(rankProjectStats({}, NOW)).toEqual([])
  })
})
