#!/usr/bin/env node
// Publish the already-built DMG in release/ as a GitHub Release — the manual
// distribution step that turns a local `npm run dist` into something users can
// download. This does NOT build: run `npm run dist` (or `/build-app`) first, then
// `npm run release`. Mirrors the hand-rolled convention used through v0.0.20:
// tag `vX.Y.Z`, title "Concourse X.Y.Z — developer beta", unsigned-beta notes
// with the one-time Gatekeeper quarantine bypass.
//
// Usage:
//   npm run release            # create (or update) the release for package.json's version
//   npm run release -- --draft # create as a draft so you can review/edit before publishing
//   npm run release -- --notes path/to/body.md   # use a hand-written body verbatim
//   npm run release -- --dry-run # print the tag/title/notes and exit; touch nothing
//
// Idempotent: re-running for the same version re-uploads the DMG (--clobber) and
// updates the notes, so a botched run is safe to repeat. gh auth + a built DMG
// are the only prerequisites; the release tag is created at HEAD by gh, so run
// this AFTER the version-bump commit is in place.

import { readFileSync, existsSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const draft = args.includes('--draft')
const dryRun = args.includes('--dry-run')
const notesArg = args.indexOf('--notes')
const notesFile = notesArg !== -1 ? args[notesArg + 1] : null

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const dmgName = `Concourse-${version}-arm64.dmg`
const dmg = path.join(root, 'release', dmgName)

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

// `git`/`gh` wrappers: trimmed stdout on success, or null on failure (so callers
// can probe "does this release exist?" without a try/catch around every call).
function run(cmd, a, { capture = true } = {}) {
  try {
    const out = execFileSync(cmd, a, {
      cwd: root,
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    })
    return capture ? out.trim() : ''
  } catch {
    return null
  }
}

// A dry run only previews the notes, so it tolerates a missing DMG / no gh auth.
if (!existsSync(dmg) && !dryRun) {
  die(`No DMG at release/${dmgName}.\n  Build it first:  npm run dist   (or /build-app)`)
}
if (!dryRun && run('gh', ['auth', 'status']) === null) {
  die('gh is not authenticated. Run:  gh auth login')
}

// Previous release tag = the latest published gh release that isn't this version.
// We ask gh (the source of truth for releases) rather than local git tags, which
// can lag behind since gh creates the tags server-side. Fetch it locally so the
// changelog range below resolves; if any of this fails we just skip the changelog.
function previousTag() {
  const list = run('gh', ['release', 'list', '--limit', '30', '--json', 'tagName', '-q', '.[].tagName'])
  if (!list) return null
  const prev = list.split('\n').map((s) => s.trim()).filter((t) => t && t !== tag)[0]
  if (prev) run('git', ['fetch', '--quiet', 'origin', 'tag', prev]) // best-effort; ok if it already exists
  return prev || null
}

// Auto changelog: commit subjects since the previous tag, merges and the noisy
// version-bump commit dropped. A rough first draft — edit on GitHub (or pass
// --notes) for the polished "what's new" prose the prior releases had.
function changelogSince(prev) {
  if (!prev) return '- _first release — add highlights here_'
  const log = run('git', ['log', `${prev}..HEAD`, '--no-merges', '--pretty=- %s'])
  if (log === null) return '- _edit me: could not read git log_'
  const lines = log.split('\n').filter((l) => l.trim() && !/^- chore: bump version/.test(l))
  return lines.length ? lines.join('\n') : `- _no commits since ${prev}_`
}

const prev = previousTag()
const sinceLabel = prev ? `since ${prev.replace(/^v/, '')}` : ''

const body =
  notesFile
    ? readFileSync(notesFile, 'utf8')
    : `**Concourse** — a lightweight, ultrafast, open-source IDE for driving a fleet of CLI coding agents (Claude Code, Codex, and any terminal-native agent) from one workbench.

> ⚠️ **Developer beta.** Apple Silicon (M-series) only, and **not yet signed/notarized by Apple** — so macOS will block it on first launch. One-time bypass below. A signed, double-click-to-open build is coming for 1.0. On an Intel Mac, run from source (see the README).

### Install
1. Download **\`${dmgName}\`** below.
2. Open it and drag **Concourse** into **Applications**.
3. Clear the download quarantine once, then open normally:
   \`\`\`bash
   xattr -dr com.apple.quarantine /Applications/Concourse.app
   \`\`\`
   (Or: right-click the app → **Open**, or **System Settings → Privacy & Security → Open Anyway**.)

### What's new ${sinceLabel}
${changelogSince(prev)}

Licensed under **AGPL-3.0**. Feedback and issues welcome.
`

const title = `Concourse ${version} — developer beta`

if (dryRun) {
  console.log(`tag:   ${tag}`)
  console.log(`title: ${title}`)
  console.log(`asset: release/${dmgName}${existsSync(dmg) ? '' : '  (NOT BUILT YET)'}`)
  console.log(`\n--- notes ---\n${body}`)
  process.exit(0)
}

// gh chokes on a multi-line --notes string across shells; hand it a file instead.
const bodyFile = path.join(root, 'release', `.notes-${version}.md`)
writeFileSync(bodyFile, body)
const exists = run('gh', ['release', 'view', tag]) !== null

if (exists) {
  console.log(`↻ Release ${tag} exists — updating notes and re-uploading DMG…`)
  if (run('gh', ['release', 'edit', tag, '--title', title, '--notes-file', bodyFile], { capture: false }) === null)
    die(`Failed to update release ${tag}.`)
  if (run('gh', ['release', 'upload', tag, dmg, '--clobber'], { capture: false }) === null)
    die(`Failed to upload ${dmgName}.`)
} else {
  console.log(`↑ Creating release ${tag}…`)
  const create = ['release', 'create', tag, dmg, '--title', title, '--notes-file', bodyFile]
  if (draft) create.push('--draft')
  if (run('gh', create, { capture: false }) === null) die(`Failed to create release ${tag}.`)
}

const url = run('gh', ['release', 'view', tag, '--json', 'url', '-q', '.url']) || ''
console.log(`\n✓ ${draft && !exists ? 'Draft ' : ''}Release ${tag} ready with ${dmgName}`)
if (url) console.log(`  ${url}`)
if (!notesFile) console.log('  (auto-generated "What\'s new" — edit on GitHub to polish.)')
