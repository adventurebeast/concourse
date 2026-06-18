import './git.css'

const api = window.api

// Status letter -> CSS color variable.
const STATUS_COLOR = {
  M: 'var(--orange)',
  A: 'var(--green)',
  U: 'var(--green)',
  D: 'var(--red)',
  R: 'var(--orange)'
}

// Human-readable tooltip for each status letter.
const STATUS_TITLE = {
  M: 'Modified',
  A: 'Added',
  U: 'Untracked',
  D: 'Deleted',
  R: 'Renamed'
}

// Split a repo-relative path into { name, dir } for the two-tone row label.
function splitPath(p) {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  if (idx === -1) return { name: norm, dir: '' }
  return { name: norm.slice(idx + 1), dir: norm.slice(0, idx) }
}

export function createGit({ onOpenDiff } = {}) {
  const body = document.getElementById('scm-body')
  // Track which groups are collapsed across refreshes.
  const collapsed = { staged: false, changes: false }
  let lastStatus = { isRepo: false }

  // ---- Persistent commit UI (built once, re-parented on every render) -------
  const commitBox = document.createElement('div')
  commitBox.className = 'scm-commit-box'

  const textarea = document.createElement('textarea')
  textarea.className = 'scm-commit-input'
  textarea.placeholder = 'Message (⌘Enter to commit)'
  textarea.rows = 1
  textarea.spellcheck = false

  const commitBtn = document.createElement('button')
  commitBtn.className = 'btn scm-commit-btn'
  commitBtn.textContent = 'Commit'

  commitBox.appendChild(textarea)
  commitBox.appendChild(commitBtn)

  function stagedCount() {
    return lastStatus.isRepo && lastStatus.staged ? lastStatus.staged.length : 0
  }

  function updateCommitEnabled() {
    const hasMsg = textarea.value.trim().length > 0
    commitBtn.disabled = !hasMsg || stagedCount() === 0
  }

  async function commit() {
    const message = textarea.value.trim()
    if (!message || stagedCount() === 0) return
    commitBtn.disabled = true
    try {
      await api.git.commit(message)
      textarea.value = ''
      autoGrow()
    } finally {
      await refresh()
    }
  }

  function autoGrow() {
    textarea.style.height = 'auto'
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px'
  }

  textarea.addEventListener('input', () => {
    autoGrow()
    updateCommitEnabled()
  })
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  })
  commitBtn.addEventListener('click', commit)

  // ---- Header buttons (in #scm-panel pane-header) ---------------------------
  const headerRefresh = document.getElementById('scm-refresh')
  const headerCommit = document.getElementById('scm-commit')
  if (headerRefresh) headerRefresh.addEventListener('click', () => refresh())
  if (headerCommit) headerCommit.addEventListener('click', () => commit())

  // ---- Row + group rendering ------------------------------------------------
  function makeRow(item, isStaged) {
    const { name, dir } = splitPath(item.path)

    const row = document.createElement('div')
    row.className = 'scm-row'
    row.title = item.path

    const letter = document.createElement('span')
    letter.className = 'scm-status'
    letter.textContent = item.status
    letter.style.color = STATUS_COLOR[item.status] || 'var(--text-dim)'
    letter.title = STATUS_TITLE[item.status] || item.status

    const label = document.createElement('span')
    label.className = 'scm-label'
    const nameEl = document.createElement('span')
    nameEl.className = 'scm-name'
    nameEl.textContent = name
    label.appendChild(nameEl)
    if (dir) {
      const dirEl = document.createElement('span')
      dirEl.className = 'scm-dir'
      dirEl.textContent = dir
      label.appendChild(dirEl)
    }

    const actions = document.createElement('div')
    actions.className = 'scm-actions'

    const addAction = (glyph, title, handler) => {
      const b = document.createElement('button')
      b.className = 'scm-action'
      b.textContent = glyph
      b.title = title
      b.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          await handler()
        } finally {
          await refresh()
        }
      })
      actions.appendChild(b)
    }

    if (isStaged) {
      addAction('−', 'Unstage Changes', () => api.git.unstage([item.path]))
    } else {
      addAction('↩', 'Discard Changes', () => api.git.discard([item.path]))
      addAction('+', 'Stage Changes', () => api.git.stage([item.path]))
    }

    row.appendChild(letter)
    row.appendChild(label)
    row.appendChild(actions)

    row.addEventListener('click', async () => {
      try {
        const { original, modified } = await api.git.diff(item.path, isStaged)
        if (typeof onOpenDiff === 'function') {
          onOpenDiff({ path: item.path, original, modified, title: name })
        }
      } catch {
        // ignore diff failures (e.g. binary / missing blobs)
      }
    })

    return row
  }

  function makeGroup(key, title, items, isStaged) {
    const group = document.createElement('div')
    group.className = 'scm-group'

    const header = document.createElement('div')
    header.className = 'scm-group-header'
    if (collapsed[key]) header.classList.add('collapsed')

    const chevron = document.createElement('span')
    chevron.className = 'scm-chevron'
    chevron.textContent = '›' // ›

    const titleEl = document.createElement('span')
    titleEl.className = 'scm-group-title'
    titleEl.textContent = title

    const badge = document.createElement('span')
    badge.className = 'scm-count'
    badge.textContent = String(items.length)

    header.appendChild(chevron)
    header.appendChild(titleEl)
    header.appendChild(badge)

    const list = document.createElement('div')
    list.className = 'scm-list'
    if (collapsed[key]) list.hidden = true

    for (const item of items) list.appendChild(makeRow(item, isStaged))

    header.addEventListener('click', () => {
      collapsed[key] = !collapsed[key]
      header.classList.toggle('collapsed', collapsed[key])
      list.hidden = collapsed[key]
    })

    group.appendChild(header)
    group.appendChild(list)
    return group
  }

  // ---- Status bar -----------------------------------------------------------
  function setBranch(branch) {
    const el = document.getElementById('status-branch')
    if (!el) return
    el.textContent = branch ? '⚎ ' + branch : ''
  }

  // ---- Render ---------------------------------------------------------------
  function render(status) {
    body.innerHTML = ''

    if (!status || !status.isRepo) {
      setBranch(null)
      const hint = document.createElement('div')
      hint.className = 'empty-hint'
      const msg = document.createElement('div')
      msg.textContent =
        'The current folder is not a Git repository. Initialize one to start tracking changes.'
      const initBtn = document.createElement('button')
      initBtn.className = 'btn'
      initBtn.textContent = 'Initialize Repository'
      initBtn.style.marginTop = '10px'
      initBtn.addEventListener('click', async () => {
        initBtn.disabled = true
        try {
          await api.git.init()
        } finally {
          await refresh()
        }
      })
      hint.appendChild(msg)
      hint.appendChild(initBtn)
      body.appendChild(hint)
      return
    }

    setBranch(status.branch)

    body.appendChild(commitBox)
    updateCommitEnabled()

    const staged = status.staged || []
    const changes = status.changes || []

    if (staged.length === 0 && changes.length === 0) {
      const clean = document.createElement('div')
      clean.className = 'empty-hint scm-clean'
      clean.textContent = 'No changes detected.'
      body.appendChild(clean)
      return
    }

    if (staged.length > 0) {
      body.appendChild(makeGroup('staged', 'Staged Changes', staged, true))
    }
    body.appendChild(makeGroup('changes', 'Changes', changes, false))
  }

  // ---- Public refresh -------------------------------------------------------
  async function refresh() {
    let status
    try {
      status = await api.git.status()
    } catch {
      status = { isRepo: false }
    }
    lastStatus = status || { isRepo: false }
    render(lastStatus)
  }

  return { refresh }
}
