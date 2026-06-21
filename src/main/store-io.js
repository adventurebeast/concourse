import fs from 'fs/promises'
import fsSync from 'fs'

// Shared, crash-safe JSON persistence for the main-process stores (session,
// recents). Two failure modes this guards against:
//   1) Partial writes / corruption — write to a per-pid temp file in the same
//      directory, fsync, then rename over the target (atomic on the same fs).
//   2) Concurrent writers (a second window) clobbering each other — every write
//      across all stores funnels through one serialized queue.

// Latest pending data per target path, so flushSync() can drain on quit.
const pending = new Map()

// Atomically write `data` (serialized as JSON) to `filePath`. Writes to a temp
// file in the same directory, fsyncs the fd, then renames over the target.
export async function writeJsonAtomic(filePath, data) {
  const json = JSON.stringify(data, null, 2)
  const tmp = `${filePath}.${process.pid}.tmp`
  let fh
  try {
    fh = await fs.open(tmp, 'w')
    await fh.writeFile(json)
    await fh.sync()
    await fh.close()
    fh = null
    await fs.rename(tmp, filePath)
    pending.delete(filePath)
  } catch {
    // Best-effort; losing this write is non-fatal.
    if (fh) {
      try {
        await fh.close()
      } catch {
        // ignore
      }
    }
    try {
      await fs.unlink(tmp)
    } catch {
      // ignore — tmp may not exist
    }
  }
}

// Read + parse JSON from `filePath`, returning `fallback` on any error.
export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

// Module-level serialized write queue. ALL writes across session.js + recents.js
// chain onto this so concurrent windows can't interleave read-modify-write. Uses
// `fn` as both fulfil and reject handlers so one failed task can't break the
// chain for subsequent writes.
let queue = Promise.resolve()
export function enqueue(fn) {
  queue = queue.then(fn, fn)
  return queue
}

// Record the latest data destined for `filePath` so flushSync() can persist it
// on quit even if its async write hasn't drained yet.
export function trackPending(filePath, data) {
  pending.set(filePath, data)
}

// Synchronously drain all tracked pending writes. For use on app quit, where the
// async queue may not get a chance to finish. Writes each to a temp file then
// renames over the target.
export function flushSync() {
  for (const [filePath, data] of pending) {
    const tmp = `${filePath}.${process.pid}.tmp`
    try {
      fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2))
      fsSync.renameSync(tmp, filePath)
    } catch {
      // Best-effort; losing this write is non-fatal.
      try {
        fsSync.unlinkSync(tmp)
      } catch {
        // ignore
      }
    }
  }
  pending.clear()
}
