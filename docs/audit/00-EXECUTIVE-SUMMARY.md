# Concourse — Engineering Sweep: Executive Summary

> A full-codebase audit by five specialist passes (architecture/scaling, correctness/bugs,
> drift/consolidation, security/robustness, performance/process) over the entire ~5,700-line
> source tree. This file is the synthesis; the five detailed reports below carry the file:line
> evidence and the per-finding recommendations.

**Audit date:** 2026-06-19 · **Scope:** all of `src/main`, `src/renderer`, `src/preload`, build config, docs
**Coverage:** 5/5 specialists completed · ~82 findings · every finding cites a specific file:line.

---

## Bottom line

Concourse has a **genuinely good core and a near-total absence of the infrastructure required to ship it to
anyone but its author.** The Electron *process model* is the best thing in the codebase — per-window IPC scoped
by `event.sender`, state keyed by `webContents.id`, careful PTY ownership, and the Anthropic key correctly
sealed inside the main process. The renderer hot paths are rAF-coalesced and the recent `paneRole`/fit refactor
is correct. That is a real foundation.

But the app is, today, **an unsigned, un-notarized, arm64-only personal build with no auto-update, no crash
reporting, no telemetry, no CI, no tests, and no committed lockfile.** None of those are features — they are the
prerequisites for putting a shell-spawning desktop app in front of millions of people and being able to operate
it. Layered on top are a handful of concrete reliability and security defects that *will* surface in the field,
and one finding that should sting: **the product's stated North Star — "notify on the working→awaiting edge" —
is dead-wired.** The `onAwait` hook fires in `terminals.js` but `main.js` never subscribes to it, so the headline
feature has no consumer.

The path to 100M users is not a rewrite. It is: **fix ~6 reliability/security defects, connect ~2 dead seams,
then build the distribution-and-operations layer that does not yet exist.**

---

## Audit provenance (the watchdog record)

| | |
|---|---|
| Specialists run | 5 (architecture/scaling · correctness/bugs · drift/consolidation · security/robustness · perf/process) |
| Completion | 5/5 returned; all 5 reports verified on disk |
| Total findings | ~82 (5 critical, ~24 high, ~30 medium, ~23 low) |
| Token cost | ~1.11M tokens across all agents · ~8.4 min wall-clock · 137 tool calls |
| Bound respected | One-shot agents, hard-capped — no overnight runaway, no millions of tokens |
| Changes made | **None.** Read-only audit; only writes are these `docs/audit/*.md` files |

---

## What is genuinely strong (don't break these)

- **Per-window IPC architecture** — globally-registered handlers scoped via `event.sender`, per-window state
  keyed by `webContents.id`. This is the pattern to extend everywhere, not replace. *(01)*
- **Main-process module split** — `ipc-*.js` separation is clean and idiomatic. *(01)*
- **Anthropic key isolation** — the key is read only in main, passed only to `new Anthropic({apiKey})`, never
  crosses IPC; the renderer receives only the parsed verdict. This is the correct template for every future
  credential (telemetry, licensing, billing). *(01, 04)*
- **`paneRole`/`fitPane` logic** — the recent sizing refactor is correct; previews don't resize their PTYs.
  Preserve it as-is when you split `terminals.js`. *(01, 05)*
- **Renderer hot paths** — output writes, fit/resize, and the fleet summary are rAF-coalesced. *(05)*
- **Security basics present** — real CSP, `setWindowOpenHandler` deny, `contextIsolation`/`nodeIntegration` at
  safe defaults, and the Anthropic structured-output call is verified correct against the current Claude API
  (`claude-haiku-4-5`, `output_config.format` json_schema). *(02, 04, 05)*

---

## The 10 cross-cutting themes (ranked by leverage)

These are the issues that **multiple independent specialists surfaced** — the highest-confidence signal in the
audit. Fix these and most of the 82 individual findings collapse.

1. **Zero distribution/operations infrastructure.** No auto-update, no crash reporting, no telemetry, no feature
   flags, no signing/notarization, no CI. *This is the wall between "my app" and "shipped to the masses."*
   → *found by 01, 04, 05*

