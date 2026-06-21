import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import {
  writeJsonAtomic,
  readJson,
  trackPending,
  writeJsonSync,
  flushSync
} from '../src/main/store-io.js'

// store-io.js is pure Node (no electron import), so the crash-safe persistence
// primitives — and the Phase-1 data-loss fix — are unit-testable directly.

let dir
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-storeio-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
const noTmp = (p) => fs.readdirSync(path.dirname(p)).every((f) => !f.includes('.tmp'))

describe('store-io', () => {
  it('writeJsonAtomic round-trips and leaves no temp file', async () => {
    const p = path.join(dir, 'a.json')
    await writeJsonAtomic(p, { a: 1 })
    expect(await readJson(p, null)).toEqual({ a: 1 })
    expect(noTmp(p)).toBe(true)
  })

  it('readJson returns the fallback on a missing/corrupt file', async () => {
    expect(await readJson(path.join(dir, 'nope.json'), 'fallback')).toBe('fallback')
  })

  it('flushSync persists pending writes then clears the map', async () => {
    const p = path.join(dir, 'b.json')
    trackPending(p, { b: 2 })
    flushSync()
    expect(await readJson(p, null)).toEqual({ b: 2 })
    // Corrupt it; a 2nd flush must NOT rewrite (pending was cleared).
    fs.writeFileSync(p, 'STALE')
    flushSync()
    expect(fs.readFileSync(p, 'utf8')).toBe('STALE')
  })

  it('writeJsonSync writes atomically and returns true', async () => {
    const p = path.join(dir, 'c.json')
    expect(writeJsonSync(p, { c: 3 })).toBe(true)
    expect(await readJson(p, null)).toEqual({ c: 3 })
    expect(noTmp(p)).toBe(true)
  })

  // The Phase-1 data-loss fix: Electron's before-quit flushSync() drains pending
  // BEFORE the renderer's unload stages the final session. Pre-fix the final blob
  // was only trackPending()'d and never drained again. saveSessionSync() now
  // writeJsonSync()s it, so the final value must win even after a prior flush.
  it('the final unload write survives a prior before-quit flush', async () => {
    const p = path.join(dir, 'session.json')
    trackPending(p, { layout: 'v1-early' })
    flushSync() // before-quit drains v1
    writeJsonSync(p, { layout: 'v2-final-on-unload' }) // saveSessionSync on unload
    expect(await readJson(p, null)).toEqual({ layout: 'v2-final-on-unload' })
  })
})
