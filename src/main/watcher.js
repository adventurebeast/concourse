import fs from 'fs'

// Per-window recursive filesystem watcher for the open workspace folder.
//
// The file tree is otherwise only re-read after in-app actions (new file/folder,
// rename, delete), so changes made OUTSIDE the app — another editor, a terminal,
// an agent writing files — never showed up until you reopened the folder. This
// watches the open root and, after a short debounce that coalesces bursts (a git
// checkout, an `npm install`), tells that window's renderer to re-read its tree
// via fileTree.refresh() (which preserves expansion + selection).
//
// macOS and Windows support { recursive: true } natively; the app targets macOS.
// Watching is best-effort: if it can't start (unsupported platform, path gone) we
// fail silently and the manual flow still works.

// High-churn / uninteresting paths. We still WATCH them — recursive fs.watch can't
// prune subtrees — but a change inside one never triggers a refresh, so a busy
// node_modules, .git, or build dir doesn't spam the tree.
const IGNORED =
  /(^|[/\\])(node_modules|\.git|\.hg|\.svn|dist|out|build|coverage|\.next|\.nuxt|\.cache|\.vite|\.DS_Store)([/\\]|$)/

// A few files INSIDE .git DO reflect git state worth surfacing in the explorer:
// HEAD (current branch), refs/packed-refs (commits + branch tips). We re-admit
// just these so a `git commit` or branch switch in a terminal repaints the tree's
// per-file status, while .git/objects + .git/logs stay filtered. We deliberately
// leave .git/index ignored: `git status` itself can rewrite it (→ refresh loop),
// and staging alone never changes a file's explorer letter (it stays 'M').
const GIT_STATE =
  /(^|[/\\])\.git[/\\]((HEAD|ORIG_HEAD|MERGE_HEAD|packed-refs)$|refs[/\\])/

const DEBOUNCE_MS = 150

// A bounded restart schedule for a watcher that errors out: back off across these
// delays, then give up (the renderer's manual Refresh still works). A successful
// change event resets the attempt counter, so a watcher that recovers can ride out
// a future error too.
const RESTART_DELAYS = [500, 1000, 2000, 4000, 8000]

export function createWatchers() {
  const byId = new Map() // webContents.id -> { watcher, timer, restartTimer, attempts }

  function stop(id) {
    const entry = byId.get(id)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.restartTimer) clearTimeout(entry.restartTimer)
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    byId.delete(id)
  }

  // Push watcher health ('watching' | 'degraded') to the window's renderer so the
  // explorer can flag a stalled watcher. Best-effort.
  function pushStatus(win, flag) {
    if (win && !win.isDestroyed()) win.webContents.send('fs:watch-status', flag)
  }

  // The watcher for `id` died — schedule a bounded restart with backoff. Past the
  // last delay we stay degraded and stop retrying; manual refresh still works.
  function scheduleRestart(win, root, id) {
    const entry = byId.get(id)
    if (!entry) return
    if (entry.restartTimer) clearTimeout(entry.restartTimer)
    const delay = RESTART_DELAYS[entry.attempts]
    pushStatus(win, 'degraded')
    if (delay === undefined) return // exhausted — leave it degraded
    const attempts = entry.attempts + 1
    entry.restartTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      start(win, root, attempts)
    }, delay)
  }

  // Start (or replace) the watcher for `win` on `root`. Called whenever a window's
  // workspace root changes; replacing tears down the previous folder's watcher.
  // `attempts` carries the backoff count across a restart (0 for a fresh start).
  function start(win, root, attempts = 0) {
    if (!win || win.isDestroyed()) return
    const id = win.webContents.id
    stop(id)
    if (!root) return

    let watcher
    try {
      watcher = fs.watch(root, { recursive: true })
    } catch {
      // Couldn't even open the watch — retry on the same backoff schedule.
      const entry = { watcher: null, timer: null, restartTimer: null, attempts }
      byId.set(id, entry)
      scheduleRestart(win, root, id)
      return
    }
    const entry = { watcher, timer: null, restartTimer: null, attempts }
    byId.set(id, entry)
    pushStatus(win, 'watching')

    watcher.on('error', () => scheduleRestart(win, root, id))
    watcher.on('change', (_type, filename) => {
      // filename is relative to root (and may be null on some platforms).
      // Skip ignored subtrees, but let the handful of git-state files through so
      // commits / branch switches still trigger a refresh.
      if (filename) {
        const f = String(filename)
        if (IGNORED.test(f) && !GIT_STATE.test(f)) return
      }
      // A healthy event: the watcher recovered, so reset the backoff counter.
      entry.attempts = 0
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        if (!win.isDestroyed()) win.webContents.send('fs:changed')
      }, DEBOUNCE_MS)
    })
  }

  return { start, stop }
}
