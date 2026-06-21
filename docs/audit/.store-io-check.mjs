// Throwaway verification of store-io persistence primitives + the data-loss fix.
// Pure Node (store-io.js imports only fs), runnable without Electron.
import os from 'os'
import path from 'path'
import fs from 'fs'
import {
  writeJsonAtomic,
  readJson,
  trackPending,
  writeJsonSync,
  flushSync,
} from '../../src/main/store-io.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-storeio-'))
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
const noTmp = (p) => fs.readdirSync(path.dirname(p)).every((f) => !f.includes('.tmp'))

// 1) async atomic write round-trips, leaves no temp file
const p1 = path.join(dir, 'a.json')
await writeJsonAtomic(p1, { a: 1 })
ok('writeJsonAtomic round-trips', JSON.stringify(await readJson(p1, null)) === '{"a":1}')
ok('writeJsonAtomic leaves no .tmp', noTmp(p1))

// 2) trackPending + flushSync persists, then clears pending
const p2 = path.join(dir, 'b.json')
trackPending(p2, { b: 2 })
flushSync()
ok('flushSync persists pending', JSON.stringify(await readJson(p2, null)) === '{"b":2}')
fs.writeFileSync(p2, 'STALE') // corrupt it; a second flush must NOT rewrite (pending cleared)
flushSync()
ok('flushSync clears pending (no second write)', fs.readFileSync(p2, 'utf8') === 'STALE')

// 3) writeJsonSync writes + returns true + no temp left
const p3 = path.join(dir, 'c.json')
ok('writeJsonSync returns true', writeJsonSync(p3, { c: 3 }) === true)
ok('writeJsonSync round-trips', JSON.stringify(await readJson(p3, null)) === '{"c":3}')
ok('writeJsonSync leaves no .tmp', noTmp(p3))

// 4) THE DATA-LOSS REGRESSION: simulate Electron's quit order —
//    before-quit flushSync() drains, THEN the renderer's unload stages+writes the
//    final blob. Pre-fix, the staged blob was only trackPending()'d and never
//    drained again -> lost. Post-fix, saveSessionSync() writeJsonSync()s it, so the
//    final value must win even though a flush already ran.
const p4 = path.join(dir, 'session.json')
trackPending(p4, { layout: 'v1-early' })
flushSync() // <- before-quit drains v1
writeJsonSync(p4, { layout: 'v2-final-on-unload' }) // <- saveSessionSync on unload
ok(
  'data-loss fix: final unload write survives a prior flush',
  JSON.stringify(await readJson(p4, null)) === '{"layout":"v2-final-on-unload"}'
)

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
