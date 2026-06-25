import { isNoise, recencyBoost } from './command-sources.js'

// Pure helpers behind per-project command capture. The PTY's shell-integration
// hook (see ipc-pty.js) emits each command the user runs as an invisible OSC
// marker on the terminal's output stream; we pull those markers back out here and
// rank the accumulated per-project counts by frecency. Kept free of any electron
// import so the parsing and ranking — the riskiest logic — are unit-testable.

// Our private OSC marker: ESC ] 5151 ; <base64(command)> BEL. 5151 isn't a code
// any terminal renders, so xterm.js silently ignores it (the marker never shows
// in the pane) while the main process can still read it off the byte stream. We
// base64 the command in the shell so an arbitrary command body — quotes, control
// chars, the BEL/ST terminators themselves — can't corrupt or split the marker.
const MARK = '\x1b]5151;'
// Don't let an unterminated marker (a hook half-written, or a coincidental ESC]
// in normal output) grow the carry buffer without bound.
const MAX_CARRY = 64 * 1024
// Ignore absurd command bodies (a giant heredoc/paste) — they're not "frequent
// commands" anyone wants relaunched, and they'd bloat the store.
const MAX_CMD_LEN = 1000

// Longest suffix of `s` that is a (non-full) prefix of MARK — i.e. a marker whose
// start landed at the very end of a chunk and will complete in the next one. We
// keep only this so normal output never accumulates.
function partialMarkTail(s) {
  const max = Math.min(MARK.length - 1, s.length)
  for (let n = max; n > 0; n--) {
    if (MARK.startsWith(s.slice(s.length - n))) return s.slice(s.length - n)
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

// Pull every complete command marker out of `buf`, returning the decoded commands
// plus the `rest` to carry into the next chunk (an incomplete trailing marker, or
// a partial-prefix tail). `buf` is the previous rest concatenated with new data.
export function extractCommands(buf) {
  const cmds = []
  let rest = buf
  // A runaway carry (unterminated marker) — give up on it rather than grow forever.
  if (rest.length > MAX_CARRY) {
    const start = rest.lastIndexOf(MARK)
    rest = start === -1 ? '' : rest.slice(start)
    if (rest.length > MAX_CARRY) return { cmds, rest: '' }
  }
  for (;;) {
    const start = rest.indexOf(MARK)
    if (start === -1) {
      rest = partialMarkTail(rest)
      break
    }
    const payloadStart = start + MARK.length
    let end = rest.indexOf('\x07', payloadStart) // BEL terminator
    let termLen = 1
    const st = rest.indexOf('\x1b\\', payloadStart) // ST terminator
    if (st !== -1 && (end === -1 || st < end)) {
      end = st
      termLen = 2
    }
    if (end === -1) {
      rest = rest.slice(start) // marker not finished yet — carry it whole
      break
    }
    const cmd = decode(rest.slice(payloadStart, end))
    if (cmd) cmds.push(cmd)
    rest = rest.slice(end + termLen)
  }
  return { cmds, rest }
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
export function rankProjectStats(stats, now, limit = 40) {
  return Object.entries(stats || {})
    .filter(([cmd, s]) => s && keepCommand(cmd))
    .map(([cmd, s]) => ({
      cmd,
      count: s.count || 0,
      score: (s.count || 0) * recencyBoost(s.lastTs || 0, now)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
