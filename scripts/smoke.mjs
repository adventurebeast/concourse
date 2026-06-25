#!/usr/bin/env node
// Post-build smoke test: launch the packaged app and confirm it actually BOOTS —
// a build can compile clean yet crash instantly on launch (a node-pty native
// mismatch, a missing bundled asset, a bad llama path). The only check the build
// flow had before this was "eyeball the version in the status bar", which says
// nothing if the window never appeared. This turns that into a hard pass/fail.
//
// How: snapshot the running Concourse PIDs, `open -n` a NEW instance (never
// touching one that may host this very session), wait, then verify the instance
// we launched is STILL alive and left no fresh crash report behind. Comparing
// PIDs (not just "is any Concourse running") means a separate dev/host instance
// can be open and we still detect the new one dying.
//
// Usage:
//   npm run smoke                       # /Applications/Concourse.app, 6s settle
//   npm run smoke -- --wait 10          # wait longer before judging
//   npm run smoke -- /path/to/Concourse.app
//
// Exit 0 = booted and stayed up; exit 1 = crashed/never started (with the crash
// report path if one was found). Safe to run inside Concourse: open -n is a
// separate instance and we never quit anything.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { execFileSync, execSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const waitIdx = args.indexOf('--wait')
const waitSec = waitIdx !== -1 ? Number(args[waitIdx + 1]) || 6 : 6
const appPath =
  args.find((a) => a.endsWith('.app')) || '/Applications/Concourse.app'

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const fail = (msg) => {
  console.error(`\n✗ smoke: ${msg}\n`)
  process.exit(1)
}

if (!existsSync(appPath)) {
  fail(`app not found at ${appPath}\n  Install it first (e.g. /build-app installs to /Applications).`)
}

// The Mach-O the bundle actually runs — matched by full path so it never collides
// with this node process or an editor that merely has "Concourse" in a filename.
const execGlob = `${appPath}/Contents/MacOS/`
const pids = () => {
  try {
    return new Set(
      execSync(`pgrep -f ${JSON.stringify(execGlob)}`, { encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  } catch {
    return new Set() // pgrep exits non-zero when nothing matches
  }
}

// Crash reports macOS writes when an app dies on launch — used only to enrich the
// failure message, so we know WHY it didn't stay up.
function freshCrash(sinceMs) {
  const dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports')
  try {
    return readdirSync(dir)
      .filter((f) => /^Concourse[-.]/.test(f) && /\.(ips|crash)$/i.test(f))
      .map((f) => path.join(dir, f))
      .find((p) => statSync(p).mtimeMs >= sinceMs)
  } catch {
    return null
  }
}

const before = pids()
const startMs = Date.now()
console.log(`▶ launching ${appPath} (expecting v${version})…`)
try {
  execFileSync('open', ['-n', appPath])
} catch (e) {
  fail(`open failed: ${e?.message || e}`)
}

// Busy-wait without timers (keep the script dependency-free); we only need a coarse
// settle window, and the loop is idle CPU for a few seconds at most.
const deadline = startMs + waitSec * 1000
while (Date.now() < deadline) {
  try {
    execSync('sleep 0.5')
  } catch {
    break
  }
}

const after = pids()
const launched = [...after].filter((p) => !before.has(p))
const crash = freshCrash(startMs)

if (launched.length === 0) {
  fail(
    `the launched instance is not running after ${waitSec}s — it crashed or never started.` +
      (crash ? `\n  Crash report: ${crash}` : '\n  (No crash report found; check Console.app.)')
  )
}
if (crash) {
  fail(`a new Concourse crash report appeared during launch:\n  ${crash}`)
}

console.log(`\n✓ smoke: Concourse booted and stayed up (${launched.length} new process) after ${waitSec}s.`)
console.log(`  Confirm the bottom-right status bar reads v${version}.`)
