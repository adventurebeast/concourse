// Bottom status bar: a single glanceable strip that ties together the three
// things you otherwise have to go hunting for — the git state of the workspace
// (left), the live pulse of the whole terminal fleet (right), and the time.
//
// The fleet summary is the point of this app: no matter which pane you're
// focused on, the right side tells you how many agents are working, waiting on
// you, finished, or errored — so you can leave a pane and still feel the room.
export function createStatusBar({ onOpenScm } = {}) {
  const branchEl = document.getElementById('status-branch')
  const gitEl = document.getElementById('status-git')
  const fleetEl = document.getElementById('status-fleet')
  const clockEl = document.getElementById('status-clock')

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
  // Buckets in priority order: the states you most want surfaced come first so
  // a quick left-to-right scan lands on "waiting" before "done". Each bucket
  // reuses the pane dot's hue (see terminals.css) for instant visual rhyme.
  const BUCKETS = [
    { key: 'blocked', label: 'waiting on you' },
    { key: 'error', label: 'errored' },
    { key: 'working', label: 'working' },
    { key: 'quiet', label: 'quiet' },
    { key: 'done', label: 'done' },
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
      // 'blocked' is the one bucket that means "go intervene" — emphasise it so a
      // glance across the bar lands on it, and spell the word out, not a bare count.
      stat.className = 'fleet-stat' + (b.key === 'blocked' ? ' needs-you' : '')
      const dot = document.createElement('i')
      dot.className = 'fleet-dot ' + b.key
      stat.appendChild(dot)
      stat.appendChild(document.createTextNode(String(n)))
      if (b.key === 'blocked') stat.appendChild(document.createTextNode(' waiting'))
      fleetEl.appendChild(stat)
      tipParts.push(`${n} ${b.label}`)
    }
    fleetEl.title =
      `${total} terminal${total === 1 ? '' : 's'}` +
      (tipParts.length ? ' · ' + tipParts.join(', ') : '')
  }

  // ---- clock --------------------------------------------------------------
  function tick() {
    const d = new Date()
    clockEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  tick()
  setInterval(tick, 15000)

  return { setGit, setFleet }
}