2. **Persistence is fragile and can wipe a user's whole fleet.** `session.json`/`recents.json` use non-atomic
   read-modify-write over a single shared file; two windows clobber each other; a crash mid-save corrupts the
   store, and the corruption fallback **silently wipes every workspace's session.** No version field for future
   migrations. → *01, 02*

3. **Pulse is an un-budgeted recurring dollar cost.** The 2s tick can fire one model call per active pane per
   tick; the stable ~400-token system prompt is re-sent uncached; there is no per-pane rate limit and no global
   concurrency cap. Cost scales linearly with users × panes × session length — a direct COGS line and a 429
   thundering-herd risk. → *01, 02, 05*

4. **Unbounded per-user footprint.** No cap on PTYs (each = a real shell+agent process tree, full env copied);
   10k scrollback per pane held in renderer RAM; Monaco eagerly loads 5 workers at boot even in terminals-only
   mode; recursive `fs.watch` over the whole tree (incl. `node_modules`). Dominates RAM/CPU at fleet scale.
   → *01, 03, 05*

5. **The IPC trust boundary is unvalidated — and it's the entire security model.** This app pipes renderer bytes
   into the user's login shell, so renderer→main IPC *is* the security boundary. Yet `fs:*` operates on any
   absolute path (incl. recursive+force delete), `git:diff` passes an unvalidated `relPath` into git specs and
   `join(root, relPath)`, and `sandbox:false` is explicitly set. Any renderer XSS becomes full-disk + shell RCE.
   → *01, 04*

6. **Dead seams that defeat documented features.** (a) The `onAwait` North-Star notification hook is never
   subscribed by `main.js`. (b) The fs-watcher fires `fs:changed` into the void — nothing bridges or consumes it,
   so the file tree never auto-refreshes from disk, *and* the watcher dies on first error with no restart and no
   manual Refresh button. Pure footprint, zero payoff. → *02, 03, 05*

7. **Renderer god-files won't survive the planned Queue/arrangements growth.** `main.js` (440 lines) is a de-facto
   app controller holding load-bearing state; `terminals.js` (1298 lines) fuses PTY lifecycle, four layout
   engines, the Pulse state machine, auto-titling, and DOM in one closure. The roadmap adds *more* layout engines
   directly here. → *01, 03*

8. **Floating, unpinned supply chain on the most privileged dependency.** `@anthropic-ai/sdk: "latest"` runs in
   main with the key and full Node, with no committed lockfile — a routine `npm install` can swap it for a
   breaking or malicious release. → *01, 04, 05*

9. **No shared util/IPC layer + inconsistent error contracts.** Three different IPC error conventions (throw /
   return-false / return-sentinel) sometimes within one file; `escapeHtml`, `basename`, shell-quote, git-status
   maps, and a ~50-line collapsible-group renderer are all copy-pasted. Blocks a single telemetry seam. → *03*

10. **Always-on timers never pause when hidden.** The 2s Pulse tick and 4s session-save run forever even when
    backgrounded, with no `dispose()` path — a battery/CPU reputation cost and uninstall driver on 100M desktops.
    → *05*

---

## Critical & high-severity master index (deduplicated)

Cross-references point to the detailed report. Sorted by "fix-first" leverage, not strictly by severity.

### 🔴 Reliability defects that bite real users now

