# Concourse — Security & Robustness Audit

Domain: security-robustness
Auditor role: Application security engineer (Electron app that executes shells + spawns AI agent processes)
Scope: Electron hardening, IPC trust boundary, secret handling, supply chain, distribution at scale
Date: 2026-06-19
Verified against: Electron 33.4.11, @anthropic-ai/sdk 0.104.1 (resolved from `"latest"`), node-pty 1.0

---

## Executive summary

Concourse is, by design, a remote-code-execution surface: it spawns the user's login shell via node-pty and routes raw bytes from the renderer straight into those shells. That makes the renderer↔main IPC boundary the entire security story. The good news: contextIsolation is implicitly ON (default in E33, and the preload uses `contextBridge`), nodeIntegration is implicitly OFF, a real CSP exists, `setWindowOpenHandler` denies popups, and the Anthropic key genuinely never crosses into the renderer (it lives in `ipc-pulse.js` in main; the renderer only ships a text tail). The preload exposes a small, explicit API rather than leaking `ipcRenderer`.

The bad news is the IPC boundary is almost entirely **unvalidated**. `sandbox: false` is set explicitly, throwing away the renderer-side sandbox. Every `fs:*` handler operates on whatever absolute path the renderer hands it — there is **no workspace confinement** at all, so a single XSS in the renderer (or a compromised dependency running in renderer context) reads/writes/deletes anywhere on the user's disk. `git:diff` passes an unvalidated `relPath` into `git show 'HEAD:'+relPath`. `@anthropic-ai/sdk` is pinned to `"latest"`, which is a live supply-chain hole. For distribution, the app is **unsigned, un-notarized, and has no auto-update channel at all** — shipping this to 100M users as-is is not viable.

Because the threat model for this app is "the renderer is the attack surface and the shell is the payload," I rate the missing IPC validation and `sandbox:false` as the dominant risks even though there is no known injection point into the renderer today — the blast radius is total (arbitrary file I/O + arbitrary shell exec) and the only thing standing between an attacker and that blast radius is "no bug in any renderer dependency, ever."

---

## Findings

### SEC-1 — `sandbox: false` disables the renderer sandbox in an RCE-class app — HIGH (confidence: high)
**Location:** `src/main/index.js:40`
```js
webPreferences: {
  preload: join(import.meta.dirname, '../preload/index.mjs'),
  sandbox: false
}
```
The renderer hosts Monaco, xterm, a file tree, and renders untrusted content (file contents, git diffs, terminal output, dropped web images). With `sandbox:false` the renderer process runs without the OS sandbox, so any renderer-side code-execution bug (a Monaco/xterm/dependency RCE, a `innerHTML` injection — see SEC-7) gets a full Node-capable-adjacent process and direct, unmediated access to every IPC channel, which in this app means arbitrary file I/O and arbitrary shell execution.

There is no stated reason `sandbox:false` is required — the preload only uses `contextBridge`, `ipcRenderer`, and `webUtils.getPathForFile`, all of which work in a sandboxed preload. (`webUtils` is available in sandboxed preloads in E33.)

**Fix:** Remove `sandbox: false` (let it default to `true`). Re-test `pathForFile` (webUtils) and the menu/IPC bridge under the sandbox; all three APIs used are sandbox-compatible. If something breaks, fix that specific thing rather than disabling the sandbox globally. Also explicitly set `contextIsolation: true` and `nodeIntegration: false` rather than relying on defaults, so a future Electron default change or a copy-paste can't silently weaken it.

---

