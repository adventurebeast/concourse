import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'

// search-worker.js runs the file-walk + regex match off the main thread so a
// ReDoS pattern can be terminated rather than freezing the app. Pure Node, so we
// spawn it directly and assert both a normal search and the kill-on-timeout path.

const here = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.resolve(here, '../src/main/search-worker.js')

let dir
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-search-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello TODO world\nsecond line\nTODO again\n')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'nothing here\n')
  // Fuel for (a+)+$ catastrophic backtracking.
  fs.writeFileSync(path.join(dir, 'evil.txt'), 'a'.repeat(60) + '!\n')
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function search({ root, regexSource, regexFlags }, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let worker = null
    const start = Date.now()
    const finish = (val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (worker) {
        try {
          worker.terminate()
        } catch {
          /* already exiting */
        }
      }
      resolve({ ...val, elapsed: Date.now() - start })
    }
    const timer = setTimeout(
      () => finish({ files: [], truncated: true, timedOut: true }),
      timeoutMs
    )
    worker = new Worker(workerPath, { workerData: { root, regexSource, regexFlags } })
    worker.on('message', finish)
    worker.on('error', (e) => finish({ error: String(e), files: [] }))
    worker.on('exit', () => finish({ files: [] }))
  })
}

describe('search-worker', () => {
  it('runs a normal search and returns matches', async () => {
    const r = await search({ root: dir, regexSource: 'TODO', regexFlags: 'gi' }, 6000)
    const f = (r.files || []).find((x) => x.name === 'a.txt')
    expect(f).toBeTruthy()
    expect(f.matches.length).toBe(2)
    expect(r.timedOut).toBeFalsy()
  })

  it('is terminated by the timeout on a ReDoS pattern (no infinite hang)', async () => {
    const r = await search({ root: dir, regexSource: '(a+)+$', regexFlags: 'g' }, 1500)
    expect(r.timedOut).toBe(true)
    expect(r.elapsed).toBeLessThan(3500)
  })
})
