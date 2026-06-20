import './beginnerHud.css'
import { icon } from './icons.js'
import { detectProjectType } from './projectType.js'

// The beginner "heads-up" line that sits just above the terminal: a calm, always-on
// answer to "where am I and what's going on?". It ties the abstract prompt
// (`concourse ❯`) to something concrete — the folder you're in, whether it's a git
// project, which branch, and how many changes are waiting.
//
// Beginner mode only (gated in CSS on data-mode) and only shown once a folder is
// open. This module is also meant to be the shared surface later beginner aids
// (friendly errors, "what just happened") plug into.
export function createBeginnerHud() {
  const el = document.getElementById('beginner-context')

  let root = null
  let status = { isRepo: false }
  // Detected { icon, label } for the open folder (e.g. { icon:'react', label:'a React app' }),
  // or null while detecting / when the project kind is unknown.
  let project = null

  function basename(p) {
    if (!p) return ''
    const parts = String(p).replace(/[/\\]+$/, '').split(/[/\\]/)
    return parts[parts.length - 1] || p
  }

  function render() {
    // Nothing useful to say until a folder is open.
    if (!root) {
      el.hidden = true
      el.innerHTML = ''
      return
    }
    el.hidden = false

    const parts = []
    // The leading icon and description adapt to the kind of project detected: a
    // React app shows the atom glyph and reads "a React app"; an unknown folder
    // falls back to the plain folder icon and no description.
    const leadIcon = project ? project.icon : 'folderOpen'
    const desc = project ? `, ${escapeHtml(project.label)}` : ''
    parts.push(
      `<span class="bh-item"><span class="bh-icon">${icon(leadIcon, 13)}</span>` +
        `You're in <strong>${escapeHtml(basename(root))}</strong>${desc}</span>`
    )

    if (status.isRepo) {
      const branch = status.branch ? `on <strong>${escapeHtml(status.branch)}</strong>` : ''
      // Once the project is already named, don't repeat "a git project" — just the branch.
      const gitText = branch ? (project ? branch : `a git project ${branch}`) : 'a git project'
      parts.push(
        `<span class="bh-sep">·</span><span class="bh-item"><span class="bh-icon">${icon('gitBranch', 13)}</span>` +
          `${gitText}</span>`
      )
      const n = (status.staged?.length || 0) + (status.changes?.length || 0)
      const changeText =
        n === 0 ? 'no changes yet' : n === 1 ? '1 change waiting' : `${n} changes waiting`
      parts.push(`<span class="bh-sep">·</span><span class="bh-item bh-muted">${changeText}</span>`)
    } else {
      parts.push(`<span class="bh-sep">·</span><span class="bh-item bh-muted">not a git project</span>`)
    }

    el.innerHTML = parts.join('')
  }

  return {
    setRoot(r) {
      root = r
      project = null // unknown until detection resolves; render the folder fallback now
      render()
      if (!r) return
      // Detect asynchronously and repaint — but only if this is still the open folder.
      detectProjectType(r).then((p) => {
        if (root !== r) return
        project = p
        render()
      })
    },
    setStatus(s) {
      status = s || { isRepo: false }
      render()
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
