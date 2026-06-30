import { app } from 'electron'

// Notify-only update check. Concourse ships as an unsigned developer beta, so it
// can't Squirrel-update in place (macOS refuses to apply updates to an unsigned
// app). Instead we poll the GitHub Releases API on launch and, if a newer version
// is published, the caller surfaces a "Download" toast that opens the release page.
// True background auto-install is Track B — it lands once the app is signed/notarized.
//
// Everything here is best-effort: offline, rate-limited, or malformed responses
// resolve to null so a failed check is invisible rather than noisy.

const REPO = 'adventurebeast/concourse'
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`

// Strict "a newer than b" for our dotted x.y.z tags. Missing/non-numeric parts
// count as 0, so a pre-release suffix can't read as "newer" than the plain tag.
export function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0
  }
  return false
}

// Resolve to { version, url } when GitHub's latest published release is newer than
// the running build, or null otherwise (including any failure). Drafts and
// pre-releases are ignored — `releases/latest` already excludes them, but we
// double-check in case the endpoint shape shifts.
export async function checkForUpdate({ signal } = {}) {
  try {
    const res = await fetch(LATEST_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Concourse/${app.getVersion()}`
      },
      signal
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.draft || data.prerelease) return null
    const latest = String(data.tag_name || '').replace(/^v/, '')
    if (!latest || !isNewer(latest, app.getVersion())) return null
    return { version: latest, url: data.html_url || `https://github.com/${REPO}/releases/latest` }
  } catch {
    return null // offline / rate-limited / malformed — stay silent
  }
}
