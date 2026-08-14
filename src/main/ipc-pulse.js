import { getRaw } from './settings.js'
import {
  ensureLocalRuntimeStarted,
  getLocalRuntime,
  resolveLocalBaseUrl,
  resolveLocalModel
} from './local-llm.js'

// The command palette may use a configured model provider to rank commands declared
// by project files. Terminal content is deliberately outside this module's API: there
// is no pane-summary IPC, provider method, prompt, or parser that accepts it.
const LOCAL_NUM_CTX = 2048
const LOCAL_NUM_PREDICT = 128
const LOCAL_KEEP_ALIVE = '30s'
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5'

function settingOrEnv(settingKey, envKey) {
  const fromSetting = (getRaw(settingKey) || '').toString().trim()
  if (fromSetting) return fromSetting
  return (process.env[envKey] || '').trim()
}

// fetch with a hard wall-clock timeout; returns null instead of throwing.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Claude provider for model-curated, allowlisted project-command suggestions.
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
      return true
    },
    async chat({ system, user, maxTokens = 200, schema }) {
      const client = await getClient()
      if (!client) return null
      const base = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: user }],
        ...(schema && { output_config: { format: { type: 'json_schema', schema } } })
      }
      let response
      try {
        response = await client.messages.create({
          ...base,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        })
      } catch (err) {
        console.log('[pulse] cache_control system rejected, retrying plain:', err?.message || err)
        response = await client.messages.create({ ...base, system })
      }
      return (response.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
    }
  }
}

// OpenAI-compatible provider for the same declared-command suggestion flow.
function openAICompatibleProvider() {
  const baseUrl = resolveLocalBaseUrl()
  const model = resolveLocalModel()
  const key = settingOrEnv('pulse.localApiKey', 'CONCOURSE_PULSE_API_KEY')
  const headers = {
    'content-type': 'application/json',
    ...(key && { authorization: `Bearer ${key}` })
  }
  const isOllama = getLocalRuntime().kind === 'ollama'
  return {
    name: 'local',
    model,
    baseUrl,
    async reachable() {
      const response = await fetchWithTimeout(`${baseUrl}/models`, { headers }, 1500)
      return !!response && response.ok
    },
    async chat({ system, user, maxTokens = LOCAL_NUM_PREDICT, numCtx = LOCAL_NUM_CTX }) {
      if (isOllama) {
        const apiBase = baseUrl.replace(/\/v1\/?$/, '')
        const response = await fetchWithTimeout(
          `${apiBase}/api/chat`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              stream: false,
              format: 'json',
              keep_alive: LOCAL_KEEP_ALIVE,
              options: { temperature: 0, num_ctx: numCtx, num_predict: maxTokens },
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
              ]
            })
          },
          20000
        )
        if (!response || !response.ok) return null
        const data = await response.json().catch(() => null)
        return data?.message?.content ?? null
      }

      const response = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          })
        },
        20000
      )
      if (!response || !response.ok) return null
      const data = await response.json().catch(() => null)
      return data?.choices?.[0]?.message?.content ?? null
    }
  }
}

function maybeAutostartLocal() {
  if (getRaw('pulse.localAutostart') === false) return
  ensureLocalRuntimeStarted().catch(() => {})
}

function createResolver() {
  async function resolve() {
    const mode = (getRaw('pulse.provider') || 'auto').toString()
    if (mode === 'off') return null

    const anthropicKey = settingOrEnv('pulse.anthropicApiKey', 'ANTHROPIC_API_KEY')
    const local = openAICompatibleProvider()
    const claude = anthropicKey ? claudeProvider(anthropicKey) : null

    if (mode === 'local') {
      maybeAutostartLocal()
      return local
    }
    if (mode === 'claude') return claude

    const explicitLocal = !!settingOrEnv('pulse.baseUrl', 'CONCOURSE_PULSE_BASE_URL')
    if (explicitLocal) {
      maybeAutostartLocal()
      return local
    }
    if (await local.reachable()) return local
    maybeAutostartLocal()
    return claude
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

let sharedResolver = null
export function getPulseProvider() {
  if (!sharedResolver) sharedResolver = createResolver()
  return sharedResolver()
}
