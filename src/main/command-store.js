import { app } from 'electron'
import path from 'path'
import crypto from 'crypto'
import { writeJsonAtomic, readJson, enqueue, trackPending } from './store-io.js'

// Persisted command favorites — the ♥ set that pins to the top of the palette.
// Same crash-safe JSON store as recents/session (atomic write + serialized
// queue). A favorite is { id, cmd, label, scope } where scope is 'global' (shows
// in every project) or an absolute project-root path (shows only there). On
// disk: { version, favorites: [...] }.
const SCHEMA_VERSION = 1
const MAX_FAVORITES = 200

function storePath() {
  return path.join(app.getPath('userData'), 'command-favorites.json')
}

// Plain read (no queue): callers either read read-only, or read inside a queued
// task before writing. Drops malformed entries so one bad record can't break the list.
async function read() {
  const data = await readJson(storePath(), null)
  const list = data && Array.isArray(data.favorites) ? data.favorites : []
  return list.filter((f) => f && typeof f.id === 'string' && typeof f.cmd === 'string')
}

// Stage + write inside an already-queued task (mirrors recents.js — never
// re-enqueue from within enqueue()).
function persist(list) {
  const data = { version: SCHEMA_VERSION, favorites: list }
  trackPending(storePath(), data)
  return writeJsonAtomic(storePath(), data)
}

export async function listFavorites() {
  return read()
}

// Favorites visible for `root`: global ones, plus those pinned to this exact
// project. Tagged projectScoped so the UI can badge/sort the pinned ones first.
export async function favoritesForRoot(root) {
  const list = await read()
  return list
    .filter((f) => f.scope === 'global' || (root && f.scope === root))
    .map((f) => ({ id: f.id, cmd: f.cmd, label: f.label, projectScoped: f.scope !== 'global' }))
}

// Add a favorite. scope: 'global' or an absolute root path. De-duped by
// (cmd, scope) so re-favoriting is a no-op. Returns true if the set changed.
export async function addFavorite({ cmd, label, scope }) {
  if (!cmd || typeof cmd !== 'string') return false
  const sc = scope || 'global'
  return enqueue(async () => {
    const list = await read()
    if (list.some((f) => f.cmd === cmd && f.scope === sc)) return false
    if (list.length >= MAX_FAVORITES) return false
    list.push({ id: crypto.randomUUID(), cmd, label: label || cmd, scope: sc })
    await persist(list)
    return true
  })
}

// Remove a favorite by id. Returns true if it existed.
export async function removeFavorite(id) {
  if (!id) return false
  return enqueue(async () => {
    const list = await read()
    const next = list.filter((f) => f.id !== id)
    if (next.length === list.length) return false
    await persist(next)
    return true
  })
}
