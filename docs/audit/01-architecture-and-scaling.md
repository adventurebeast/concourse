# Concourse — Architecture, Process Model & Readiness to Scale to 100M Users

**Auditor role:** Principal architect. **Scope:** overall structure, the Electron process model, and what must exist to ship/operate this desktop app at 100M-user scale.
**Date:** 2026-06-19 · **Branch:** main @ f904467

---

## Executive summary

The core process model is **genuinely well-designed for a small app**: a single set of globally-registered IPC handlers that scope themselves per-window via `event.sender`, per-window state keyed by `webContents.id`, clean PTY ownership/teardown, and a hard wall keeping the Anthropic API key in the main process. The module split in `src/main/` is exemplary — small, single-purpose files (`ipc-*.js`, `context.js`, `watcher.js`, `session.js`, `recents.js`). The renderer is a different story: `terminals.js` (1298 lines) and `main.js` (440 lines) are accreting responsibilities and `main.js` is the de-facto application controller with no module boundary around it.

The decisive finding for the stated goal — **shipping to 100M users** — is that **none of the operational infrastructure a mass-distributed desktop app requires exists**: no auto-update, no crash reporting, no telemetry, no error reporting, no feature flags, no licensing/auth/billing, no settings sync, no CI, no tests, no code signing, no notarization. The app is currently configured as an unsigned personal build (`identity: null`, arm64-only DMG, no update channel). This is not a code-quality problem; it is a **missing-product problem**. The sections below quantify exactly what to build.

There are also a handful of concrete correctness/robustness issues that will surface *before* 100M users — at the first multi-window power user or the first agent that writes 50 files/sec: an unbounded `session.json`/`recents.json` write pattern with read-modify-write races, an `fs.watch({recursive})` that is macOS/Windows-only and silently dead on Linux, per-PTY env that pins `process.env` wholesale, and a Pulse polling loop that scales O(panes × providers calls) with no global budget.

---

## Part 1 — Module boundaries & coupling

### 1.1 `src/renderer/main.js` is a god-file / application controller (HIGH)
**Location:** `src/renderer/main.js:1-440`

`main.js` is not a bootstrap; it is the application. In 440 lines it directly owns: icon rendering, a hand-rolled tooltip engine (`main.js:24-55`), workspace root state (`currentRoot`, `main.js:58`), theme persistence, "experience mode" persistence, every global keybinding registration (`main.js:111-147`), activity-bar view switching, titlebar wiring, sidebar/panel/terminals-only layout toggles, **the entire session save/restore lifecycle** (`gatherSession`/`saveSession`/`restoreSession`, `main.js:303-368`), two hand-written drag-resizer implementations (`dragV`/`dragH`, `main.js:371-404`), and the boot sequence.

Each module (`editor`, `git`, `fileTree`, `terminals`, …) is created cleanly with a callback contract, which is good — but `main.js` is the hub every wire passes through, and it holds load-bearing state (`currentRoot`, `lastSavedJSON`) as module-level mutable variables. There is no `AppController` object, no state store, no separation between "wiring" and "logic."

**Where it breaks at 10× features:** every new view (the planned Queue / fleet arrangements in `docs/arrangements.md`), every new persisted setting, every new keybinding, and every new layout toggle lands here. Session shape is defined inline in `gatherSession()` with no schema/versioning (see 3.2). Two windows share nothing but the renderer module instance is per-window, so this isn't a correctness bug — it's a maintainability cliff.

**Recommendation:** Extract three seams now, before the Queue work: (a) a `workspace.js` owning `currentRoot` + `setWorkspace`/`saveSession`/`restoreSession` with a **versioned session schema**; (b) a `layout.js` owning sidebar/panel/terminals-only/activity-bar state (it's all DOM-class toggling today and will multiply with arrangements); (c) a `settings.js` owning theme + mode + future synced prefs behind one persistence API (today it's raw `localStorage.getItem/setItem` scattered across `main.js:213-259`). Keep `main.js` as pure wiring.

### 1.2 `terminals.js` mixes five concerns in one 1298-line module (HIGH)
**Location:** `src/renderer/terminals.js:25-1298`

`createTerminals()` is a single closure that owns: (1) the PTY/xterm session lifecycle, (2) **four** layout engines (`applyGrid`/`applyStack`/`applyFlow` + tabs, `terminals.js:370-441`), (3) the entire Pulse Layer-A state machine + Layer-B summarization (`terminals.js:1143-1235`), (4) auto-titling with a 4-tier priority resolver (`terminals.js:895-968`), and (5) DOM construction for tabs/cells/stubs/menus/confirm-dialogs (`create()`, `terminals.js:573-784`, is 200+ lines by itself).

