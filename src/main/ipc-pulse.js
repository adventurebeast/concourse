import { ipcMain } from 'electron'
import { getRaw } from './settings.js'
import {
  ensureLocalRuntimeStarted,
  getLocalRuntime,
  localServerManaged,
  resolveLocalBaseUrl,
  resolveLocalModel
} from './local-llm.js'

// Pulse is a tiny, frequent microtask (a ~250-token tail in, a one-line label out), so
// we pin the local model to a small footprint instead of taking each backend's defaults.
// This is the difference between Pulse sipping resources and cooking the machine:
//   - num_ctx 2048: our tail (<=2500 chars) + system prompt fit easily under 2K tokens.
//     Ollama's DEFAULT is the model's full trained context (32K for qwen2.5) — which pins
//     a ~1.8 GB KV cache on the GPU for a 0.5B model and churns it every call. Capping the
//     context drops the resident footprint ~60% (measured 1.8 GB -> 717 MB).
//   - num_predict 128: a <=14-word summary + the JSON wrapper never needs more; caps the
//     worst-case generation so a confused tiny model can't run away to max_tokens.
//   - keep_alive 30s: let the model fall out of VRAM ~30s after the panes go quiet instead
//     of Ollama's 5-minute default (which the 30s working-heartbeat refreshes FOREVER, so
//     the GPU never idles). During active use the heartbeat keeps it warm; once you stop,
//     it releases. NOTE: these only take effect on Ollama's NATIVE /api/chat — the
//     OpenAI-compatible /v1 endpoint silently drops them, which is why local Pulse ran hot.
const LOCAL_NUM_CTX = 2048
const LOCAL_NUM_PREDICT = 128
const LOCAL_KEEP_ALIVE = '30s'

// Pulse · Layer B — turn a pane's recent visible output into a compact
// { state, summary } verdict, so the UI can tell "awaiting your input"
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

// Few-shot examples for the tiny local model — defined as DATA, not inline prose, so the
// exact summary strings the prompt teaches are ALSO the strings we refuse to let through
// verbatim (see EXAMPLE_ECHOES below). A 0.5b model handed thin/ambiguous input parrots the
// most concrete example it was shown rather than admit it has nothing to say — which is why
// "Indexing the repository, about 40 percent done" kept surfacing on panes indexing nothing,
// looking identical across every pane. Single source ⇒ the prompt and the guard can't drift.
const FEWSHOT = [
  {
    in: '● I updated the login flow to call /token/refresh and added auth.test.js.\\n>',
    summary: 'Adding token refresh to the login flow, with a test',
    state: 'awaiting'
  },
  {
    in: 'Indexing repository... 1240/3000 files',
    summary: 'Indexing the repository, about 40 percent done',
    state: 'working'
  },
  {
    in: '$ npm run build\\nbuilt dist/ in 3.2s\\n$',
    summary: 'Built the project into dist',
    state: 'done'
  }
]

// Structured-output schema (used by the Claude backend; OpenAI-compatible servers
// vary in json_schema support, so the local backend uses json_object + the prompt).
// summary first (and required first) so the model generates the important field before
// the throwaway status tag, and isn't biased into a status-shaped sentence.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    state: { type: 'string', enum: STATES }
  },
  required: ['summary', 'state']
}