| # | Finding | Location | Sev/Conf | Report |
|---|---------|----------|----------|--------|
| R1 | **Tab reorder rebuilds the sessions Map from the DOM and can drop a session — orphaning a live PTY** (pane stays on screen, shell untracked, leaks until window close) | `terminals.js:153-161` | crit/med | 02 |
| R2 | **Stacked close-confirm dialogs leak a capture-phase keydown listener and can double-enter `destroy()`** | `terminals.js:268-316` | crit/med | 02 |
| R3 | **`session.json` non-atomic, racy, unversioned; crash-mid-save can wipe ALL workspaces' sessions** | `session.js:26-57`, `recents.js:23-58`, `main.js:325-341` | high/high | 01, 02 |
| R4 | **No top-level `uncaughtException`/`unhandledRejection` handlers** — one throw in a non-try main path kills every window's terminals with no record (`ipc-fs` deliberately propagates) | `main/index.js`, `ipc-fs.js:21` | high/high | 01 |
| R5 | **Editor opens an empty buffer on read error & treats binaries as text — Cmd+S then corrupts the file (silent data loss)** | `editor.js:313-358` | high/high | 02 |
| R6 | **fs-watcher dies on first error, never restarts, and has no manual Refresh** — file tree silently stops reflecting disk | `watcher.js:41-66` | high/high | 02 |
| R7 | **Pulse `summarize()` applies a stale model verdict to a pane that changed during the await** — corrupts fleet counts, pins wrong label | `terminals.js:1162-1199` | high/med | 02 |
| R8 | **`onAwait` North-Star hook is never subscribed** — the working→awaiting notification (the product's dominant signal) has no consumer | `terminals.js:25,529`, `main.js:95` | high/high | 03 |
| R9 | **`fs:changed` is fired into the void** — file tree never auto-refreshes from external/agent writes | `watcher.js:63`, `preload:46`, `main.js` | high/high | 03 |

### 🔒 Security (the IPC boundary is the whole model)

| # | Finding | Location | Sev/Conf | Report |
|---|---------|----------|----------|--------|
| S1 | **No path confinement in `ipc-fs`** — renderer can read/write/recursively-delete any path on disk (`~/.ssh`, `~/.aws`) | `ipc-fs.js:24-71` | high/high | 04 |
| S2 | **`sandbox:false`** disables the renderer sandbox in an RCE-class app with no stated need | `main/index.js:40` | high/high | 04 |
| S3 | **`git:diff` passes unvalidated `relPath`** into git object specs and `join(root, relPath)` — traversal/arbitrary blob read | `ipc-git.js:85-113` | med/high | 04 |
| S4 | **`@anthropic-ai/sdk: "latest"`** — unpinned, privileged (runs in main with the key), no lockfile | `package.json:19` | high/high | 01, 04, 05 |
| S5 | **Unsigned + un-notarized + no update-signature story** — tampered DMG is unverifiable for a shell-spawning app | `electron-builder.yml:20-22`, `main/index.js` | high/high | 04 |
| S6 | **innerHTML sinks fed by filename / git-branch / model-generated Pulse text** — confirm none reach a sink verbatim | `fileTree.js:234,328`, `terminals.js:108,274,596` | med/med | 04 |
| S7 | **`git discard` permanently `fs.rm(force)`-deletes "untracked" files from a possibly-stale snapshot** — irreversible; use `shell.trashItem` | `ipc-git.js:148-176` | med/med | 02 |

### 🏗️ Distribution & operations (the 100M-user blockers)

| # | Finding | Location | Sev | Report |
|---|---------|----------|-----|--------|
| D1 | **No auto-update** — a shipped bug is permanent for the entire install base | `package.json`, `electron-builder.yml` | crit/high | 01, 04, 05 |
| D2 | **No crash reporting** — native (node-pty), renderer, and main crashes produce nothing in production | `main/index.js:54-56` | crit/high | 01, 05 |
| D3 | **Unsigned, un-notarized, arm64-only** — Gatekeeper blocks it everywhere but the dev machine | `electron-builder.yml:15-25` | crit/high | 01, 04, 05 |
| D4 | **No telemetry/analytics** — can't measure adoption, crash-free rate, or even size the Pulse cost | (absence) | high/high | 01, 05 |
| D5 | **No feature flags / remote kill-switch** — behavior hard-branched on localStorage/env; a bad rollout can only be fixed by another (un-pushable) release | `main.js:213-259`, `ipc-pulse.js:209-213` | high/high | 01 |
| D6 | **No CI, no tests, no committed lockfile** — every release is a local, ungated, no-rollback event | repo root | high/high | 01, 05 |

### ⚡ Performance & footprint at fleet scale

| # | Finding | Location | Sev | Report |
|---|---------|----------|-----|--------|
| P1 | **Pulse cadence + no prompt caching** = recurring per-user $; level-triggered every 2s tick, ~400-tok system prompt re-sent uncached, `TAIL_MAX=8000` | `ipc-pulse.js:39-65,148-152`, `terminals.js:1207-1235` | high/high | 05 |
| P2 | **No global concurrency cap on Pulse calls** — 20–30 panes settling together = 20–30 concurrent calls (429 herd / 20s local stalls) | `ipc-pulse.js:219-260` | high/high | 05 |
| P3 | **Synchronous `readFileSync`/`writeFileSync` of shell rc files on every PTY spawn** blocks the IPC thread (10-pane restore serialises 10×~4 sync reads) | `ipc-pty.js:21-28,47-85,123` | high/high | 05 |
| P4 | **Monaco eagerly loads 5 workers at boot** even in terminals-only mode — largest bundle, fixed idle-RAM, slows first paint; lazy-init like the diff editor already does | `editor.js:3-17`, `main.js:61,438` | high/high | 05 |
| P5 | **Unbounded pane count** — each pane = xterm + 10k scrollback + shell + agent process; no cap, no adaptive scrollback | `terminals.js:574,645-652`, `ipc-pty.js:131` | high/high | 01, 05 |
| P6 | **File tree fully tears down & rebuilds visible DOM on every change** (innerHTML='' + recursive rebuild per toggle/git-repaint); maintain `Map<path,rowEl>` and diff-patch | `fileTree.js:169,264,276` | med/high | 05 |
| P7 | **Always-on 2s + 4s timers never pause when hidden, never `dispose()`d** | `terminals.js:1207`, `main.js:338` | med/high | 05 |

### 🧹 Drift & consolidation (raises velocity, not user-facing)

| # | Finding | Location | Report |
|---|---------|----------|--------|
| C1 | Three different IPC error contracts (throw / return-false / return-sentinel), sometimes in one file — blocks a single telemetry seam | `ipc-git.js`, `ipc-fs.js:21`, `ipc-pulse.js:255` | 03 |
| C2 | No shared IPC client (8× `const api=window.api`, ~30 hand-written preload wrappers, 4 async-style variants) | `renderer/*.js` | 03 |
| C3 | Copy-pasted helpers: `escapeHtml` ×2, `basename` ×3 (one POSIX-only bug), shell-quote ×3, git-status maps ×2, collapsible-group renderer ~50 lines ×2 | multiple | 03 |
| C4 | Untyped implicit payload contracts (`GitStatus`, `PulseVerdict`, `SessionBlob`) read by up to 6 modules | multiple | 03 |
| C5 | Small dead code: duplicate `setLayout` key in the public API object, empty `if` block, `fitActive`/`fitAll` identical aliases | `terminals.js:1297`, `editor.js:174` | 03, 05 |
| C6 | No lint/format/typecheck — the duplicate `setLayout` key is a live example a linter would catch | `package.json` | 05 |

---

## Roadmap to 100M users

Framed for a **desktop** app: scale here means distribution + update safety + observability + per-user
footprint + a commercial backend — not server horizontal scaling.

### ⏱️ Quick wins this week (hours each, high ROI)
- **Connect the two dead seams** (R8 `onAwait`, R9 `fs:changed`) — the North Star feature and live file-tree
  refresh both already exist and just need wiring. *Highest payoff-per-line in the audit.*
- **Make session writes atomic** (tmp+fsync+rename) and **serialize them through one main-process queue** (R3) —
  stops the "crash wipes every session" failure mode.
- **Pin `@anthropic-ai/sdk` to an exact version and commit `package-lock.json`** (S4).
- **Add top-level `uncaughtException`/`unhandledRejection` handlers** that log to disk (R4).
- **Confine `fs:*` and `git:diff` paths to the workspace root** with one shared `confine(root, p)` helper
  (S1, S3) — generalize the discipline `ipc-search.js:52` already uses.
- **Add a per-pane min-interval + global concurrency semaphore + `cache_control` on the Pulse system prompt**
  (P1, P2) — caps the one recurring cost before it has users.
- **Add ESLint + Prettier** (catches C5/C6 immediately) and **Vitest on the pure functions** (paneRole, await
  regexes, shell-escapers, `parseVerdict`).

### 🚧 Tier 0 — Cannot ship externally without these
- **Code signing + notarization** (Developer ID, hardened runtime, entitlements plist for node-pty); add
  **Windows Authenticode + x64/universal mac** targets. *(D3, S5)*
- **Auto-update** via `electron-updater` over an HTTPS-only signed feed, with **staged rollout, signature
  verification, and a renderer↔main API-version handshake** that fails closed on desync. *(D1)*
- **Crash reporting** (`crashReporter.start()` + Sentry-class uploader covering main + renderer + native) — paired
  with the R4 handlers. *(D2)*

### 🛰️ Tier 1 — Cannot operate at scale without these
- **Consent-gated telemetry** (anonymous install id, version, OS, coarse usage, error counts, **pane count + Pulse
  provider mix** to size cost) with a kill-switch — also a GDPR/CCPA requirement. Build it in main like Pulse;
  **redact `ANTHROPIC_API_KEY`/`CONCOURSE_PULSE_*` and never upload pane tails.** *(D4)*
- **Feature flags / remote config** (fail-open to last-known), so a bad layout or Pulse provider can be
  cohort-flagged and killed remotely. *(D5)*
- **CI/CD**: PRs run lint + typecheck + tests; tagged builds sign + notarize + publish; **decouple the version
  bump from `pack`/`dist`** and drop the unconditional clean; cache the node-pty `.node` artifact. *(D6, P-build)*
- **Bound the per-user footprint**: cap concurrent PTYs (graceful UX), adaptive scrollback, lazy-load Monaco,
  pause timers when hidden, prune the fs-watcher (chokidar/@parcel-watcher with ignored globs). *(P3–P7)*
- **Versioned, per-workspace session files** with a `migrate(blob)` step — before millions carry old blobs across
  auto-updates. *(R3 + session-schema)*

### 💳 Tier 2 — Commercial backend (greenfield)
- Accounts (device-flow OAuth), an **offline-tolerant entitlement/licensing service** (fail-open/grace-period),
  billing (Stripe), and optional **settings/session sync** (the per-workspace session store is the natural sync
  unit). Keep every credential in main, extending the Pulse boundary. *(01)*

### 🏛️ Structural refactors (do alongside, before the Queue lands)
- Split `terminals.js` into `terminalSession.js` / `terminalLayout.js` (with a **layout registry** so new
  arrangements *register* instead of editing `applyLayout`) / `pulse.js`. Preserve `paneRole`/`fitPane`.
- Extract `main.js` into `workspace.js` / `layout.js` / `settings.js`; keep `main.js` as pure wiring.
- Introduce a small shared layer: `ipc.js` (one error contract + telemetry seam), `dom.js`, `paths.js`,
  `gitStatus.js`, and a `channels.js` registry imported by both preload and main. Collapses ~9 duplicated helpers.

---

## How to read the detail reports

| Report | Domain | Findings |
|--------|--------|----------|
| [`01-architecture-and-scaling.md`](01-architecture-and-scaling.md) | Process model, IPC contract, module boundaries, distribution/ops gaps, commercial backend | 20 |
| [`02-correctness-and-bugs.md`](02-correctness-and-bugs.md) | Real bugs, races, leaks, lifecycle, data-loss paths | 17 |
| [`03-drift-and-consolidation.md`](03-drift-and-consolidation.md) | Dead seams, duplication, inconsistent contracts, shared-util plan | 16 |
| [`04-security-and-robustness.md`](04-security-and-robustness.md) | Electron hardening, IPC trust boundary, secrets, supply chain, signing | 11 |
| [`05-performance-and-process.md`](05-performance-and-process.md) | Hot paths, footprint, Pulse cost, testing/CI/build process | 18 |

Each finding in those reports carries the offending code, the trigger, the user-visible consequence, a confidence
rating, and a concrete fix. Start with the **Quick wins** list above — it is the highest leverage per hour of work
in the entire audit.
