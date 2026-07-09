import { isNoise, recencyBoost } from './command-sources.js'

// Pure helpers behind per-project command capture. The PTY's shell-integration
// hook (see ipc-pty.js) emits each command the user runs as an invisible OSC
// marker on the terminal's output stream; we pull those markers back out here and
// rank the accumulated per-project counts by frecency. Kept free of any electron
// import so the parsing and ranking — the riskiest logic — are unit-testable.

// Our private OSC markers. Neither code is one any terminal renders, so xterm.js
// silently ignores them (they never show in the pane) while the main process can
// still read them off the byte stream. Payloads are base64'd in the shell so an
// arbitrary body — quotes, control chars, the BEL/ST terminators themselves —
// can't corrupt or split the marker.
//   ESC ] 5151 ; <base64(command)> BEL — each command the user runs (palette history)
//   ESC ] 5152 ; <base64(cwd)>     BEL — the shell's cwd at each prompt (session resurrection)
const MARK = '\x1b]5151;'
const CWD_MARK = '\x1b]5152;'
const MARKS = [MARK, CWD_MARK]
// Don't let an unterminated marker (a hook half-written, or a coincidental ESC]
// in normal output) grow the carry buffer without bound.
const MAX_CARRY = 64 * 1024
// Ignore absurd command bodies (a giant heredoc/paste) — they're not "frequent
// commands" anyone wants relaunched, and they'd bloat the store.
const MAX_CMD_LEN = 1000

// Longest suffix of `s` that is a (non-full) prefix of ANY marker — i.e. a marker
// whose start landed at the very end of a chunk and will complete in the next
// one. We keep only this so normal output never accumulates.
function partialMarkTail(s) {
  const maxLen = Math.max(...MARKS.map((m) => m.length))
  const max = Math.min(maxLen - 1, s.length)
  for (let n = max; n > 0; n--) {
    const tail = s.slice(s.length - n)
    if (MARKS.some((m) => m.startsWith(tail))) return tail
  }
  return ''
}

function decode(b64) {
  try {
    const cmd = Buffer.from(b64, 'base64').toString('utf8').trim()
    if (!cmd || cmd.length > MAX_CMD_LEN) return null
    return cmd
  } catch {
    return null
  }
}

// Earliest occurrence of any marker in `s` from `from`, or null.
function nextMark(s) {
  let best = null
  for (const mark of MARKS) {
    const at = s.indexOf(mark)
    if (at !== -1 && (best === null || at < best.at)) best = { at, mark }
  }
  return best
}

// Pull every complete marker out of `buf`, returning the decoded commands and
// cwds plus the `rest` to carry into the next chunk (an incomplete trailing
// marker, or a partial-prefix tail). `buf` is the previous rest concatenated
// with new data.
export function extractCommands(buf) {
  const cmds = []
  const cwds = []
  let rest = buf
  // A runaway carry (unterminated marker) — give up on it rather than grow forever.
  if (rest.length > MAX_CARRY) {
    const start = Math.max(...MARKS.map((m) => rest.lastIndexOf(m)))
    rest = start === -1 ? '' : rest.slice(start)
    if (rest.length > MAX_CARRY) return { cmds, cwds, rest: '' }
  }
  for (;;) {
    const hit = nextMark(rest)
    if (!hit) {
      rest = partialMarkTail(rest)
      break
    }
    const payloadStart = hit.at + hit.mark.length
    let end = rest.indexOf('\x07', payloadStart) // BEL terminator
    let termLen = 1
    const st = rest.indexOf('\x1b\\', payloadStart) // ST terminator
    if (st !== -1 && (end === -1 || st < end)) {
      end = st
      termLen = 2
    }
    if (end === -1) {
      rest = rest.slice(hit.at) // marker not finished yet — carry it whole
      break
    }
    const body = decode(rest.slice(payloadStart, end))
    if (body) (hit.mark === CWD_MARK ? cwds : cmds).push(body)
    rest = rest.slice(end + termLen)
  }
  return { cmds, cwds, rest }
}

// Whether a captured command is worth storing: real (non-noise) and not absurdly
// long. Bare navigation/tidy commands (`ls`, `cd ..`) share the palette's noise
// filter so the per-project list mirrors what "Frequent" deserves to surface.
export function keepCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false
  const c = cmd.trim()
  return !!c && c.length <= MAX_CMD_LEN && !isNoise(c)
}

// Rank a per-project { cmd -> { count, lastTs } } map by frecency (same zoxide-
// style weighting as the shell-history ranker), de-noised, capped to `limit`.
// `minCount` is a hard floor on raw run-count: the palette gates display at 2 so a
// command typed once never surfaces, while internal callers (pruning) pass 1 to
// keep every stored entry in play. The floor is applied BEFORE frecency, so a
// once-run-but-recent command can't ride its recency boost past the gate.
export function rankProjectStats(stats, now, limit = 40, minCount = 1) {
  return Object.entries(stats || {})
    .filter(([cmd, s]) => s && (s.count || 0) >= minCount && keepCommand(cmd))
    .map(([cmd, s]) => ({
      cmd,
      count: s.count || 0,
      score: (s.count || 0) * recencyBoost(s.lastTs || 0, now)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// Sum a { <root>: { <cmd>: { count, lastTs } } } map into one combined
// { <cmd>: { count, lastTs } } bucket — counts added, lastTs the most recent —
// so a command run across several projects ranks by its total use. Backs the
// palette's cross-project "Global" group; the same minCount gate then applies to
// the aggregate, so a command run once in each of two projects (total 2) qualifies.
export function mergeBuckets(projects) {
  const out = {}
  for (const bucket of Object.values(projects || {})) {
    if (!bucket || typeof bucket !== 'object') continue
    for (const [cmd, s] of Object.entries(bucket)) {
      if (!s) continue
      const cur = out[cmd] || { count: 0, lastTs: 0 }
      cur.count += s.count || 0
      cur.lastTs = Math.max(cur.lastTs, s.lastTs || 0)
      out[cmd] = cur
    }
  }
  return out
}
