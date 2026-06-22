import { ipcMain } from 'electron'
import { getRaw } from './settings.js'
import {
  ensureLocalRuntimeStarted,
  localServerManaged,
  resolveLocalBaseUrl,
  resolveLocalModel
} from './local-llm.js'

// Pulse · Layer B — turn a pane's recent visible output into a compact
// { state, summary, question } verdict, so the UI can tell "awaiting your input"
// from "still working" from "done" without you reading the scrollback.
//
// Provider-pluggable (the ecosystem is multi-LLM). The backend is chosen at runtime
// and re-evaluated every few seconds, so a server you start AFTER the app gets picked
// up. Order of preference:
//   1. CONCOURSE_PULSE_BASE_URL set -> "local": that exact OpenAI-compatible endpoint,
//      used unconditionally (explicit opt-in — Ollama, LM Studio, llama.cpp, a remote
//      box). Default base http://localhost:11434/v1.
//   2. else a local server answering at http://localhost:11434/v1 -> "local",
//      AUTO-DETECTED. Zero-config happy path: `ollama serve` and Pulse just turns on.
//      No env var, no key, fully offline, free — and it works even for a Finder-launched
//      app, which never sees your shell's exported env vars.
//   3. else ANTHROPIC_API_KEY set -> "claude": Anthropic API + Haiku (the cheap /fast
//      tier for this per-pane microtask).
//   4. else -> disabled (Layer A still runs).
// A reachable local server is preferred over an Anthropic key when both are present
// (free / offline / private). The key / SDK / network access live ONLY in the main
// process; the renderer just sends a text tail and gets a verdict (or null). Every
// failure degrades to null — Pulse must never take the app down.

const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5'
// The local base URL and model live in local-llm.js (shared with the provisioning
// flow) so the server we auto-start, the model we download, and the model Pulse
// calls can never drift apart.

// Configuration precedence for Pulse: a Settings value (set in the Settings
// window) wins; otherwise the matching environment variable; otherwise the
// caller's default. Settings beat env because they're an explicit, in-app user
// choice — while env vars stay as a zero-UI / headless escape hatch. Read fresh on
// every resolve so a change in the Settings window takes effect within the resolver
// TTL (a few seconds) without a restart.
function settingOrEnv(settingKey, envKey) {
  const fromSetting = (getRaw(settingKey) || '').toString().trim()
  if (fromSetting) return fromSetting
  return (process.env[envKey] || '').trim()
}

const STATES = ['working', 'awaiting', 'done', 'error', 'idle']

// Structured-output schema (used by the Claude backend; OpenAI-compatible servers
// vary in json_schema support, so the local backend uses json_object + the prompt).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: STATES },
    summary: { type: 'string' },
    question: { type: 'string' }
  },
  required: ['state', 'summary', 'question']
}

const SYSTEM = [
  'You monitor ONE pane of a terminal multiplexer used to run CLI coding agents',
  '(such as Claude Code) and plain shells. You are given the recent visible output',
  'of that single pane. Decide its current state and write a tiny label a human can',
  'read at a glance. Judge only from the output shown — do not invent activity.',
  '',
  'state — pick exactly one:',
  '  working  — actively producing output, mid-task, or a spinner/progress is running',
  '  awaiting — at REST, waiting on the human (an agent\'s normal resting state). Covers',
  '             BOTH: (a) mid-task — a y/n, confirmation, password/auth, "continue?" it',
  '             needs answered to proceed; AND (b) end-of-turn — it FINISHED its turn and',
  '             is parked at its input box waiting for your next instruction. If a coding',
  '             agent (e.g. Claude Code) is sitting at its prompt with nothing running,',
  '             that is awaiting, NOT done and NOT idle.',
  '  done     — a one-shot SHELL command finished successfully and returned to the shell',
  '             prompt (e.g. a build/test run). Use only for plain commands, not agents.',
  '  error    — stopped on an error, failure, traceback, or non-zero exit',
  '  idle     — a bare, empty shell prompt that has not been used; nothing pending',
  '',
  'summary — at most 8 words, present tense, concrete (filenames, counts, command).',
  '          No fluff, no "the agent", no trailing period.',
  'question — when state is awaiting: what it needs from you next, <=12 words (the exact',
  '           prompt if mid-task, else the next step it expects). Otherwise empty string.',
  '',
  'Respond with ONLY a JSON object of the form',
  '{"state": "...", "summary": "...", "question": "..."} — no prose, no code fence.'
].join('\n')

