#!/usr/bin/env node
// Create the GitHub Release + immutable version tag. Native installers are never
// uploaded from a workstation: the tag triggers build-mac.yml and build-win.yml,
// which build on native runners and attach verified artifacts. The macOS workflow
// refuses to upload unless Developer ID signing, notarization, stapling, strict
// codesign verification, and Gatekeeper assessment all succeed.
//
// Usage:
//   npm run release            # install locally, then publish if distribution credentials exist
//   npm run release -- --draft # create as a draft so you can review/edit before publishing
//   npm run release -- --notes path/to/body.md   # use a hand-written body verbatim
//   npm run release -- --dry-run # print the tag/title/notes and exit; touch nothing
//
// Idempotent: re-running for the same version updates the notes. The release tag
// is created at HEAD by gh, so run this AFTER the version-bump commit is in place.

import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'

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
const exeName = `Concourse-${version}-x64.exe`
const REQUIRED_RELEASE_SECRETS = [
  'MAC_CSC_LINK',
  'MAC_CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER'
]
const localInstaller = path.join(root, 'scripts', 'install-local.mjs')

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

function skipPublicRelease(reason) {
  console.warn(`\n⚠ Local v${version} install succeeded; public ${tag} release skipped.`)
  console.warn(`  ${reason}\n`)
  process.exit(0)
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

// A real release always refreshes /Applications first. This happens before GitHub
// auth/secret checks by design: a missing public-distribution credential must never
// leave the developer running an old local build again.
if (!dryRun) {
  try {
    execFileSync(process.execPath, [localInstaller], { cwd: root, stdio: 'inherit' })
  } catch {
    die('local build/install failed; refusing to continue to the public release step')
  }
}

// A dry run only previews the tag/notes, so it tolerates missing auth/secrets.
if (!dryRun && run('gh', ['auth', 'status']) === null) {
  skipPublicRelease('GitHub CLI is not authenticated. Run `gh auth login` when you want to publish.')
}
if (!dryRun) {
  const configured = run('gh', ['secret', 'list', '--json', 'name', '-q', '.[].name'])
  const names = new Set((configured || '').split('\n').filter(Boolean))
  const missing = REQUIRED_RELEASE_SECRETS.filter((name) => !names.has(name))
  if (missing.length) {
    skipPublicRelease(
      `Protected macOS distribution credentials are missing:\n` +
        missing.map((name) => `  - ${name}`).join('\n') +
        '\n  Configure them as GitHub Actions secrets; never paste their values into release commands or notes.'
    )
  }
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

> ⚠️ **Developer beta.** Apple Silicon (M-series) Macs and 64-bit Windows. macOS builds are Developer ID-signed, Apple-notarized, and Gatekeeper-verified by CI before upload. Windows builds are not yet code-signed, so SmartScreen may warn on first launch. On an Intel Mac, run from source (see the README).

### Install — macOS (Apple Silicon)
1. Download **\`${dmgName}\`** below. (The signed and notarized CI build appears after the release checks finish.)
2. Open it and drag **Concourse** into **Applications**.
3. Open Concourse normally. No quarantine-removal command is required.

### Install — Windows (x64)
1. Download **\`${exeName}\`** below. (Built by CI — it appears a few minutes after this release goes live.)
2. Run it. SmartScreen will warn once (unsigned beta): **More info → Run anyway**.

### What's new ${sinceLabel}
${changelogSince(prev)}

Licensed under **AGPL-3.0**. Feedback and issues welcome.
`

const title = `Concourse ${version} — developer beta`

if (dryRun) {
  console.log(`tag:   ${tag}`)
  console.log(`title: ${title}`)
  console.log(`assets: signed macOS + native Windows installers built by tag-triggered CI`)
  console.log(`\n--- notes ---\n${body}`)
  process.exit(0)
}

// gh chokes on a multi-line --notes string across shells; hand it a file instead.
const notesDir = mkdtempSync(path.join(os.tmpdir(), 'concourse-release-'))
const bodyFile = path.join(notesDir, `.notes-${version}.md`)
writeFileSync(bodyFile, body)
const exists = run('gh', ['release', 'view', tag]) !== null

if (exists) {
  console.log(`↻ Release ${tag} exists — updating notes…`)
  if (run('gh', ['release', 'edit', tag, '--title', title, '--notes-file', bodyFile], { capture: false }) === null)
    die(`Failed to update release ${tag}.`)
} else {
  console.log(`↑ Creating release ${tag}…`)
  const create = ['release', 'create', tag, '--title', title, '--notes-file', bodyFile]
  if (draft) create.push('--draft')
  if (run('gh', create, { capture: false }) === null) die(`Failed to create release ${tag}.`)
}

const url = run('gh', ['release', 'view', tag, '--json', 'url', '-q', '.url']) || ''
console.log(`\n✓ ${draft && !exists ? 'Draft ' : ''}Release ${tag} created; native CI artifacts are pending`)
if (url) console.log(`  ${url}`)
if (!notesFile) console.log('  (auto-generated "What\'s new" — edit on GitHub to polish.)')
