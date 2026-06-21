# Concourse Audit — RESUME HERE

> Checkpoint saved 2026-06-20. Read this first to continue the audit-driven fix work.
> Companion docs in this folder: `00-EXECUTIVE-SUMMARY.md`, reports `01`–`05`, `PLAN.md` (engineering
> hardening — the sequenced fix plan with file:line targets), and `PRODUCTION-READINESS.md` (the road to a
> **public 1.0**: the user-facing product layer `PLAN.md` omits + the distribution/ops epics).

---

## Where we are

The engineering sweep (5-agent audit) and the implementation plan are **complete and written to disk**.
**Wave 1 AND Wave 2 of the fixes are APPLIED to the working tree but UNCOMMITTED and UNVERIFIED** (no app
launch yet — blocked on the no-build-without-permission gate). All 17 changed `src/**` files pass `node --check`.
Wave 2 ran 2026-06-20 as a bounded 5-agent workflow (`concourse-fixes-wave2`, ~2.8 min, disjoint files).

### ✅ Done

**Audit + plan docs** (all in `docs/audit/`):
- `00-EXECUTIVE-SUMMARY.md` — verdict, deduplicated master findings index, roadmap to 100M users
- `01`–`05` — the five specialist reports (~82 findings, file:line cited)
- `PLAN.md` — 5 shippable PRs, sequenced into waves, with per-step files/change/verify/effort

**Wave 1 code changes** (working tree, uncommitted, syntax-checked with `node --check`, partition held — zero file overlaps):

| Workstream | Files | Closes |
|------------|-------|--------|
| PR-2a/2b persistence | `src/main/store-io.js` (NEW), `session.js`, `recents.js` | R3 core: atomic tmp+fsync+rename, one serialized write queue, `readJson`/`flushSync`/`trackPending` exported |
| PR-3a security | `src/main/paths.js` (NEW), `ipc-fs.js`, `ipc-git.js` | S1 (confine all `fs:*`), S3 (`git:diff` confinement), S7 (`git:discard` → `shell.trashItem`, recoverable), null-root guards on all git handlers |
| PR-1a live tree | `src/preload/index.js`, `src/main/watcher.js`, `src/renderer/main.js`, `fileTree.js`, `index.html` | R9 (auto-refresh on `fs:changed`), R6 (watcher restart+backoff, `fs:watch-status`, Refresh button) |
| PR-1c terminal bugs | `src/renderer/terminals.js` | R1 (tab-reorder PTY orphan — bail not drop), R2 (confirmClose listener leak + double-destroy), R7 (Pulse stale-verdict race) |
| PR-1c editor bug | `src/renderer/editor.js` | R5 (read-error + binary file → read-only preview; save() guarded; normal utf8 path byte-identical) |

**Not ours:** `src/main/menu.js` (+9 lines, zoom menu ⌘+/⌘-/⌘0) was edited by the USER during the session — left untouched.

---

## ▶️ Next action when resuming

**Decision point:** Wave 1 + Wave 2 are applied (all `node --check` clean) but UNVERIFIED. Pick one:
1. **Build & verify Wave 1+2** (needs explicit build permission) — launch app, exercise: session save/restore +
   per-workspace files + force-quit flush + legacy→`.bak` migration; `git discard`→Trash; live tree + Refresh;
   tab reorder; binary file open; Pulse cost (2nd-call cache hit, ≤3 concurrent, idle pane = 0 calls); friendly
   prompt in zsh+bash; file-tree badge patching survives rename/expansion. *Recommended* — persistence/shell/
   PTY/Pulse are risky to stack unverified.
2. **Resolve the decision-gated items** (onAwait North Star · per-window root + single-instance lock · sandbox
   flip · `@anthropic-ai/sdk` pin) so Wave 3 can proceed.
3. **Self-review the combined diff** before anything else.

---

## Remaining work (from PLAN.md, not yet started)

**Wave 2 — ✅ APPLIED 2026-06-20** (5 agents, disjoint files, all `node --check` clean):
- ✅ PR-2 finish: per-workspace `sessions/<hash>.json` + sha-collision guard, `session-meta.json`, versioned
  schema + `migrateSession()` (renderer), legacy→`.bak` migration, `before-quit`→`store-io.flushSync()` +
  sync `session:saveSync` channel (`session.js`, `ipc-session.js`, `index.js`, `preload`, `renderer/main.js`)
- ✅ PR-4a Pulse cost: prompt-cache SYSTEM (+string fallback), TAIL_MAX 8000→2500, tailOf 40→24 (40 for
  alt-buffer/TUI), edge-trigger + `MIN_SUMMARIZE_MS=12000`, `MAX_CONCURRENT=3` semaphore (`ipc-pulse.js`, `terminals.js`)
- ✅ Also landed: PR-3.9 PTY rc-file hardening (userData/pty-rc 0700 + randomUUID, confine cwd) + PR-4.7
  prompt-detect cache (`ipc-pty.js`); PR-3.10 innerHTML sink + PR-4.5 `dispose()` + PR-4.9 adaptive scrollback +
  PR-5c dup `setLayout` (`terminals.js`); PR-4.6 save-timer-on-hidden (`renderer/main.js`); PR-4.10 file-tree
  diff-patch with full-`render()` fallback (`fileTree.js`)
