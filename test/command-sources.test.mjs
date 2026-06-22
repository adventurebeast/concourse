import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { rankHistory, splitEntries, getProjectCommands } from '../src/main/command-sources.js'

// command-sources.js is pure Node (no electron import), so the history ranking and
// project-command parsing — the riskiest logic behind the palette — are
// unit-testable directly. rankHistory is the frecency core split out from the file
// IO; getProjectCommands reads real files from a root we point at a temp dir.

const NOW = 1_700_000_000_000 // fixed "now" (ms) so recency math is deterministic
const ext = (cmd, ageMs) => `: ${Math.floor((NOW - ageMs) / 1000)}:0;${cmd}` // zsh extended line
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

describe('rankHistory — frecency, noise, dedup', () => {
  it('ranks by frequency when there are no timestamps', () => {
    const entries = ['git push', 'git status', 'git status', 'git status', 'git push']
    const ranked = rankHistory(entries, NOW)
    expect(ranked[0].cmd).toBe('git status') // 3× beats 2×
    expect(ranked[0].count).toBe(3)
    expect(ranked.find((r) => r.cmd === 'git push').count).toBe(2)
  })

  it('recency outweighs raw frequency (a recent command beats a stale, more-frequent one)', () => {
    const entries = [
      ext('deploy old', 30 * DAY), // ×5 but a month ago → boost 0.4 → score 2
      ext('deploy old', 30 * DAY),
      ext('deploy old', 30 * DAY),
      ext('deploy old', 30 * DAY),
      ext('deploy old', 30 * DAY),
      ext('claude --resume', 30 * MIN), // ×2 in the last hour → boost 4 → score 8
      ext('claude --resume', 30 * MIN)
    ]
    const ranked = rankHistory(entries, NOW)
    expect(ranked[0].cmd).toBe('claude --resume')
  })

  it('drops bare navigation/tidy noise but keeps real cd targets', () => {
    const entries = ['ls', 'ls -la', 'cd ..', 'pwd', 'clear', 'cd /srv/app', 'just deploy']
    const cmds = rankHistory(entries, NOW).map((r) => r.cmd)
    expect(cmds).not.toContain('ls')
    expect(cmds).not.toContain('cd ..')
    expect(cmds).not.toContain('clear')
    expect(cmds).toContain('cd /srv/app')
    expect(cmds).toContain('just deploy')
  })

  it('parses the zsh extended-history timestamp and de-dupes', () => {
    const entries = [ext('npm run dev', 5 * MIN), ext('npm run dev', 2 * MIN)]
    const ranked = rankHistory(entries, NOW)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].count).toBe(2)
  })

  it('caps the list (default 40)', () => {
    const entries = Array.from({ length: 50 }, (_, i) => `cmd-number-${i}`)
    expect(rankHistory(entries, NOW)).toHaveLength(40)
  })

  it('drops bash HISTTIMEFORMAT marker lines (#<epoch>)', () => {
    const cmds = rankHistory(['#1700000000', 'git push'], NOW).map((r) => r.cmd)
    expect(cmds).toEqual(['git push'])
  })
})

describe('splitEntries — zsh line continuation', () => {
  it('keeps plain lines as separate entries', () => {
    expect(splitEntries('one\ntwo')).toEqual(['one', 'two'])
  })
  it('joins a backslash-continued command into one entry', () => {
    const entries = splitEntries('git commit \\\n  -m "msg"')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain('-m "msg"')
  })
  it('does NOT join when the line ends in an even number of backslashes', () => {
    // a literal (escaped) trailing backslash is not a line continuation
    expect(splitEntries('echo done\\\\\nnext')).toHaveLength(2)
  })
})

describe('getProjectCommands — npm / just / make parsing', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-cmdsrc-'))
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite', test: 'vitest' } })
    )
    fs.writeFileSync(
      path.join(dir, 'justfile'),
      [
        '# a comment',
        'deploy: build',
        '    echo go',
        '_private:',
        '    echo hi',
        'build:',
        '    echo b',
        'serve arg="x":',
        '    echo serving',
        'ver := "1.0"'
      ].join('\n')
    )
    fs.writeFileSync(
      path.join(dir, 'Makefile'),
      [
        '.PHONY: all',
        'CC := gcc',
        'all: build',
        '\techo all',
        'build:',
        '\techo build',
        'clean dist:',
        '\trm -rf out'
      ].join('\n')
    )
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('turns package.json scripts into `npm run <name>`', async () => {
    const cmds = (await getProjectCommands(dir)).map((c) => c.cmd)
    expect(cmds).toContain('npm run dev')
    expect(cmds).toContain('npm run test')
  })

  it('turns justfile recipes into `just <name>`, skipping private recipes and assignments', async () => {
    const cmds = (await getProjectCommands(dir)).map((c) => c.cmd)
    expect(cmds).toContain('just deploy')
    expect(cmds).toContain('just build')
    expect(cmds).toContain('just serve') // recipe with a default-valued parameter
    expect(cmds).not.toContain('just _private')
    expect(cmds).not.toContain('just ver')
  })

  it('turns Makefile targets into `make <name>`, skipping .PHONY and assignments', async () => {
    const cmds = (await getProjectCommands(dir)).map((c) => c.cmd)
    expect(cmds).toContain('make all')
    expect(cmds).toContain('make build')
    expect(cmds).toContain('make clean') // multiple targets on one line
    expect(cmds).toContain('make dist')
    expect(cmds).not.toContain('make CC')
  })

  it('tags each command with its source', async () => {
    const bySource = {}
    for (const c of await getProjectCommands(dir)) bySource[c.source] = true
    expect(bySource).toEqual({ npm: true, just: true, make: true })
  })

  it('returns nothing when no folder is open', async () => {
    expect(await getProjectCommands(null)).toEqual([])
  })

  it('returns nothing for a folder with no command files', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-empty-'))
    expect(await getProjectCommands(empty)).toEqual([])
    fs.rmSync(empty, { recursive: true, force: true })
  })
})
