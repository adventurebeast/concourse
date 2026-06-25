import path from 'path'
import fs from 'fs/promises'

// The data behind the command palette's "This project" group, plus the shared
// noise filter and frecency weighting used to rank the per-project "Frequent"
// list (see command-capture.js / command-history.js).
//   • project command files (package.json scripts, justfile, Makefile) → named,
//     per-project commands surfaced without retyping.
//   • isNoise / recencyBoost → the de-noising and zoxide-style recency weighting
//     applied to captured per-project command counts.
// Everything here is best-effort and read-only: a missing/garbled file yields an
// empty list, never an error that could break the palette.

// Cap project commands so a repo with hundreds of npm scripts can't flood the list.
const PROJECT_LIMIT = 60

// Bare navigation / screen-tidying commands that are noise in a "frequent
// commands" list — you don't need a launcher for `ls`. Only EXACT matches are
// dropped, so `cd /some/project` (a real, reusable command) is kept.
const NOISE = new Set([
  'ls',
  'ls -a',
  'ls -l',
  'ls -la',
  'ls -al',
  'll',
  'la',
  'cd',
  'cd ..',
  'cd -',
  'cd ~',
  'pwd',
  'clear',
  'exit',
  'fg',
  'bg',
  'jobs',
  'history',
  'reset'
])

// Concourse itself types `cd '<dir>' && clear` into a fresh pane when a folder
// opens (cdInto() in terminals.js). The shell hook captures it like any command,
// but the user never wrote it and it's long, pane-setup noise — never a "frequent
// command" worth relaunching. Match the whole line so a real `cd x && npm test`
// is untouched; allow `;` as well as `&&` and trailing whitespace.
const AUTO_CD_CLEAR = /^cd\b.*(&&|;)\s*clear\s*$/

// Anything shorter than 2 chars (single-letter aliases, `z`, etc.) is dropped by
// the length guard, so the set only needs multi-char noise.
export function isNoise(cmd) {
  if (cmd.length < 2) return true
  return NOISE.has(cmd) || AUTO_CD_CLEAR.test(cmd)
}

// zoxide-style frecency: a command's weight is its raw count scaled by how
// recently it was last used, so something run 50× last month ranks below
// something run 10× today. A zero/missing timestamp gets a neutral boost, so
// ranking degrades to pure frequency.
export function recencyBoost(ts, now) {
  if (!ts) return 1
  const age = now - ts
  const HOUR = 3600e3
  const DAY = 24 * HOUR
  const WEEK = 7 * DAY
  if (age < HOUR) return 4
  if (age < DAY) return 2
  if (age < WEEK) return 1
  return 0.4
}

// --- project command files -------------------------------------------------

async function readMaybe(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

// package.json "scripts" → `npm run <name>`.
async function npmScripts(root) {
  const text = await readMaybe(path.join(root, 'package.json'))
  if (!text) return []
  try {
    const pkg = JSON.parse(text)
    const scripts = pkg && pkg.scripts
    if (!scripts || typeof scripts !== 'object') return []
    return Object.keys(scripts).map((name) => ({
      cmd: `npm run ${name}`,
      label: name,
      source: 'npm'
    }))
  } catch {
    return [] // malformed package.json — skip rather than throw
  }
}

// justfile recipes → `just <name>`. A recipe header is `name…:` at column 0; we
// reject `:=` assignments and skip private (_-prefixed) recipes.
async function justRecipes(root) {
  let text = null
  for (const name of ['justfile', 'Justfile', '.justfile']) {
    text = await readMaybe(path.join(root, name))
    if (text) break
  }
  if (!text) return []
  const out = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    // Recipe headers start at column 0 with a name (bodies are indented, comments
    // start with '#', attributes with '['). Find the first ':'; if it's immediately
    // followed by '=' the line is an assignment (`name := value`), not a recipe.
    // Scanning for the colon (vs. one regex) keeps recipes whose params carry a
    // default value, e.g. `serve port="8080":`.
    const m = /^([a-zA-Z][\w-]*)/.exec(line)
    if (!m) continue
    const colon = line.indexOf(':')
    if (colon === -1 || line[colon + 1] === '=') continue
    const name = m[1]
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ cmd: `just ${name}`, label: name, source: 'just' })
  }
  return out
}

// Makefile targets → `make <name>`. Reject `:=` assignments, `.PHONY`/dot
// targets (start with '.') and pattern rules ('%'), which all fail the leading
// [a-zA-Z] anchor.
async function makeTargets(root) {
  let text = null
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    text = await readMaybe(path.join(root, name))
    if (text) break
  }
  if (!text) return []
  const out = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    if (!/^[a-zA-Z]/.test(line)) continue // indented bodies, .PHONY/dot, % patterns, comments
    const colon = line.indexOf(':')
    if (colon === -1 || line[colon + 1] === '=') continue // no rule, or a `:=` assignment
    // A rule may list several targets before the colon (`clean dist: deps`).
    for (const name of line.slice(0, colon).trim().split(/\s+/)) {
      if (!/^[a-zA-Z][\w-]*$/.test(name) || seen.has(name)) continue
      seen.add(name)
      out.push({ cmd: `make ${name}`, label: name, source: 'make' })
    }
  }
  return out
}

export async function getProjectCommands(root) {
  if (!root) return []
  const groups = await Promise.all([npmScripts(root), justRecipes(root), makeTargets(root)])
  const out = []
  const seen = new Set()
  for (const g of groups) {
    for (const it of g) {
      if (seen.has(it.cmd)) continue
      seen.add(it.cmd)
      out.push(it)
      if (out.length >= PROJECT_LIMIT) return out
    }
  }
  return out
}
