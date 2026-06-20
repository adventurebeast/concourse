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

const DEBOUNCE_MS = 150

export function createWatchers() {
  const byId = new Map() // webContents.id -> { watcher, timer }

  function stop(id) {
    const entry = byId.get(id)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.watcher.close()
    } catch {
      /* already closed */
    }
    byId.delete(id)
  }

  // Start (or replace) the watcher for `win` on `root`. Called whenever a window's
  // workspace root changes; replacing tears down the previous folder's watcher.
  function start(win, root) {
    if (!win || win.isDestroyed()) return
    const id = win.webContents.id
    stop(id)
    if (!root) return

    let watcher
    try {
      watcher = fs.watch(root, { recursive: true })
    } catch {
      return // watching unsupported here — manual refresh still works
    }
    const entry = { watcher, timer: null }
    byId.set(id, entry)

    watcher.on('error', () => stop(id))
    watcher.on('change', (_type, filename) => {
      // filename is relative to root (and may be null on some platforms).
      if (filename && IGNORED.test(String(filename))) return
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        if (!win.isDestroyed()) win.webContents.send('fs:changed')
      }, DEBOUNCE_MS)
    })
  }

  return { start, stop }
}
