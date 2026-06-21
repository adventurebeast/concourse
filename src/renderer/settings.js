// Settings window — a data-driven preferences panel (VS Code / Cursor style: a
// category rail on the left, a searchable list of settings on the right). Every
// control is generated from the schema the main process sends over IPC, so this
// file never has to know which settings exist — it just renders the registry and
// writes changes back through window.api.settings.
//
// Reuses the app's design tokens by importing the shared stylesheet, then layering
// the settings-specific layout on top.
import './style.css'
import './settings.css'

const api = window.api

// Instant theme/mode before the async settings load: both windows share one
// origin, so the localStorage cache the workbench writes is readable here too.
// This paints the panel in the right theme with no flash.
document.documentElement.dataset.theme =
  localStorage.getItem('concourse-theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.mode =
  localStorage.getItem('concourse-mode') === 'expert' ? 'expert' : 'beginner'

const nav = document.getElementById('settings-nav')
const content = document.getElementById('settings-content')
const search = document.getElementById('settings-search')
const resetAllBtn = document.getElementById('settings-reset-all')

let groups = [] // schema (grouped)
let values = {} // current values (secrets redacted to '')
let secretsSet = {} // key -> bool: is a secret currently stored?
const controls = new Map() // key -> { set(value), row, group, haystack }

const sectionId = (id) => 'section-' + id

// ---------- control builders ----------
// Each returns { el, set(value) }. set() reflects an external value WITHOUT
// re-firing a write (used on load and on cross-window changes).

function makeBoolean(s) {
  const btn = document.createElement('button')
  btn.className = 'settings-switch'
  btn.type = 'button'
  btn.setAttribute('role', 'switch')
  const render = (v) => {
    btn.classList.toggle('on', !!v)
    btn.setAttribute('aria-checked', v ? 'true' : 'false')
  }
  btn.addEventListener('click', () => {
    const next = !values[s.key]
    values[s.key] = next
    render(next)
    api.settings.set(s.key, next)
  })
  return { el: btn, set: render }
}

function makeEnum(s) {
  const sel = document.createElement('select')
  sel.className = 'settings-select'
  for (const o of s.options) {
    const opt = document.createElement('option')
    opt.value = o.value
    opt.textContent = o.label
    sel.appendChild(opt)
  }
  sel.addEventListener('change', () => {
    values[s.key] = sel.value
    api.settings.set(s.key, sel.value)
  })
  return { el: sel, set: (v) => (sel.value = v) }
}

function makeNumber(s) {
  const wrap = document.createElement('div')
  wrap.className = 'settings-number-wrap'
  const inp = document.createElement('input')
  inp.type = 'number'
  inp.className = 'settings-input settings-input-number'
  if (s.min != null) inp.min = s.min
  if (s.max != null) inp.max = s.max
  if (s.step != null) inp.step = s.step
  inp.addEventListener('change', () => {
    let n = parseFloat(inp.value)
    if (!isFinite(n)) {
      inp.value = values[s.key]
      return
    }
    // Clamp client-side to match what the store will persist. The store also
    // clamps, but when the clamped value equals the current one it won't broadcast
    // a correction — so without this the field could keep showing a rejected value.
    if (typeof s.min === 'number') n = Math.max(s.min, n)
    if (typeof s.max === 'number') n = Math.min(s.max, n)
    inp.value = n
    values[s.key] = n
    api.settings.set(s.key, n)
  })
  wrap.appendChild(inp)
  if (s.unit) {
    const u = document.createElement('span')
    u.className = 'settings-unit'
    u.textContent = s.unit
    wrap.appendChild(u)
  }
  return { el: wrap, set: (v) => (inp.value = v) }
}

function makeText(s) {
  const inp = document.createElement('input')
  inp.type = 'text'
  inp.className = 'settings-input'
  inp.spellcheck = false
  if (s.placeholder) inp.placeholder = s.placeholder
  inp.addEventListener('change', () => {
    values[s.key] = inp.value
    api.settings.set(s.key, inp.value)
  })
  return { el: inp, set: (v) => (inp.value = v == null ? '' : v) }
}

function makeSecret(s) {
  const wrap = document.createElement('div')
  wrap.className = 'settings-secret'
  const inp = document.createElement('input')
  inp.type = 'password'
  inp.className = 'settings-input'
  inp.autocomplete = 'off'
  inp.spellcheck = false
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'settings-link settings-secret-clear'
  clear.textContent = 'Clear'
  const render = () => {
    const isSet = !!secretsSet[s.key]
    inp.placeholder = isSet ? '•••••••••• (set)' : s.placeholder || ''
    clear.hidden = !isSet
  }
  // A blank field never overwrites a stored key (main treats '' as "unchanged").
  inp.addEventListener('change', () => {
    if (!inp.value) return
    api.settings.set(s.key, inp.value)
    inp.value = ''
    secretsSet[s.key] = true
    render()
  })
  clear.addEventListener('click', () => {
    api.settings.set(s.key, null) // null = explicit clear
    inp.value = ''
    secretsSet[s.key] = false
    render()
  })
  wrap.appendChild(inp)
  wrap.appendChild(clear)
  return { el: wrap, set: render }
}

function buildControl(s) {
  switch (s.type) {
    case 'boolean':
      return makeBoolean(s)
    case 'enum':
      return makeEnum(s)
    case 'number':
      return makeNumber(s)
    case 'secret':
      return makeSecret(s)
    default:
      return makeText(s)
  }
}

// ---------- render ----------
function render() {
  nav.innerHTML = ''
  content.innerHTML = ''
  controls.clear()

  for (const g of groups) {
    const navItem = document.createElement('button')
    navItem.type = 'button'
    navItem.className = 'settings-nav-item'
    navItem.textContent = g.label
    navItem.dataset.target = sectionId(g.id)
    navItem.addEventListener('click', () =>
      document.getElementById(sectionId(g.id))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    )
    nav.appendChild(navItem)

    const section = document.createElement('section')
    section.className = 'settings-section'
    section.id = sectionId(g.id)
    const h = document.createElement('h2')
    h.className = 'settings-section-title'
    h.textContent = g.label
    section.appendChild(h)

    for (const s of g.settings) {
      const row = document.createElement('div')
      row.className = 'settings-row'

      const info = document.createElement('div')
      info.className = 'settings-info'
      const label = document.createElement('div')
      label.className = 'settings-label'
      label.textContent = s.label
      info.appendChild(label)
      if (s.description) {
        const d = document.createElement('div')
        d.className = 'settings-desc'
        d.textContent = s.description
        info.appendChild(d)
      }

      const ctrlWrap = document.createElement('div')
      ctrlWrap.className = 'settings-control'
      const c = buildControl(s)
      ctrlWrap.appendChild(c.el)

      row.appendChild(info)
      row.appendChild(ctrlWrap)
      section.appendChild(row)

      controls.set(s.key, {
        set: c.set,
        row,
        group: g.id,
        haystack: (s.label + ' ' + (s.description || '') + ' ' + s.key).toLowerCase()
      })
    }
    content.appendChild(section)
  }
  syncControls()
}

// Reflect the current `values` / `secretsSet` into every control.
function syncControls() {
  for (const [key, c] of controls) {
    try {
      c.set(values[key])
    } catch {
      // a control failing to sync must not break the rest
    }
  }
}

// The panel themes itself from its own settings (so changing the theme here is
// visible immediately, even before the workbench echoes it back).
function applyTheme() {
  if (values['appearance.theme']) document.documentElement.dataset.theme = values['appearance.theme']
  if (values['appearance.mode']) document.documentElement.dataset.mode = values['appearance.mode']
}

// ---------- search filter ----------
function applyFilter(qRaw) {
  const q = (qRaw || '').trim().toLowerCase()
  const groupHasMatch = {}
  for (const [, c] of controls) {
    const match = !q || c.haystack.includes(q)
    c.row.hidden = !match
    if (match) groupHasMatch[c.group] = true
  }
  for (const g of groups) {
    const hide = q && !groupHasMatch[g.id]
    const sec = document.getElementById(sectionId(g.id))
    if (sec) sec.hidden = hide
    const navItem = nav.querySelector(`[data-target="${sectionId(g.id)}"]`)
    if (navItem) navItem.hidden = hide
  }
}
search.addEventListener('input', () => applyFilter(search.value))

// ---------- reset all (two-click confirm, no blocking dialog) ----------
let resetArmed = false
let resetTimer = null
function disarmReset() {
  resetArmed = false
  resetAllBtn.textContent = 'Reset All'
  resetAllBtn.classList.remove('danger')
  clearTimeout(resetTimer)
}
resetAllBtn.addEventListener('click', async () => {
  if (!resetArmed) {
    resetArmed = true
    resetAllBtn.textContent = 'Click again to confirm'
    resetAllBtn.classList.add('danger')
    resetTimer = setTimeout(disarmReset, 3000)
    return
  }
  disarmReset()
  await api.settings.reset()
  const snap = await api.settings.getAll()
  values = snap.values
  secretsSet = snap.secretsSet
  applyTheme()
  syncControls()
})

// ---------- live updates from other windows / the workbench ----------
api.settings.onChanged((payload) => {
  if (!payload) return
  if (payload.values) values = payload.values
  if (payload.secretsSet) secretsSet = payload.secretsSet
  applyTheme()
  syncControls()
})

// ---------- boot ----------
;(async () => {
  try {
    groups = await api.settings.schema()
    const snap = await api.settings.getAll()
    values = snap.values
    secretsSet = snap.secretsSet
  } catch {
    content.innerHTML = '<div class="settings-error">Could not load settings.</div>'
    return
  }
  applyTheme()
  render()

  // Scrollspy: highlight the nav item for the section currently in view.
  const obs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        nav.querySelectorAll('.settings-nav-item').forEach((n) =>
          n.classList.toggle('active', n.dataset.target === en.target.id)
        )
      }
    },
    { root: content, rootMargin: '0px 0px -65% 0px', threshold: 0 }
  )
  for (const g of groups) {
    const sec = document.getElementById(sectionId(g.id))
    if (sec) obs.observe(sec)
  }
})()
