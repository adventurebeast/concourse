import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { getProjectCommands } from '../src/main/command-sources.js'

// command-sources.js is pure Node (no electron import), so the project-command
// parsing — the riskiest read-from-disk logic behind the palette — is
// unit-testable directly. getProjectCommands reads real files from a root we
// point at a temp dir. (The per-project history ranking lives in command-capture
// and is covered in command-capture.test.mjs.)

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
