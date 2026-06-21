import { showToast } from './toast.js'

// Bottom status bar: a single glanceable strip that ties together the three
// things you otherwise have to go hunting for — the git state of the workspace
// (left), the live pulse of the whole terminal fleet (right), and the time.
//
// The fleet summary is the point of this app: no matter which pane you're
// focused on, the right side tells you how many panes are working vs idle, so you
// can leave a pane and still feel the room.
export function createStatusBar({ onOpenScm } = {}) {
  const branchEl = document.getElementById('status-branch')
  const gitEl = document.getElementById('status-git')
  const fleetEl = document.getElementById('status-fleet')
  const pulseEl = document.getElementById('status-pulse')
  const clockEl = document.getElementById('status-clock')
  const versionEl = document.getElementById('status-version')

  // Build version — a quiet "vX.Y.Z" at the far right so you can confirm at a
  // glance that the freshly-built app actually loaded (the version is auto-bumped
  // on every pack/dist build). Resolved once at startup from the main process.
  if (versionEl && window.api?.app?.version) {
    window.api.app
      .version()
      .then((v) => {
        if (v) versionEl.textContent = 'v' + v
      })
      .catch(() => {})
  }

  // Clicking the git portion jumps to the Source Control view.
  if (onOpenScm) {
    branchEl.addEventListener('click', onOpenScm)
    gitEl.addEventListener('click', onOpenScm)
  }

  // ---- git ----------------------------------------------------------------
  // The branch name itself is written by git.js (setBranch). Here we add the
  // compact change counts beside it — "3 ✎" changed, "2 ✓" staged — and make
  // the whole git portion feel clickable when there's a repo to open.
  function setGit(status) {
    const repo = status && status.isRepo && !status.noFolder
    branchEl.classList.toggle('clickable', !!repo)
    gitEl.classList.toggle('clickable', !!repo)

    gitEl.innerHTML = ''
    if (!repo) return
    const changed = (status.changes || []).length
    const staged = (status.staged || []).length
    const bits = []
    if (changed) bits.push({ cls: 'git-changed', text: changed + ' ✎', tip: `${changed} changed` })
    if (staged) bits.push({ cls: 'git-staged', text: staged + ' ✓', tip: `${staged} staged` })
    for (const b of bits) {
      const span = document.createElement('span')
      span.className = 'git-stat ' + b.cls
      span.textContent = b.text
      span.title = b.tip
      gitEl.appendChild(span)
    }
  }

  // ---- fleet --------------------------------------------------------------
  // Two buckets, mirroring the pane dots: working (spinner) and idle (at rest).
  // Each reuses the pane dot's hue (see terminals.css) for instant visual rhyme.
  const BUCKETS = [
    { key: 'working', label: 'working' },
    { key: 'idle', label: 'idle' }
  ]

  function setFleet(fleet) {
    fleetEl.innerHTML = ''
    const counts = (fleet && fleet.counts) || {}
    const total = (fleet && fleet.total) || 0
    if (!total) {
      fleetEl.textContent = ''
      fleetEl.title = 'No terminals open'
      return
    }
    const tipParts = []
    for (const b of BUCKETS) {
      const n = counts[b.key] || 0
      if (!n) continue
      const stat = document.createElement('span')
      stat.className = 'fleet-stat'
      const dot = document.createElement('i')
      dot.className = 'fleet-dot ' + b.key
      stat.appendChild(dot)
      stat.appendChild(document.createTextNode(String(n)))
      fleetEl.appendChild(stat)
      tipParts.push(`${n} ${b.label}`)
    }
    fleetEl.title =
      `${total} terminal${total === 1 ? '' : 's'}` +
      (tipParts.length ? ' · ' + tipParts.join(', ') : '')
  }

  // ---- pulse (Layer B summariser) -----------------------------------------
  // A quiet chip showing which model backend is turning quiet panes into
  // one-line labels — provider + model when live, a dim hint when it's off.
  // There's no push event for provider state, so we poll pulse:status (which
  // re-resolves the backend on a short TTL, so a server started/stopped after
  // launch shows up here within a poll or two — the visible proof of auto-detect).
  // Fire the "unreachable" toast only on the live→down edge, once per outage, so
  // the 10s poll can't spam it. Reset when Pulse recovers or is turned off.
  let pulseDownNotified = false

  function setPulse(s) {
    if (!pulseEl) return
    pulseEl.innerHTML = ''
    const dot = document.createElement('i')
    // No provider resolved → Layer B is off. Say so quietly, so a user who
    // expected their local model can tell it isn't connected (vs. just silence).
    if (!s || !s.enabled) {
      pulseDownNotified = false
      dot.className = 'pulse-dot off'
      pulseEl.appendChild(dot)
      pulseEl.appendChild(document.createTextNode('Pulse off'))
      pulseEl.title =
        'Pulse summaries off — no model backend. Run a local server (e.g. `ollama serve`) ' +
        'or set ANTHROPIC_API_KEY to get one-line pane labels.'
      return
    }
    const provider = s.provider || 'model'
    const live = !!s.reachable
    // A configured provider that just went unreachable: notify once + offer Settings.
    if (!live && !pulseDownNotified) {
      pulseDownNotified = true
      showToast(`Pulse can't reach ${provider} — using basic pane detection until it's back.`, {
        kind: 'warn',
        action: { label: 'Settings', onClick: () => window.api?.window?.openSettings?.() }
      })
    } else if (live) {
      pulseDownNotified = false
    }
    dot.className = 'pulse-dot ' + (live ? 'on' : 'warn')
    pulseEl.appendChild(dot)
    // provider · model when reachable; provider · "offline" when configured but down.
    const tail = s.model ? ' · ' + (live ? s.model : 'offline') : ''
    pulseEl.appendChild(document.createTextNode(provider + tail))
    pulseEl.title = live
      ? `Pulse summaries · ${provider} · model ${s.model || '—'} · connected`
      : `Pulse summaries · ${provider} · model ${s.model || '—'} · not reachable (is the server running?)`
  }

  async function refreshPulse() {
    if (!window.api?.pulse?.status) return
    try {
      setPulse(await window.api.pulse.status())
    } catch {
      // Leave the last-known chip rather than flickering to empty on a hiccup.
    }
  }
  refreshPulse()
  setInterval(refreshPulse, 10000)

  // ---- clock --------------------------------------------------------------
  function tick() {
    const d = new Date()
    clockEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  tick()
  setInterval(tick, 15000)

  return { setGit, setFleet }
}
