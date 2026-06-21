// Workspace search runs here, OFF the main process thread. A user-supplied regex
// (regex mode in the search UI) can exhibit catastrophic backtracking (ReDoS); on
// the main thread a single pathological `regex.exec()` would freeze every window
// and stall all PTY/IPC traffic indefinitely. Isolating the walk+match in a
// worker_threads Worker lets the parent terminate() it on a timeout instead.
//
// The regex is COMPILED in the parent (cheap, and catches invalid patterns there);
// only the MATCHING — the part that backtracks — happens here. We receive the
// regex source/flags via workerData and rebuild it.
import { parentPort, workerData } from 'worker_threads'
import fs from 'fs/promises'
import path from 'path'

// Directories we never descend into when searching.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  '.svn',
  '.hg',
  'coverage',
  '.vite'
])

// Hard limits so a huge tree or a too-broad query can't return unbounded data.
const MAX_FILES = 5000 // files scanned per search
const MAX_RESULTS = 2000 // total matching lines returned
const MAX_FILE_BYTES = 1024 * 1024 // skip files larger than 1 MB
const MAX_MATCHES_PER_LINE = 50

// Cheap binary sniff: NUL byte in the first chunk means "not text".
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function run({ root, regexSource, regexFlags }) {
  const regex = new RegExp(regexSource, regexFlags)
  const files = []
  let totalMatches = 0
  let filesScanned = 0
  let truncated = false

  async function walk(dir) {
    if (truncated) return
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (truncated) return
      if (SKIP_DIRS.has(d.name)) continue
      const full = path.join(dir, d.name)
      if (d.isDirectory()) {
        await walk(full)
      } else if (d.isFile()) {
        if (filesScanned >= MAX_FILES) {
          truncated = true
          return
        }
        filesScanned++
        await scanFile(full)
      }
    }
  }

  async function scanFile(full) {
    let buf
    try {
      const stat = await fs.stat(full)
      if (stat.size > MAX_FILE_BYTES) return
      buf = await fs.readFile(full)
    } catch {
      return
    }
    if (looksBinary(buf)) return

    const content = buf.toString('utf8')
    const lines = content.split('\n')
    const matches = []
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]
      regex.lastIndex = 0
      let m
      const ranges = []
      let guard = 0
      while ((m = regex.exec(text)) !== null) {
        ranges.push([m.index, m.index + m[0].length])
        if (m[0].length === 0) regex.lastIndex++ // avoid zero-width infinite loop
        if (++guard >= MAX_MATCHES_PER_LINE) break
      }
      if (ranges.length === 0) continue
      matches.push({ line: i + 1, text: text.length > 400 ? text.slice(0, 400) : text, ranges })
      totalMatches += ranges.length
      if (totalMatches >= MAX_RESULTS) {
        truncated = true
        break
      }
    }
    if (matches.length === 0) return
    const rel = path.relative(root, full)
    const norm = rel.replace(/\\/g, '/')
    const idx = norm.lastIndexOf('/')
    files.push({
      path: full,
      name: idx === -1 ? norm : norm.slice(idx + 1),
      dir: idx === -1 ? '' : norm.slice(0, idx),
      matches
    })
  }

  await walk(root)
  files.sort((a, b) => (a.dir + a.name).localeCompare(b.dir + b.name))
  return { files, totalMatches, truncated }
}

run(workerData)
  .then((res) => parentPort.postMessage(res))
  .catch((err) =>
    parentPort.postMessage({
      files: [],
      totalMatches: 0,
      truncated: false,
      error: String((err && err.message) || err)
    })
  )
