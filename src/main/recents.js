import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { writeJsonAtomic, readJson, enqueue, trackPending } from './store-io.js'

// Persisted list of recently-opened workspace folders. Stored as JSON in the
// app's userData dir so it survives restarts. Most-recent first, capped.
const MAX_RECENTS = 12

function storePath() {
  return path.join(app.getPath('userData'), 'recents.json')
}

async function read() {
  const list = await readJson(storePath(), [])
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
}

async function write(list) {
  trackPending(storePath(), list)
  return enqueue(() => writeJsonAtomic(storePath(), list))
}

// Return recents that still exist on disk, pruning any that don't, as
// [{ path, name }] most-recent first.
export async function getRecents() {
  // Prune + rewrite runs inside one queued task so a concurrent write can't
  // clobber the pruned list.
  return enqueue(async () => {
    const list = await read()
    const out = []
    let changed = false
    for (const p of list) {
      try {
        const stat = await fs.stat(p)
        if (stat.isDirectory()) {
          out.push({ path: p, name: path.basename(p) || p })
          continue
        }
      } catch {
        // missing — drop it
      }
      changed = true
    }
    if (changed) {
      const pruned = out.map((r) => r.path)
      trackPending(storePath(), pruned)
      await writeJsonAtomic(storePath(), pruned)
    }
    return out
  })
}

// Move `dir` to the front of the recents list.
export async function addRecent(dir) {
  if (!dir) return
  // Read + dedupe + write runs inside one queued task so concurrent windows
  // can't read stale data and clobber each other.
  return enqueue(async () => {
    const list = await read()
    const next = [dir, ...list.filter((p) => p !== dir)].slice(0, MAX_RECENTS)
    trackPending(storePath(), next)
    await writeJsonAtomic(storePath(), next)
  })
}
