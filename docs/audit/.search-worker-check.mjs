// Verifies search-worker.js: (1) a normal search returns matches, (2) a ReDoS
// pattern is TERMINATED by the parent's timeout instead of hanging forever.
// Mirrors the spawn+timeout logic in ipc-search.js. Pure Node — no Electron.
import os from 'os'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'

const here = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.resolve(here, '../../src/main/search-worker.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-search-'))
fs.writeFileSync(path.join(dir, 'a.txt'), 'hello TODO world\nsecond line\nTODO again\n')
fs.writeFileSync(path.join(dir, 'b.txt'), 'nothing here\n')
// A long run of 'a' with no trailing match — fuel for (a+)+$ catastrophic backtracking.
fs.writeFileSync(path.join(dir, 'evil.txt'), 'a'.repeat(60) + '!\n')

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
        } catch {}
      }
      resolve({ ...val, elapsed: Date.now() - start })
    }
    const timer = setTimeout(() => finish({ files: [], truncated: true, timedOut: true }), timeoutMs)
    worker = new Worker(workerPath, { workerData: { root, regexSource, regexFlags } })
    worker.on('message', finish)
    worker.on('error', (e) => finish({ error: String(e), files: [] }))
    worker.on('exit', () => finish({ files: [] }))
  })
}

let pass = 0,
  fail = 0
const ok = (name, cond) => {
  if (cond) {
    pass++
    console.log('  ok  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name)
  }
}

// 1) Normal literal search returns matches.
const r1 = await search({ root: dir, regexSource: 'TODO', regexFlags: 'gi' }, 6000)
const todoFile = (r1.files || []).find((f) => f.name === 'a.txt')
ok('normal search finds the right file', !!todoFile)
ok('normal search finds both TODO lines', todoFile && todoFile.matches.length === 2)
ok('normal search did not time out', !r1.timedOut)

// 2) ReDoS pattern is killed by the timeout, not left to hang.
const t0 = Date.now()
const r2 = await search({ root: dir, regexSource: '(a+)+$', regexFlags: 'g' }, 1500)
const wall = Date.now() - t0
ok('ReDoS search reports timedOut', r2.timedOut === true)
ok('ReDoS search returns within ~timeout (worker was terminated)', wall < 3500)
console.log(`     (ReDoS search wall time: ${wall}ms — would be effectively infinite on the main thread)`)

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
