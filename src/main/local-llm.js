import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getRaw } from './settings.js'

// The local-model runtime for Pulse — two backends behind one selection so local Pulse
// is genuinely zero-config no matter the machine:
//
//   ollama   — if the user already has Ollama installed, reuse it (best models, shared
//              store). We start `ollama serve` ourselves if nothing's serving.
//   bundled  — otherwise the app ships its own llama.cpp `llama-server` binary and a
//              small downloaded model, so "run a local AI" works with NOTHING installed.
//              This is the "built-in for all users" path.
//   external — the user pointed Pulse at their own endpoint (Settings base URL / env);
//              we never spawn against it.
//
// Everything degrades silently: no runtime, no binary, no model — Pulse falls back to
// its deterministic Layer A. Starting a model server can never take the app down.

// ===== built-in model identities ===================================================
// Ollama tag (ollama runtime) — small, fast, Apache-2.0.
export const BUILTIN_LOCAL_MODEL = 'qwen2.5:0.5b'
const OLLAMA_BASE_URL = 'http://localhost:11434/v1'
export const DEFAULT_LOCAL_BASE_URL = OLLAMA_BASE_URL

// Bundled llama.cpp runtime. It serves on its OWN port so it can never clash with a
// real Ollama on 11434. The weights are the same model in GGUF form (Qwen2.5-0.5B-
// Instruct, Q4_K_M, ~400 MB, Apache-2.0) — downloaded once into userData on first use.
const BUNDLED_PORT = 11435
const BUNDLED_BASE_URL = `http://127.0.0.1:${BUNDLED_PORT}/v1`
const BUNDLED_GGUF = {
  filename: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
  sizeLabel: '~400 MB'
}

// Don't re-attempt a spawn more than this often (a missing binary / a server that won't
// come up must not turn the 5s resolver into a spawn storm). The explicit "run it"
// click passes force:true to skip this.
const ATTEMPT_BACKOFF_MS = 30000

// Pulse config precedence: in-app Settings value wins, else env var, else built-in.
function settingOrEnv(settingKey, envKey) {
  const fromSetting = (getRaw(settingKey) || '').toString().trim()
  if (fromSetting) return fromSetting
  return (process.env[envKey] || '').trim()
}

// ===== ollama binary resolution =====================================================
// A Finder-launched app inherits a bare launchd PATH, so probe the standard install
// spots directly; login-shell `which` is only a fallback for odd installs.
const OLLAMA_PATHS = [
  '/usr/local/bin/ollama',
  '/opt/homebrew/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama'
]
function ollamaBinarySync() {
  for (const p of OLLAMA_PATHS) if (existsSync(p)) return p
  return null
}
function whichViaLoginShell() {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-lic', 'command -v ollama'], { timeout: 4000 }, (err, stdout) => {
      const found = (stdout || '').trim().split('\n').pop()
      resolve(!err && found && existsSync(found) ? found : null)
    })
  })
}
let ollamaPath // undefined = unresolved, null = not found, string = path
let ollamaProbe = null
async function resolveOllamaBinary() {
  if (ollamaPath !== undefined) return ollamaPath
  const sync = ollamaBinarySync()
  if (sync) {
    ollamaPath = sync
    return sync
  }
  if (!ollamaProbe) {
    ollamaProbe = whichViaLoginShell().then((p) => {
      ollamaPath = p
      return p
    })
  }
  return ollamaProbe
}

// ===== bundled runtime paths ========================================================
// Packaged: extraResources puts the binary dir at <Resources>/llama. Dev: build/bin in
// the repo (populated by `npm run fetch:llama`).
function bundledServerBinary() {
  const dir = app.isPackaged ? join(process.resourcesPath, 'llama') : join(app.getAppPath(), 'build', 'bin')
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const p = join(dir, exe)
  return existsSync(p) ? p : null
}
export function bundledModelDir() {
  return join(app.getPath('userData'), 'models')
}
export function bundledModelPath() {
  return join(bundledModelDir(), BUNDLED_GGUF.filename)
}

