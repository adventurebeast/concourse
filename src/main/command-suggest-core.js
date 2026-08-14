// Pure logic behind the palette's "Suggested" group — no electron / no IO, so it's
// unit-testable (see test/command-suggest-core.test.mjs). The electron-wired shell
// (fetching the stores, calling the Pulse model, caching) lives in command-suggest.js.
//
// The whole design is GROUNDED: the model only ever picks and labels commands drawn
// only from this project's declared scripts/recipes/targets,
// never invents one. parseModelPicks() enforces that by dropping anything the model
// returns that isn't in the candidate set — which is what makes even the tiny default
// local model (qwen2.5:0.5b) safe to use here. A deterministic baseline backs it up.

export const MAX_SUGGESTIONS = 5
// How many real commands we hand the model to choose from — enough spread to curate,
// small enough to keep the prompt (and a tiny model's context) light.
export const MAX_CANDIDATES = 16

// Common script/recipe/target names → a friendly one-line label. Used for the
// deterministic baseline and as a fallback when the model omits/blanks a label.
const FRIENDLY = {
  dev: 'Start the app in development',
  start: 'Start the app',
  serve: 'Serve the app',
  build: 'Build the project',
  test: 'Run the tests',
  lint: 'Lint the code',
  format: 'Format the code',
  typecheck: 'Type-check the code',
  watch: 'Rebuild on every change',
  clean: 'Clean the build output',
  release: 'Cut a release',
  install: 'Install dependencies'
}
// Declared scripts with these names are the project's real entrypoints — prefer them
// in the baseline (roughly the order a newcomer wants them in).
const PRIORITY = [
  'dev',
  'start',
  'serve',
  'build',
  'test',
  'lint',
  'typecheck',
  'format',
  'watch',
  'release',
  'clean'
]

// Structured-output schema for the Claude backend (local servers use json_object +
// the prompt). `commands` first so the model commits to the picks, not a preamble.
export const SUGGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { cmd: { type: 'string' }, label: { type: 'string' } },
        required: ['cmd', 'label']
      }
    }
  },
  required: ['commands']
}

export const SYSTEM = [
  'A developer just opened a project in a terminal. From the CANDIDATE COMMANDS below,',
  'choose the few most useful to have one keystroke away — the project’s real entry',
  'points (a way to run it, build it, and test it).',
  '',
  'Hard rules:',
  '- Choose ONLY commands that appear VERBATIM in the candidate list. Never invent a',
  '  command, subcommand, flag, or path, and never edit one — copy it exactly.',
  `- Pick at most ${MAX_SUGGESTIONS}. Prefer a spread (run / build / test) over`,
  '  several near-duplicates.',
  '- For each, write a short plain-English label of what it does: <=6 words, no trailing',
  '  period. E.g. {"cmd": "npm run dev", "label": "Start the app in development"}.',
  '',
  'Respond with ONLY JSON: {"commands":[{"cmd":"...","label":"..."}]} — no prose, no fence.'
].join('\n')

// --- candidate assembly ----------------------------------------------------

const norm = (s) => (typeof s === 'string' ? s.trim() : '')

// Bare name of a declared command's label ("dev" from an npm script, a recipe/target
// name) lower-cased, for the FRIENDLY map and PRIORITY check.
const baseName = (label) => norm(label).toLowerCase()

function friendlyLabel(name) {
  return FRIENDLY[name] || norm(name)
}

// Build a de-duped set only from declarative project metadata, excluding anything the
// user explicitly favorited. Runtime terminal text and command history are not inputs.
export function buildCandidates({ project = [], favorites = [] }) {
  const faved = new Set(favorites.map((f) => f.cmd))
  const byCmd = new Map()

  for (const p of project) {
    const cmd = norm(p.cmd)
    if (!cmd || faved.has(cmd) || byCmd.has(cmd)) continue
    const name = baseName(p.label)
    byCmd.set(cmd, { cmd, kind: 'script', name, label: friendlyLabel(name) })
  }
  return [...byCmd.values()]
}

