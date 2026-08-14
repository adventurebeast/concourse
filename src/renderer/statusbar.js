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
  // Three buckets, mirroring the pane dots: working (busy), awaiting (at rest, your
  // move — the high-value one) and idle (quiet). Each reuses the pane dot's hue (see
  // terminals.css) for instant visual rhyme. `awaiting` sits in the middle so the
  // count you're hunting for — agents waiting on you — reads between busy and quiet.
  const BUCKETS = [
    { key: 'working', label: 'working' },
    { key: 'awaiting', label: 'awaiting you' },
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
    // Any state we don't render a bucket for (e.g. 'done'/'error') would
    // silently vanish while still counting toward total, so the dots wouldn't
    // sum to the terminal count. Fold every non-bucketed state into idle so the
    // buckets always add up.
    const bucketKeys = new Set(BUCKETS.map((b) => b.key))
    let extraIdle = 0
    for (const k of Object.keys(counts)) {
      if (!bucketKeys.has(k)) extraIdle += counts[k] || 0
    }
    for (const b of BUCKETS) {
      let n = counts[b.key] || 0
      if (b.key === 'idle') n += extraIdle
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
      (tipParts.length ? ' · ' + tipParts.join(', ') : '') +
      ' · click for legend'
  }

  // ---- Pulse legend (click the fleet count) -------------------------------
  // The fleet count is the one always-visible Pulse surface; clicking it explains
  // what the dots, colours, and stable labels mean — a canonical, pull-not-push
  // reference the just-in-time coach marks point back to. Click-only; never auto-pops.
  let legendEl = null
  function closeLegend() {
    if (!legendEl) return
    legendEl.remove()
    legendEl = null
    document.removeEventListener('mousedown', onDocDown, true)
    document.removeEventListener('keydown', onKey, true)
  }
  function onDocDown(e) {
    // legendEl may already be detached if a close raced this listener — bail.
    if (!legendEl) return
    if (!legendEl.contains(e.target) && !fleetEl.contains(e.target)) closeLegend()
  }
  function onKey(e) {
    if (e.key === 'Escape') closeLegend()
  }
  function toggleLegend() {
    if (legendEl) return closeLegend()
    legendEl = document.createElement('div')
    legendEl.className = 'pulse-legend'
    legendEl.innerHTML =
      '<div class="pulse-legend-title">Pulse</div>' +
      '<div class="leg-row"><i class="fleet-dot working"></i><span>Working — the agent is busy (the tab breathes)</span></div>' +
      '<div class="leg-row"><i class="fleet-dot awaiting"></i><span>Awaiting you — at a prompt, or parked at its turn</span></div>' +
      '<div class="leg-row"><i class="fleet-dot idle"></i><span>Idle — quiet, nothing pending</span></div>' +
      '<div class="leg-row"><span class="leg-swatch"></span><span>Each colour marks one agent — across every layout</span></div>' +
      '<div class="leg-row"><span class="leg-chip">abc</span><span>Stable labels identify panes without reading terminal text</span></div>'
    document.body.appendChild(legendEl)
    const r = fleetEl.getBoundingClientRect()
    const bar = document.getElementById('status-bar').getBoundingClientRect()
    legendEl.style.left =
      Math.max(8, Math.min(r.left, window.innerWidth - legendEl.offsetWidth - 8)) + 'px'
    legendEl.style.bottom = window.innerHeight - bar.top + 6 + 'px'
    // Defer so this same click doesn't immediately close it via the doc listener.
    setTimeout(() => {
      // A rapid open→close in the same tick can fire this after closeLegend ran;
      // bail if the legend is already gone so we don't re-attach orphan listeners.
      if (!legendEl) return
      document.addEventListener('mousedown', onDocDown, true)
      document.addEventListener('keydown', onKey, true)
    }, 0)
  }
  fleetEl.classList.add('status-action')
  fleetEl.style.cursor = 'pointer'
  fleetEl.addEventListener('click', toggleLegend)

  // ---- clock --------------------------------------------------------------
  function tick() {
    // Skip if the clock element is gone (view torn down) — avoid touching a
    // detached node every 15s.
    if (clockEl && !clockEl.isConnected) return
    const d = new Date()
    clockEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  tick()
  const clockTimer = setInterval(tick, 15000)

  // Teardown: cancel the clock interval so a disposed status bar leaves no timer.
  function dispose() {
    clearInterval(clockTimer)
  }

  return { setGit, setFleet, dispose }
}
