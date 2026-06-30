import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'

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

// Synchronously + atomically write `data` to `filePath` (temp file, then rename
// over the target). For the window-unload / quit path, where the async write
// queue can't be awaited. Clears any pending entry for this path so a later
// flushSync() won't redundantly rewrite it. Returns true on success.
export function writeJsonSync(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fsSync.renameSync(tmp, filePath)
    pending.delete(filePath)
    return true
  } catch {
    // Best-effort; losing this write is non-fatal.
    try {
      fsSync.unlinkSync(tmp)
    } catch {
      // ignore — tmp may not exist
    }
    return false
  }
}

// Sweep orphaned atomic-write temp files left in `dir`. Both write paths name
// their temp `<file>.<pid>.tmp` and clean it up in their own catch block — but a
// process that dies between open and rename (force-quit, crash, dev relaunch)
// can never run that cleanup, so its temp leaks forever (the next launch uses a
// new pid and never revisits the dead one). session.js's one-shot migration
// likewise leaves `<file>.migrate.tmp` if it's interrupted. This drains both on
// startup. Best-effort: a temp owned by a still-live pid (another window) is
// left alone, and any error is swallowed — a failed sweep must never block boot.
export async function sweepStaleTmp(dir) {
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch {
    return // dir may not exist yet on first launch
  }
  for (const name of entries) {
    const pidMatch = name.match(/\.(\d+)\.tmp$/)
    const isMigrate = name.endsWith('.migrate.tmp')
    if (!pidMatch && !isMigrate) continue
    // Don't reap a temp whose owner process is still running — it may be an
    // in-flight write from a concurrent window.
    if (pidMatch) {
      const pid = Number(pidMatch[1])
      if (pid !== process.pid && isPidAlive(pid)) continue
    }
    try {
      await fs.unlink(path.join(dir, name))
    } catch {
      // ignore — already gone, or raced with another sweeper
    }
  }
}

// True if a process with `pid` currently exists. `kill(pid, 0)` sends no signal;
// it throws ESRCH when there's no such process and EPERM when one exists but is
// owned by another user (still "alive" for our purposes).
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

// Synchronously drain all tracked pending writes. For use on app quit, where the
// async queue may not get a chance to finish. Iterates a snapshot so the
// per-write pending.delete() can't perturb iteration.
export function flushSync() {
  for (const [filePath, data] of [...pending]) {
    writeJsonSync(filePath, data)
  }
  pending.clear()
}
