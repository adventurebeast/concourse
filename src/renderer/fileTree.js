import './fileTree.css'
import { showToast } from './toast.js'

const api = window.api

// Git status letter -> color / tooltip, mirroring the SCM panel (git.js) so the
// explorer indicators read the same way. Folders roll up to a single dot.
const STATUS_COLOR = {
  M: 'var(--orange)',
  A: 'var(--green)',
  U: 'var(--green)',
  D: 'var(--red)',
  R: 'var(--orange)'
}
const STATUS_TITLE = {
  M: 'Modified',
  A: 'Added',
  U: 'Untracked',
  D: 'Deleted',
  R: 'Renamed'
}
// When a path carries more than one status, the higher rank wins.
const STATUS_RANK = { U: 1, A: 2, R: 3, M: 4, D: 5 }

// ---------- Icons (Lucide-style mono outline, matching the app chrome) ----------
function svg(body, color, size = 16) {
  return `<svg class="ft-svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
}

const FOLDER_COLOR = '#5a8bbd'

function folderIcon(open) {
  if (open) {
    return svg(
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
      FOLDER_COLOR
    )
  }
  return svg(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    FOLDER_COLOR
  )
}

// File glyphs by category — distinguished by shape, with muted tints that read
// on both light and dark backgrounds.
const GLYPHS = {
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  code: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 13 2 2-2 2"/>',
  data: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  archive:
    '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'
}

// A generic file glyph in an arbitrary color (used by the inline-create row).
function fileGlyph(color) {
  return svg(GLYPHS.file, color)
}

// Muted category tints (work on light + dark).
const CAT_COLOR = {
  file: 'currentColor',
  code: '#4a90d9',
  data: '#c0892f',
  doc: '#5a9aa8',
  image: '#9b72c6',
  archive: '#9a9a9a'
}

// Extension -> category.
const EXT_CAT = {
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  cc: 'code',
  cs: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  css: 'code',
  scss: 'code',
  sass: 'code',
  less: 'code',
  html: 'code',
  htm: 'code',
  vue: 'code',
  svelte: 'code',
  xml: 'code',
  sql: 'code',
  json: 'data',
  yml: 'data',
  yaml: 'data',
  toml: 'data',
  env: 'data',
  lock: 'data',
  ini: 'data',
  conf: 'data',
  md: 'doc',
  markdown: 'doc',
  txt: 'doc',
  log: 'doc',
  pdf: 'doc',
  rst: 'doc',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  ico: 'image',
  svg: 'image',
  bmp: 'image',
  zip: 'archive',
  gz: 'archive',
  tar: 'archive',
  tgz: 'archive',
  rar: 'archive',
  '7z': 'archive'
}

// Specific full-name overrides (manifests, dotfiles).
const NAME_CAT = {
  'package.json': 'data',
  'package-lock.json': 'data',
  'tsconfig.json': 'data',
  'jsconfig.json': 'data',
  '.gitignore': 'data',
  '.gitattributes': 'data',
  '.npmrc': 'data',
  '.editorconfig': 'data',
  '.env': 'data',
  dockerfile: 'code',
  'readme.md': 'doc',
  license: 'doc',
  'license.md': 'doc'
}

function fileIcon(name) {
  const lower = name.toLowerCase()
  let cat = NAME_CAT[lower]
  if (!cat) {
    const dot = lower.lastIndexOf('.')
    const ext = dot >= 0 ? lower.slice(dot + 1) : ''
    cat = EXT_CAT[ext] || 'file'
  }
  return svg(GLYPHS[cat], CAT_COLOR[cat])
}

const chevron = svg('<path d="m9 18 6-6-6-6"/>', 'currentColor', 16)

function basename(p) {
  if (!p) return ''
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}
function dirname(p) {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx <= 0 ? trimmed.slice(0, idx + 1) || trimmed : trimmed.slice(0, idx)
}
function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.replace(/[/\\]+$/, '') + sep + name
}
function isSameOrDescendant(candidate, parent) {
  const c = candidate.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  return c === p || c.startsWith(p + '/')
}
// Path relative to the workspace root (for "Copy Relative Path"). Falls back to
// the basename if the entry somehow sits outside the root.
function relativeTo(base, p) {
  if (!base) return basename(p)
  const b = base.replace(/[/\\]+$/, '')
  if (p === b) return basename(p)
  if (p.startsWith(b + '/') || p.startsWith(b + '\\')) return p.slice(b.length + 1)
  return basename(p)
}

export function createFileTree({
  onOpenFile,
  onOpenTerminal,
  onFindInFolder,
  onPathChanged,
  onGitChanged
}) {
  const container = document.getElementById('file-tree')
  container.tabIndex = 0
  container.setAttribute('role', 'tree')
  container.setAttribute('aria-label', 'Workspace files')
  const modifier = api.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const trashLabel = api.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash'
  let root = null
  const expanded = new Set() // absolute paths of expanded folders
  let selected = null // absolute path of selected row
  let clipboardPath = null // absolute path of the entry copied with ⌘C, for ⌘V paste
  let clipboardMode = 'copy'
  let draggedPath = null // workspace entry currently being moved with internal DnD

  // ---------- Rendering ----------
  // We render the visible tree from a cache of directory children so that
  // refresh can preserve expansion without re-walking lazily.
  const childrenCache = new Map() // dirPath -> [{name,path,isDir}]

  // ---------- Git status decoration ----------
  // Per-path status derived from the SCM status (applyGitStatus). Files map to
  // their own letter; folders roll up to 'M' (contains tracked changes) or 'U'
  // (contains only untracked files). Rows read these maps in decorateRow.
  const fileStatus = new Map() // absPath -> 'M'|'A'|'U'|'D'|'R'
  const dirStatus = new Map() // absPath -> 'M'|'U'
  let stagedPaths = new Set()
  let changedPaths = new Set()

  function absOf(rel) {
    const base = root.replace(/[/\\]+$/, '')
    return base + '/' + rel.replace(/\\/g, '/')
  }

  // Paint (or clear) a single rendered row's git indicator.
  function decorateRow(row) {
    const path = row.dataset.path
    const isDir = row.dataset.dir === '1'
    const label = row.querySelector('.ft-label')
    const old = row.querySelector('.ft-status')
    if (old) old.remove()
    if (label) label.style.color = ''
    row.classList.remove('ft-changed')

    const st = isDir ? dirStatus.get(path) : fileStatus.get(path)
    if (!st) return

    const color = STATUS_COLOR[st] || 'var(--text)'
    row.classList.add('ft-changed')
    if (label) label.style.color = color
    const badge = document.createElement('span')
    badge.className = 'ft-status' + (isDir ? ' ft-status-dir' : '')
    badge.textContent = isDir ? '●' : st
    badge.style.color = color
    badge.title = STATUS_TITLE[st] ? STATUS_TITLE[st] + (isDir ? ' contents' : '') : ''
    row.appendChild(badge)
  }

  function decorateAll() {
    for (const row of container.querySelectorAll('.ft-row[data-path]')) decorateRow(row)
  }

  // Snapshot of the status maps that the DOM currently reflects, so a subsequent
  // applyGitStatus can repaint only the rows whose letter/dot actually changed
  // (PR-4.10 diff-and-patch) instead of touching every visible row.
  let paintedFileStatus = new Map()
  let paintedDirStatus = new Map()

  // Compute the fresh fileStatus/dirStatus maps from an SCM status object
  // ({ staged, changes }) into the live maps. Returns true on success, false if
  // the incoming shape is unusable (caller then leaves the maps as built).
  function rebuildStatusMaps(status) {
    fileStatus.clear()
    dirStatus.clear()
    stagedPaths = new Set((status?.staged || []).map((entry) => entry?.path).filter(Boolean))
    changedPaths = new Set((status?.changes || []).map((entry) => entry?.path).filter(Boolean))
    if (root && status && status.isRepo) {
      const entries = [...(status.staged || []), ...(status.changes || [])]
      for (const e of entries) {
        if (!e || !e.path) continue
        const abs = absOf(e.path)
        const prev = fileStatus.get(abs)
        if (!prev || (STATUS_RANK[e.status] || 0) > (STATUS_RANK[prev] || 0)) {
          fileStatus.set(abs, e.status)
        }
        // Roll the change up through every ancestor folder to the root.
        const tracked = e.status !== 'U'
        let dir = dirname(abs)
        while (dir && dir.length >= root.length) {
          if (tracked) dirStatus.set(dir, 'M')
          else if (!dirStatus.get(dir)) dirStatus.set(dir, 'U')
          if (dir === root) break
          const parent = dirname(dir)
          if (parent === dir) break
          dir = parent
        }
      }
    }
    return true
  }

  // Re-decorate only the rows whose status changed between the painted snapshot
  // and the freshly built maps. Paths in either snapshot that differ get their
  // row touched; rows that don't currently exist in the DOM are skipped (they'll
  // pick up the right badge from decorateRow when they're next rendered). Returns
  // false to signal the caller it should fall back to a full repaint.
  function patchChangedRows() {
    const touched = new Set()
    const collect = (path, oldMap, newMap) => {
      if (touched.has(path)) return
      if ((oldMap.get(path) || '') !== (newMap.get(path) || '')) touched.add(path)
    }
    for (const p of paintedFileStatus.keys()) collect(p, paintedFileStatus, fileStatus)
    for (const p of fileStatus.keys()) collect(p, paintedFileStatus, fileStatus)
    for (const p of paintedDirStatus.keys()) collect(p, paintedDirStatus, dirStatus)
    for (const p of dirStatus.keys()) collect(p, paintedDirStatus, dirStatus)

    for (const path of touched) {
      const row = container.querySelector(`.ft-row[data-path="${cssEscape(path)}"]`)
      if (row && !row.classList.contains('ft-inline')) decorateRow(row)
    }
    return true
  }

  // Rebuild the status maps from an SCM status object ({ staged, changes }) and
  // repaint visible rows without disturbing expansion or an in-progress rename.
  // PR-4.10: when we already hold a painted snapshot we patch only the rows whose
  // status changed; on the first status (no snapshot) or on any unexpected shape
  // we fall back to decorateAll() so the tree can never end up half-painted.
  function applyGitStatus(status) {
    const hadSnapshot = paintedFileStatus.size > 0 || paintedDirStatus.size > 0
    let ok = false
    try {
      if (rebuildStatusMaps(status)) {
        ok = hadSnapshot ? patchChangedRows() : false
      }
    } catch {
      ok = false
    }
    if (!ok) decorateAll()
    // Record what the DOM now reflects so the next call can diff against it.
    paintedFileStatus = new Map(fileStatus)
    paintedDirStatus = new Map(dirStatus)
  }

  async function loadChildren(dirPath) {
    try {
      const list = await api.fs.readDir(dirPath)
      childrenCache.set(dirPath, list)
      return list
    } catch {
      childrenCache.set(dirPath, [])
      return []
    }
  }

  function makeRow({ entry, depth }) {
    const row = document.createElement('div')
    row.className = 'ft-row'
    row.tabIndex = 0 // focusable so the explorer can own keyboard focus (⌘⌫ to delete)
    row.dataset.path = entry.path
    row.dataset.dir = entry.isDir ? '1' : '0'
    row.draggable = true
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-level', String(depth + 1))
    row.setAttribute('aria-selected', String(entry.path === selected))
    row.style.paddingLeft = 4 + depth * 12 + 'px'
    if (entry.path === selected) row.classList.add('selected')

    const isOpen = entry.isDir && expanded.has(entry.path)
    if (entry.isDir) row.setAttribute('aria-expanded', String(isOpen))

    const twisty = document.createElement('span')
    twisty.className = 'ft-twisty'
    if (entry.isDir) {
      twisty.innerHTML = chevron
      twisty.classList.toggle('open', isOpen)
    }
    row.appendChild(twisty)

    const icon = document.createElement('span')
    icon.className = 'ft-icon'
    icon.innerHTML = entry.isDir ? folderIcon(isOpen) : fileIcon(entry.name)
    row.appendChild(icon)

    const label = document.createElement('span')
    label.className = 'ft-label'
    label.textContent = entry.name
    row.appendChild(label)

    row.addEventListener('click', (e) => {
      e.stopPropagation()
      selectRow(entry.path)
      if (entry.isDir) {
        toggleFolder(entry.path)
      } else {
        onOpenFile(entry.path)
      }
    })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      selectRow(entry.path)
      openContextMenu(e.clientX, e.clientY, entry)
    })
    row.addEventListener('dragstart', (e) => {
      draggedPath = entry.path
      row.classList.add('ft-dragging')
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-concourse-path', entry.path)
    })
    row.addEventListener('dragend', () => {
      draggedPath = null
      row.classList.remove('ft-dragging')
      clearDropHover()
    })

    decorateRow(row)
    return row
  }

  // Build a children container (for a folder's subtree) recursively, only
  // descending into folders that are in the `expanded` set.
  function buildChildrenEls(dirPath, depth) {
    const frag = document.createDocumentFragment()
    const list = childrenCache.get(dirPath) || []
    for (const entry of list) {
      frag.appendChild(makeRow({ entry, depth }))
      if (entry.isDir && expanded.has(entry.path)) {
        frag.appendChild(buildChildrenEls(entry.path, depth + 1))
      }
    }
    return frag
  }

  function render() {
    closeInlineEdit()
    // The scroll container (#file-tree) resets scrollTop to 0 when we blow away
    // and rebuild its contents, snapping the explorer back to the top on every
    // expand/collapse/refresh. Capture the position before the rebuild and
    // restore it after so the user keeps their place.
    const prevScroll = container.scrollTop
    container.innerHTML = ''
    if (!root) return
    container.appendChild(buildChildrenEls(root, 0))
    container.scrollTop = prevScroll
  }

  // Ensure children for `root` and every expanded folder are cached, then render.
  async function ensureAndRender() {
    const need = [root, ...expanded]
    await Promise.all(need.map((p) => (childrenCache.has(p) ? Promise.resolve() : loadChildren(p))))
    render()
  }

  function selectRow(path) {
    selected = path
    for (const el of container.querySelectorAll('.ft-row.selected')) {
      el.classList.remove('selected')
      el.setAttribute('aria-selected', 'false')
    }
    const row = container.querySelector(`.ft-row[data-path="${cssEscape(path)}"]`)
    if (row) {
      row.classList.add('selected')
      row.setAttribute('aria-selected', 'true')
      // Pull keyboard focus into the explorer so ⌘⌫ targets this row. preventScroll
      // keeps the tree from jumping. Opening a file refocuses the editor afterward,
      // which is fine — the row stays visibly selected either way.
      row.focus({ preventScroll: true })
    }
  }

  async function toggleFolder(path) {
    if (expanded.has(path)) {
      expanded.delete(path)
    } else {
      expanded.add(path)
      if (!childrenCache.has(path)) await loadChildren(path)
    }
    render()
    selectRow(path)
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s)
    return s.replace(/["\\]/g, '\\$&')
  }

  // ---------- Public API ----------
  async function load(newRoot) {
    root = newRoot
    closeMenu()
    closeConfirm()
    expanded.clear()
    childrenCache.clear()
    selected = null
    clipboardPath = null
    clipboardMode = 'copy'
    fileStatus.clear()
    dirStatus.clear()
    stagedPaths.clear()
    changedPaths.clear()
    // Root changed — drop the painted snapshot so the next applyGitStatus takes
    // the full decorateAll() fallback rather than diffing against stale paths.
    paintedFileStatus = new Map()
    paintedDirStatus = new Map()
    const nameEl = document.getElementById('workspace-name')

    // No folder open — show a call-to-action instead of a tree.
    if (!root) {
      if (nameEl) {
        nameEl.textContent = ''
        nameEl.hidden = true
      }
      container.innerHTML = ''
      const hint = document.createElement('div')
      hint.className = 'empty-hint'
      hint.innerHTML = '<p>You have not opened a folder.</p>'
      const btn = document.createElement('button')
      btn.className = 'btn'
      btn.textContent = 'Open Folder'
      btn.style.marginTop = '10px'
      btn.addEventListener('click', () => document.getElementById('open-folder').click())
      hint.appendChild(btn)
      container.appendChild(hint)
      return
    }

    if (nameEl) {
      nameEl.textContent = (basename(root) || '').toUpperCase()
      nameEl.hidden = false
    }
    await loadChildren(root)
    render()
  }

  async function refresh() {
    if (!root) return
    // Re-read cached directories so the tree reflects on-disk changes, while
    // preserving expansion and selection.
    childrenCache.clear()
    const need = [root, ...expanded]
    await Promise.all(need.map((p) => loadChildren(p)))
    // Drop expanded paths that no longer exist.
    for (const p of [...expanded]) {
      const parent = dirname(p)
      const siblings = childrenCache.get(parent)
      if (siblings && !siblings.some((e) => e.path === p && e.isDir)) expanded.delete(p)
    }
    if (selected) {
      const parent = dirname(selected)
      const siblings = childrenCache.get(parent)
      if (siblings && !siblings.some((e) => e.path === selected)) selected = null
    }
    render()
  }

  // Determine the directory a new entry should be created in:
  // selected folder (or selected file's parent), else an expanded folder,
  // else the root.
  function targetDir() {
    if (selected) {
      const row = container.querySelector(`.ft-row[data-path="${cssEscape(selected)}"]`)
      if (row && row.dataset.dir === '1') return selected
      return dirname(selected)
    }
    return root
  }

  // ---------- Inline edit (new file / new folder / rename) ----------
  let activeInline = null
  function closeInlineEdit() {
    if (activeInline && activeInline.parentNode) activeInline.parentNode.removeChild(activeInline)
    activeInline = null
  }

  async function expandTo(dirPath) {
    // Expand a folder (and ensure ancestors) so a new child becomes visible.
    const ancestors = []
    for (let dir = dirPath; dir && dir !== root && isSameOrDescendant(dir, root); ) {
      ancestors.unshift(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    for (const dir of ancestors) {
      expanded.add(dir)
      if (!childrenCache.has(dir)) await loadChildren(dir)
    }
  }

  // Depth (indent level) for a new child row inside `dirPath`. Root's children
  // sit at depth 0; otherwise it's the folder row's depth + 1, read from the DOM.
  function childDepthOf(dirPath) {
    if (dirPath === root) return 0
    const folderRow = container.querySelector(`.ft-row[data-path="${cssEscape(dirPath)}"]`)
    if (folderRow) return Math.round((parseInt(folderRow.style.paddingLeft) - 4) / 12) + 1
    return 1
  }

  async function startCreate(kind) {
    if (!root) return
    const dir = targetDir()
    await expandTo(dir)
    await ensureAndRender()
    beginInline({
      kind: kind === 'folder' ? 'newFolder' : 'newFile',
      dir,
      depth: childDepthOf(dir),
      initial: ''
    })
  }

  function beginInline({ kind, dir, depth, initial, targetEntry, anchorRow }) {
    closeInlineEdit()
    const row = document.createElement('div')
    row.className = 'ft-row ft-inline'
    row.style.paddingLeft = 4 + depth * 12 + 'px'

    const twisty = document.createElement('span')
    twisty.className = 'ft-twisty'
    row.appendChild(twisty)

    const icon = document.createElement('span')
    icon.className = 'ft-icon'
    icon.innerHTML = kind === 'newFolder' ? folderIcon(false) : fileGlyph('#9d9d9d')
    row.appendChild(icon)

    const input = document.createElement('input')
    input.className = 'ft-input'
    input.type = 'text'
    input.value = initial || ''
    input.spellcheck = false
    row.appendChild(input)
    activeInline = row

    // Position the inline row in the tree.
    if (kind === 'rename' && anchorRow) {
      anchorRow.replaceWith(row)
    } else {
      // Insert as the first child of the target directory's group. We place it
      // directly after the folder's own row (or at the top for root).
      placeInlineInDir(row, dir)
    }

    input.focus()
    if (kind === 'rename' && initial) {
      const dot = initial.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : initial.length)
    }

    let committed = false
    const cancel = () => {
      if (committed) return
      committed = true
      closeInlineEdit()
      render()
    }
    const commit = async () => {
      if (committed) return
      const name = input.value.trim()
      if (!name || (kind === 'rename' && name === initial)) return cancel()
      if (name === '.' || name === '..' || /[/\\\u0000-\u001f]/.test(name)) {
        showInlineError(input, new Error('Enter a name without slashes or control characters.'))
        return
      }
      committed = true
      try {
        if (kind === 'newFolder') {
          const p = joinPath(dir, name)
          await api.fs.createDir(p)
          expanded.add(dir)
          await refresh()
          selectRow(p)
        } else if (kind === 'newFile') {
          const p = joinPath(dir, name)
          await api.fs.createFile(p)
          expanded.add(dir)
          await refresh()
          selectRow(p)
          onOpenFile(p)
        } else if (kind === 'rename') {
          const newPath = joinPath(dirname(targetEntry.path), name)
          await api.fs.rename(targetEntry.path, newPath)
          notifyPathChanged(targetEntry.path, newPath)
          await refresh()
          selectRow(newPath)
        }
      } catch (err) {
        committed = false
        showInlineError(input, err)
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    })
    input.addEventListener('blur', () => {
      // Blur commits a typed name (same path as Enter) so a focus steal — a
      // click elsewhere or an fs-watcher refresh()/render() that tears down the
      // inline row — doesn't silently discard a half-typed name. An empty value
      // (or an unchanged rename) still cancels via commit()'s own guard.
      setTimeout(commit, 0)
    })
  }

  function showInlineError(input, err) {
    input.classList.add('ft-input-error')
    input.title = (err && (err.message || String(err))) || 'Operation failed'
    input.focus()
    input.addEventListener(
      'input',
      () => {
        input.classList.remove('ft-input-error')
        input.title = ''
      },
      { once: true }
    )
  }

  // Insert an inline row at the top of a directory's visible group.
  function placeInlineInDir(row, dir) {
    if (dir === root) {
      container.insertBefore(row, container.firstChild)
      return
    }
    const folderRow = container.querySelector(`.ft-row[data-path="${cssEscape(dir)}"]`)
    if (folderRow && folderRow.nextSibling) {
      container.insertBefore(row, folderRow.nextSibling)
    } else if (folderRow) {
      container.appendChild(row)
    } else {
      container.insertBefore(row, container.firstChild)
    }
  }

  function startRename(entry) {
    const anchorRow = container.querySelector(`.ft-row[data-path="${cssEscape(entry.path)}"]`)
    const depth = anchorRow ? Math.round((parseInt(anchorRow.style.paddingLeft) - 4) / 12) : 0
    beginInline({
      kind: 'rename',
      depth,
      initial: entry.name,
      targetEntry: entry,
      anchorRow
    })
  }

  // ---------- Context menu ----------
  let menuEl = null
  let menuOrigin = null
  function closeMenu(restoreFocus = false) {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl)
    menuEl = null
    document.removeEventListener('mousedown', onMenuOutside, true)
    document.removeEventListener('keydown', onMenuKey, true)
    if (restoreFocus && menuOrigin?.isConnected) menuOrigin.focus({ preventScroll: true })
    menuOrigin = null
  }
  function onMenuOutside(e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu()
  }
  function onMenuKey(e) {
    if (!menuEl) return
    const items = [...menuEl.querySelectorAll('.ft-menu-item:not(.disabled)')]
    const current = items.indexOf(document.activeElement)
    let next
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopImmediatePropagation()
      closeMenu(true)
      return
    }
    if (e.key === 'ArrowDown') next = (current + 1) % items.length
    else if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = items.length - 1
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopImmediatePropagation()
      items[current]?.click()
      return
    }
    if (next !== undefined) {
      e.preventDefault()
      e.stopImmediatePropagation()
      items[next]?.focus()
    }
  }

  function notifyPathChanged(oldPath, newPath) {
    for (const openPath of [...expanded]) {
      if (!isSameOrDescendant(openPath, oldPath)) continue
      expanded.delete(openPath)
      expanded.add(newPath + openPath.slice(oldPath.length))
    }
    if (selected && isSameOrDescendant(selected, oldPath)) {
      selected = newPath + selected.slice(oldPath.length)
    }
    if (clipboardPath && isSameOrDescendant(clipboardPath, oldPath)) {
      clipboardPath = newPath + clipboardPath.slice(oldPath.length)
    }
    onPathChanged?.(oldPath, newPath)
  }

  async function duplicateEntry(entry) {
    try {
      const created = await api.fs.importDrop(dirname(entry.path), entry.path)
      await refresh()
      selectRow(created)
    } catch (err) {
      showToast(`Could not duplicate ${entry.name}: ${err?.message || 'operation failed'}`, {
        kind: 'error'
      })
    }
  }

  async function transferTo(entry, mode) {
    let dir
    try {
      dir = await api.fs.chooseDestination(dirname(entry.path))
    } catch (err) {
      showToast(err?.message || 'Choose a folder inside the workspace.', { kind: 'error' })
      return
    }
    if (!dir) return
    try {
      const created =
        mode === 'move'
          ? await api.fs.move(entry.path, dir)
          : await api.fs.importDrop(dir, entry.path)
      if (mode === 'move') notifyPathChanged(entry.path, created)
      await expandTo(dir)
      await refresh()
      selectRow(created)
    } catch (err) {
      showToast(`Could not ${mode} ${entry.name}: ${err?.message || 'operation failed'}`, {
        kind: 'error'
      })
    }
  }

  async function expandRecursive(path) {
    const MAX_EXPANDED_FOLDERS = 1000
    let count = 0
    const visit = async (dir) => {
      if (count >= MAX_EXPANDED_FOLDERS) return
      count++
      expanded.add(dir)
      const entries = await loadChildren(dir)
      for (const entry of entries) {
        if (entry.isDir) await visit(entry.path)
        if (count >= MAX_EXPANDED_FOLDERS) break
      }
    }
    await visit(path)
    render()
    if (count >= MAX_EXPANDED_FOLDERS) {
      showToast('Expansion stopped after 1,000 folders to keep the explorer responsive.', {
        kind: 'warn'
      })
    }
  }

  function collapseRecursive(path) {
    for (const openPath of [...expanded]) {
      if (isSameOrDescendant(openPath, path)) expanded.delete(openPath)
    }
    render()
  }

  async function runGitAction(label, action) {
    try {
      const ok = await action()
      if (ok === false) throw new Error(`${label} failed.`)
      await onGitChanged?.()
      await refresh()
    } catch (err) {
      showToast(err?.message || `${label} failed.`, { kind: 'error' })
    }
  }

  function openContextMenu(x, y, entry) {
    closeMenu()
    const isRoot = entry.path === root
    const dirForCreate = entry.isDir ? entry.path : dirname(entry.path)
    const rel = relativeTo(root, entry.path).replace(/\\/g, '/')
    const status = entry.isDir ? dirStatus.get(entry.path) : fileStatus.get(entry.path)
    const includesPath = (paths) =>
      [...paths].some((p) => p === rel || (entry.isDir && p.startsWith(rel + '/')))
    const isStaged = includesPath(stagedPaths)
    const isChanged = includesPath(changedPaths)
    const items = [
      ...(!entry.isDir ? [{ label: 'Open', action: () => onOpenFile(entry.path) }] : []),
      {
        label: api.platform === 'darwin' ? 'Reveal in Finder' : 'Show in File Explorer',
        action: () => api.shell.showItemInFolder(entry.path)
      },
      {
        label: 'Open in Terminal',
        action: () => onOpenTerminal?.(entry.isDir ? entry.path : dirname(entry.path))
      },
      ...(entry.isDir
        ? [
            {
              label: 'Find in Folder…',
              action: () => onFindInFolder?.(entry.path, entry.name)
            },
            { label: 'Expand Recursively', action: () => expandRecursive(entry.path) },
            { label: 'Collapse Recursively', action: () => collapseRecursive(entry.path) }
          ]
        : []),
      { sep: true },
      {
        label: 'New File',
        action: async () => {
          await expandTo(dirForCreate)
          await ensureAndRender()
          beginInline({
            kind: 'newFile',
            dir: dirForCreate,
            depth: childDepthOf(dirForCreate),
            initial: ''
          })
        }
      },
      {
        label: 'New Folder',
        action: async () => {
          await expandTo(dirForCreate)
          await ensureAndRender()
          beginInline({
            kind: 'newFolder',
            dir: dirForCreate,
            depth: childDepthOf(dirForCreate),
            initial: ''
          })
        }
      },
      { sep: true },
      ...(!isRoot
        ? [
            {
              label: 'Cut',
              shortcut: `${modifier}X`,
              action: () => {
                clipboardPath = entry.path
                clipboardMode = 'cut'
              }
            },
            {
              label: 'Copy',
              shortcut: `${modifier}C`,
              action: () => {
                clipboardPath = entry.path
                clipboardMode = 'copy'
              }
            },
            {
              label: 'Paste',
              shortcut: `${modifier}V`,
              disabled: !clipboardPath,
              action: () => pasteInto(dirForCreate)
            },
            { label: 'Duplicate', shortcut: `${modifier}D`, action: () => duplicateEntry(entry) },
            { label: 'Move To…', action: () => transferTo(entry, 'move') },
            { label: 'Copy To…', action: () => transferTo(entry, 'copy') },
            { sep: true }
          ]
        : [
            {
              label: 'Paste',
              shortcut: `${modifier}V`,
              disabled: !clipboardPath,
              action: () => pasteInto(root)
            },
            { sep: true }
          ]),
      {
        label: 'Copy Path',
        action: () => api.clipboard.writeText(entry.path)
      },
      {
        label: 'Copy Relative Path',
        action: () => api.clipboard.writeText(relativeTo(root, entry.path))
      },
      ...(!isRoot && status
        ? [
            { sep: true },
            ...(isStaged
              ? [
                  {
                    label: 'Unstage Changes',
                    action: () => runGitAction('Unstage', () => api.git.unstage([rel]))
                  }
                ]
              : []),
            ...(isChanged
              ? [
                  {
                    label: 'Stage Changes',
                    action: () => runGitAction('Stage', () => api.git.stage([rel]))
                  }
                ]
              : []),
            ...(!entry.isDir && isChanged
              ? [
                  {
                    label: 'Discard Changes…',
                    danger: true,
                    action: () => confirmDiscard(entry, rel)
                  }
                ]
              : [])
          ]
        : []),
      ...(!isRoot
        ? [
            { sep: true },
            {
              label: 'Rename',
              shortcut: api.platform === 'darwin' ? '⏎' : 'F2',
              action: () => startRename(entry)
            },
            {
              label: trashLabel,
              shortcut: api.platform === 'darwin' ? '⌘⌫' : 'Del',
              action: () => confirmDelete(entry),
              danger: true
            }
          ]
        : [])
    ]

    menuEl = document.createElement('div')
    menuEl.className = 'ft-menu'
    menuEl.setAttribute('role', 'menu')
    menuEl.setAttribute('aria-label', entry.name)
    menuOrigin = document.activeElement
    for (const it of items) {
      if (it.sep) {
        const sep = document.createElement('div')
        sep.className = 'ft-menu-sep'
        menuEl.appendChild(sep)
        continue
      }
      const item = document.createElement('div')
      item.setAttribute('role', 'menuitem')
      item.setAttribute('aria-disabled', String(!!it.disabled))
      item.tabIndex = -1
      item.className =
        'ft-menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '')
      const label = document.createElement('span')
      label.textContent = it.label
      item.appendChild(label)
      if (it.shortcut) {
        const shortcut = document.createElement('span')
        shortcut.className = 'ft-menu-shortcut'
        shortcut.textContent = it.shortcut
        item.appendChild(shortcut)
      }
      item.addEventListener('click', () => {
        if (it.disabled) return
        closeMenu(true)
        Promise.resolve()
          .then(it.action)
          .catch((err) => {
            showToast(err?.message || `${it.label} failed.`, { kind: 'error' })
          })
      })
      menuEl.appendChild(item)
    }
    document.body.appendChild(menuEl)

    // Keep menu within the viewport.
    const rect = menuEl.getBoundingClientRect()
    const px = Math.min(x, window.innerWidth - rect.width - 6)
    const py = Math.min(y, window.innerHeight - rect.height - 6)
    menuEl.style.left = Math.max(4, px) + 'px'
    menuEl.style.top = Math.max(4, py) + 'px'

    document.addEventListener('mousedown', onMenuOutside, true)
    document.addEventListener('keydown', onMenuKey, true)
    menuEl.querySelector('.ft-menu-item:not(.disabled)')?.focus({ preventScroll: true })
  }

  // ---------- Recoverable removal and discard confirmation ----------
  let confirmEl = null
  let confirmOrigin = null
  function closeConfirm() {
    const wasOpen = !!confirmEl
    if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl)
    confirmEl = null
    document.removeEventListener('keydown', onConfirmKey, true)
    if (wasOpen) {
      if (confirmOrigin?.isConnected) confirmOrigin.focus({ preventScroll: true })
      else if (selected) selectRow(selected)
      else container.focus({ preventScroll: true })
    }
    confirmOrigin = null
  }
  let onConfirmKey = () => {}

  function confirmDelete(entry) {
    if (entry.path === root) return
    confirmAction({
      title: `${trashLabel}: '${entry.name}'?`,
      detail: 'You can restore this item from the system trash.',
      label: trashLabel,
      action: async () => {
        await api.fs.delete(entry.path)
        for (const p of [...expanded]) {
          if (isSameOrDescendant(p, entry.path)) expanded.delete(p)
        }
        if (selected && isSameOrDescendant(selected, entry.path)) selected = null
        if (clipboardPath && isSameOrDescendant(clipboardPath, entry.path)) clipboardPath = null
        await refresh()
      }
    })
  }

  function confirmDiscard(entry, rel) {
    confirmAction({
      title: `Discard changes in '${entry.name}'?`,
      detail:
        changedPaths.has(rel) && fileStatus.get(entry.path) === 'U'
          ? 'This untracked file will be moved to the system trash.'
          : 'Unsaved changes on disk will be replaced by the Git index. This cannot be undone.',
      label: 'Discard Changes',
      action: async () => {
        if ((await api.git.discard([rel])) === false) throw new Error('Discard failed.')
        await onGitChanged?.()
        await refresh()
      }
    })
  }

  function confirmAction({ title, detail, label, action }) {
    closeConfirm()
    confirmOrigin = document.activeElement
    const overlay = document.createElement('div')
    overlay.className = 'ft-confirm-overlay'

    const box = document.createElement('div')
    box.className = 'ft-confirm'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', title)

    const msg = document.createElement('div')
    msg.className = 'ft-confirm-msg'
    msg.textContent = title
    box.appendChild(msg)

    const sub = document.createElement('div')
    sub.className = 'ft-confirm-sub'
    sub.textContent = detail
    box.appendChild(sub)

    const actions = document.createElement('div')
    actions.className = 'ft-confirm-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'btn ft-btn-secondary'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', closeConfirm)

    const delBtn = document.createElement('button')
    delBtn.className = 'btn ft-btn-danger'
    delBtn.textContent = label
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true
      try {
        await action()
        closeConfirm()
      } catch (err) {
        delBtn.disabled = false
        sub.classList.add('ft-confirm-err')
        sub.textContent = (err && (err.message || String(err))) || `${label} failed`
      }
    })

    actions.appendChild(cancelBtn)
    actions.appendChild(delBtn)
    box.appendChild(actions)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    confirmEl = overlay

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closeConfirm()
    })
    onConfirmKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        closeConfirm()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        if (delBtn.disabled || document.activeElement === delBtn) cancelBtn.focus()
        else delBtn.focus()
      }
    }
    document.addEventListener('keydown', onConfirmKey, true)
    cancelBtn.focus()
  }

  // ---------- Header buttons ----------
  function bind(id, fn) {
    const el = document.getElementById(id)
    if (el) el.addEventListener('click', fn)
  }
  bind('ft-collapse', () => {
    expanded.clear()
    render()
  })
  bind('ft-new-file', () => startCreate('file'))
  bind('ft-new-folder', () => startCreate('folder'))
  // Manual re-read of the tree (also the fallback when the fs watcher is degraded).
  bind('ft-refresh', () => refresh())
  // Reveal the workspace root in Finder (selected files use the context menu).
  bind('ft-reveal', () => {
    if (root) api.shell.showItemInFolder(root)
  })

  // Flag the explorer panel when the fs watcher stalls, so manual Refresh stands out.
  if (api.fs && api.fs.onWatchStatus) {
    const panel = document.getElementById('explorer-panel')
    api.fs.onWatchStatus((status) => {
      if (panel) panel.classList.toggle('degraded', status === 'degraded')
    })
  }

  // Click on empty tree area deselects.
  container.addEventListener('click', () => {
    selected = null
    for (const el of container.querySelectorAll('.ft-row.selected')) {
      el.classList.remove('selected')
      el.setAttribute('aria-selected', 'false')
    }
    container.focus({ preventScroll: true })
  })
  // Right-click on empty area: create at root.
  container.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.ft-row')) return
    e.preventDefault()
    if (!root) return
    selected = null
    container.focus({ preventScroll: true })
    openContextMenu(e.clientX, e.clientY, { name: basename(root), path: root, isDir: true })
  })

  // ---------- Keyboard: ⌘⌫ deletes the highlighted entry ----------
  // Routes through the same confirm dialog as the context-menu Delete. Scoped to
  // when the explorer owns focus so it never hijacks the editor's or a terminal's
  // own ⌘⌫ (delete-to-line-start).
  function findEntry(path) {
    if (!path) return null
    const list = childrenCache.get(dirname(path))
    return (list || []).find((entry) => entry.path === path) || null
  }
  document.addEventListener('keydown', (e) => {
    const deleteKey =
      api.platform === 'darwin'
        ? e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'Backspace' || e.key === 'Delete')
        : e.key === 'Delete' && !e.metaKey && !e.ctrlKey && !e.altKey
    if (!deleteKey || !inExplorerFocus()) return
    if (!selected || confirmEl) return
    const entry = findEntry(selected)
    if (!entry) return
    e.preventDefault()
    confirmDelete(entry)
  })

  // ---------- Keyboard: Return renames the highlighted entry ----------
  // Mirrors Finder/VS Code (mac): with a row selected and the explorer focused,
  // Return opens an inline rename. Scoped like ⌘⌫ above so it never steals the
  // editor's or a terminal's Enter; skipped while an inline edit is in progress.
  document.addEventListener('keydown', (e) => {
    const renameKey = e.key === 'F2' || (api.platform === 'darwin' && e.key === 'Enter')
    if (!renameKey || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (!selected || confirmEl) return
    if (!inExplorerFocus()) return
    const entry = findEntry(selected)
    if (!entry) return
    e.preventDefault()
    startRename(entry)
  })

  // ---------- Keyboard clipboard actions ----------
  // A lightweight internal clipboard: ⌘C stashes the selected path, ⌘V copies it
  // into the target directory (selected folder, a file's parent, or the root)
  // via the same clash-safe importDrop the drag-drop path uses. Scoped to when
  // the explorer owns focus so it never hijacks the editor's or a terminal's own
  // copy/paste. Copying in place is allowed — importDrop suffixes " (n)".
  function inExplorerFocus() {
    const ae = document.activeElement
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
      return false
    }
    return !confirmEl && !menuEl && ae && ae.closest && ae.closest('#explorer-panel')
  }
  async function pasteInto(dir) {
    if (!clipboardPath || !root) return
    try {
      const created =
        clipboardMode === 'cut'
          ? await api.fs.move(clipboardPath, dir)
          : await api.fs.importDrop(dir, clipboardPath)
      if (clipboardMode === 'cut') {
        notifyPathChanged(clipboardPath, created)
        clipboardPath = null
        clipboardMode = 'copy'
      }
      await expandTo(dir)
      await refresh()
      selectRow(created)
    } catch (err) {
      showToast(`Could not paste: ${err?.message || 'operation failed'}`, { kind: 'error' })
    }
  }
  document.addEventListener('keydown', (e) => {
    const commandKey = api.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (!commandKey || e.altKey || e.shiftKey) return
    const key = e.key.toLowerCase()
    if (!['c', 'x', 'v', 'd'].includes(key)) return
    if (!inExplorerFocus()) return
    if (key === 'c' || key === 'x') {
      if (!selected) return
      e.preventDefault()
      clipboardPath = selected
      clipboardMode = key === 'x' ? 'cut' : 'copy'
    } else if (key === 'v') {
      if (!clipboardPath) return
      e.preventDefault()
      pasteInto(targetDir())
    } else {
      if (!selected) return
      const entry = findEntry(selected)
      if (!entry) return
      e.preventDefault()
      duplicateEntry(entry)
    }
  })

  // Native explorer navigation, plus the keyboard equivalent of a right click.
  container.addEventListener('keydown', (e) => {
    if (!inExplorerFocus() || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (!root) return
      e.preventDefault()
      const entry = findEntry(selected) || { name: basename(root), path: root, isDir: true }
      const row = document.activeElement === container ? container : document.activeElement
      const rect = row.getBoundingClientRect()
      openContextMenu(rect.left + 12, rect.bottom, entry)
      return
    }
    if (e.shiftKey) return
    const rows = [...container.querySelectorAll('.ft-row[data-path]')]
    const index = rows.findIndex((row) => row.dataset.path === selected)
    let next
    if (e.key === 'ArrowDown') next = Math.min(index + 1, rows.length - 1)
    else if (e.key === 'ArrowUp') next = Math.max(index - 1, 0)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rows.length - 1
    else if (e.key === 'ArrowRight') {
      const entry = findEntry(selected)
      if (!entry?.isDir) return
      e.preventDefault()
      if (!expanded.has(selected)) toggleFolder(selected)
      else if (rows[index + 1] && isSameOrDescendant(rows[index + 1].dataset.path, selected)) {
        next = index + 1
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (expanded.has(selected)) toggleFolder(selected)
      else if (selected && dirname(selected) !== root) selectRow(dirname(selected))
    } else if (e.key === 'Enter' && api.platform !== 'darwin') {
      const entry = findEntry(selected)
      if (!entry) return
      e.preventDefault()
      if (entry.isDir) toggleFolder(entry.path)
      else onOpenFile(entry.path)
    }
    if (next !== undefined && rows[next]) {
      e.preventDefault()
      selectRow(rows[next].dataset.path)
      rows[next].scrollIntoView({ block: 'nearest' })
    }
  })

  // ---------- Drag and drop ----------
  // Internal rows MOVE within the workspace. Finder/web drops COPY into it.
  function dragHasFiles(e) {
    const t = e.dataTransfer && e.dataTransfer.types
    return !!t && (t.includes ? t.includes('Files') : [...t].includes('Files'))
  }
  // The folder a drop lands in: the folder row under the cursor, the parent of a
  // file row, or the root over empty space.
  function dropDirFor(target) {
    const row = target && target.closest && target.closest('.ft-row[data-path]')
    if (!row) return root
    return row.dataset.dir === '1' ? row.dataset.path : dirname(row.dataset.path)
  }
  let dropHoverRow = null
  function clearDropHover() {
    container.classList.remove('ft-drop-active')
    if (dropHoverRow) dropHoverRow.classList.remove('ft-drop-into')
    dropHoverRow = null
  }
  container.addEventListener('dragover', (e) => {
    const internal = !!draggedPath
    if (!root || (!internal && !dragHasFiles(e))) return
    e.preventDefault()
    const dir = dropDirFor(e.target)
    if (internal && isSameOrDescendant(dir, draggedPath)) {
      e.dataTransfer.dropEffect = 'none'
      clearDropHover()
      return
    }
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
    container.classList.add('ft-drop-active')
    // Highlight the specific folder row a drop would land in (none → root).
    const row = e.target.closest && e.target.closest('.ft-row[data-dir="1"]')
    if (row !== dropHoverRow) {
      if (dropHoverRow) dropHoverRow.classList.remove('ft-drop-into')
      dropHoverRow = row || null
      if (dropHoverRow) dropHoverRow.classList.add('ft-drop-into')
    }
  })
  container.addEventListener('dragleave', (e) => {
    // Ignore the dragleave that fires when crossing between child rows.
    if (e.relatedTarget && container.contains(e.relatedTarget)) return
    clearDropHover()
  })
  container.addEventListener('drop', async (e) => {
    const internal = draggedPath
    if (!root || (!internal && !dragHasFiles(e))) return
    e.preventDefault()
    e.stopPropagation()
    // Resolve the destination and read the DataTransfer synchronously — it goes
    // dead the moment we await below.
    const dir = dropDirFor(e.target)
    const files = e.dataTransfer ? [...e.dataTransfer.files] : []
    clearDropHover()
    if (internal) {
      draggedPath = null
      if (isSameOrDescendant(dir, internal) || dirname(internal) === dir) return
      try {
        const moved = await api.fs.move(internal, dir)
        notifyPathChanged(internal, moved)
        await expandTo(dir)
        await refresh()
        selectRow(moved)
      } catch (err) {
        showToast(`Could not move: ${err?.message || 'operation failed'}`, { kind: 'error' })
        await refresh()
      }
      return
    }
    if (!files.length) return
    const created = []
    let failed = 0
    for (const f of files) {
      try {
        const src = api.pathForFile?.(f)
        if (src) {
          created.push(await api.fs.importDrop(dir, src))
        } else if (f.type.startsWith('image/')) {
          // Pathless image dragged from a web page: copy its bytes in.
          const bytes = new Uint8Array(await f.arrayBuffer())
          created.push(await api.fs.importBytes(dir, f.name, f.type, bytes))
        }
      } catch {
        failed++
      }
    }
    if (failed)
      showToast(`${failed} dropped item${failed === 1 ? '' : 's'} could not be imported.`, {
        kind: 'error'
      })
    if (!created.length) return
    if (dir !== root) expanded.add(dir)
    await refresh()
    // Reveal where the drop landed by selecting the last item copied in.
    selectRow(created[created.length - 1])
  })

  return { load, refresh, applyGitStatus }
}