The fitting/`paneRole` logic (`terminals.js:970-1071`) is excellent and well-commented — it should be preserved as-is. But Pulse and layout are independent subsystems trapped in this closure. The `docs/arrangements.md` roadmap ("new layout modes for 10+ agents," "The Queue") means **more** layout engines land directly in this file.

**Recommendation:** Split along the existing internal seams: `terminalSession.js` (one PTY+xterm+state), `terminalLayout.js` (the `applyLayout`/`paneRole`/fit machinery, parameterized by a layout registry so new arrangements register instead of editing `applyLayout`), and `pulse.js` (the Layer-A timers + `summarize()` + `setState`/`dotClass`/`emitFleet`). The `LAYOUT_ORDER`/`LAYOUTS` arrays already hint at a registry; formalize it so the Queue is a new entry, not a new branch.

### 1.3 Cross-module coupling routed through `main.js` callbacks is fine today, fragile at scale (MEDIUM)
**Location:** `src/renderer/main.js:73-104`

Modules communicate via injected callbacks (`onStatus`, `onFleet`, `onOpenFile`, `onOpenDiff`), which is clean for the current ~10 modules. But the fan-out is already non-trivial: `git.onStatus` updates three subscribers (`hud`, `fileTree`, `statusbar`, `main.js:78-82`), and `terminals` reaches back into `git.status()` directly (`terminals.js:934`) *and* receives `getRoot` as a closure. There is no event bus; adding an N-th subscriber means editing the producer's wiring in `main.js`.

**Recommendation:** Not urgent, but before the module count doubles, introduce a tiny typed event emitter (`bus.emit('git:status', s)`) so producers don't need to know their consumers. This also decouples the future settings-sync / multi-window-coordination work.

---

## Part 2 — IPC architecture

### 2.1 The per-window-via-`event.sender` IPC model is the strongest part of the codebase (POSITIVE / HIGH confidence)
**Location:** `src/main/index.js:91-99`, `src/main/context.js:9-41`, `src/main/ipc-pty.js:94-182`

Handlers are registered once, globally, and every one resolves its window from `event.sender`. State is a `Map` keyed by `webContents.id` (`context.js:10`), dropped on `'closed'` (`index.js:71-77`). PTYs are keyed `"<wcId>:<rendererId>"` (`ipc-pty.js:94-95`) so the renderer's restarting `term-N` counter can't collide across windows, output routes back only to the owning `WebContents` with an `isDestroyed()` guard (`ipc-pty.js:143-149`), and a window close tears down only its own shells (`ipc-pty.js:175-181`). This is the correct multi-window architecture and it is implemented carefully. **Keep this pattern as the app grows** — every new stateful subsystem should key by `webContents.id` the same way.

### 2.2 The IPC contract is untyped, unversioned, and split between three conventions (HIGH)
**Location:** `src/preload/index.js:5-106`; channel strings throughout `src/main/ipc-*.js`

The preload is a single hand-maintained object literal and the **only** definition of the renderer↔main contract. There is no shared schema, no TypeScript (project is deliberately plain JS), no payload validation at the boundary except in Pulse (`ipc-pulse.js:69-71, 242`). Channel naming is consistent *within* the `domain:verb` convention (`workspace:open`, `git:status`) but **mixes `invoke` (request/response) and `send` (fire-and-forget) with no marker** distinguishing them — `term:*` uses `send` (`ipc-pty.js:97,156,161,166`) while everything else uses `invoke`. A renderer author cannot tell from the preload whether a call returns a value without reading the main handler.

There is also **no version handshake**. The moment auto-update ships (Part 4), a new main process can run against a stale renderer cache or vice-versa during the update swap, and a renamed/removed channel fails silently (an `invoke` rejects, a `send` is dropped with no error).

**Recommendation:** (a) Define the contract once as a single source of truth — a `channels.js` map of `{ name, kind: 'invoke'|'send'|'on', validate }` that both preload and main import; generate the preload surface from it. (b) Add an `app:apiVersion` handshake the renderer checks at boot, refusing to run (and prompting relaunch) on mismatch — essential once updates can desync the two halves. (c) Validate every `invoke`/`send` payload in main (Pulse already models this; generalize it). The renderer is `sandbox: false` (`index.js:40`), so main **must** treat all renderer input as untrusted — today `fs:*` and `git:*` handlers pass renderer-supplied paths straight to the filesystem (see 2.3).

