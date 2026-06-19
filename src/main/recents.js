import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

// Persisted list of recently-opened workspace folders. Stored as JSON in the
// app's userData dir so it survives restarts. Most-recent first, capped.
const MAX_RECENTS = 12

function storePath() {
  return path.join(app.getPath('userData'), 'recents.json')
}

async function read() {
  try {
    const raw = await fs.readFile(storePath(), 'utf8')
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

async function write(list) {
  try {
    await fs.writeFile(storePath(), JSON.stringify(list, null, 2))
  } catch {
    // Best-effort; losing recents is non-fatal.
  }
}

// Return recents that still exist on disk, pruning any that don't, as
// [{ path, name }] most-recent first.
export async function getRecents() {
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
  if (changed) await write(out.map((r) => r.path))
  return out
}

// Move `dir` to the front of the recents list.
export async function addRecent(dir) {
  if (!dir) return
  const list = await read()
  const next = [dir, ...list.filter((p) => p !== dir)].slice(0, MAX_RECENTS)
  await write(next)
}
