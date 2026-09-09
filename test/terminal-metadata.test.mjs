import { describe, expect, it } from 'vitest'
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractCwds, validateTerminalCwd } from '../src/main/terminal-metadata.js'

const cwdMarker = (cwd) => `\x1b]5152;${Buffer.from(cwd).toString('base64')}\x07`
const legacyCommandMarker = (command) => `\x1b]5151;${Buffer.from(command).toString('base64')}\x07`

describe('cwd-only terminal metadata', () => {
  it('keeps command and model-text capture out of production IPC boundaries', () => {
    const pty = readFileSync(new URL('../src/main/ipc-pty.js', import.meta.url), 'utf8')
    const preload = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
    const pulse = readFileSync(new URL('../src/main/ipc-pulse.js', import.meta.url), 'utf8')
    expect(pty).not.toMatch(/5151|Get-History|recordCommand|term:command/)
    expect(preload).not.toMatch(/term:command|pulse:summarize/)
    expect(pulse).not.toMatch(/pulse:summarize|recent output|provider\.summarize/)
  })

  it('extracts cwd metadata across chunks', () => {
    const marker = cwdMarker('/workspace/app')
    const first = extractCwds(marker.slice(0, 11))
    const second = extractCwds(first.rest + marker.slice(11))
    expect(first.cwds).toEqual([])
    expect(second.cwds).toEqual(['/workspace/app'])
  })

  it('does not parse or retain legacy command markers', () => {
    const secret = legacyCommandMarker('login --password correct-horse')
    const result = extractCwds(`output${secret}prompt`)
    expect(result.cwds).toEqual([])
    expect(result.rest).toBe('')
  })

  it('accepts only valid absolute cwd metadata and preserves spaces in directory names', () => {
    for (const value of [
      'CANARY_SECRET',
      '/workspace/\x00CANARY_SECRET',
      '/workspace/\nCANARY_SECRET'
    ]) {
      expect(extractCwds(cwdMarker(value)).cwds).toEqual([])
    }
    expect(extractCwds('\x1b]5152;not base64!\x07').cwds).toEqual([])
    expect(extractCwds('\x1b]5152;L//+\x07').cwds).toEqual([])
    expect(extractCwds(cwdMarker('/workspace/folder ')).cwds).toEqual(['/workspace/folder '])
    expect(extractCwds(cwdMarker('C:\\workspace')).cwds).toEqual(['C:\\workspace'])
    expect(extractCwds(cwdMarker('\\\\server\\share')).cwds).toEqual(['\\\\server\\share'])
  })

  it('confines reported cwd to existing workspace directories, including symlink targets', async () => {
    const fixture = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'concourse-cwd-test-')))
    const root = path.join(fixture, 'workspace')
    const child = path.join(root, 'child')
    const outside = path.join(fixture, 'outside')
    mkdirSync(root)
    mkdirSync(child)
    mkdirSync(outside)
    writeFileSync(path.join(root, 'file.txt'), 'fixture')
    symlinkSync(
      outside,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(await validateTerminalCwd(root, root)).toBe(root)
    expect(await validateTerminalCwd(root, child)).toBe(child)
    expect(await validateTerminalCwd(path.parse(root).root, child)).toBe(child)
    for (const candidate of [
      outside,
      path.join(root, 'missing'),
      path.join(root, 'file.txt'),
      path.join(root, 'escape')
    ]) {
      expect(await validateTerminalCwd(root, candidate)).toBeNull()
    }
    expect(await validateTerminalCwd(null, child)).toBeNull()
  })
})
