import { app } from 'electron'
import path from 'path'
import { writeJsonAtomic, readJson, enqueue, trackPending } from './store-io.js'
import { SETTINGS_BY_KEY, SECRET_KEYS, defaultSettings } from './settings-schema.js'

// Central, persisted user-preferences store. Sits on the same crash-safe JSON
// helpers as session/recents (atomic write + serialized queue + quit flush), and
// holds an in-memory cache so synchronous consumers (the Pulse resolver) and the
// IPC handlers don't each touch disk. On disk: { version, values: { key: value } }.

const SCHEMA_VERSION = 1

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

// Defaults merged with whatever was persisted. Loaded once, then kept current on
// every set() so getAllRaw()/getRaw() stay accurate for synchronous callers.
let cache = null

// Coerce + validate a single value against its schema entry. Returns the coerced
// value, or undefined when the key is unknown or the value is unusable (so callers
// can drop it rather than persist garbage).
function coerce(key, value) {
  const def = SETTINGS_BY_KEY[key]
  if (!def) return undefined
  switch (def.type) {
    case 'boolean':
      return !!value
    case 'number': {
      let n = typeof value === 'number' ? value : parseFloat(value)
      if (!isFinite(n)) return undefined
      if (typeof def.min === 'number') n = Math.max(def.min, n)
      if (typeof def.max === 'number') n = Math.min(def.max, n)
      return n
    }
    case 'enum':
      return def.options.some((o) => o.value === value) ? value : undefined
    case 'text':
    case 'secret':
      return value == null ? '' : String(value)
    default:
      return undefined
  }
}

function sanitizeAll(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    const c = coerce(k, v)
    if (c !== undefined) out[k] = c
  }
  return out
}

async function load() {
  if (cache) return cache
  const raw = await readJson(settingsPath(), null)
  const stored = raw && typeof raw === 'object' ? raw.values : null
  cache = { ...defaultSettings(), ...sanitizeAll(stored) }
  return cache
}

function persist() {
  const data = { version: SCHEMA_VERSION, values: { ...cache } }
  return enqueue(async () => {
    trackPending(settingsPath(), data)
    await writeJsonAtomic(settingsPath(), data)
  })
}

// Warm the cache at startup so the synchronous getters below are accurate the
// first time the Pulse resolver (or anything else in main) reads a value.
export async function initSettings() {
  await load()
  return getAllRaw()
}

// Full settings as the main process sees them (secrets in the clear) — for
// internal consumers like the Pulse resolver. Falls back to defaults if the cache
// somehow hasn't loaded yet.
export function getAllRaw() {
  return cache ? { ...cache } : defaultSettings()
}
export function getRaw(key) {
  return getAllRaw()[key]
}

// Renderer-facing snapshot: secret values are blanked and reported separately as
// booleans, so the UI can show a "set" indicator without ever receiving the value.
export function getAllRedacted() {
  const all = getAllRaw()
  const values = { ...all }
  const secretsSet = {}
  for (const key of SECRET_KEYS) {
    secretsSet[key] = !!(all[key] && String(all[key]).length)
    values[key] = ''
  }
  return { values, secretsSet }
}

// Set one key. Returns true only when the stored value actually changed, so the
// IPC layer knows whether to broadcast. For secrets: '' / undefined means "leave
// unchanged" (a blank field must never wipe a saved key); pass null to clear.
export async function setSetting(key, value) {
  const def = SETTINGS_BY_KEY[key]
  if (!def) return false
  await load()
  if (def.type === 'secret') {
    if (value === '' || value === undefined) return false
    if (value === null) value = ''
  }
  const coerced = coerce(key, value)
  if (coerced === undefined) return false
  if (cache[key] === coerced) return false
  cache[key] = coerced
  await persist()
  return true
}

// Reset one key to its default. Returns true if it changed.
export async function resetSetting(key) {
  const def = SETTINGS_BY_KEY[key]
  if (!def) return false
  await load()
  if (cache[key] === def.default) return false
  cache[key] = def.default
  await persist()
  return true
}

// Reset every key to its default.
export async function resetAll() {
  await load()
  cache = defaultSettings()
  await persist()
  return true
}
