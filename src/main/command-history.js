import { app } from 'electron'
import path from 'path'
import { writeJsonAtomic, readJson, enqueue, trackPending } from './store-io.js'
import { keepCommand, rankProjectStats } from './command-capture.js'

// Per-project command history — the data behind the palette's "Frequent" group.
// Unlike the old global ~/.zsh_history reader, this records the commands you
// actually run inside Concourse, bucketed by the window's open folder, so each
// project's Frequent list is its own. Capture is fed by the shell-integration
// hook in ipc-pty.js: only real shell commands fire it, so commands typed into
// Claude/vim/etc. (which are stdin to that program, not the shell) never land
// here. On disk: { version, projects: { "<root>": { "<cmd>": { count, lastTs } } } }.
const SCHEMA_VERSION = 1
const HISTORY_LIMIT = 40
// Cap entries per project so a long-lived project can't grow without bound; when
// exceeded we keep the most frecent and drop the tail.
const MAX_PER_PROJECT = 300
// Coalesce the bursty per-command writes — we mutate in memory immediately and
// flush at most this often. trackPending() means an un-flushed change still drains
// on quit via store-io's flushSync().
const FLUSH_DELAY_MS = 1500

function storePath() {
  return path.join(app.getPath('userData'), 'command-history.json')
}

let state = null // { version, projects } — authoritative once loaded
let loading = null
let flushTimer = null

async function ensureLoaded() {
  if (state) return state
  if (!loading) {
    loading = (async () => {
      const data = await readJson(storePath(), null)
      const projects =
        data && data.projects && typeof data.projects === 'object' ? data.projects : {}
      state = { version: SCHEMA_VERSION, projects }
      return state
    })()
  }
  return loading
}

function scheduleFlush() {
  trackPending(storePath(), state) // so quit's flushSync persists even if the timer hasn't fired
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const snapshot = { version: SCHEMA_VERSION, projects: state.projects }
    enqueue(() => writeJsonAtomic(storePath(), snapshot))
  }, FLUSH_DELAY_MS)
  if (flushTimer.unref) flushTimer.unref() // never keep the process alive for a flush
}

// Drop the least-frecent entries once a project exceeds the cap.
function prune(bucket, now) {
  const cmds = Object.keys(bucket)
  if (cmds.length <= MAX_PER_PROJECT) return bucket
  const keep = new Set(rankProjectStats(bucket, now, MAX_PER_PROJECT).map((r) => r.cmd))
  const next = {}
  for (const c of cmds) if (keep.has(c)) next[c] = bucket[c]
  return next
}

// Record one command run in `root`'s project. Best-effort and silent: a missing
// root (shell opened outside any project) or a noise command is simply ignored.
export async function recordCommand(root, cmd) {
  if (!root || !keepCommand(cmd)) return
  const c = cmd.trim()
  await ensureLoaded()
  let bucket = state.projects[root]
  if (!bucket) bucket = state.projects[root] = {}
  const cur = bucket[c] || { count: 0, lastTs: 0 }
  cur.count += 1
  cur.lastTs = Date.now()
  bucket[c] = cur
  state.projects[root] = prune(bucket, cur.lastTs)
  scheduleFlush()
}

// Frecency-ranked commands for `root`, or [] when no folder is open or nothing
// has been captured yet (the palette then shows its "run a few…" empty state).
export async function historyForRoot(root) {
  if (!root) return []
  await ensureLoaded()
  return rankProjectStats(state.projects[root], Date.now(), HISTORY_LIMIT)
}
