import './localLlmSetup.css'

// The one-click "run the Local LLM" experience, as a single reusable promise.
//
// This is deliberately self-contained and window-agnostic: the Settings window calls
// it when you switch Pulse to Local, and the onboarding flow will call the SAME
// function later. One consent surface, one code path — so the experience can't drift
// between the two places a user might first meet it.
//
// The deal we present is the whole pitch in three lines: a small one-time download,
// then a private model that runs in the background for free, forever, offline. After
// you say yes, nothing else is asked of you — no server to run, no localhost URL. The
// main process starts the runtime and downloads the model; we just show the bar.
//
//   ensureLocalLlmReady() resolves to:
//     'installed'  — the model is ready (either already was, or just downloaded)
//     'cancelled'  — you declined, or cancelled mid-download
//     'error'      — something went wrong (the dialog shows it; this is the signal
//                    for callers that want to revert a setting)

const api = window.api

// Single progress listener for the whole app: the preload adds an ipcRenderer.on each
// time onProgress() is called, so we subscribe ONCE here and fan out to whichever
// dialog is currently open. Avoids stacking a new listener on every dialog open.
let activeProgress = null
api?.model?.onProgress?.((p) => {
  if (activeProgress) activeProgress(p)
})

const PITCH_TITLE = 'Run a local AI for Pulse?'
const PITCH_BODY =
  'Pulse can read each terminal and tell you which agents are working, which are waiting on you, and what they’re doing — powered by a small AI that runs entirely on your Mac.'
const PITCH_POINTS = [
  ['download', 'One-time download (~400 MB). Nothing to install or configure.'],
  ['lock', 'Private & offline — your terminals never leave your machine.'],
  ['bolt', 'Free, forever. No API key, no account, no per-use cost.']
]

// Tiny inline glyphs so the dialog needs no icon dependency.
const GLYPH = {
  download: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>'
}

export async function ensureLocalLlmReady() {
  // Skip the whole dialog if the model is already on disk — saying "yes" to something
  // that's already done is just friction.
  const st = await api?.model?.status?.().catch(() => null)
  if (st?.installed) return 'installed'
  return runSetupDialog()
}

function runSetupDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'llm-setup-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', PITCH_TITLE)

    const card = document.createElement('div')
    card.className = 'llm-setup-card'
    overlay.appendChild(card)

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      activeProgress = null
      document.removeEventListener('keydown', onKey)
      overlay.classList.add('closing')
      setTimeout(() => overlay.remove(), 140)
      resolve(result)
    }
    const onKey = (e) => {
      // Esc closes only while we haven't started a download (so a stray keypress can't
      // abandon an in-progress pull by accident).
      if (e.key === 'Escape' && card.dataset.phase === 'pitch') finish('cancelled')
    }
    document.addEventListener('keydown', onKey)

    // ---- pitch view (the consent moment) ----
    const renderPitch = () => {
      card.dataset.phase = 'pitch'
      card.innerHTML = `
        <div class="llm-setup-head">
          <div class="llm-setup-spark">${GLYPH.bolt}</div>
          <h2 class="llm-setup-title"></h2>
        </div>
        <p class="llm-setup-body"></p>
        <ul class="llm-setup-points"></ul>
        <div class="llm-setup-actions">
          <button class="llm-setup-btn ghost" data-act="no">Not now</button>
          <button class="llm-setup-btn primary" data-act="yes">Yes, run it locally</button>
        </div>`
      card.querySelector('.llm-setup-title').textContent = PITCH_TITLE
      card.querySelector('.llm-setup-body').textContent = PITCH_BODY
      const ul = card.querySelector('.llm-setup-points')
      for (const [glyph, text] of PITCH_POINTS) {
        const li = document.createElement('li')
        li.innerHTML = `<span class="llm-setup-point-ico">${GLYPH[glyph]}</span><span></span>`
        li.querySelector('span:last-child').textContent = text
        ul.appendChild(li)
      }
      card.querySelector('[data-act="no"]').addEventListener('click', () => finish('cancelled'))
      card.querySelector('[data-act="yes"]').addEventListener('click', () => startDownload())
    }

    // ---- progress view ----
    const renderProgress = () => {
      card.dataset.phase = 'progress'
      card.innerHTML = `
        <div class="llm-setup-head">
          <div class="llm-setup-spark spinning">${GLYPH.download}</div>
          <h2 class="llm-setup-title">Setting up your local AI…</h2>
        </div>
        <p class="llm-setup-status">Starting…</p>
        <div class="llm-setup-bar"><div class="llm-setup-fill"></div></div>
        <div class="llm-setup-actions">
          <button class="llm-setup-btn ghost" data-act="cancel">Cancel</button>
        </div>`
      card.querySelector('[data-act="cancel"]').addEventListener('click', () => {
        api?.model?.cancel?.()
        finish('cancelled')
      })
    }

    const setProgress = (p) => {
      const statusEl = card.querySelector('.llm-setup-status')
      const fill = card.querySelector('.llm-setup-fill')
      if (!statusEl || !fill) return
      if (p.phase === 'downloading' && typeof p.percent === 'number') {
        fill.classList.remove('indeterminate')
        fill.style.width = `${Math.round(p.percent * 100)}%`
        const pct = Math.round(p.percent * 100)
        statusEl.textContent = pct > 0 ? `Downloading model — ${pct}%` : 'Downloading model…'
      } else {
        // 'starting' (or a status with no byte totals): show motion, not a fake number.
        fill.classList.add('indeterminate')
        statusEl.textContent = p.status || 'Working…'
      }
    }

    // Once a terminal view (done/error) is shown, lock it in. Both the 'done'/'error'
    // progress event AND the provision() promise resolving can reach for these renders;
    // without a guard they double-render, or one path's success flips the other path's
    // error out from under the user. Only the FIRST terminal view wins — mirrors how
    // finish() is settled-guarded.
    let viewSettled = false

    const renderDone = () => {
      if (viewSettled) return
      viewSettled = true
      card.dataset.phase = 'done'
      card.innerHTML = `
        <div class="llm-setup-head">
          <div class="llm-setup-spark ok">${GLYPH.bolt}</div>
          <h2 class="llm-setup-title">Your local AI is ready</h2>
        </div>
        <p class="llm-setup-body">Pulse now reads your panes on-device — privately, offline, and free. It runs in the background; there’s nothing else to set up.</p>
        <div class="llm-setup-actions">
          <button class="llm-setup-btn primary" data-act="done">Done</button>
        </div>`
      card.querySelector('[data-act="done"]').addEventListener('click', () => finish('installed'))
    }

    const renderError = (message) => {
      if (viewSettled) return
      viewSettled = true
      card.dataset.phase = 'error'
      card.innerHTML = `
        <div class="llm-setup-head">
          <div class="llm-setup-spark err">${GLYPH.bolt}</div>
          <h2 class="llm-setup-title">Couldn’t set up the local AI</h2>
        </div>
        <p class="llm-setup-body llm-setup-error"></p>
        <div class="llm-setup-actions">
          <button class="llm-setup-btn ghost" data-act="close">Close</button>
          <button class="llm-setup-btn primary" data-act="retry">Try again</button>
        </div>`
      card.querySelector('.llm-setup-error').textContent =
        message || 'Something went wrong. Please try again.'
      card.querySelector('[data-act="close"]').addEventListener('click', () => finish('error'))
      card.querySelector('[data-act="retry"]').addEventListener('click', () => startDownload())
    }

    const startDownload = () => {
      // Fresh attempt (including "Try again" from the error view): re-arm the terminal
      // view so this run's done/error can render again.
      viewSettled = false
      renderProgress()
      activeProgress = (p) => {
        if (p.phase === 'error') renderError(p.error)
        else if (p.phase === 'done') renderDone()
        else if (p.phase === 'cancelled') finish('cancelled')
        else setProgress(p)
      }
      api?.model
        ?.provision?.({})
        .then((res) => {
          // The 'done'/'error' progress event normally drives the view; this is a
          // belt-and-braces fallback in case the final event was missed.
          if (settled) return
          if (res?.ok) renderDone()
          else if (res?.error !== 'cancelled') renderError(null)
        })
        .catch(() => {
          if (!settled) renderError(null)
        })
    }

    renderPitch()
    document.body.appendChild(overlay)
    // Focus the primary action so Enter accepts.
    card.querySelector('[data-act="yes"]')?.focus()
  })
}
