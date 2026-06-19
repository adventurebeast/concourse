import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'

// Persisted per-workspace session state (open editor tabs, terminal layout, UI
// sizes) plus the last-opened root for auto-reopen. Stored as one JSON file in
// userData: { lastRoot, roots: { [rootPath]: blob } }.
function storePath() {
  return path.join(app.getPath('userData'), 'session.json')
}

async function readStore() {
  try {
    const raw = await fs.readFile(storePath(), 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') {
      if (!data.roots || typeof data.roots !== 'object') data.roots = {}
      return data
    }
  } catch {
    // missing / corrupt — start fresh
  }
  return { lastRoot: null, roots: {} }
}

async function writeStore(data) {
  try {
    await fs.writeFile(storePath(), JSON.stringify(data, null, 2))
  } catch {
    // Best-effort; losing session state is non-fatal.
  }
}

export async function getLastRoot() {
  const data = await readStore()
  return data.lastRoot || null
}

export async function setLastRoot(root) {
  const data = await readStore()
  data.lastRoot = root || null
  await writeStore(data)
}

export async function getSession(root) {
  if (!root) return null
  const data = await readStore()
  return data.roots[root] || null
}

export async function setSession(root, blob) {
  if (!root) return
  const data = await readStore()
  data.roots[root] = blob || {}
  data.lastRoot = root
  await writeStore(data)
}