### SEC-2 — No path confinement in `ipc-fs.js`: renderer can read/write/delete anywhere on disk — HIGH (confidence: high)
**Location:** `src/main/ipc-fs.js:24-71` (all handlers)
```js
ipcMain.handle('fs:readFile', async (_e, filePath) => fs.readFile(filePath, 'utf8'))
ipcMain.handle('fs:writeFile', async (_e, filePath, content) => { await fs.writeFile(filePath, content); return true })
ipcMain.handle('fs:delete', async (_e, p) => { await fs.rm(p, { recursive: true, force: true }); return true })
```
None of these handlers consult `ctx.getRoot(_e.sender)` or constrain the path to the workspace root. The renderer passes absolute paths and main obeys. So the effective capability granted to the renderer is "read, overwrite, create, rename, and recursively delete any path the app's OS user can touch" — `~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.zshrc`, `/etc/...` if writable. `fs:delete` with `{ recursive: true, force: true }` on an attacker-chosen path is effectively `rm -rf` of anything.

In normal use the renderer only passes paths under the tree, but the trust boundary is the IPC, not the UI. Combined with SEC-1 (no sandbox) this is the single largest blast radius in the app.

**Fix:** Add a `confine(root, p)` helper that resolves `path.resolve(root, p)`, verifies `resolved === root || resolved.startsWith(root + path.sep)`, and rejects symlink escapes (`fs.realpath` the parent and re-check). Apply it to every `fs:*` handler. Reject (throw) when no root is open or the path escapes. The temp-dir writers (`fs:saveDrop`) are an exception — they already build their own path under `os.tmpdir()` and sanitize the basename, which is the correct pattern.

---

### SEC-3 — `git:diff` passes unvalidated `relPath` into git object specs and `join(root, relPath)` — MEDIUM (confidence: high)
**Location:** `src/main/ipc-git.js:85-113`
```js
ipcMain.handle('git:diff', async (e, relPath, staged = false) => {
  ...
  original = await git.show(['HEAD:' + relPath])      // line 92
  modified = await git.show([':' + relPath])           // line 100 (staged)
  modified = await fs.readFile(join(root, relPath), 'utf8') // line 107 (unstaged)
```
`relPath` is renderer-controlled and unvalidated. The unstaged branch does `fs.readFile(join(root, relPath))` — a `relPath` of `../../../../etc/passwd` reads outside the workspace (same class as SEC-2). The git branches are passed as a single arg to `simple-git`'s `show`, so this is not classic shell injection, but `HEAD:` / `:` gitrevisions syntax still lets the renderer read arbitrary blobs/paths inside the repo and, via `..`, traverse. Unlike the other git handlers, `git:diff` is **not** wrapped to consult the workspace boundary.

**Fix:** Validate `relPath` is a string, reject any segment of `..` and any absolute path, and confine `join(root, relPath)` with the same helper from SEC-2. For the `git.show` specs, normalize the path and reject `..`.

---

### SEC-4 — `@anthropic-ai/sdk: "latest"` is an unpinned, live supply-chain dependency — HIGH (confidence: high)
**Location:** `package.json:19` (`"@anthropic-ai/sdk": "latest"`); also recorded as `"latest"` in `package-lock.json:12`
`"latest"` means every fresh `npm install` (CI, a new contributor, a release build machine) can resolve a different, newer version than what was audited — currently 0.104.1. This SDK runs **in the main process**, which is the privileged side with the Anthropic API key, network access, and full Node. A compromised or malicious release (npm account takeover, dependency-confusion, a bad transitive dep) executes with the key in scope. The lockfile pins the resolved tree for `npm ci`, but the manifest range itself is `"latest"`, so any `npm install`/`npm update` re-floats it, and the lockfile literally stores the spec as `"latest"`.

A second, latent correctness risk rides on this: `ipc-pulse.js:152` uses `output_config.format.json_schema`, which is a recent SDK feature (present in 0.104.1, confirmed in `messages.d.ts`). Pinning to an older `"latest"` resolution would break Pulse's Claude backend at runtime. This couples a security range to a runtime API contract — exactly what pinning prevents.

