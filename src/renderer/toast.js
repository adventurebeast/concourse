import './toast.css'

// App-wide, non-blocking notification surface. Until now git/save/fs/Pulse/watcher
// failures went to console only — invisible in a packaged build. toast.show() puts a
// transient, accessible message in the corner; errors persist until dismissed,
// info/success auto-dismiss. showOnce() coalesces repeats so a per-tick source
// (e.g. an unreachable Pulse endpoint) can't spam the user.

let host = null
function ensureHost() {
  if (host && host.isConnected) return host
  host = document.getElementById('toast-host')
  if (!host) {
    host = document.createElement('div')
    host.id = 'toast-host'
    host.setAttribute('aria-live', 'polite')
    document.body.appendChild(host)
  }
  return host
}

// kind: 'info' | 'success' | 'warn' | 'error'
// opts: { timeout?, action?: { label, onClick } }
export function showToast(message, { kind = 'info', timeout, action } = {}) {
  const h = ensureHost()

  const el = document.createElement('div')
  el.className = 'toast toast-' + kind
  // Errors interrupt (assertive); the rest are polite.
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status')

  const msg = document.createElement('span')
  msg.className = 'toast-msg'
  msg.textContent = message
  el.appendChild(msg)

  let timer = null
  const remove = () => {
    if (timer) clearTimeout(timer)
    if (!el.isConnected) return
    el.classList.remove('toast-in')
    el.classList.add('toast-out')
    setTimeout(() => el.remove(), 200)
  }

  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button')
    btn.className = 'toast-action'
    btn.textContent = action.label
    btn.addEventListener('click', () => {
      try {
        action.onClick()
      } finally {
        remove()
      }
    })
    el.appendChild(btn)
  }

  const close = document.createElement('button')
  close.className = 'toast-close'
  close.textContent = '×'
  close.title = 'Dismiss'
  close.setAttribute('aria-label', 'Dismiss')
  close.addEventListener('click', remove)
  el.appendChild(close)

  h.appendChild(el)
  requestAnimationFrame(() => el.classList.add('toast-in'))

  // Errors stay until dismissed (timeout 0); others auto-dismiss.
  const ttl = timeout != null ? timeout : kind === 'error' ? 0 : kind === 'success' ? 2500 : 4000
  if (ttl > 0) timer = setTimeout(remove, ttl)

  return { dismiss: remove }
}

// Suppress an identical message seen within `windowMs` (default 8s) — keeps a
// repeating failure from stacking up dozens of identical toasts.
const lastShown = new Map()
export function showToastOnce(message, opts = {}, windowMs = 8000) {
  const now = Date.now()
  const prev = lastShown.get(message) || 0
  if (now - prev < windowMs) return null
  lastShown.set(message, now)
  return showToast(message, opts)
}
