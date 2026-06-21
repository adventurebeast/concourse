import { app } from 'electron'
import path from 'path'
import crypto from 'crypto'
import fsSync from 'fs'
import { writeJsonAtomic, writeJsonSync, readJson, enqueue, trackPending } from './store-io.js'

// Persisted per-workspace session state (open editor tabs, terminal layout, UI
// sizes) plus the last-opened root for auto-reopen. Each workspace lives in its
// own file under userData/sessions/<hash>.json so a single corrupt file resets
// only that one workspace; a small meta file tracks the last-opened root.
const SCHEMA_VERSION = 1

function sessionDir() {
  return path.join(app.getPath('userData'), 'sessions')
}
// One file per workspace, keyed by a hash of its absolute root path. The stored
// blob also records the root so a (vanishingly unlikely) hash collision can't
// hand back another workspace's state.
function sessionFile(root) {
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)
  return path.join(sessionDir(), hash + '.json')
}
function metaPath() {
  return path.join(app.getPath('userData'), 'session-meta.json')
}
function legacyPath() {
  return path.join(app.getPath('userData'), 'session.json')
}

// Make sure the per-workspace directory exists (created once, synchronously, so
// the first write can't race against the mkdir).
let dirReady = false
function ensureDir() {
  if (dirReady) return
  try {
    fsSync.mkdirSync(sessionDir(), { recursive: true })
  } catch {
    // ignore — directory may already exist
  }
  dirReady = true
}

// One-time migration off the old single-file store. If the legacy session.json
// exists and we haven't migrated yet (no meta file), fan it out into the meta
// file + one per-root file, then rename the legacy file aside (keep a .bak, never
// delete). The meta-presence check makes a re-run a no-op, so this is idempotent.
function migrateLegacyStore() {
  const legacy = legacyPath()
  try {
    if (!fsSync.existsSync(legacy)) return
    if (fsSync.existsSync(metaPath())) return
    const raw = fsSync.readFileSync(legacy, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return
    ensureDir()
    const roots = data.roots && typeof data.roots === 'object' ? data.roots : {}
    for (const root of Object.keys(roots)) {
      const tmp = sessionFile(root) + '.migrate.tmp'
      const payload = { version: SCHEMA_VERSION, root, blob: roots[root] || {} }
      fsSync.writeFileSync(tmp, JSON.stringify(payload, null, 2))
      fsSync.renameSync(tmp, sessionFile(root))
    }
    const metaTmp = metaPath() + '.migrate.tmp'
    fsSync.writeFileSync(
      metaTmp,
      JSON.stringify({ version: SCHEMA_VERSION, lastRoot: data.lastRoot || null }, null, 2)
    )
    fsSync.renameSync(metaTmp, metaPath())
    fsSync.renameSync(legacy, legacy + '.bak')
  } catch {
    // Best-effort; a failed migration just leaves users on a fresh store.
  }
}

// Run migration once, at module init, before any read can touch the new store.
migrateLegacyStore()

async function readMeta() {
  const data = await readJson(metaPath(), { version: SCHEMA_VERSION, lastRoot: null })
  if (data && typeof data === 'object') return data
  return { version: SCHEMA_VERSION, lastRoot: null }
}

export async function getLastRoot() {
  const data = await readMeta()
  return data.lastRoot || null
}

export async function setLastRoot(root) {
  // Queued so a concurrent write from another window can't clobber the meta file.
  return enqueue(async () => {
    const data = { version: SCHEMA_VERSION, lastRoot: root || null }
    trackPending(metaPath(), data)
    await writeJsonAtomic(metaPath(), data)
  })
}

// Synchronously + durably persist a workspace's session blob (plus the lastRoot
// meta) for the beforeunload saveSync path. This runs as a window tears down —
// too late to await the async write queue, and (on app quit) AFTER before-quit
// has already drained+cleared the pending map. So we must write to disk right
// here rather than only staging; otherwise the final layout is lost. We also
// trackPending() as a redundant safety net for any later flush.
export function saveSessionSync(root, blob) {
  if (!root) return
  ensureDir()
  const data = { version: SCHEMA_VERSION, root, blob: blob || {} }
  const meta = { version: SCHEMA_VERSION, lastRoot: root }
  trackPending(sessionFile(root), data)
  trackPending(metaPath(), meta)
  writeJsonSync(sessionFile(root), data)
  writeJsonSync(metaPath(), meta)
}

export async function getSession(root) {
  if (!root) return null
  const data = await readJson(sessionFile(root), null)
  if (!data || typeof data !== 'object') return null
  // Guard against a hash collision handing back the wrong workspace's state.
  if (data.root !== root) return null
  return data.blob || null
}

export async function setSession(root, blob) {
  if (!root) return
  ensureDir()
  // Queued so concurrent writes (this root from another window) serialize.
  return enqueue(async () => {
    const data = { version: SCHEMA_VERSION, root, blob: blob || {} }
    trackPending(sessionFile(root), data)
    await writeJsonAtomic(sessionFile(root), data)
    // Track the last-opened root alongside the per-workspace write.
    const meta = { version: SCHEMA_VERSION, lastRoot: root }
    trackPending(metaPath(), meta)
    await writeJsonAtomic(metaPath(), meta)
  })
}
