import path from 'path'
import { getProjectCommands } from './command-sources.js'
import { historyForRoot, globalHistory } from './command-history.js'
import { favoritesForRoot } from './command-store.js'
import { getPulseProvider } from './ipc-pulse.js'
import {
  SYSTEM,
  SUGGEST_SCHEMA,
  buildCandidates,
  planSuggestions,
  buildUserText,
  finalizeSuggestions
} from './command-suggest-core.js'

// The palette's "Suggested" group: up to 5 quick commands for the open project,
// curated by the Pulse model from real signal (declared scripts + your history) and
// GROUNDED so the model can never surface an invented command (see command-suggest-
// core.js for the pure logic + why this is safe even on the tiny local model). With
// Pulse off/unreachable we return the deterministic baseline. This replaced the old
// static cheatsheet (ls/cd/git status…), which ignored the project completely.

// Pull the real command signal for `root` from the stores, minus anything already
// favorited (the user pinned those; suggest COMPLEMENTS the ♥ list), into candidates.
async function gatherCandidates(root) {
  const [project, thisProject, global, favorites] = await Promise.all([
    getProjectCommands(root),
    historyForRoot(root),
    globalHistory(),
    favoritesForRoot(root)
  ])
  return buildCandidates({ project, thisProject, global, favorites })
}

async function curate(root, candidates) {
  const { baseline, candidateOrder } = planSuggestions(candidates)

  let provider = null
  try {
    provider = await getPulseProvider()
  } catch {
    provider = null
  }
  if (!provider) return { list: baseline, degraded: true }

  let raw = null
  try {
    // Leave numCtx at Pulse's default (2048) — the prompt fits easily, and matching the
    // per-pane summary's context size avoids forcing Ollama to resize its KV cache (a
    // reload) when it alternates between summaries and this occasional call. Only the
    // output cap is bumped so the 5-item JSON never truncates.
    raw = await provider.chat({
      system: SYSTEM,
      user: buildUserText(root ? path.basename(root) : '', candidateOrder),
      maxTokens: 256,
      schema: SUGGEST_SCHEMA
    })
  } catch {
    raw = null
  }
  return finalizeSuggestions(raw, candidates, baseline)
}

// --- public API: cached, coalesced ----------------------------------------

// Per-root cache. A model-backed result is good for a few minutes; a degraded
// (baseline-only) result gets a short TTL so it upgrades quickly once Pulse comes
// online. In-flight promises are shared so a burst of palette opens does one call.
const CACHE_TTL_MS = 180_000
const DEGRADED_TTL_MS = 30_000
const cache = new Map() // root -> { at, ttl, list }
const inFlight = new Map() // root -> Promise<list>

async function compute(root) {
  const candidates = await gatherCandidates(root)
  if (!candidates.length) return { list: [], degraded: false }
  return curate(root, candidates)
}

export async function suggestCommands(root) {
  if (!root) return []
  const now = Date.now()
  const hit = cache.get(root)
  if (hit && now - hit.at < hit.ttl) return hit.list

  if (inFlight.has(root)) return inFlight.get(root)
  const p = (async () => {
    try {
      const { list, degraded } = await compute(root)
      cache.set(root, { at: Date.now(), ttl: degraded ? DEGRADED_TTL_MS : CACHE_TTL_MS, list })
      return list
    } catch {
      // Never let a suggestion failure break the palette — an empty list just hides
      // the group. Cache briefly so we don't hammer on every open.
      cache.set(root, { at: Date.now(), ttl: DEGRADED_TTL_MS, list: [] })
      return []
    } finally {
      inFlight.delete(root)
    }
  })()
  inFlight.set(root, p)
  return p
}

// Drop a root's cached suggestions so the next request recomputes — call when its
// command history changes (a new command was run) so suggestions stay current.
export function invalidateSuggestions(root) {
  if (root) cache.delete(root)
  else cache.clear()
}
