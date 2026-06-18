import './fileTree.css'

const api = window.api

// ---------- Icons ----------
// Folder icons (open / closed). VS Code uses a soft slate-blue folder glyph.
const FOLDER_COLOR = '#c09553'

function svg(viewBox, body, color) {
  return `<svg class="ft-svg" viewBox="${viewBox}" width="16" height="16" fill="${color}" aria-hidden="true">${body}</svg>`
}

function folderIcon(open) {
  if (open) {
    return svg(
      '0 0 16 16',
      '<path d="M1.5 13.5 3 7.5h12l-1.5 6a.5.5 0 0 1-.49.4H2A.5.5 0 0 1 1.5 13.5z"/><path d="M1.5 6V3.5a.5.5 0 0 1 .5-.5h4l1.5 1.5H14a.5.5 0 0 1 .5.5V7H3.4a.5.5 0 0 0-.48.36L1.5 12z" opacity=".55"/>',
      FOLDER_COLOR
    )
  }
  return svg(
    '0 0 16 16',
    '<path d="M2 3.5a.5.5 0 0 1 .5-.5h4l1.5 1.5h5.5a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5z"/>',
    FOLDER_COLOR
  )
}

// A generic file (sheet with folded corner).
function fileGlyph(color) {
  return svg(
    '0 0 16 16',
    '<path d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 4 14z"/><path d="M9 1.5 13 5.5H9.5A.5.5 0 0 1 9 5z" opacity=".5"/>',
    color
  )
}

// Map an extension/name to a tasteful color so file types are visually distinct
// even with a shared glyph (clean + consistent, like a minimal icon theme).
const EXT_COLORS = {
  js: '#e8d44d',
  mjs: '#e8d44d',
  cjs: '#e8d44d',
  jsx: '#e8d44d',
  ts: '#3aa6f0',
  tsx: '#3aa6f0',
  json: '#cbcb41',
  md: '#519aba',
  markdown: '#519aba',
  css: '#42a5f5',
  scss: '#cf649a',
  sass: '#cf649a',
  less: '#2a5e8c',
  html: '#e37933',
  htm: '#e37933',
  vue: '#41b883',
  svelte: '#ff3e00',
  py: '#4b8bbe',
  rb: '#cc342d',
  go: '#00add8',
  rs: '#dea584',
  java: '#cc4f37',
  c: '#599eff',
  h: '#a074c4',
  cpp: '#599eff',
  cc: '#599eff',
  cs: '#68217a',
  php: '#7377ad',
  sh: '#89e051',
  bash: '#89e051',
  zsh: '#89e051',
  yml: '#cb4b16',
  yaml: '#cb4b16',
  toml: '#9c7a4d',
  xml: '#e37933',
  sql: '#dad8d8',
  lock: '#787878',
  env: '#dcca4a',
  txt: '#9d9d9d',
  log: '#9d9d9d',
  svg: '#ffb13b',
  png: '#a074c4',
  jpg: '#a074c4',
  jpeg: '#a074c4',
  gif: '#a074c4',
  webp: '#a074c4',
  ico: '#a074c4',
  pdf: '#e2574c',
  zip: '#afafaf',
  gz: '#afafaf',
  tar: '#afafaf'
}

// Specific full-name overrides (configs, manifests).
const NAME_ICONS = {
  'package.json': '#8bc34a',
  'package-lock.json': '#787878',
  'tsconfig.json': '#3aa6f0',
  'jsconfig.json': '#e8d44d',
  '.gitignore': '#e8623f',
  '.gitattributes': '#e8623f',
  '.npmrc': '#cb3837',
  '.editorconfig': '#dad8d8',
  'dockerfile': '#0db7ed',
  'license': '#d4b54a',
  'license.md': '#d4b54a',
  'readme.md': '#519aba',
  '.env': '#dcca4a'
}

function fileIcon(name) {
  const lower = name.toLowerCase()
  if (NAME_ICONS[lower]) return fileGlyph(NAME_ICONS[lower])
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  const color = EXT_COLORS[ext] || '#9d9d9d'
  return fileGlyph(color)
}

const chevron = svg(
  '0 0 16 16',
  '<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  'currentColor'
)

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
    if (nameEl) nameEl.textContent = (basename(root) || 'EXPLORER').toUpperCase()
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
  bind('ft-refresh', () => refresh())
  bind('ft-collapse', () => {
    expanded.clear()
    render()
  })
  bind('ft-new-file', () => startCreate('file'))
  bind('ft-new-folder', () => startCreate('folder'))

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

  return { load, refresh }
}