// ===== runtime selection ============================================================
// The single decision every part of the local stack (provider, autostart, provisioning)
// consults, so the runtime we start, the model we fetch, and the endpoint Pulse calls
// can never drift apart.
export function getLocalRuntime() {
  const explicit = settingOrEnv('pulse.baseUrl', 'CONCOURSE_PULSE_BASE_URL')
  if (explicit) {
    return { kind: 'external', baseUrl: explicit.replace(/\/+$/, ''), model: resolveLocalModel(), manageable: false }
  }
  // Prefer a real Ollama install (richer model store) over our bundled mini-runtime.
  if (ollamaBinarySync()) {
    return { kind: 'ollama', baseUrl: OLLAMA_BASE_URL, model: resolveLocalModel(), manageable: true }
  }
  const binary = bundledServerBinary()
  if (binary) {
    return {
      kind: 'bundled',
      baseUrl: BUNDLED_BASE_URL,
      model: BUILTIN_LOCAL_MODEL,
      manageable: true,
      binary,
      gguf: BUNDLED_GGUF,
      modelPath: bundledModelPath()
    }
  }
  // Nothing we can manage. Auto-detect may still find a server someone else is running
  // on the default Ollama port.
  return { kind: 'none', baseUrl: OLLAMA_BASE_URL, model: resolveLocalModel(), manageable: false }
}

export function resolveLocalBaseUrl() {
  return getLocalRuntime().baseUrl
}
export function resolveLocalModel() {
  return settingOrEnv('pulse.model', 'CONCOURSE_PULSE_MODEL') || BUILTIN_LOCAL_MODEL
}

// ===== reachability =================================================================
// GET /v1/models is the liveness probe both Ollama and llama-server answer.
export async function probeReachable(baseUrl, ms = 1500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: ctrl.signal })
    return !!r && r.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}
export async function waitForReachable(baseUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeReachable(baseUrl)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// ===== managed server process =======================================================
let child = null // the runtime process WE own (null if none / externally owned)
let lastAttemptAt = 0

function track(proc) {
  proc.on('error', (err) => {
    if (child === proc) child = null
    console.log('[pulse] local runtime failed to start:', err?.message || err)
  })
  proc.on('exit', () => {
    if (child === proc) child = null
  })
  proc.unref() // don't keep Electron's loop alive; we still hold the handle to kill it
  child = proc
}

// Bring the selected runtime up if it's manageable, not already serving, and ready
// (the bundled runtime needs its weights on disk first — provisioning downloads them).
// Idempotent and fire-and-forget; callers don't await the server actually answering.
export async function ensureLocalRuntimeStarted({ force = false } = {}) {
  const rt = getLocalRuntime()
  if (!rt.manageable) return // external / none — nothing to manage
  if (child && child.exitCode === null) return // our process is already (re)starting

  const now = Date.now()
  if (!force && now - lastAttemptAt < ATTEMPT_BACKOFF_MS) return
  lastAttemptAt = now

  if (await probeReachable(rt.baseUrl)) return // already serving — reuse it

  try {
    if (rt.kind === 'ollama') {
      const bin = await resolveOllamaBinary()
      if (!bin) return
      track(spawn(bin, ['serve'], { env: { ...process.env }, stdio: 'ignore', detached: false }))
      console.log('[pulse] started Ollama (ollama serve), pid', child?.pid)
    } else if (rt.kind === 'bundled') {
      if (!existsSync(rt.modelPath)) return // weights not downloaded yet
      track(
        spawn(rt.binary, ['-m', rt.modelPath, '--host', '127.0.0.1', '--port', String(BUNDLED_PORT)], {
          env: { ...process.env },
          stdio: 'ignore',
          detached: false
        })
      )
      console.log('[pulse] started bundled llama-server, pid', child?.pid)
    }
  } catch (err) {
    child = null
    console.log('[pulse] could not start local runtime:', err?.message || err)
  }
}

export function localServerManaged() {
  return !!(child && child.exitCode === null)
}

// Stop the runtime, but only if WE started it — an externally-owned server (the Ollama
// menubar app, one you ran yourself) must outlive Concourse. Called on quit.
export function stopLocalServer() {
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* best-effort */
    }
  }
  child = null
}