### 2.3 `fs:*` handlers accept arbitrary renderer paths with no workspace confinement (MEDIUM, security-relevant)
**Location:** `src/main/ipc-fs.js:24-71`

`fs:readFile`, `fs:writeFile`, `fs:delete` (recursive+force), and `fs:rename` operate on any absolute path the renderer sends, with no check that the path lies under the open workspace root. Today the renderer is trusted (it's our own code), so this is not an active exploit. But with `sandbox: false` and a renderer that loads `monaco`, `xterm`, and renders arbitrary file/agent output, a single renderer-side XSS or a malicious dropped file that influences a path becomes a full-filesystem read/delete primitive in the main process. `git.discard` similarly `fs.rm`s computed paths (`ipc-git.js:166`).

**Recommendation:** Confine every `fs:*` mutation to the calling window's root via `ctx.getRoot(e.sender)` + a canonicalized `path.resolve` containment check (reject `..`, symlink escapes, absolute paths outside root) — the search handler already scopes to root (`ipc-search.js:52`); apply the same discipline to `fs:*`. This is cheap now and load-bearing once the renderer renders untrusted content at scale.

### 2.4 `Anthropic({ apiKey: 'latest' SDK })` structured-output call is correct but pinned to `"latest"` (LOW, confirmed against current SDK)
**Location:** `src/main/ipc-pulse.js:147-153`; `package.json:19`

I verified the SDK call against the current Anthropic API: `output_config: { format: { type: 'json_schema', schema: SCHEMA } }` is the canonical structured-output parameter (not OpenAI's `response_format`), the schema correctly sets `additionalProperties: false` + `required`, and `claude-haiku-4-5` is a valid model id that supports structured outputs. The code is right. The risk is `"@anthropic-ai/sdk": "latest"` in `package.json:19`: a non-pinned `latest` means a future SDK release can change request/response shape and break Pulse on a routine `npm install`, with no lockfile evidence in the repo. **Recommendation:** pin to an exact version and add `package-lock.json` to the repo; for a shipped product, a floating `latest` dependency is an uncontrolled-change vector.

---

## Part 3 — State, lifecycle & persistence

### 3.1 `session.json` / `recents.json` use full read-modify-write on every save with a race window (MEDIUM)
**Location:** `src/main/session.js:26-57`, `src/main/recents.js:23-58`

Every `setSession`/`setLastRoot`/`addRecent` does `readStore()` → mutate → `writeStore()` over the **entire** JSON file (`session.js:39-43, 51-56`). The renderer auto-saves on a 4-second interval (`main.js:338`) **and** on `beforeunload` (`main.js:339-341`). With multiple windows open on the same machine, two `setSession` calls interleave read-modify-write on one shared `session.json`, and the second writer clobbers the first window's blob — there is no per-key locking and `writeStore` is a non-atomic `fs.writeFile` (no temp-file-rename), so a crash mid-write corrupts the whole store (the reader does handle corruption by starting fresh, `session.js:20-23`, which means **a crash during save silently wipes every workspace's session**).

**Where it breaks:** the first user who runs 3 windows, or any crash during the 4s autosave. At 100M users this is a steady trickle of "lost all my tabs" support tickets with no telemetry to see them (Part 4).

**Recommendation:** Write atomically (write to `session.json.tmp`, `fsync`, `rename`). Serialize writes through a single in-main queue so concurrent windows can't interleave. Longer term, move to per-workspace files (`sessions/<hash>.json`) so one window's save never touches another's data, and so the store doesn't grow unbounded (today every folder ever opened accumulates in one file forever — `session.js:51-56` never prunes).

### 3.2 Session blob has no schema or version field (MEDIUM)
**Location:** `src/renderer/main.js:307-368`

`gatherSession()` emits an ad-hoc object (`{ editor, terminals, ui }`) and `restoreSession()` reads it with defensive `&&` chains. There is no `version` field. The first time the session shape changes (and it will — the Queue, pinned panes, per-pane agent presets are all on the roadmap), old blobs restore into the new code with missing/renamed keys and the defensive reads silently drop state or, worse, half-restore. `restore()` in terminals (`terminals.js:797-803`) already tolerates this loosely, which masks the problem rather than solving it.

**Recommendation:** Add `version: N` to the blob, and a `migrate(blob)` step in `restoreSession`. This is a five-line change now and an unbounded migration headache once millions of users carry old blobs across auto-updates.

### 3.3 Window lifecycle is solid; multi-window coordination of shared global state is the gap (MEDIUM)
**Location:** `src/main/index.js:29-120`, `src/main/session.js:39-43`

Per-window teardown is correct (PTYs, watcher, ctx all forgotten on close — `index.js:71-77`). The seam is **shared global** state: `setLastRoot` is global-across-all-windows (`session.js:39`), so with two windows open, whichever saved last wins, and the "dock-activate reopens last session" path (`index.js:117-120`) reopens whatever the last window to save happened to set. `addRecent` is similarly a global mutable list hit by every window. This is benign for one user with one window but is the first thing that misbehaves for power users (the target persona — "fleet of CLI coding agents").

**Recommendation:** Make `lastRoot` a per-window concept for restore, and treat the global one as "most-recent across windows" only for cold launch. Funnel `recents` writes through the same serialized queue as 3.1.

### 3.4 No process-level crash handling anywhere in main (HIGH — see also 4.2)
**Location:** entire `src/main/` (absence)

There is no `process.on('uncaughtException')`, no `process.on('unhandledRejection')`, no `app.on('render-process-gone')` handler outside the dev-only logger (`index.js:54-56`), and no `app.on('child-process-gone')`. A throw in any non-`try` main path (e.g. a node-pty native error, a `simple-git` spawn failure that escapes a handler) takes down the entire main process and **every** window's terminals with it, with zero record. Most `ipc-git`/`ipc-pulse` handlers do wrap in `try/catch`, but `ipc-fs.js:24-71` deliberately lets exceptions propagate to the renderer ("the renderer is responsible for surfacing any failures," `ipc-fs.js:21-22`) — an unhandled rejection in main.

**Recommendation:** Add top-level `uncaughtException`/`unhandledRejection` handlers that log to disk and (Part 4) report. This is the single highest-leverage robustness change and a prerequisite for operating at scale.

---

## Part 4 — THE 100M-USER QUESTION: what infrastructure is MISSING

This is a desktop app, so "scale" means distribution, update safety, observability, per-user footprint, and the commercial backend — not web horizontal scaling. **Every item below is currently absent.**

### 4.1 No auto-update mechanism (CRITICAL)
**Location:** `package.json:18-32` (no `electron-updater`), `electron-builder.yml:15-25` (no `publish` block)

There is no `electron-updater` dependency, no `autoUpdater` call in main, and no `publish`/update-feed configuration in `electron-builder.yml`. The build auto-bumps the version (`package.json:14`, and `index.js:101-104` surfaces it) but nothing consumes that version to update anyone. **At 100M users you cannot ship a fix.** A bad release is permanent for every installed copy; a security fix can't be pushed. This is the #1 blocker.

**Recommendation:** Add `electron-updater` with a staged-rollout-capable feed (the GitHub provider works to start; a real CDN-backed feed — S3+CloudFront or a vendor like Hazel/Nuts — for scale). Add a `publish` block to `electron-builder.yml`. Critically, implement **update safety**: staged rollout (1%→10%→100%), an explicit channel (`latest`/`beta`), differential downloads (blockmap), signature verification on the update payload, and a renderer/main API-version handshake (2.2) so an update that desyncs the two halves fails closed and re-launches rather than corrupting state.

### 4.2 No crash reporting (CRITICAL)
**Location:** `src/main/index.js` (no `crashReporter.start()`), entire codebase

`crashReporter` is never started and there is no Sentry/Bugsnag/Crashpad upload. Native crashes in node-pty (a C++ addon, `package.json:23`) and renderer GPU/V8 crashes produce **nothing** — no minidump, no breadcrumb. The dev-only `render-process-gone` logger (`index.js:54-56`) is gated behind `ELECTRON_RENDERER_URL` and goes to a terminal nobody sees in production. With 100M users, the long tail of platform/driver/agent-specific crashes is invisible; you'd be flying blind.

**Recommendation:** `crashReporter.start()` in main before any window opens, with an uploader endpoint (self-hosted minidump collector or Sentry's Electron SDK which captures main, renderer, **and** native node-pty crashes). Pair with the `uncaughtException` handlers from 3.4.

### 4.3 No telemetry / analytics / error reporting (HIGH)
**Location:** entire codebase (absence)

There is no usage telemetry, no error-event reporting, no funnel/retention instrumentation, and no way to know how many panes/windows/agents a real user runs (the exact data needed to validate the per-user footprint in 4.5). At scale you cannot operate what you cannot measure: you won't know update adoption, crash-free-session rate, which layouts/agents are used, or where users churn.

**Recommendation:** Add a privacy-respecting, **opt-in/opt-out-able** telemetry layer (anonymous install id, version, OS, coarse usage events, error counts) with an explicit consent UI and a kill switch — this is also a legal requirement under GDPR/CCPA at scale. Keep it in main (like Pulse) so the key/endpoint never reaches the renderer. Gate everything behind feature flags (4.4) so you can dark-launch and roll back.

### 4.4 No feature-flag / remote-config system (HIGH)
**Location:** entire codebase (absence)

Behavior is hard-branched on `localStorage` (`concourse-mode`/`concourse-theme`, `main.js:213-259`) and `process.env` for Pulse provider selection (`ipc-pulse.js:209-213`). There is no remote kill switch and no gradual-rollout mechanism for features. When a new layout or a new Pulse provider misbehaves in the field, the only remedy is another full release (which you also can't push — 4.1).

**Recommendation:** Add a lightweight remote-config fetch (cached, fail-open to last-known/defaults) keyed by the anonymous install id, so features can be flagged on by cohort and killed remotely. This is what makes 100M-user operation survivable.

### 4.5 Per-user resource footprint is unbounded by design (HIGH)
**Location:** `src/main/ipc-pty.js:97-153`, `src/main/watcher.js:41-66`, `src/renderer/terminals.js:1207-1235`

The product *premise* is "a grid of many agents," and nothing bounds the cost:
- **PTYs:** one `node-pty` per pane with no cap; each is a real OS process tree (login shell + the agent it runs). 20 panes × multiple windows = dozens of shells + agents. No limit, no warning.
- **Env bloat:** every PTY is spawned with `{ ...process.env, … }` (`ipc-pty.js:105-116`) — the **entire** parent environment is copied into each shell's env block per spawn. Cheap individually, but it pins a full env snapshot per pane.
- **xterm scrollback:** `scrollback: 10000` per terminal (`terminals.js:651`) — 10k lines × N panes held in renderer memory.
- **fs.watch:** one recursive watcher per window (`watcher.js:49`); recursive watch on a large repo can open thousands of OS handles on macOS.
- **Pulse loop:** a 2-second `setInterval` (`terminals.js:1207`) walks every pane every tick and can fire a model call per quiet pane per tick. With a cloud (Anthropic) provider this is **unbounded billable API calls scaling with pane count × users** — there's a per-pane in-flight guard (`ipc-pulse.js:246-249`) and a tail hash to skip no-ops (`terminals.js:1168`), but no **global** rate budget across panes/windows.

**Where it breaks:** RAM/CPU on the user's machine for the power user; **your** Anthropic bill for every Pulse-enabled user if you ever ship a hosted key (today the key is BYO via env, `ipc-pulse.js:211` — but a consumer product will want a built-in provider, at which point 4.5 is a direct COGS line).

**Recommendation:** Cap concurrent PTYs (with a graceful "too many panes" UX), make scrollback configurable and lower by default, add a **global** Pulse budget (token-bucket across all panes/windows, backoff under load), and measure real footprint via telemetry (4.3) before picking the caps. For a hosted Pulse provider, this budget is mandatory cost control.

### 4.6 No code signing or notarization — distribution is impossible at scale (CRITICAL)
**Location:** `electron-builder.yml:15-25`

`identity: null` (`electron-builder.yml:20`) means the app is **unsigned**; there is no notarization step, no entitlements file, no hardened-runtime config, and the target is arm64-only DMG (`electron-builder.yml:17-20`) — no x64, no Windows, no Linux, no auto-update-friendly target. An unsigned, un-notarized macOS app is blocked by Gatekeeper on every machine but the developer's; users get "Concourse is damaged and can't be opened." This is explicitly flagged as a "personal use" build (`electron-builder.yml:21`) and is correct *for that purpose*, but it is a hard wall for any external distribution.

**Recommendation:** Provision an Apple Developer ID, enable signing + `notarize` in electron-builder, add `build/entitlements.mac.plist` (node-pty needs `com.apple.security.cs.allow-unsigned-executable-memory` / JIT entitlements; the asarUnpack for node-pty at `electron-builder.yml:13-14` is already correct). Add Windows (Authenticode signing) and x64/universal mac targets. Wire signing into CI (4.8). Without this, the install base is exactly one machine.

### 4.7 No licensing / auth / billing backend (HIGH for a commercial product)
**Location:** entire codebase (absence)

There is no account system, no license check, no entitlement gating, no billing integration, and no settings-sync backend. For a free OSS tool this is fine; for a product shipped to 100M users with a hosted Pulse provider or paid tiers, all of it is greenfield. Today the only "account-ish" thing is the BYO `ANTHROPIC_API_KEY` env var (`ipc-pulse.js:211`).

**Recommendation:** Decide the commercial model first, then: an auth provider (device-flow OAuth fits a desktop app), a licensing/entitlement service the main process checks (cache offline-tolerant, fail-open or grace-period to survive backend outages), Stripe (or similar) for billing, and a settings-sync service if cross-device prefs are wanted (the per-workspace session store in 3.1 is the natural sync unit). Keep all credentials/keys in main, never the renderer — the existing Pulse boundary (`ipc-pulse.js:16-18`) is the right model to extend.

### 4.8 No CI, no tests, no lockfile (HIGH)
**Location:** repo root (no `.github/`, no `*.test.js`, no `package-lock.json`)

There is no continuous integration, no test of any kind, and no committed lockfile. The build/release flow is a local `npm run dist` (`package.json:14`) on the developer's machine. At 100M users every release is a high-stakes event (no rollback once shipped — 4.1) and there is no automated gate catching a broken main↔renderer contract, a node-pty rebuild failure, or a regression in session restore.

**Recommendation:** Add CI that builds, signs, notarizes, and publishes on tag; add at least smoke tests for the IPC contract (every preload channel has a handler), session migrate/restore round-trips, and PTY create/kill. Commit the lockfile. This is the safety net that makes frequent shipping to a large base possible.

---

## Part 5 — Build & config topology

### 5.1 `electron.vite.config.mjs` is clean and correct (POSITIVE)
**Location:** `electron.vite.config.mjs:1-29`

Standard three-target electron-vite config with `externalizeDepsPlugin()` on main+preload (correct for native deps), explicit inputs, and the renderer rooted at `src/renderer`. The `asarUnpack` for node-pty (`electron-builder.yml:13-14`) and `npmRebuild: false` + the `postinstall` electron-rebuild (`package.json:16`) are the right pattern for a native module. No issues here.

### 5.2 Version auto-bump on every pack/dist is a footgun at scale (LOW)
**Location:** `package.json:14-15`

`dist`/`pack` run `npm version patch` unconditionally (`package.json:14-15`), so every local build burns a patch version. Combined with no CI and local-only releases (4.8), version numbers are driven by how often the developer builds, not by what shipped. Once auto-update exists (4.1), the published version must correspond to an actual release artifact; an auto-bump on every dev build muddies the update feed.

**Recommendation:** Move version bumping into the tagged-release CI job, not the local build script.

---

## Prioritized roadmap to "operable at scale"

**Tier 0 — cannot ship externally without these (CRITICAL):**
1. Code signing + notarization + entitlements; add Windows/x64 targets (4.6)
2. Auto-update with staged rollout + signature verification + API-version handshake (4.1, 2.2)
3. Crash reporting (native + renderer + main) and top-level error handlers (4.2, 3.4)

**Tier 1 — cannot operate at scale without these (HIGH):**
4. Telemetry/analytics with consent + kill switch (4.3)
5. Feature flags / remote config (4.4)
6. CI that builds/signs/notarizes/publishes; smoke tests; commit lockfile (4.8)
7. Atomic, serialized, versioned session/recents persistence (3.1, 3.2, 3.3)
8. Per-user footprint caps + global Pulse budget (4.5)
9. Confine `fs:*` to workspace root; validate all IPC payloads (2.3, 2.2)

**Tier 2 — commercial + maintainability:**
10. Licensing/auth/billing/settings-sync backend (4.7)
11. Refactor `main.js` and `terminals.js` along the seams in Part 1 before the Queue work lands (1.1, 1.2)
12. Pin the Anthropic SDK; formalize the IPC channel registry (2.4, 2.2)

---

## What is already right (preserve these)

- The per-window `event.sender` IPC model and `webContents.id`-keyed state (2.1) — this is the correct foundation; extend every new subsystem the same way.
- PTY ownership/teardown and the renderer-id keying that survives per-window counter resets (`ipc-pty.js`).
- The Pulse main/renderer boundary keeping the API key out of the renderer (`ipc-pulse.js:16-18`) — the template for all future credentials.
- `paneRole`/`fitPane` discipline so previews never resize an agent's PTY (`terminals.js:970-1071`).
- The small, single-purpose main-process module split (`ipc-*.js`, `watcher.js`, `context.js`) — apply the same discipline to the renderer.