**Fix:** Pin to an exact, audited version, e.g. `"@anthropic-ai/sdk": "0.104.1"` (or a `~0.104.x` patch range at most), and commit the lockfile. Add `npm audit` / a CI step that fails on a changed resolution. Audit other ranges too: `^` ranges on `node-pty`, `simple-git`, `@xterm/*`, `electron`, `electron-builder`, `monaco-editor` all float minor/patch — acceptable for devDeps, but `node-pty` and `simple-git` are runtime/privileged and worth tightening.

---

### SEC-5 — Unsigned, un-notarized distribution with `identity: null` — HIGH for 100M-scale (confidence: high)
**Location:** `electron-builder.yml:20-22`
```yaml
# Local "stable" build for personal use — no Apple signing/notarization.
identity: null
```
`identity: null` disables macOS code signing; there is no `afterSign`/notarization hook and no hardened-runtime entitlements file referenced. A build produced this way will be Gatekeeper-quarantined on every other Mac (users must right-click→Open or `xattr -d`), trains users to bypass Gatekeeper, and — critically — ships **unsigned binaries with no integrity guarantee**. At any real scale an attacker who can get a tampered DMG in front of users (mirror, MITM of a download, malicious "Concourse" reupload) faces zero signature verification. For an app that spawns the user's shell, a trojaned build is game over.

