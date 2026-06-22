import { ipcMain } from 'electron'
import { existsSync, createWriteStream } from 'fs'
import { mkdir, rename, unlink } from 'fs/promises'
import {
  getLocalRuntime,
  ensureLocalRuntimeStarted,
  bundledModelDir,
  bundledModelPath,
  waitForReachable
} from './local-llm.js'

// Model provisioning — the main-process half of the one-click "Yes, run the Local
// LLM" flow. The renderer says "make the local model ready"; this gets a runtime up and
// the model in place, streaming progress so the dialog shows a bar, not a frozen window.
//
// It branches on the active runtime (see local-llm.js):
//   ollama   — POST /api/pull (streams real byte-progress), then the runtime serves it.
//   bundled  — download the GGUF into userData with progress, then spawn llama-server.
// Same IPC contract and same dialog for both — only the mechanics differ.
//
// Everything degrades gracefully: no runtime, no network, a bad name — the flow reports
// an error the dialog can show, and Pulse falls back to deterministic Layer A.

// Ollama's native API lives at the root (…/api/*); Pulse's OpenAI-compatible surface is
// under …/v1. Derive one from the other so there's a single source of truth.
function apiRootFrom(baseUrl) {
  return baseUrl.replace(/\/v1$/, '')
}

// A pulled Ollama model leaves a manifest on disk — answer "installed?" with no server
// and no network so the dialog can skip straight to "ready" for someone who has it.
function ollamaManifestPath(model) {
  const [name, tag = 'latest'] = model.split(':')
  const home = process.env.HOME || ''
  return `${home}/.ollama/models/manifests/registry.ollama.ai/library/${name}/${tag}`
}

// Is the active runtime's model already in place? (Offline, cheap.)
function isModelInstalled(rt) {
  try {
    if (rt.kind === 'ollama') return existsSync(ollamaManifestPath(rt.model))
    if (rt.kind === 'bundled') return existsSync(bundledModelPath())
    if (rt.kind === 'external') return true // the user's own endpoint — assume it's set up
    return false
  } catch {
    return false
  }
}

// ---- ollama: pull with streamed progress -----------------------------------------
async function provisionOllama(rt, { send, signal }) {
  const apiRoot = apiRootFrom(rt.baseUrl)
  const res = await fetch(`${apiRoot}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: rt.model, stream: true }),
    signal
  })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res?.status ?? '?'}).`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let percent = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl // /api/pull streams newline-delimited JSON: one status object per line.
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj.error) throw new Error(obj.error)
      if (typeof obj.total === 'number' && obj.total > 0 && typeof obj.completed === 'number') {
        percent = Math.min(1, obj.completed / obj.total)
      }
      send({ phase: 'downloading', status: obj.status || 'Downloading…', percent })
    }
  }
}

// ---- bundled: download the GGUF, then start llama-server --------------------------
async function provisionBundled(rt, { send, signal }) {
  await mkdir(bundledModelDir(), { recursive: true })
  const finalPath = bundledModelPath()
  const partPath = finalPath + '.part'

  const res = await fetch(rt.gguf.url, { signal })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res?.status ?? '?'}).`)
  const total = Number(res.headers.get('content-length')) || 0

  const file = createWriteStream(partPath)
  const reader = res.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      // Respect backpressure on a ~400 MB write so memory stays flat.
      if (!file.write(buf)) await new Promise((r) => file.once('drain', r))
      received += buf.length
      const percent = total ? Math.min(1, received / total) : 0
      const mb = (received / 1e6).toFixed(0)
      send({ phase: 'downloading', status: total ? `Downloading model — ${mb} MB` : 'Downloading model…', percent })
    }
    await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    file.destroy()
    await unlink(partPath).catch(() => {}) // don't leave a half file behind
    throw err
  }
  await rename(partPath, finalPath) // atomic: a present GGUF is always complete

  // Weights in place — start the bundled server and wait for it to answer.
  send({ phase: 'starting', status: 'Starting the local runtime…' })
  await ensureLocalRuntimeStarted({ force: true })
  if (!(await waitForReachable(rt.baseUrl, 25000))) {
    throw new Error('Downloaded the model, but the local runtime did not start.')
  }
}

export function registerModel() {
  const inFlight = new Map() // webContents id -> AbortController

  ipcMain.handle('model:status', async () => {
    const rt = getLocalRuntime()
    return { model: rt.model, runtime: rt.kind, installed: isModelInstalled(rt) }
  })

  ipcMain.handle('model:provision', async (e) => {
    const rt = getLocalRuntime()
    const send = (p) => {
      try {
        e.sender.send('model:progress', { model: rt.model, runtime: rt.kind, ...p })
      } catch {
        /* window may have closed mid-flight */
      }
    }

    if (rt.kind === 'none') {
      send({ phase: 'error', error: 'No local runtime is available. Install Ollama from ollama.com, or use a packaged build with the bundled runtime.' })
      return { ok: false, error: 'no-runtime' }
    }
    if (rt.kind === 'external') {
      // The user pointed Pulse at their own server; nothing for us to download.
      send({ phase: 'done', percent: 1, status: 'Ready' })
      return { ok: true, already: true }
    }
    if (isModelInstalled(rt)) {
      // Make sure it's actually serving, then report ready.
      await ensureLocalRuntimeStarted({ force: true })
      send({ phase: 'done', percent: 1, status: 'Ready' })
      return { ok: true, already: true }
    }

    const ctrl = new AbortController()
    inFlight.set(e.sender.id, ctrl)
    try {
      if (rt.kind === 'ollama') {
        // Ollama pulls via its own server — make sure it's up first.
        send({ phase: 'starting', status: 'Starting the local runtime…' })
        await ensureLocalRuntimeStarted({ force: true })
        if (!(await waitForReachable(rt.baseUrl, 20000))) {
          send({ phase: 'error', error: 'Could not start Ollama. Open the Ollama app, then try again.' })
          return { ok: false, error: 'runtime-unavailable' }
        }
        send({ phase: 'downloading', status: 'Downloading model…', percent: 0 })
        await provisionOllama(rt, { send, signal: ctrl.signal })
      } else {
        send({ phase: 'downloading', status: 'Downloading model…', percent: 0 })
        await provisionBundled(rt, { send, signal: ctrl.signal })
      }
      send({ phase: 'done', percent: 1, status: 'Ready' })
      return { ok: true }
    } catch (err) {
      if (ctrl.signal.aborted) {
        send({ phase: 'cancelled' })
        return { ok: false, error: 'cancelled' }
      }
      send({ phase: 'error', error: err?.message || 'Download failed.' })
      return { ok: false, error: err?.message || 'error' }
    } finally {
      inFlight.delete(e.sender.id)
    }
  })

  ipcMain.handle('model:cancel', (e) => {
    inFlight.get(e.sender.id)?.abort()
    return true
  })
}
