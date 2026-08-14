#!/usr/bin/env node
// Build and install the current source as the one canonical local macOS app.
// Public distribution requires Developer ID + notarization, but a local install
// can use a complete ad-hoc signature once quarantine is removed. This script is
// deliberately invoked before every public-release attempt so /Applications never
// remains on an older version just because CI credentials are missing.

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const builtApp = path.join(root, 'release', 'mac-arm64', 'Concourse.app')
const installedApp = '/Applications/Concourse.app'
const stagingApp = `/Applications/.Concourse-installing-${process.pid}.app`

function die(message) {
  console.error(`\n✗ local install: ${message}\n`)
  process.exit(1)
}

function run(command, args, { capture = false } = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
}

function bundleVersion(appPath) {
  try {
    return run(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')],
      { capture: true }
    ).trim()
  } catch {
    return 'unknown'
  }
}

if (process.platform !== 'darwin') die('this installer is only for macOS')

console.log(`▶ Building local Concourse v${version}…`)
run('npm', ['run', 'preflight'])
run('npm', ['run', 'fetch:llama'])
run('npm', ['run', 'clean'])
run('npm', ['run', 'build'])
run('npx', [
  'electron-builder',
  '--mac',
  '--dir',
  '--publish',
  'never',
  '--config.mac.identity=-',
  '--config.mac.notarize=false'
])

if (!existsSync(builtApp)) die(`builder did not produce ${builtApp}`)
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', builtApp])
if (bundleVersion(builtApp) !== version) {
  die(`built bundle version is ${bundleVersion(builtApp)}, expected ${version}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').replace('Z', '')
const trash = path.join(os.homedir(), '.Trash')
let backup = null
try {
  // Verify a complete staged copy before touching the currently installed app.
  if (existsSync(stagingApp)) throw new Error(`staging path already exists: ${stagingApp}`)
  run('ditto', [builtApp, stagingApp])
  run('xattr', ['-dr', 'com.apple.quarantine', stagingApp])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagingApp])
  const stagedVersion = bundleVersion(stagingApp)
  if (stagedVersion !== version) throw new Error(`staged version is ${stagedVersion}, expected ${version}`)

  if (existsSync(installedApp)) {
    const previous = bundleVersion(installedApp)
    backup = path.join(trash, `Concourse-v${previous}-replaced-${stamp}.app`)
    renameSync(installedApp, backup)
    console.log(`↻ Previous local app moved to ${backup}`)
  }

  renameSync(stagingApp, installedApp)
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', installedApp])
  const installedVersion = bundleVersion(installedApp)
  if (installedVersion !== version) throw new Error(`installed version is ${installedVersion}, expected ${version}`)
} catch (error) {
  // Preserve failed copies in Trash and restore the previous known-good app.
  if (backup && existsSync(installedApp)) {
    renameSync(installedApp, path.join(trash, `Concourse-failed-install-${stamp}.app`))
  }
  if (backup && existsSync(backup) && !existsSync(installedApp)) renameSync(backup, installedApp)
  if (existsSync(stagingApp)) {
    renameSync(stagingApp, path.join(trash, `Concourse-failed-staging-${stamp}.app`))
  }
  die(error?.message || error)
}

// Launch only when no normal installed instance is already running. Replacing an
// app bundle does not replace already-loaded processes; auto-killing them could
// terminate live terminals/agents, so a running old instance gets a clear restart
// instruction instead.
let running = false
try {
  const pids = run('pgrep', ['-f', '^/Applications/Concourse\\.app/Contents/MacOS/Concourse( |$)'], {
    capture: true
  })
  running = Boolean(pids.trim())
} catch {
  running = false
}

if (running) {
  console.log(`\n✓ Concourse v${version} installed and verified at ${installedApp}`)
  console.log('  Quit every currently running Concourse window, then reopen it to load this version.')
} else {
  run('open', [installedApp])
  console.log(`\n✓ Concourse v${version} installed, verified, and launched from ${installedApp}`)
}