// Kept deliberately lean and example-led: the DEFAULT backend is a tiny local model
// (qwen2.5:0.5b) chosen so Pulse stays light/free/offline, and small models follow a
// short, example-led prompt far better than a long rule list. The PRIMARY output is the
// summary — a one-sentence "what is this pane working on" — so a user with many tabs open
// can remember where each one stands WITHOUT re-reading the scrollback. `state` is a
// cheap secondary tag only: the visible working/awaiting/idle status is owned by the
// deterministic Layer A in the renderer, and the model's state merely nudges idle→awaiting.
const SYSTEM = [
  'You watch ONE pane in a wall of many terminal panes running CLI coding agents',
  '(such as Claude Code) and shells. The user keeps lots of panes open and cannot recall',
  'what each one is doing. Your ONLY job: in ONE sentence, name the WORK in this pane —',
  'the feature, file, command, or problem being worked on — so they can pick up where they',
  'left off at a glance. Judge only from the visible output; do not invent activity.',
  '',
  'summary — THE important output. ONE sentence, <=14 words, naming the WORK itself: the',
  '          feature being built, the bug being chased, the files or commands in play, with',
  '          REAL names from the output. Weight the MOST RECENT lines: describe what the',
  '          pane is on NOW, not where the conversation started. Read the CONTENT, not just',
  '          the last line.',
  '',
  '          NEVER describe the agent or its status. Do not start with "Agent", "The agent",',
  '          "User", or "This pane". Do not say it is "working", "waiting", "idle", "done",',
  '          "running", "awaiting input", "in a safe state", "experiencing issues", or',
  '          "requires/needs intervention" — the user already sees status from the colour.',
  '          Write the WORK as the subject. Present tense, no trailing period. Use "" only',
  '          for a truly empty, unused pane.',
  '',
  'state — a coarse secondary tag; the user already sees status, so spend no effort here.',
  '        Pick one: working | awaiting | done | error | idle. (awaiting = at a prompt that',
  '        needs the human, including an agent parked at its own input box.)',
  '',
  'Respond with ONLY a JSON object {"summary": "...", "state": "..."} — no prose, no code',
  'fence. The summary names the WORK; never the status. Rewrite a status sentence into the',
  'work it is about:',
  '  BAD  "Agent is in a safe state, waiting for user input to continue"',
  '  BAD  "Agent is experiencing issues with style.css and terminals.css, requires manual fix"',
  '  GOOD "Fixing the terminal colours in style.css and terminals.css"',
  '',
  ...FEWSHOT.flatMap((ex) => [
    `  "${ex.in}" ->`,
    `     {"summary": "${ex.summary}", "state": "${ex.state}"}`
  ])
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
// Deterministic backstop for the one failure the prompt can't fully train out of a tiny
// (0.5b) model: narrating the AGENT'S STATUS instead of the WORK ("Agent is experiencing
// issues with style.css …", "The agent is in a safe state, waiting for input"). The label
// must read as WHAT the pane is on, so strip a leading status-subject preamble and let the
// work phrase that follows stand on its own.
function dropStatusPreamble(summary) {
  let s = summary
  // "Agent is …", "The agent is currently …", "I am …", "It is …", "This pane is …" — remove
  // the status subject + linking verb so the verb describing the work becomes the head. The
  // linking verb is REQUIRED so a real work-summary that merely starts with "Terminal" or
  // "Pane" (no "is/was") is left untouched. The leading bare "Currently …" is also dropped.
  s = s
    .replace(/^\s*(?:the\s+)?(?:agent|assistant|user|terminal|pane|tab|this\s+pane|it|i)\b\s+(?:is|am|are|was|were|has\s+been|appears\s+to\s+be|seems\s+to\s+be)\s+(?:currently\s+)?/i, '')
    .replace(/^\s*currently\s+/i, '')
  // Upcase the new first letter so "experiencing issues …" reads cleanly.
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Normalise a raw summary from a small (0.5b) local model before it becomes a label: drop a
// "summary:" key echo and surrounding quotes/backticks the model wraps it in, and collapse
// the stray newlines/runs of whitespace it sometimes leaves mid-string.
function sanitizeSummary(s) {
  return s
    .replace(/^\s*summary\s*[:\-–]\s*/i, '')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A tiny model sometimes returns ONLY a status word as the "summary" despite the prompt's
// ban — that's never a work label, so we blank it rather than show "Working" as the summary.
// Anchored + single trailing token so a real label that NAMES work ("Waiting on /token") is
// left intact.
const STATUS_ONLY = /^(?:working|idle|done|running|active|busy|pending|waiting|awaiting(?:\s+input)?|in\s+progress)\.?$/i

// A 0.5b model handed thin/ambiguous input tends to echo a few-shot example verbatim rather
// than admit it has nothing to say — which is why the demo phrase "Indexing the repository,
// about 40 percent done" surfaced on panes doing no such thing, identically across panes (it
// is hardcoded, so every pane parrots the SAME line — looks like cross-terminal bleed, isn't).
// Any summary that reduces to one of the example outputs is therefore a parrot, never a real
// observation, so we blank it and the pane falls back to its base name / OSC title. Normalise
// both sides (case, punctuation, whitespace) so a stray period/comma/quote can't dodge it.
const normForEcho = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const EXAMPLE_ECHOES = new Set(FEWSHOT.map((ex) => normForEcho(ex.summary)))

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
  let summary = ''
  if (typeof parsed.summary === 'string') {
    // sanitise (key echo / wrapping quotes / whitespace) -> strip a trailing period the
    // prompt forbids but a small model still emits -> drop any "Agent is …" status preamble.
    let s = sanitizeSummary(parsed.summary).replace(/[.\s]+$/, '').trim()
    s = dropStatusPreamble(s)
    if (STATUS_ONLY.test(s)) s = '' // pure status word survived: not a work label
    if (s && EXAMPLE_ECHOES.has(normForEcho(s))) s = '' // a parroted few-shot example, not a real label
    summary = s
  }
  return { state, summary }
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
  // Ollama is the common local backend, and only its NATIVE /api/chat honours the footprint
  // caps (num_ctx / num_predict / keep_alive) that keep Pulse light — the /v1 OpenAI-compat
  // shim drops them. So when the runtime is Ollama, talk to it natively; every other
  // OpenAI-compatible server (LM Studio, our bundled llama-server, a remote box) keeps /v1.
  const isOllama = getLocalRuntime().kind === 'ollama'
  return {
    name: 'local',
    model,
    baseUrl,
    async reachable() {
      // GET /models is the cheap OpenAI-compatible liveness probe (Ollama answers it too).
      const r = await fetchWithTimeout(`${baseUrl}/models`, { headers }, 1500)
      return !!r && r.ok
    },
    async summarize(payload) {
      if (isOllama) {
        // Native Ollama: /api/chat sits next to /v1 (strip the /v1 suffix). `format: 'json'`
        // is Ollama's JSON mode; `options`/`keep_alive` are the footprint caps the /v1 shim
        // ignores. This is what makes local Pulse stop pinning a 32K-context KV cache.
        const apiBase = baseUrl.replace(/\/v1\/?$/, '')
        const r = await fetchWithTimeout(
          `${apiBase}/api/chat`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              stream: false,
              format: 'json',
              keep_alive: LOCAL_KEEP_ALIVE,
              options: { temperature: 0, num_ctx: LOCAL_NUM_CTX, num_predict: LOCAL_NUM_PREDICT },
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
        return data?.message?.content ?? null
      }
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            max_tokens: LOCAL_NUM_PREDICT,
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
// Kept low: on a weak machine (CPU-only inference, few cores) even 2 simultaneous
// local generations saturate the box. Pulse is a background convenience, not a
// throughput job — serialising a little is invisible to the user and keeps the
// fans down. The per-pane settle cooldown in the renderer already thins the queue.
const MAX_CONCURRENT = 2

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
