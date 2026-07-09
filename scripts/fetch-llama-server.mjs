#!/usr/bin/env node
// Vendor a llama.cpp `llama-server` binary into build/bin so the packaged app can ship
// a built-in local model runtime — no Ollama required. Idempotent: skips if the binary
// is already present. Run automatically by `npm run dist` / `npm run pack`, or by hand
// with `npm run fetch:llama`.
//
// It downloads the latest llama.cpp release asset for THIS platform/arch from GitHub,
// extracts it, and copies the server binary plus its sibling shared libraries into
// build/bin (the binary resolves the libs via @loader_path, so they ship together).
// llama.cpp is MIT-licensed — redistribution inside the app is fine.
//
// NOTE: this is build tooling that runs in plain Node (not Electron). It relies on the
// system `tar` for macOS/Linux .tar.gz assets; Windows .zip assets are extracted with
// PowerShell's Expand-Archive (`unzip` is NOT a stock Windows binary — it only happens
// to exist on Git-Bash-provisioned CI images).

import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  copyFileSync,
  statSync,
  chmodSync,
  writeFileSync
} from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const REPO = 'ggml-org/llama.cpp'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build', 'bin')
const serverName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

// Always leave build/bin present so electron-builder's extraResources never errors on a
// missing source dir. A failure here is NON-FATAL: the app just ships without the
// bundled runtime and falls back to Ollama / deterministic Pulse. So packaging never
// breaks just because GitHub was unreachable.
mkdirSync(outDir, { recursive: true })
const bail = (msg) => {
  console.warn(`[fetch:llama] ${msg} — building WITHOUT the bundled runtime.`)
  process.exit(0)
}

if (existsSync(join(outDir, serverName))) {
  console.log(`[fetch:llama] ${serverName} already in build/bin — skipping.`)
  process.exit(0)
}

// Preference-ordered name matchers for this platform/arch — the FIRST regex with a
// matching asset wins. Windows needs the ordering: the release carries several
// win-*-x64 builds (cpu / cuda / vulkan / …) and only the CPU build runs everywhere;
// a loose match used to grab whichever variant listed first (e.g. a CUDA build that
// won't start without the driver stack).
function assetMatchers() {
  const a = process.arch
  if (process.platform === 'darwin') return [a === 'arm64' ? /macos-arm64/i : /macos-x64/i]
  if (process.platform === 'linux') return [a === 'arm64' ? /ubuntu-arm64/i : /ubuntu-x64/i]
  if (process.platform === 'win32') return [/win-cpu-x64/i, /win-.*x64/i]
  return null
}

// Recursively find the directory that contains the server binary.
function findServerDir(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const st = statSync(p)
    if (st.isDirectory()) {
      const r = findServerDir(p)
      if (r) return r
    } else if (f === serverName) {
      return dir
    }
  }
  return null
}

async function main() {
  const matchers = assetMatchers()
  if (!matchers) bail(`unsupported platform ${process.platform}/${process.arch}`)

  console.log('[fetch:llama] querying latest llama.cpp release…')
  const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'user-agent': 'concourse-build', accept: 'application/vnd.github+json' }
  }).then((r) => r.json())

  // llama.cpp ships macOS/Linux as .tar.gz and Windows as .zip — accept either.
  // Walk the matchers in preference order (see assetMatchers).
  const isArchive = (n) => /\.(?:zip|tar\.gz|tgz)$/i.test(n)
  let asset = null
  for (const m of matchers) {
    asset = (rel.assets || []).find((x) => m.test(x.name) && isArchive(x.name))
    if (asset) break
  }
  if (!asset) {
    console.warn('[fetch:llama] available assets:', (rel.assets || []).map((x) => x.name).join(', '))
    bail(`no matching release asset for ${process.platform}/${process.arch}`)
  }
  console.log(`[fetch:llama] downloading ${asset.name} (~${(asset.size / 1e6).toFixed(0)} MB)…`)

  const work = join(tmpdir(), `llama-fetch-${process.pid}`)
  mkdirSync(work, { recursive: true })
  const zipPath = join(work, asset.name)
  const bytes = Buffer.from(
    await fetch(asset.browser_download_url, { headers: { 'user-agent': 'concourse-build' } }).then((r) =>
      r.arrayBuffer()
    )
  )
  writeFileSync(zipPath, bytes)

  console.log('[fetch:llama] extracting…')
  if (/\.zip$/i.test(asset.name)) {
    if (process.platform === 'win32') {
      // Expand-Archive ships with every PowerShell — `unzip` does not exist on a
      // clean Windows box (a local `npm run dist:win` would die on ENOENT).
      const q = (s) => `'${s.replace(/'/g, "''")}'`
      execFileSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${q(zipPath)} -DestinationPath ${q(work)} -Force`
      ])
    } else {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', work])
    }
  } else {
    execFileSync('tar', ['-xzf', zipPath, '-C', work]) // .tar.gz / .tgz (macOS/Linux)
  }

  const srcDir = findServerDir(work)
  if (!srcDir) bail('llama-server not found inside the archive')

  // Ship ONLY the server binary + its shared libraries (it resolves them via
  // @loader_path / rpath, so they must sit beside it) + the LICENSE. The archive also
  // bundles a dozen other CLI tools (llama-cli, llama-bench, llama-tts, rpc-server, …)
  // that Pulse never calls — copying them too would triple the runtime's footprint in
  // the app for nothing.
  const isLib = (f) => /\.(?:dylib|so(?:\.\d+)*|dll)$/i.test(f)
  for (const f of readdirSync(srcDir)) {
    const s = join(srcDir, f)
    if (!statSync(s).isFile()) continue
    if (f === serverName || isLib(f) || f === 'LICENSE') copyFileSync(s, join(outDir, f))
  }
  chmodSync(join(outDir, serverName), 0o755)
  rmSync(work, { recursive: true, force: true })
  console.log(`[fetch:llama] ✓ vendored ${serverName} + libs into build/bin`)
}

main().catch((e) => bail(`failed: ${e?.message || e}`))
