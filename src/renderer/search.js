import './search.css'

const api = window.api

// Debounce: wait this long after the last keystroke before searching.
const DEBOUNCE_MS = 200

export function createSearch({ getRoot, onOpenFile } = {}) {
  const input = document.getElementById('search-input')
  const body = document.getElementById('search-body')
  const summary = document.getElementById('search-summary')
  const caseBtn = document.getElementById('search-case')
  const wordBtn = document.getElementById('search-word')
  const regexBtn = document.getElementById('search-regex')
  const clearBtn = document.getElementById('search-clear')

  const opts = { caseSensitive: false, wholeWord: false, useRegex: false }
  // Groups collapsed by file path, preserved across re-renders within a query.
  const collapsed = new Set()
  let timer = null
  let runToken = 0 // guards against out-of-order async results

  // ---- Toggle buttons -------------------------------------------------------
  function wireToggle(btn, key) {
    btn.addEventListener('click', () => {
      opts[key] = !opts[key]
      btn.classList.toggle('active', opts[key])
      run()
    })
  }
  wireToggle(caseBtn, 'caseSensitive')
  wireToggle(wordBtn, 'wholeWord')
  wireToggle(regexBtn, 'useRegex')

  // ---- Input ----------------------------------------------------------------
  function autoGrow() {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 120) + 'px'
  }
  input.addEventListener('input', () => {
    autoGrow()
    schedule()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      run()
    }
  })

  clearBtn.addEventListener('click', () => {
    input.value = ''
    autoGrow()
    collapsed.clear()
    renderEmpty()
    input.focus()
  })

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(run, DEBOUNCE_MS)
  }

  // ---- Highlighted line text -----------------------------------------------
  function makeLineText(text, ranges) {
    const frag = document.createDocumentFragment()
    // Trim leading whitespace for display, shifting ranges to match.
    const leading = text.length - text.trimStart().length
    let cursor = leading
    for (const [start, end] of ranges) {
      const s = Math.max(start, leading)
      // Clamp end too, so a match that falls entirely inside the trimmed
      // leading whitespace doesn't produce an empty span and mis-advance cursor.
      const e = Math.max(end, leading)
      if (e <= s) continue // zero-width after clamping (match was all indentation)
      if (s > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, s)))
      const hit = document.createElement('span')
      hit.className = 'search-hit'
      hit.textContent = text.slice(s, e)
      frag.appendChild(hit)
      cursor = e
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)))
    return frag
  }

  // ---- Render ---------------------------------------------------------------
  function renderEmpty(message) {
    body.innerHTML = ''
    summary.hidden = true
    if (message) {
      const hint = document.createElement('div')
      hint.className = 'empty-hint'
      hint.textContent = message
      body.appendChild(hint)
    }
  }

  // Shown while a query is in flight so stale results don't linger and a valid
  // pending query never flashes 'No results found.'.
  function renderPending() {
    body.innerHTML = ''
    summary.hidden = false
    summary.textContent = 'Searching…'
  }

  function render(result) {
    body.innerHTML = ''
    const { files, totalMatches, truncated, error, noFolder } = result

    if (noFolder) {
      renderEmpty('Open a folder to search its files.')
      return
    }
    if (error) {
      summary.hidden = false
      summary.textContent = error
      return
    }
    if (files.length === 0) {
      summary.hidden = false
      summary.textContent = 'No results found.'
      return
    }

    summary.hidden = false
    const fileWord = files.length === 1 ? 'file' : 'files'
    summary.textContent =
      `${totalMatches} result${totalMatches === 1 ? '' : 's'} in ${files.length} ${fileWord}` +
      (truncated ? ' (truncated)' : '')

    for (const file of files) {
      body.appendChild(makeGroup(file))
    }
  }

  function makeGroup(file) {
    const isCollapsed = collapsed.has(file.path)

    const group = document.createElement('div')
    group.className = 'search-group'

    const header = document.createElement('div')
    header.className = 'search-group-header'
    if (isCollapsed) header.classList.add('collapsed')
    header.title = file.path

    const chevron = document.createElement('span')
    chevron.className = 'search-chevron'
    chevron.textContent = '›'

    const name = document.createElement('span')
    name.className = 'search-file-name'
    name.textContent = file.name

    const dir = document.createElement('span')
    dir.className = 'search-file-dir'
    dir.textContent = file.dir

    const count = document.createElement('span')
    count.className = 'search-count'
    count.textContent = String(file.matches.reduce((n, m) => n + m.ranges.length, 0))

    header.append(chevron, name, dir, count)

    const list = document.createElement('div')
    list.className = 'search-matches'
    if (isCollapsed) list.hidden = true

    for (const m of file.matches) {
      const row = document.createElement('div')
      row.className = 'search-match'
      row.title = `${file.name}:${m.line}`
      row.appendChild(makeLineText(m.text, m.ranges))
      const first = m.ranges[0]
      row.addEventListener('click', () => {
        if (typeof onOpenFile === 'function') {
          onOpenFile(file.path, {
            line: m.line,
            column: first[0] + 1,
            endColumn: first[1] + 1
          })
        }
      })
      list.appendChild(row)
    }

    header.addEventListener('click', () => {
      const nowCollapsed = !collapsed.has(file.path)
      if (nowCollapsed) collapsed.add(file.path)
      else collapsed.delete(file.path)
      header.classList.toggle('collapsed', nowCollapsed)
      list.hidden = nowCollapsed
    })

    group.append(header, list)
    return group
  }

  // ---- Run a search ---------------------------------------------------------
  async function run() {
    clearTimeout(timer)
    const query = input.value
    if (!query.trim()) {
      collapsed.clear()
      renderEmpty()
      return
    }
    const token = ++runToken
    // Clear stale results and show a pending state before awaiting, so the panel
    // never keeps showing the previous query's hits while this one is in flight.
    renderPending()
    let result
    try {
      result = await api.search.find(query, opts)
    } catch {
      result = { files: [], totalMatches: 0, truncated: false, error: 'Search failed.' }
    }
    if (token !== runToken) return // a newer search superseded this one
    render(result)
  }

  // ---- Public API -----------------------------------------------------------
  // Called when the panel becomes visible.
  function focus() {
    input.focus()
    input.select()
  }

  return { focus, run }
}
