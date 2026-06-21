import { ipcMain } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'

// Workspace search. The file-walk + regex matching runs in a worker_threads Worker
// (search-worker.js) so a pathological user regex can't freeze the main process —
// see that file's header. Here we resolve+validate on the main thread, then spawn
// the worker with a hard wall-clock timeout and terminate() it if it overruns.

const SEARCH_TIMEOUT_MS = 6000
// search-worker.js is emitted next to this bundle (a second main entry in
// electron.vite.config.mjs) and asarUnpack'd so the Worker can load it from disk.
const workerPath = join(import.meta.dirname, 'search-worker.js')

// Escape a plain query for use inside a RegExp.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildRegex(query, { caseSensitive, wholeWord, useRegex }) {
  let source = useRegex ? query : escapeRegExp(query)
  if (wholeWord) source = `\\b(?:${source})\\b`
  const flags = caseSensitive ? 'g' : 'gi'
  return new RegExp(source, flags)
}

export function registerSearch(ctx) {
  // Find all matching lines under the workspace root.
  // opts: { caseSensitive, wholeWord, useRegex }
  // Returns { files: [{ path, name, dir, matches: [{ line, text, ranges:[[start,end]] }] }],
  //           truncated, totalMatches, error, timedOut }
  ipcMain.handle('search:find', async (_e, query, opts = {}) => {
    const root = ctx.getRoot(_e.sender)
    if (!root) return { files: [], totalMatches: 0, truncated: false, noFolder: true }
    if (!query) return { files: [], totalMatches: 0, truncated: false }

    // Compile on the main thread: cheap, and gives a clean "Invalid pattern" error.
    // Matching (the part that can backtrack) happens in the worker.
    let regex
    try {
      regex = buildRegex(query, opts)
    } catch {
      return { files: [], totalMatches: 0, truncated: false, error: 'Invalid pattern' }
    }

    return await new Promise((resolve) => {
      let settled = false
      let worker = null
      const finish = (val) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (worker) {
          try {
            worker.terminate()
          } catch {
            // ignore — already exiting
          }
        }
        resolve(val)
      }
      // Kill a runaway (e.g. ReDoS) search and report it as truncated.
      const timer = setTimeout(
        () => finish({ files: [], totalMatches: 0, truncated: true, timedOut: true }),
        SEARCH_TIMEOUT_MS
      )
      try {
        worker = new Worker(workerPath, {
          workerData: { root, regexSource: regex.source, regexFlags: regex.flags }
        })
      } catch {
        return finish({ files: [], totalMatches: 0, truncated: false, error: 'Search unavailable' })
      }
      worker.on('message', finish)
      worker.on('error', () =>
        finish({ files: [], totalMatches: 0, truncated: false, error: 'Search failed' })
      )
      worker.on('exit', () => finish({ files: [], totalMatches: 0, truncated: false }))
    })
  })
}