// Deterministic ordering — the baseline result AND the backfill for the model's picks.
// Put the project's familiar entrypoints first, then preserve declaration order.
export function baselineOrder(candidates) {
  const scripts = PRIORITY.map((p) =>
    candidates.find((c) => c.kind === 'script' && c.name === p)
  ).filter(Boolean)
  const otherScripts = candidates.filter((c) => c.kind === 'script' && !PRIORITY.includes(c.name))
  return [...scripts, ...otherScripts].slice(0, MAX_SUGGESTIONS)
}

const toOut = (c) => ({ cmd: c.cmd, label: c.label })

// The deterministic ordered candidates, the {cmd,label} baseline list (≤5) shown when
// there's no model, and the (capped) candidate order to hand the model — baseline first
// so a small model sees the strongest signal early.
export function planSuggestions(candidates) {
  const ordered = baselineOrder(candidates)
  const baseline = ordered.map(toOut).slice(0, MAX_SUGGESTIONS)
  const candidateOrder = [
    ...ordered,
    ...candidates.filter((c) => !ordered.some((o) => o.cmd === c.cmd))
  ].slice(0, MAX_CANDIDATES)
  return { ordered, baseline, candidateOrder }
}

// --- model prompt + reply parsing ------------------------------------------

export function buildUserText(projectName, candidateOrder) {
  const name = projectName || 'this folder'
  const lines = candidateOrder.map((c) => `- ${c.cmd}  [script]`)
  return `project: ${name}\n\nCANDIDATE COMMANDS:\n${lines.join('\n')}`
}

// Pull the outermost {...} out of a model reply and parse it; tolerant of a code
// fence or stray prose a small model may wrap around the JSON.
function extractJson(text) {
  if (typeof text !== 'string') return null
  const stripped = text.replace(/```(?:json)?/gi, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return null
  }
}

function sanitizeLabel(s) {
  return norm(s)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .slice(0, 48)
    .trim()
}

// Turn the model reply into validated picks. GROUNDING: keep only commands that exist
// in the candidate set (exact match) — this is what makes a tiny model safe here.
// Unknown/invented commands are silently dropped.
function parseModelPicks(text, byCmd) {
  const obj = extractJson(text)
  const arr = obj && Array.isArray(obj.commands) ? obj.commands : null
  if (!arr) return []
  const out = []
  const seen = new Set()
  for (const item of arr) {
    const cmd = norm(item && item.cmd)
    const cand = byCmd.get(cmd)
    if (!cand || seen.has(cmd)) continue
    seen.add(cmd)
    const label = sanitizeLabel(item.label) || cand.label
    out.push({ cmd, label })
    if (out.length >= MAX_SUGGESTIONS) break
  }
  return out
}

// Combine a model reply with the deterministic baseline into the final ≤5 list.
// `raw` is the model's text (or null when Pulse is off/unreachable/failed). Returns
// { list, degraded } — degraded=true means the model didn't contribute (baseline only),
// which the caller caches with a shorter TTL so it upgrades once Pulse comes online.
export function finalizeSuggestions(raw, candidates, baseline) {
  if (!raw) return { list: baseline, degraded: true }
  const byCmd = new Map(candidates.map((c) => [c.cmd, c]))
  const picks = parseModelPicks(raw, byCmd)
  if (!picks.length) return { list: baseline, degraded: true }

  // Trust the model's curation, but guarantee a useful list: fill any remaining slots
  // from the baseline so a thin/timid reply still gives up to 5.
  const merged = [...picks]
  for (const b of baseline) {
    if (merged.length >= MAX_SUGGESTIONS) break
    if (!merged.some((m) => m.cmd === b.cmd)) merged.push(b)
  }
  return { list: merged.slice(0, MAX_SUGGESTIONS), degraded: false }
}
