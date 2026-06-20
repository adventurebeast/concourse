import './fileTree.css'

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
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  archive: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'
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
  js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', ts: 'code', tsx: 'code',
  py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', c: 'code',
  h: 'code', cpp: 'code', cc: 'code', cs: 'code', php: 'code', sh: 'code',
  bash: 'code', zsh: 'code', css: 'code', scss: 'code', sass: 'code',
  less: 'code', html: 'code', htm: 'code', vue: 'code', svelte: 'code',
  xml: 'code', sql: 'code',
  json: 'data', yml: 'data', yaml: 'data', toml: 'data', env: 'data',
  lock: 'data', ini: 'data', conf: 'data',
  md: 'doc', markdown: 'doc', txt: 'doc', log: 'doc', pdf: 'doc', rst: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  ico: 'image', svg: 'image', bmp: 'image',
  zip: 'archive', gz: 'archive', tar: 'archive', tgz: 'archive', rar: 'archive', '7z': 'archive'
}

// Specific full-name overrides (manifests, dotfiles).
const NAME_CAT = {
  'package.json': 'data', 'package-lock.json': 'data', 'tsconfig.json': 'data',
  'jsconfig.json': 'data', '.gitignore': 'data', '.gitattributes': 'data',
  '.npmrc': 'data', '.editorconfig': 'data', '.env': 'data',
  dockerfile: 'code', 'readme.md': 'doc', license: 'doc', 'license.md': 'doc'
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

export function createFileTree({ onOpenFile }) {
  const container = document.getElementById('file-tree')
  let root = null
  const expanded = new Set() // absolute paths of expanded folders
  let selected = null // absolute path of selected row

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

  // Rebuild the status maps from an SCM status object ({ staged, changes }) and
  // repaint visible rows without disturbing expansion or an in-progress rename.
  function applyGitStatus(status) {
    fileStatus.clear()
    dirStatus.clear()
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
    decorateAll()
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
    row.dataset.path = entry.path
    row.dataset.dir = entry.isDir ? '1' : '0'
    row.style.paddingLeft = 4 + depth * 12 + 'px'
    if (entry.path === selected) row.classList.add('selected')

    const isOpen = entry.isDir && expanded.has(entry.path)

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
      if (entry.isDir) {
        toggleFolder(entry.path)
      } else {
        selectRow(entry.path)
        onOpenFile(entry.path)
      }
    })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      selectRow(entry.path)
      openContextMenu(e.clientX, e.clientY, entry)
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
    container.innerHTML = ''
    if (!root) return
    container.appendChild(buildChildrenEls(root, 0))
  }

  // Ensure children for `root` and every expanded folder are cached, then render.
  async function ensureAndRender() {
    const need = [root, ...expanded]
    await Promise.all(
      need.map((p) => (childrenCache.has(p) ? Promise.resolve() : loadChildren(p)))
    )
    render()
  }

  function selectRow(path) {
    selected = path
    for (const el of container.querySelectorAll('.ft-row.selected')) el.classList.remove('selected')
    const row = container.querySelector(`.ft-row[data-path="${cssEscape(path)}"]`)
    if (row) row.classList.add('selected')
  }

  async function toggleFolder(path) {
    if (expanded.has(path)) {
      expanded.delete(path)
    } else {
      expanded.add(path)
      if (!childrenCache.has(path)) await loadChildren(path)
    }
    render()
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s)
    return s.replace(/["\\]/g, '\\$&')
  }

  // ---------- Public API ----------
  async function load(newRoot) {
    root = newRoot
    expanded.clear()
    childrenCache.clear()
    selected = null
    const nameEl = document.getElementById('workspace-name')

    // No folder open — show a call-to-action instead of a tree.
    if (!root) {
      if (nameEl) { nameEl.textContent = ''; nameEl.hidden = true }
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

    if (nameEl) { nameEl.textContent = (basename(root) || '').toUpperCase(); nameEl.hidden = false }
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
    if (dirPath === root) return
    expanded.add(dirPath)
    if (!childrenCache.has(dirPath)) await loadChildren(dirPath)
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
          // Carry over expansion/selection to the new path.
          if (expanded.has(targetEntry.path)) {
            expanded.delete(targetEntry.path)
            expanded.add(newPath)
          }
          if (selected === targetEntry.path) selected = newPath
          await refresh()
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
      // Blur cancels (matches VS Code when empty; commit on Enter).
      setTimeout(cancel, 0)
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
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl)
    menuEl = null
    document.removeEventListener('mousedown', onMenuOutside, true)
    document.removeEventListener('keydown', onMenuKey, true)
  }
  function onMenuOutside(e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu()
  }
  function onMenuKey(e) {
    if (e.key === 'Escape') closeMenu()
  }

  function openContextMenu(x, y, entry) {
    closeMenu()
    const dirForCreate = entry.isDir ? entry.path : dirname(entry.path)
    const items = [
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
      { label: 'Reveal in Finder', action: () => api.shell.showItemInFolder(entry.path) },
      { sep: true },
      { label: 'Rename', action: () => startRename(entry) },
      { label: 'Delete', action: () => confirmDelete(entry), danger: true }
    ]

    menuEl = document.createElement('div')
    menuEl.className = 'ft-menu'
    for (const it of items) {
      if (it.sep) {
        const sep = document.createElement('div')
        sep.className = 'ft-menu-sep'
        menuEl.appendChild(sep)
        continue
      }
      const item = document.createElement('div')
      item.className = 'ft-menu-item' + (it.danger ? ' danger' : '')
      item.textContent = it.label
      item.addEventListener('click', () => {
        closeMenu()
        it.action()
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
  }

  // ---------- Delete confirmation ----------
  let confirmEl = null
  function closeConfirm() {
    if (confirmEl && confirmEl.parentNode) confirmEl.parentNode.removeChild(confirmEl)
    confirmEl = null
    document.removeEventListener('keydown', onConfirmKey, true)
  }
  let onConfirmKey = () => {}

  function confirmDelete(entry) {
    closeConfirm()
    const overlay = document.createElement('div')
    overlay.className = 'ft-confirm-overlay'

    const box = document.createElement('div')
    box.className = 'ft-confirm'

    const msg = document.createElement('div')
    msg.className = 'ft-confirm-msg'
    msg.textContent = `Are you sure you want to delete '${entry.name}'?`
    box.appendChild(msg)

    const sub = document.createElement('div')
    sub.className = 'ft-confirm-sub'
    sub.textContent = entry.isDir
      ? 'This folder and its contents will be permanently deleted.'
      : 'This file will be permanently deleted.'
    box.appendChild(sub)

    const actions = document.createElement('div')
    actions.className = 'ft-confirm-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'btn ft-btn-secondary'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', closeConfirm)

    const delBtn = document.createElement('button')
    delBtn.className = 'btn ft-btn-danger'
    delBtn.textContent = 'Delete'
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true
      try {
        await api.fs.delete(entry.path)
        expanded.delete(entry.path)
        if (selected === entry.path) selected = null
        closeConfirm()
        await refresh()
      } catch (err) {
        delBtn.disabled = false
        sub.classList.add('ft-confirm-err')
        sub.textContent = (err && (err.message || String(err))) || 'Delete failed'
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
      if (e.key === 'Escape') closeConfirm()
      else if (e.key === 'Enter') delBtn.click()
    }
    document.addEventListener('keydown', onConfirmKey, true)
    delBtn.focus()
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
  // Reveal the workspace root in Finder (selected files use the context menu).
  bind('ft-reveal', () => {
    if (root) api.shell.showItemInFolder(root)
  })

  // Click on empty tree area deselects.
  container.addEventListener('click', () => {
    selected = null
    for (const el of container.querySelectorAll('.ft-row.selected')) el.classList.remove('selected')
  })
  // Right-click on empty area: create at root.
  container.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.ft-row')) return
    e.preventDefault()
    if (!root) return
    selected = null
    openContextMenu(e.clientX, e.clientY, { name: basename(root), path: root, isDir: true })
  })

  return { load, refresh, applyGitStatus }
}