**Fix:** Before any public distribution: enable Developer ID signing (`identity` = your cert or omit to auto-detect), add hardened runtime + a minimal entitlements plist, and wire notarization (`@electron/notarize` via electron-builder's `afterSign`/`notarize` config). The comment "for personal use" is fine for a local build, but this file is the one that ships, so the scaling note below treats it as the release config.

---

### SEC-6 — No auto-update mechanism, and no update-signature story — HIGH for 100M-scale (confidence: high)
**Location:** absence across `package.json` (no `electron-updater`), `electron-builder.yml` (no `publish:` block), `src/main/index.js` (no `autoUpdater`)
There is no `electron-updater`/`autoUpdater` wiring and no `publish` config, so there is **no update channel at all**. At 100M users that means: you cannot push a security fix; users run whatever they downloaded forever; and when you *do* add updates, doing it wrong is catastrophic. Electron's `autoUpdater` on macOS (Squirrel.Mac) verifies updates via **code signature**, so SEC-5 is a prerequisite — an unsigned app cannot have a trustworthy update path. An attacker who controls the update feed (or MITMs an HTTP feed, or a feed with no signature pinning) pushes a malicious build that, again, owns the user's shell.

**Fix:** Adopt `electron-updater` with an HTTPS-only feed and rely on Squirrel.Mac's signature verification (requires SEC-5 signing). Pin the feed to your domain over TLS; never ship an HTTP update URL. Consider a staged rollout + a kill-switch. Add a minimal "you are N versions behind" nag so stale installs are visible.

---

### SEC-7 — `innerHTML` sinks fed by filesystem-derived strings — MEDIUM (confidence: medium)
**Location:** `src/renderer/fileTree.js:234` (`icon.innerHTML = ... fileIcon(entry.name)`), `:328`, plus icon sinks at `:227,278,325,424`; `src/renderer/terminals.js:108,121,274,596,617,640`
`fileIcon(entry.name)` selects an icon by extension; if any code path interpolates the raw filename (or other on-disk-derived text such as a git branch, a search snippet, or a Pulse summary) into an `innerHTML` template, a crafted filename like `<img src=x onerror=...>` becomes script in the renderer. With SEC-1 (no sandbox) and SEC-2 (full-disk fs), renderer script execution escalates to full RCE. I did not confirm a concrete injected-filename path reaches `innerHTML` verbatim (the icon helpers appear to emit static SVG keyed by extension, not the name), so this is **medium confidence** — it's a dangerous pattern in a file-tree that renders attacker-influenced names, not a proven exploit.

**What would confirm it:** trace each `innerHTML` assignment back to its inputs and check whether any concatenates `entry.name`, a git branch, a search line, or a Pulse `summary`/`question` string without escaping. Pulse output in particular is model-controlled text rendered in the UI — if it lands in `innerHTML`, a prompt-injected agent pane could XSS the host.

**Fix:** Replace `innerHTML` with `textContent` for any text, and build icon SVGs with DOM APIs or a fixed template where only known-safe constants are interpolated. Treat Pulse `summary`/`question` and filenames as untrusted strings at every UI sink.

---

### SEC-8 — Renderer-controlled `cwd` and friendly-prompt rc files in shared world-readable temp dir — MEDIUM (confidence: medium)
**Location:** `src/main/ipc-pty.js:97,137` (`cwd: cwd || ctx.getRoot(...)`), and `:50-81` (`friendlyPromptSetup` writes to `os.tmpdir()/concourse-shell-init`)
`term:create` accepts an arbitrary `cwd` from the renderer with no confinement — a spawned shell can be started in any directory. That is low-severity on its own (the user can `cd` anyway), but it means PTY spawn location is fully renderer-trusted. More notable: the generated rc files (`.zshrc`, `concourse.bashrc`) are written to a **predictable, shared** path under `os.tmpdir()` (typically world-readable on macOS, and shared across all users on multi-user systems) and then **sourced by the user's login shell** via `ZDOTDIR`/`--rcfile`. On a shared/multi-user host, another local user who can write that predictable path before Concourse sources it can inject shell commands that run in the victim's shell. The content the app writes is itself safe (paths are `shq`-quoted at `ipc-pty.js:31`), but the file location is attacker-pre-creatable.

**What would confirm it:** check `os.tmpdir()` perms on target macOS (per-user `$TMPDIR` on macOS is `700`, which would neutralize this; a hardcoded `/tmp` would not). The code uses `os.tmpdir()`, which on macOS is the per-user dir — so this is **medium/low** on stock macOS and rises on Linux or any host where TMPDIR is `/tmp`.

**Fix:** Write rc files under `app.getPath('userData')` (per-user, app-owned) instead of `os.tmpdir()`, create the dir with mode `0700`, and use a random per-session filename. Confine `cwd` to existing directories (and ideally to the workspace root) before spawning.

---

### SEC-9 — Anthropic key correctly isolated, but Pulse provider config trusts env with no redaction in logs — LOW (confidence: high)
**Location:** `src/main/ipc-pulse.js:129,211,255` and `:131`
Positive confirmation first: the key is read only in main (`process.env.ANTHROPIC_API_KEY`, `ipc-pulse.js:211`), passed only to `new Anthropic({ apiKey })` (`:129`), and never sent over IPC — `pulse:summarize` returns only the parsed `{state,summary,question}` verdict. The renderer never sees the key. Good.

Two residual concerns: (1) `CONCOURSE_PULSE_BASE_URL` lets the operator point Pulse at *any* URL and Pulse will POST the pane's recent terminal output (up to 8000 chars — possibly secrets the agent printed) there with an optional bearer key; that's by design but worth documenting as a data-egress setting. (2) Error logging at `:131` and `:255` logs `err?.message`; SDK/network errors generally don't echo the key, but an unredacted dump of a request error *could*. Low risk, but in a 100M-user telemetry pipeline (see scaling) any main-process log that might contain a key or pane contents must be scrubbed before it leaves the device.

**Fix:** Document `CONCOURSE_PULSE_BASE_URL`/`_API_KEY` as a data-egress control; ensure any future crash/telemetry reporter explicitly redacts `ANTHROPIC_API_KEY`, `CONCOURSE_PULSE_API_KEY`, and never uploads pane tails.

---

### SEC-10 — `shell:openPath` / `showItemInFolder` pass renderer paths to the OS opener unchecked — LOW (confidence: medium)
**Location:** `src/main/ipc-shell.js:8-17`
`shell.openPath(p)` opens an arbitrary renderer-supplied path with its default handler. `shell.openPath` will not execute a path as a command, but it *will* launch the default app for, e.g., a `.app` bundle or a document that auto-runs macros — so "open this path" is a meaningful capability if the renderer is compromised (SEC-1). It's gated only on `if (p)`. `showItemInFolder` is lower-risk (reveals in Finder).

**Fix:** This is acceptable for the in-app "Reveal in Finder" use, but confine `openPath` to paths under the workspace root (reuse the SEC-2 helper) and refuse executable bundles, so a compromised renderer can't auto-launch arbitrary local apps.

---

### SEC-11 — `before-input-event` ⌘R guard is bypassable; reload wipes all terminals — LOW (confidence: high)
**Location:** `src/main/index.js:62-66`
The reload guard only intercepts `key === 'r'` with meta/control. It won't catch `location.reload()` from any renderer script, programmatic navigation, or a renderer crash/reload. A reload destroys every PTY and editor tab (data-loss, not a classic security issue), and on reload the renderer re-runs against the same un-validated IPC. Robustness, not exploitability.

**Fix:** Also handle `will-navigate`/`will-prevent-unload` to block in-page navigation, and persist enough session state that an unexpected reload is recoverable rather than destructive.

---

## Cross-cutting themes

1. **The IPC boundary is the whole security model, and it is unvalidated.** main trusts every path, channel payload, and `cwd` from the renderer. Add one confinement helper + per-handler validation and most of the file-disclosure/destruction blast radius disappears.
2. **Defense-in-depth was turned off, not just absent.** `sandbox:false` is an explicit choice with no stated need; turning it back on is cheap and removes the "one renderer bug = total RCE" property.
3. **Distribution is unbuilt for scale.** No signing, no notarization, no update channel, no integrity verification — all prerequisites for safely shipping an app that spawns shells to a large audience.
4. **Supply chain floats.** `"latest"` on the most privileged dependency (runs in main, holds the key) is a standing risk and also couples a security range to a runtime API contract.
5. **Untrusted strings reach UI sinks.** Filenames, git branches, and *model-generated Pulse summaries* flow toward `innerHTML`; in a no-sandbox renderer that is an RCE pathway, so it must be escaped at the sink.

## Scaling to 100M users (desktop framing)

- **Update safety is the #1 blocker.** No code signing (SEC-5) + no auto-update (SEC-6) means you cannot patch the field and cannot guarantee build integrity. For an RCE-class app this is a hard prerequisite, not a nice-to-have. Sign + notarize, then adopt `electron-updater` over an HTTPS feed that relies on Squirrel.Mac signature verification, with staged rollout and a kill-switch.
- **Per-user resource footprint.** Each pane is a real PTY + child shell + (often) a full coding-agent process; a "fleet" of 10+ agents per window plus Monaco + multiple xterm buffers is heavy. At scale this drives support tickets (RAM/CPU/fan) and crash rates. Cap concurrent PTYs, surface resource usage, and reap dead agents aggressively.
- **Telemetry/crash reporting must be privacy-safe by construction.** Any reporter you add runs in main alongside the Anthropic key and pane contents (which can contain secrets the agent printed). Build redaction first (strip `ANTHROPIC_API_KEY`, `CONCOURSE_PULSE_*`, never upload pane tails) before turning on any upload.
- **Pulse data-egress is a config-driven network sink.** `CONCOURSE_PULSE_BASE_URL` ships pane output to an operator-chosen URL. At scale, document it, default it off, and make the destination visible in the UI so enterprise users can audit egress.
- **Supply-chain pinning + lockfile discipline** become release-blocking at scale: pin `@anthropic-ai/sdk`, gate releases on `npm ci` + `npm audit`, and verify the `node-pty` native rebuild (`electron-rebuild` in `postinstall`) is reproducible on the signing machine.
- **Reload/crash resilience:** persist session state so a renderer crash or stray reload doesn't nuke a user's whole fleet of running agents — at 100M users this is a top support-burden driver.
