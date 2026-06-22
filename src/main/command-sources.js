import os from 'os'
import path from 'path'
import fs from 'fs/promises'

// Reads the user's real command sources and ranks them — the data behind the
// command palette's "Frequent" and "This project" groups. Two sources:
//   • shell history (~/.zsh_history, ~/.bash_history) → frecency-ranked recents,
//     so the commands you actually run most float to the top (vs. Up-Arrow's
//     blind, recency-only, noise-filled cycle).
//   • the project's own command files (package.json scripts, justfile, Makefile)
//     → named, per-project commands surfaced without retyping.
// Everything here is best-effort and read-only: a missing/garbled file yields an
// empty list, never an error that could break the palette.

// --- shell history ---------------------------------------------------------

// Cap how much history we parse: the tail is where your live habits are, and a
// multi-MB history file shouldn't cost anything on each palette open.
const MAX_HISTORY_LINES = 5000
// Hard byte cap on the read itself (not just the ranked output): a pathologically
// large history file (HISTSIZE unset, or a corrupted append) must never be slurped
// whole into the main process — we read only this much from the tail.
const MAX_HISTORY_BYTES = 2_000_000
// How many ranked history commands to hand back.
const HISTORY_LIMIT = 40
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

// Anything shorter than 2 chars (single-letter aliases, `z`, etc.) is dropped by
// the length guard, so the set only needs multi-char noise.
function isNoise(cmd) {
  if (cmd.length < 2) return true
  return NOISE.has(cmd)
}

// One zsh extended-history line looks like `: 1700000000:0;git status`. Plain
// zsh/bash lines are just the command. Returns { ts, cmd } or null to skip.
function parseLine(line) {
  if (!line) return null
  let ts = 0
  let cmd = line
  const ext = /^: (\d+):\d+;([\s\S]*)$/.exec(line)
  if (ext) {
    ts = parseInt(ext[1], 10) * 1000
    cmd = ext[2]
  } else if (line.startsWith('#')) {
    // bash HISTTIMEFORMAT writes `#<epoch>` on its own line before the command —
    // skip the marker; the command on the next line is parsed normally.
    return null
  }
  cmd = cmd.trim()
  if (!cmd) return null
  return { ts, cmd }
}

// Join zsh continuation lines (a trailing backslash escapes the newline) so a
// multi-line command counts as one entry rather than fragments.
export function splitEntries(text) {
  const raw = text.split('\n')
  const entries = []
  let buf = null
  for (const line of raw) {
    buf = buf === null ? line : buf + '\n' + line
    // Odd number of trailing backslashes → the newline was escaped; keep reading.
    const m = /(\\+)$/.exec(buf)
    if (m && m[1].length % 2 === 1) {
      buf = buf.slice(0, -1) // drop the escaping backslash
      continue
    }
    entries.push(buf)
    buf = null
  }
  if (buf !== null) entries.push(buf)
  return entries
}

async function readHistoryEntries(file) {
  try {
    const st = await fs.stat(file)
    let text
    if (st.size > MAX_HISTORY_BYTES) {
      // Read only the last MAX_HISTORY_BYTES; the leading partial line is harmless
      // junk that parseLine drops or that simply ranks low.
      const fh = await fs.open(file, 'r')
      try {
        const buf = Buffer.alloc(MAX_HISTORY_BYTES)
        const { bytesRead } = await fh.read(buf, 0, MAX_HISTORY_BYTES, st.size - MAX_HISTORY_BYTES)
        text = buf.toString('utf8', 0, bytesRead)
      } finally {
        await fh.close()
      }
    } else {
      text = await fs.readFile(file, 'utf8')
    }
    return splitEntries(text).slice(-MAX_HISTORY_LINES) // only the tail matters
  } catch {
    return [] // no such file / unreadable — fine
  }
}

// zoxide-style frecency: a command's weight is its raw count scaled by how
// recently it was last used, so something run 50× last month ranks below
// something run 10× today. Entries with no timestamp (plain history) get a
// neutral boost, so the list degrades to pure frequency.
function recencyBoost(ts, now) {
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

// Rank a flat list of raw history entry strings by frecency, de-noised and
// de-duped. Pure (no file IO) so it's unit-testable; getHistoryCommands feeds it
// the tails of the real history files.
export function rankHistory(entries, now) {
  const stats = new Map() // cmd -> { count, lastTs }
  for (const line of entries) {
    const p = parseLine(line)
    if (!p || isNoise(p.cmd)) continue
    const cur = stats.get(p.cmd) || { count: 0, lastTs: 0 }
    cur.count += 1
    if (p.ts > cur.lastTs) cur.lastTs = p.ts
    stats.set(p.cmd, cur)
  }
  return [...stats.entries()]
    .map(([cmd, s]) => ({ cmd, count: s.count, score: s.count * recencyBoost(s.lastTs, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, HISTORY_LIMIT)
}

let historyCache = null // { key, data } — key is a fingerprint of the source files

export async function getHistoryCommands() {
  const home = os.homedir()
  const files = [path.join(home, '.zsh_history'), path.join(home, '.bash_history')]

  // Cache by a size+mtime fingerprint so rapid re-opens don't re-parse unchanged files.
  let key = ''
  for (const f of files) {
    try {
      const st = await fs.stat(f)
      key += `${f}:${st.mtimeMs}:${st.size};`
    } catch {
      key += `${f}:0;`
    }
  }
  if (historyCache && historyCache.key === key) return historyCache.data

  const allEntries = []
  for (const f of files) allEntries.push(...(await readHistoryEntries(f)))
  const data = rankHistory(allEntries, Date.now())
  historyCache = { key, data }
  return data
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
