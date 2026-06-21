import { app, safeStorage } from 'electron'
import path from 'path'
import { writeJsonAtomic, readJson, enqueue, trackPending } from './store-io.js'
import { SETTINGS_BY_KEY, SECRET_KEYS, defaultSettings } from './settings-schema.js'

const SECRET_SET = new Set(SECRET_KEYS)

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

// Secret values (API keys) are encrypted at rest with the OS keychain (Electron
// safeStorage) so a plaintext key never sits in settings.json. The in-memory
// `cache` always holds the DECRYPTED value — the Pulse resolver in main needs it
// in the clear — and only the on-disk form is the encrypted envelope `{ enc }`
// (base64). Where OS encryption is unavailable (e.g. some headless Linux), we
// fall back to a clearly-labelled `{ plain }` so we never silently masquerade
// plaintext as encrypted.
let warnedNoEncryption = false
function encodeSecret(plain) {
  if (!plain) return ''
  const str = String(plain)
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(str).toString('base64') }
    }
  } catch {
    // fall through to the labelled-plaintext fallback
  }
  if (!warnedNoEncryption) {
    console.warn('[settings] OS encryption unavailable — secrets stored unencrypted at rest')
    warnedNoEncryption = true
  }
  return { plain: str }
}
function decodeSecret(stored) {
  if (stored == null || stored === '') return ''
  // Legacy plaintext string (written before encryption existed, or hand-edited):
  // read it through — it gets re-encrypted on the next persist().
  if (typeof stored === 'string') return stored
  if (typeof stored === 'object') {
    if (typeof stored.plain === 'string') return stored.plain
    if (typeof stored.enc === 'string') {
      try {
        return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'))
      } catch {
        // Encrypted on another machine / the OS keychain changed → treat as unset.
        return ''
      }
    }
  }
  return ''
}

// On-disk values object -> validated, decrypted in-memory values.
function decodeStored(stored) {
  if (!stored || typeof stored !== 'object') return {}
  const out = {}
  const nonSecret = {}
  for (const [k, v] of Object.entries(stored)) {
    if (SECRET_SET.has(k)) {
      const c = coerce(k, decodeSecret(v))
      if (c !== undefined) out[k] = c
    } else {
      nonSecret[k] = v
    }
  }
  Object.assign(out, sanitizeAll(nonSecret))
  return out
}

async function load() {
  if (cache) return cache
  const raw = await readJson(settingsPath(), null)
  const stored = raw && typeof raw === 'object' ? raw.values : null
  cache = { ...defaultSettings(), ...decodeStored(stored) }
  return cache
}

function persist() {
  const values = {}
  for (const [k, v] of Object.entries(cache)) {
    values[k] = SECRET_SET.has(k) ? encodeSecret(v) : v
  }
  const data = { version: SCHEMA_VERSION, values }
  // Stage synchronously, BEFORE enqueuing, so a quit while this write is still
  // sitting in the async queue can still flush the latest settings (flushSync only
  // drains paths already present in `pending`). Mirrors recents.js write().
  trackPending(settingsPath(), data)
  return enqueue(() => writeJsonAtomic(settingsPath(), data))
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
