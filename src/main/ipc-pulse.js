import { ipcMain } from 'electron'

// Pulse · Layer B — turn a pane's recent visible output into a compact
// { state, summary, question } verdict, so the UI can tell "blocked waiting for
// you" from "still working" from "done" without you reading the scrollback.
//
// Provider-pluggable (the ecosystem is multi-LLM). Two backends ship today, chosen
// by environment at startup:
//   CONCOURSE_PULSE_BASE_URL set  -> "local": any OpenAI-compatible HTTP endpoint
//                                    (Ollama, LM Studio, llama.cpp server, …),
//                                    default base http://localhost:11434/v1.
//                                    No key, fully offline, free.
//   else ANTHROPIC_API_KEY set    -> "claude": Anthropic API + Haiku (the cheap
//                                    /fast tier for this per-pane microtask).
//   else                          -> disabled (Layer A still runs).
// The key / SDK / network access live ONLY in the main process; the renderer just
// sends a text tail and gets a verdict (or null). Every failure degrades to null —
// Pulse must never take the app down.

const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5'
const DEFAULT_LOCAL_MODEL = 'llama3.2:3b'
const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434/v1'

const STATES = ['working', 'blocked', 'done', 'error', 'idle']

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
  '  working — actively producing output, mid-task, or a spinner/progress is running',
  '  blocked — stopped, waiting on the human: a y/n prompt, a question, a confirmation,',
  '            a password/auth step, a "continue?" — nothing proceeds until they answer',
  '  done    — a task or command finished successfully; back at an idle prompt',
  '  error   — stopped on an error, failure, traceback, or non-zero exit',
  '  idle    — an empty shell prompt, nothing happening, nothing pending',
  '',
  'summary — at most 8 words, present tense, concrete (filenames, counts, command).',
  '          No fluff, no "the agent", no trailing period.',
  'question — only when state is blocked: the exact thing it waits on, <=12 words.',
  '           Otherwise an empty string.',
  '',
  'Respond with ONLY a JSON object of the form',
  '{"state": "...", "summary": "...", "question": "..."} — no prose, no code fence.'
].join('\n')

// Cap renderer-supplied strings — the main process must not trust the renderer's own
// line cap, or a buggy/huge buffer could be shipped to the model.
const TAIL_MAX = 8000
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
  const model = (process.env.CONCOURSE_PULSE_MODEL || '').trim() || DEFAULT_CLAUDE_MODEL
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
      const resp = await client.messages.create({
        model,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: 'user', content: buildUserText(payload) }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } }
      })
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
  const baseUrl = ((process.env.CONCOURSE_PULSE_BASE_URL || '').trim() || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, '')
  const model = (process.env.CONCOURSE_PULSE_MODEL || '').trim() || DEFAULT_LOCAL_MODEL
  const key = (process.env.CONCOURSE_PULSE_API_KEY || '').trim()
  const headers = { 'content-type': 'application/json', ...(key && { authorization: `Bearer ${key}` }) }
  return {
    name: 'local',
    model,
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

// Pick a backend from the environment: a base URL wins (explicit opt-in to local),
// else an Anthropic key, else nothing.
function createProvider() {
  if ((process.env.CONCOURSE_PULSE_BASE_URL || '').trim()) return openAICompatibleProvider()
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) return claudeProvider(process.env.ANTHROPIC_API_KEY.trim())
  return null
}

export function registerPulse() {
  const provider = createProvider()

  // Coalesce bursts: at most one in-flight summary per pane.
  const inFlight = new Set()

  ipcMain.handle('pulse:status', async () => {
    let reachable = false
    if (provider) {
      try {
        reachable = await provider.reachable()
      } catch {
        reachable = false
      }
    }
    return {
      enabled: !!provider,
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      reachable
    }
  })

  ipcMain.handle('pulse:summarize', async (_e, payload = {}) => {
    if (!provider) return null
    // Don't spend a call on an empty/garbage payload (renderer gates too, but the
    // main process must not trust it).
    if (typeof payload?.tail !== 'string' || !payload.tail.trim()) return null
    const { id } = payload
    if (id != null) {
      if (inFlight.has(id)) return null
      inFlight.add(id)
    }
    try {
      const raw = await provider.summarize(payload)
      return parseVerdict(raw)
    } catch (err) {
      console.log('[pulse] summarize failed:', err?.status || '', err?.message || err)
      return null
    } finally {
      if (id != null) inFlight.delete(id)
    }
  })
}
