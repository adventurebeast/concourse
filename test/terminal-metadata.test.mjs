import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractCwds } from '../src/main/terminal-metadata.js'

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
})