- ⚠️ **Review/verify flags before trusting Wave 2:**
  - **Pulse cache may be a no-op**: Haiku 4.5 min cacheable prefix is **4096 tokens** (brief said ~1–2K) —
    token-count `SYSTEM`; if under 4096, `cache_control` is silently ignored (no caching, no regression).
  - **R7 softening**: a *failed* summarize now commits `lastTailHash`, so an identical screen waits for a
    state-change or 12s instead of Wave-1's immediate retry-on-failure.
  - **preload `saveSync(root, blob)`** (not plan's `(blob)`); renderer+handler match; main has no per-WebContents
    active-root map.
  - **PTY**: no-folder-open now falls back to home (old code honored a raw cwd); old `os.tmpdir()` rc files left
    un-pruned; new files live one-per-shell under `userData/pty-rc`.
  - **file-tree**: prior `applyGitStatus` already didn't full-`render()`; the real win is O(all-rows)→O(changed)
    badge patching, not avoiding structural rebuilds.
- ⛔ Deferred from Wave 2 (decision-gated): PR-2.7 per-window `lastRoot`, single-instance lock, PR-2.9 prune sweep.

**Wave 2/3 — DECISION-GATED (see PLAN.md "Decisions needed" table):**
- PR-1b **onAwait North Star** — what does "awaiting" *do*? (badge / sound / OS notification / toggle)
- PR-3b **sandbox flip** (`sandbox:false` → true) — needs full app retest; confirm preload has no direct Node imports
- PR-3b **pin `@anthropic-ai/sdk`** off `"latest"` — needs exact version decision + commit lockfile
- PR-2a **single-instance lock?** (`requestSingleInstanceLock`)
- Pulse tuning numbers — **applied audit-recommended defaults in Wave 2** (12s min interval, cap 3, TAIL_MAX
  2500, tail 24); revisit if verdict accuracy/cost is off
- `editor.js:174` empty-if intent; `tsc --checkJs` strictness; symlinked-workspace policy

**BUILD-GATED (needs `npm install`, whose postinstall rebuilds node-pty — gated):**
- PR-5a/5b: ESLint + Prettier + `jsconfig` + Vitest (the safety net). Should ideally land *before* further refactors.

**Later waves (remaining after Wave 2):**
- PR-4b/4c: idle-timer/PTY async-init follow-ups + **lazy Monaco** (deferred — needs `renderer/main.js`, which
  Wave 2's persistence agent owns; couldn't partition disjointly in a bounded wave)
- PR-3c remainder (rc-file follow-ups beyond 3.9; innerHTML sink R3.10 is DONE)
- PR-5d/5e (shared util layer, channel registry — touch many files across lanes; need their own wave)
- PR-5 step 13 (PLAN-ONLY): split `terminals.js` / `main.js` — only AFTER the test net exists

**Out of scope of the 5 PRs (separate infra epics):** signing/notarization, auto-update, crash reporting,
telemetry, feature flags, CI/CD, commercial backend. See `00-EXECUTIVE-SUMMARY.md` Tiers 0–2.

**Product-readiness track (road to public 1.0) — planned 2026-06-20 in `PRODUCTION-READINESS.md`:** the entire
user-facing layer the 5 PRs omit — **PR-A** settings substrate, **PR-B** in-app API-key + Pulse provider config
+ the unconsumed `pulse:status` badge, **PR-C** error/toast surface, **PR-D** Preferences/Help/About menus +
North-Star notify, **PR-E** onboarding, **PR-F** window-state/font polish — plus the Gate-A distribution epics
above. Each step carries file:line + effort. First slice: PR-A → PR-B (makes Pulse usable in-app). The doc also
records that much of `PLAN.md` PR-1/2/4 is already in the tree, and that the **`onAwait` North Star + `pulse:status`
badge are both still unconsumed seams**.

---

## Known minor cleanups (a lint pass will catch)
- `recents.js` `write()` is now unused internally (kept per plan step).
- Watcher `degraded` class is toggled on `#explorer-panel` but has no CSS yet (cosmetic; `fileTree.css` wasn't owned).

## Standing constraints (honored throughout)
- **No build/launch/`npm install`/commit without explicit per-instance permission** (memory: `no-build-without-permission`).
- Execution model: 5 agents max, bounded one-shot waves, each agent owns a **disjoint file set** (safe parallel
  edits, no worktrees). Synthesis/review done by the main loop.
- Workflow scripts for resume: see `.../workflows/scripts/` — `concourse-fixes-wave1-*.js` (Wave 1),
  `concourse-fixes-wave2-wf_6696175c-7f4.js` (Wave 2).
- **Bound all workflow runtimes** (memory: `bound-workflow-runtimes`): set effort, tight scope, wall-clock
  watchdog; Wave 2 ran in ~2.8 min under a 10-min cap.