// Cap renderer-supplied strings — the main process must not trust the renderer's own
// line cap, or a buggy/huge buffer could be shipped to the model.
const TAIL_MAX = 2500
const FIELD_MAX = 200
const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

function buildUserText({ tail, baseName, lastCommand, branch }) {
  const ctxLines = []
  if (baseName) ctxLines.push(`pane: ${cap(baseName, FIELD_MAX)}`)
  if (lastCommand) ctxLines.push(`last command typed: ${cap(lastCommand, FIELD_MAX)}`)
  if (branch) ctxLines.push(`git branch: ${cap(branch, FIELD_MAX)}`)
  const head = ctxLines.length ? ctxLines.join('\n') + '\n\n' : ''
  return `${head}recent output (last lines of the pane):\n\n${cap(tail, TAIL_MAX) || '(no output captured)'}`
}

// Both backends return raw model text; one parser turns it into a validated verdict.
// Tolerant of a code fence or stray prose (smaller local models add them) by grabbing
// the outermost { … } before parsing.
function parseVerdict(text) {
  if (typeof text !== 'string') return null
  const stripped = text.replace(/```(?:json)?/gi, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return null
  }
  const state = STATES.includes(parsed.state) ? parsed.state : null
  if (!state) return null
  return {
    state,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    question: typeof parsed.question === 'string' ? parsed.question.trim() : ''
  }
}

// fetch with a hard wall-clock timeout; returns null instead of throwing.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// ---- backends -------------------------------------------------------------------

// Claude (Anthropic API + Haiku). Lazy-loads the SDK so a missing install or bad key
// degrades to disabled rather than crashing the app at startup.
function claudeProvider(apiKey) {
  const model = settingOrEnv('pulse.model', 'CONCOURSE_PULSE_MODEL') || DEFAULT_CLAUDE_MODEL
  let clientPromise = null
  const getClient = () => {
    if (!clientPromise) {
      clientPromise = import('@anthropic-ai/sdk')
        .then(({ default: Anthropic }) => new Anthropic({ apiKey }))
        .catch((err) => {
          console.log('[pulse] SDK unavailable:', err?.message || err)
          return null
        })
    }
    return clientPromise
  }
  return {
    name: 'claude',
    model,
    async reachable() {
      // Key present; we don't ping Anthropic just to render a status badge.
      return true
    },
    async summarize(payload) {
      const client = await getClient()
      if (!client) return null
      // Prompt-cache the stable SYSTEM block so the 2nd+ consecutive Haiku call
      // reads it from cache (usage.cache_read_input_tokens > 0) instead of
      // reprocessing it. NOTE: SYSTEM must clear Haiku's ~4K-token minimum
      // cacheable prefix to actually cache — below that the API silently skips
      // the cache (cache_creation_input_tokens stays 0). Token-count to verify;
      // not a blocker here. The user text (volatile) stays uncached after it.
      const base = {
        model,
        max_tokens: 200,
        messages: [{ role: 'user', content: buildUserText(payload) }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } }
      }
      let resp
      try {
        resp = await client.messages.create({
          ...base,
          system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]
        })
      } catch (err) {
        // Fall back to the plain-string system if the SDK rejects the
        // array + cache_control shape — output must be unchanged either way.
        console.log('[pulse] cache_control system rejected, retrying plain:', err?.message || err)
        resp = await client.messages.create({ ...base, system: SYSTEM })
      }
      return (resp.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
    }
  }
}

// Any OpenAI-compatible chat endpoint — one code path for Ollama / LM Studio /
// llama.cpp server, and the same shape most cloud providers expose. Plain fetch to a
// configurable base URL: no SDK, no native build, no key required (localhost runtimes
// ignore Authorization; a key is sent only if CONCOURSE_PULSE_API_KEY is set).
function openAICompatibleProvider() {
  const baseUrl = resolveLocalBaseUrl()
  const model = resolveLocalModel()
  const key = settingOrEnv('pulse.localApiKey', 'CONCOURSE_PULSE_API_KEY')
  const headers = { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) }
  return {
    name: 'local',
    model,
    baseUrl,
    async reachable() {
      // GET /models is the cheap OpenAI-compatible liveness probe (Ollama: /v1/models).
      const r = await fetchWithTimeout(`${baseUrl}/models`, { headers }, 1500)
      return !!r && r.ok
    },
    async summarize(payload) {
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            max_tokens: 200,
            temperature: 0,
            // json_object is the lowest-common-denominator across local servers; the
            // prompt already pins the exact keys and we validate the parsed result.
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: buildUserText(payload) }
            ]
          })
        },
        20000
      )
      if (!r || !r.ok) return null
      const data = await r.json().catch(() => null)
      return data?.choices?.[0]?.message?.content ?? null
    }
  }
}

// Kick a background local-model server (Ollama) into existence when the Local backend
// is in play and nothing is serving yet. Fire-and-forget and idempotent — it no-ops if
// a server is already reachable, if one we own is already starting, or if auto-start is
// turned off in Settings. This is what makes local Pulse truly zero-config: you don't
// run `ollama serve` and you don't paste a localhost URL — the app brings the server up
// and a later resolve (within the TTL) sees it reachable and switches to local.
function maybeAutostartLocal() {
  if (getRaw('pulse.localAutostart') === false) return
  // The runtime layer picks Ollama or the bundled llama-server and only starts
  // something it can manage and that's ready — so this is safe to fire blindly.
  ensureLocalRuntimeStarted().catch(() => {})
}

// Resolve a backend at runtime (see the header for the full precedence list). This is
// async because auto-detect may probe the local server, and the result is cached for a
// few seconds so we don't probe on every call — while still noticing a server that
// starts or stops mid-session.
function createResolver() {
  async function resolve() {
    // The Settings window can force a provider or turn Pulse off; default is
    // auto-detect. Read fresh each resolve so a change applies within the TTL.
    const mode = (getRaw('pulse.provider') || 'auto').toString()
    if (mode === 'off') return null

    const anthropicKey = settingOrEnv('pulse.anthropicApiKey', 'ANTHROPIC_API_KEY')
    // Both candidates are cheap to construct (no network until used; the Anthropic SDK
    // is lazy-imported on first summarize), so build them per-resolve to pick up live
    // Settings changes (model, base URL, keys) without a restart.
    const local = openAICompatibleProvider()
    const claude = anthropicKey ? claudeProvider(anthropicKey) : null

    // Explicit choice: trust it. (For 'local' we don't gate on a probe — a briefly-down
    // server should still report its configured provider and recover on its own; for
    // 'claude' a missing key leaves Pulse off until one is set.)
    if (mode === 'local') {
      maybeAutostartLocal()
      return local
    }
    if (mode === 'claude') return claude

    // Auto-detect (default). Precedence:
    // 1. Explicit endpoint (Settings base URL or env): trust the operator. We still try
    //    auto-start (it no-ops unless it's a manageable localhost Ollama that's down).
    const explicitLocal = !!settingOrEnv('pulse.baseUrl', 'CONCOURSE_PULSE_BASE_URL')
    if (explicitLocal) {
      maybeAutostartLocal()
      return local
    }
    // 2. A reachable local server wins (free, offline, private). A refused connection
    //    fails fast, so this adds no real latency when nothing is running.
    if (await local.reachable()) return local
    // 3. Nothing serving yet — start a background server if auto-start is on and Ollama
    //    is installed. Fire-and-forget: a later resolve, once the port answers, returns
    //    local. Meanwhile fall through so Pulse isn't stuck waiting on model load.
    maybeAutostartLocal()
    // 4. Fall back to Anthropic when a key is present.
    if (claude) return claude
    // 5. Nothing usable yet — Layer A still carries the UI.
    return null
  }

  const TTL_MS = 5000
  let cache = { provider: undefined, expires: 0 }
  return async function getProvider() {
    const now = Date.now()
    if (cache.provider !== undefined && now < cache.expires) return cache.provider
    const provider = await resolve()
    cache = { provider, expires: now + TTL_MS }
    return provider
  }
}

// Global concurrency cap across ALL panes/windows: with 8+ panes pulsing at
// once we'd otherwise fire 8 model calls in parallel. Run at most MAX_CONCURRENT
// and FIFO-queue the rest. Queued requests carry their pane key so a newer
// request for the same pane can supersede (stale-drop) an older queued one —
// we don't want to spend a call on a summary the UI has already moved past.
const MAX_CONCURRENT = 3

function createSemaphore(max) {
  let active = 0
  const queue = [] // { key, superseded, resolve }

  function release() {
    active--
    // Drain to the next live (non-superseded) waiter.
    while (queue.length) {
      const item = queue.shift()
      if (item.superseded) {
        item.resolve(null)
        continue
      }
      active++
      item.resolve(() => release())
      return
    }
  }

  return {
    // Acquire a slot for `key`. Resolves to a release() fn when a slot is
    // granted, or null if this request was superseded by a newer one for the
    // same pane while it sat in the queue (stale-drop — caller must not run).
    acquire(key) {
      return new Promise((resolve) => {
        if (active < max) {
          active++
          resolve(() => release())
          return
        }
        // A still-queued request for the same pane is now obsolete — mark it so
        // it resolves to null (dropped) instead of running a stale summary.
        if (key != null) {
          for (const item of queue) {
            if (item.key === key) item.superseded = true
          }
        }
        queue.push({ key, superseded: false, resolve })
      })
    }
  }
}

export function registerPulse() {
  const getProvider = createResolver()

  // Coalesce bursts: at most one in-flight summary per pane.
  const inFlight = new Set()
  const semaphore = createSemaphore(MAX_CONCURRENT)

  ipcMain.handle('pulse:status', async () => {
    const provider = await getProvider()
    let reachable = false
    if (provider) {
      try {
        reachable = await provider.reachable()
      } catch {
        reachable = false
      }
    }
    // `managed` = a model server WE launched is alive. `starting` = we launched it but
    // it isn't answering yet (model still loading) — lets the UI say "starting local
    // model…" instead of looking disabled during the first-run warm-up.
    const managed = localServerManaged()
    return {
      enabled: !!provider,
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      reachable,
      managed,
      starting: managed && provider?.name === 'local' && !reachable
    }
  })

  ipcMain.handle('pulse:summarize', async (_e, payload = {}) => {
    const provider = await getProvider()
    if (!provider) return null
    // Don't spend a call on an empty/garbage payload (renderer gates too, but the
    // main process must not trust it).
    if (typeof payload?.tail !== 'string' || !payload.tail.trim()) return null
    // Pane ids (term-1, term-2, …) restart per window, so scope the in-flight key
    // by the calling window's webContents id — otherwise two windows' "term-1"
    // would block each other.
    const key = payload.id != null ? `${_e.sender.id}:${payload.id}` : null
    if (key != null) {
      if (inFlight.has(key)) return null
      inFlight.add(key)
    }
    try {
      // Wait for a global concurrency slot (>3 panes at once => the rest queue).
      // A null release means this request was superseded while queued by a newer
      // request for the same pane — drop it without spending a model call.
      const release = await semaphore.acquire(key)
      if (release == null) return null
      try {
        const raw = await provider.summarize(payload)
        return parseVerdict(raw)
      } finally {
        release()
      }
    } catch (err) {
      console.log('[pulse] summarize failed:', err?.status || '', err?.message || err)
      return null
    } finally {
      if (key != null) inFlight.delete(key)
    }
  })
}
