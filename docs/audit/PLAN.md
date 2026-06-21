# Concourse — Implementation Plan

> Sequenced, file-level plan to complete the fixes from the engineering audit (see
> [`00-EXECUTIVE-SUMMARY.md`](00-EXECUTIVE-SUMMARY.md) and reports `01`–`05`). Produced by five
> planners (one per shippable PR), each of which read the actual source to confirm change points.
> Every step lists the files, the concrete change, how to verify it, and rough effort.

**Five PRs · ~13–18 focused days total.** The larger distribution/ops/commercial work (signing,
auto-update, crash reporting, telemetry, CI, billing) is **out of scope here** — those are infrastructure
epics, captured at the end, not "fairly quick" code fixes.

---

## Sequencing philosophy

The planners confirmed every PR is *independently shippable* (no hard ordering), but there is a clearly
optimal order driven by two principles:

1. **Build the safety net first.** PR-5a/5b (lint + typecheck + a Vitest net over the highest-risk pure
   functions) protect the exact files every other PR edits. Land them before touching `terminals.js`.
2. **Stop the bleeding before optimizing.** Data-loss (PR-2) and the unvalidated shell/file boundary (PR-3)
   outrank cost/perf tuning (PR-4). Do the cheap reliability/security fixes early; defer the big perf work.
3. **Refactor last.** The `terminals.js`/`main.js` splits (PR-5 step 13) are *plan-only* and must come
   **after** PR-1 and PR-4 finish editing `terminals.js` — refactoring it concurrently guarantees merge hell.

### Recommended merge sequence (waves)

| Wave | Theme | Lands | Effort | Rationale |
|------|-------|-------|--------|-----------|
| **0** | Safety net | PR-5a (lint/format/typecheck) · PR-5b (Vitest + first tests) | ~1.5d | Static checks + regression tests gate everything after |
| **1** | Stop the bleeding | PR-1c (critical bugs) · PR-1a (live tree) · PR-2a/2b (atomic persistence) · PR-3a (path confinement + git) | ~4–5d | Closes data-loss + the worst RCE-class holes; PR-1a/1c are also user-visible quick wins |
| **2** | Decisions + hardening | PR-1b (onAwait North Star) · PR-3b (sandbox flip) · PR-3c (rc-file + innerHTML) · PR-2c (multi-window + quit flush) | ~3–4d | Carry product/risk decisions; sandbox flip needs a full retest gate |
| **3** | Cost & footprint | PR-4a (Pulse cost) → 4b (timers/PTY) → 4c (lazy Monaco) → 4d (scrollback/tree) | ~4–6d | Insurance before adding users; PR-4a is cheap and high-value |
| **4** | Consolidation | PR-5c (dead code) · PR-5d (shared util) · PR-5e (channel registry + ipc.js) | ~2d | Pure cleanup, guarded by the Wave-0 net |
| **5** | Structural (separate workstream) | `terminals.js` / `main.js` splits | TBD | Only after Waves 0–4; gated by the test net |

**First slice to cut tomorrow:** PR-5a + PR-5b (the net) and PR-1c (the two critical bugs) — together ~2 days,
zero product decisions, and they immediately make the codebase safer to change.

---

## ⚠️ Decisions needed before coding (human / product calls)

These block specific steps. Resolve them first so the work doesn't stall mid-PR.

| Decision | Affects | Recommendation |
|----------|---------|----------------|
| **What does "awaiting" *do*?** in-app tab badge / sound / OS notification / all-behind-a-toggle | PR-1b (R8) | Quiet in-app tab+title badge + optional sound; OS `Notification` behind a settings flag |
| **Should Pulse keep summarizing when the window is hidden?** | PR-4b (P7) | **Yes** — backgrounding is exactly when notifications matter. Pause only the 4s *save* timer, not the Pulse tick (or run a slower hidden cadence) |
| **Pulse target numbers** — per-pane min interval, global concurrency cap, TAIL sizes | PR-4a (P1/P2) | Start: 12s min interval · cap 3–4 concurrent · TAIL_MAX 8000→~2500 · tailOf 40→~24 |
| **Exact `@anthropic-ai/sdk` version to pin** | PR-3 (S4) | Read the installed version first; pin at-or-after it; confirm it matches `ipc-pulse.js` call sites (check the claude-api reference) |
| **Does `src/preload/index.js` import Node built-ins directly?** | PR-3b (S2) | If yes, the sandbox flip needs an extra IPC-refactor step. Audit the preload before estimating. *(Note: built output is referenced as `index.mjs` — the known preload-path gotcha)* |
| **Is the app single-instance (`requestSingleInstanceLock`)?** | PR-2a (R3) | If not, add the lock in PR-2a — the in-process write queue only protects against same-process races |
| **`editor.js:173-176` empty `if (activeKey === key) {}`** — early-return or fall-through? | PR-5c | Author decides; don't delete blindly (changes re-activation focus behavior) |
| **`tsc --checkJs` strictness** — check-all-with-suppressions vs curated include list | PR-5a | Loose: `strict:false, skipLibCheck:true`, start scoped to avoid a false-positive flood |
| **Allow symlinked workspace dirs that point outside the root?** (monorepo-via-symlink) | PR-3a (S1) | Decide how strict the `realpath` prefix check is |

---

## Audit path corrections (planners found these while reading the code)

- `looksBinary` and `buildRegex` live in **`src/main/ipc-search.js:33/39`**, *not* `editor.js` (as report 05 stated).
  PR-1's editor binary-gating therefore needs its **own** renderer-side check (or share the search one via the
  PR-5d util layer).
- `parseVerdict` is in **`src/main/ipc-pulse.js:85`**.
- There is **no `src/main/main.js`** — the controller is `src/renderer/main.js`. Git-status maps are in
  `src/renderer/git.js:6-22` and `src/renderer/fileTree.js:7-22`.

---

## Effort roll-up

| PR | Workstream | Effort | Sub-split |
|----|-----------|--------|-----------|
| PR-1 | Dead seams + correctness bugs | 1.5–2d | 1a live-tree · 1b notify-seam · 1c terminal/editor bugs |
| PR-2 | Persistence hardening | 2–3d | 2a atomic-util · 2b per-workspace+schema · 2c multi-window+flush |
| PR-3 | Security & supply chain | 2–3d | 3a path-confinement+git · 3b sandbox+deps · 3c rc-file+innerHTML |
| PR-4 | Pulse cost + perf/footprint | 4–6d | 4a Pulse-cost · 4b timers+PTY · 4c lazy-Monaco · 4d scrollback+tree |
| PR-5 | Dev-process + consolidation | 3–4d | 5a tooling · 5b tests · 5c dead-code · 5d util-layer · 5e channels+ipc |
| | **Total** | **~13–18d** | (solo, focused; compresses with parallelism) |

---

# PR-1 — Dead seams + correctness bugs

**Goal:** close R1, R2, R5, R6, R7, R8, R9 — wire the working→awaiting notification (North Star), live
file-tree refresh, harden the watcher, and fix the PTY-orphan / listener-leak / editor-corruption / Pulse-race bugs.
**Split:** 1a "live tree" (R9+R6) · 1b "notify seam" (R8, carries a product decision) · 1c "terminal & editor
correctness" (R1+R2+R7+R5). **Effort:** 1.5–2d. **Depends on:** ideally Wave-0 net first.

| # | Step | Files | Change | Verify | Effort | Closes |
|---|------|-------|--------|--------|--------|--------|
| 1 | Bridge `fs:changed` through preload | `preload/index.js:46` | Add `onChanged: (cb)=>ipcRenderer.on('fs:changed',()=>cb())` to the `fs` api | `window.api.fs.onChanged` is a fn; IPC arrives on external file touch | 15m | R9 |
| 2 | Refresh tree on `fs:changed` | `renderer/main.js:85` | After fileTree created: `api.fs.onChanged(()=>fileTree.refresh())` (refresh already preserves expand/selection) | External create/rename/delete updates tree ~150ms, no lost state | 15m | R9 |
| 3 | Harden watcher: bounded restart + health | `main/watcher.js:41-66, 27-37` | On error, restart with backoff (500ms→4s, ~5 max), reset on success; push `fs:watch-status`; clear timers in stop() | Force an error → bounded backoff, no thrash, degraded→watching flips | 2h | R6 |
| 4 | Expose watcher status (optional) | `preload/index.js` | Add `onWatchStatus` mirroring `onChanged` (skip if Refresh-only) | status reaches renderer | 15m | R6 |
| 5 | Refresh button + health indicator | `renderer/index.html:42-47`, `fileTree.js:706-720`, `main.js` | Add `#ft-refresh` btn (`refresh` icon exists) → `bind('ft-refresh',()=>refresh())`; degraded class from status | Click refreshes preserving state; degraded shows; refresh recovers | 1h | R6 |
| 6 | **Build the `onAwait` consumer (North Star)** | `renderer/main.js:95-99`, `statusbar.js`, `terminals.js:25,529` (consume only) | Pass `onAwait` into createTerminals; default = tab/title badge + optional sound; OS notification behind a flag. **Don't** change firing logic at `terminals.js:524-531` | working→awaiting in an unfocused pane fires once on the edge, never for active pane | 2-3h | R8 |
| 7 | Fix tab-reorder PTY orphan | `terminals.js:153-161` | Reorder by `el.dataset.id` (not object identity); assert `ordered.length===sessions.size` + all ids present; on mismatch **bail** (keep Map, re-run applyLayout) instead of `filter(Boolean)`-dropping. Confirm tabs carry `dataset.id` | Stress reorder + forced mismatch → sessions.size constant, no PTY dropped | 1h | R1 |
| 8 | Single-instance confirmClose + idempotent finish() | `terminals.js:268-316` | Closure-level `confirmOverlay` guard (focus existing, return); idempotent `finish()`; `destroy()` no-ops if `!sessions.has(id)` | Spam Cmd+W → one dialog, one `term:kill`, no leaked keydown listener | 1h | R2 |
| 9 | Fix Pulse stale-verdict race | `terminals.js:1162-1199` | After the await, recompute `hashStr(tailOf(s))`; if ≠ pre-await hash, **drop** verdict and leave `lastSummaryHash` unset; only commit on match | Inject output mid-await → stale verdict dropped, re-summarizes next tick | 45m | R7 |
| 10 | Add `looksBinary` helper | `editor.js` (~l.59-71) | New pure helper: scan first ~8KB for NUL / high ratio of � (decode failure) | `looksBinary` true on NUL/�, false on JS source | 30m | R5 |
| 11 | Surface read errors + gate binaries in openFile | `editor.js:313-358`, opt. `ipc-fs.js:43-44`, `preload` | Replace silent `catch{content=''}`: on error show message + open **read-only** (no accidental overwrite); if `looksBinary`, open non-editable preview. Keep utf8 happy path byte-identical | text→editable; error→read-only no empty-save; binary→preview no corruption | 2h | R5 |

**Top risks:** R8 is a product decision (noisy if wrong — default quiet). Editor gating touches the shared
openFile hot path (file tree, search-jump, restore) — keep utf8 path unchanged. Reorder bail path must re-sync
from the sessions Map, not freeze. **Open Qs:** awaiting UX & scope (unfocused pane vs unfocused window);
binary detection renderer-only vs main-side typed return; watcher indicator location + does Refresh re-arm.

---

# PR-2 — Persistence hardening

**Goal:** eliminate the "crash / second window wipes every session" failure mode. Atomic writes, one serialized
main-process write queue, per-workspace files, versioned schema + `migrate()`, per-window root, sync flush on quit.
**Split:** 2a foundation (atomic+queue util) · 2b per-workspace files + schema + migration · 2c multi-window + quit-flush.
**Effort:** 2–3d.

| # | Step | Files | Change | Verify | Effort | Closes |
|---|------|-------|--------|--------|--------|--------|
| 1 | Atomic-write + serialized queue util | `main/store-io.js` (new) | `writeJsonAtomic` (tmp in **same dir** + fsync + rename); module-level promise-chain `enqueue()` serializing *all* writes; `flushSync()` draining pending via `writeFileSync`+`renameSync`; guarded `readJson(fallback)` | 50 concurrent writes + mid-write kill → file always old- or new-valid, no leftover `.tmp` | M | R3 |
| 2 | Route session.js through queue+atomic | `session.js:26-32, 39-43, 51-57` | `writeStore`→`enqueue(()=>writeJsonAtomic(...))`; wrap each read-modify-write of setLastRoot/setSession in one `enqueue()` so windows can't clobber | Two windows switching folders → no lost root, never truncated | S | R3 |
| 3 | Route recents.js through same queue | `recents.js:23-29, 54-59, 33-51` | `write()`→enqueue+atomic; wrap addRecent + getRecents-prune in enqueue | Two windows opening folders → recents valid, deduped, capped 12 | S | R3 |
| 4 | Per-workspace files `sessions/<hash>.json` | `session.js` storePath→sessionDir()/sessionFile(); getSession/setSession | Small meta file (`{version,lastRoot}`); per-root `{version,root,blob}` keyed by `sha256(root).slice(0,16)`; validate stored `.root===root` (collision guard) | Corrupt one workspace file → only that workspace resets, others restore intact | M | R3 |
| 5 | One-time migration from legacy session.json | `session.js` (new `migrateLegacyStore()`) | If old `session.json` exists & no meta: write meta + one file per root (atomic), then rename old→`.bak` (don't delete); idempotent | Populated legacy store → all roots restore, `.bak` exists, no re-run | S | R3 |
| 6 | Versioned schema + `migrate(blob)` | `renderer/main.js:307-321, 344-368` | Stamp `version:1`; add `migrateSession(blob)` (versionless=0→1, no-op seam); call before reading fields | Old + v1 blobs restore identically; a throwaway v2 bump exercises the migrator | M | schema |
| 7 | Per-window lastRoot; global = cold-launch only | `context.js`, `ipc-workspace.js:16-43`, `renderer/main.js:410-431`, `ipc-session.js:6` | Keep global `lastRoot` for cold launch/dock-activate-with-0-windows only; restore uses the window's own root; assert/comment global is cold-launch-only | A→win1, B→win2, quit, relaunch → opens most-recent, not a mix; dock-activate correct | M | multi-window |
| 8 | Synchronous final-flush on quit | `main/index.js` (before-quit), `store-io.flushSync`, `renderer/main.js:339-341`, `preload:75` | Renderer beforeunload gathers blob sync + `sendSync` (`saveSync`); main `before-quit`→`flushSync()` drains pending | Change layout then force quit <4s later → change persisted | M | flush |
| 9 | Prune dead workspaces (optional) | `session.js` startup sweep | Delete `sessions/<hash>.json` whose `.root` no longer exists (mirror recents prune), enqueued | Delete a folder, relaunch → orphan file removed, no error | S | R3 |

**Top risks:** rename must stay on the same filesystem (tmp in userData, not os.tmpdir). The in-process queue
does **not** guard two app instances → confirm single-instance lock. `flushSync` needs a true sync path
(async IPC can't complete in beforeunload). Migration must not delete the old file until all roots are written.
**Open Qs:** single-instance lock? global lastRoot single vs MRU list? flush all windows or focused? hash scheme?

---

# PR-3 — Security & supply chain

**Goal:** harden the IPC boundary that pipes renderer bytes into the login shell + filesystem. Confine all
fs/git paths to the workspace root, restore the sandbox, pin/audit deps, make `git discard` non-destructive,
move rc-file temp writes to a private dir, close the one verbatim innerHTML sink.
**Split:** 3a path-confinement + git (S1/S3/S7) · 3b sandbox + supply chain (S2/S4) · 3c rc-file + innerHTML.
**Effort:** 2–3d.

| # | Step | Files | Change | Verify | Effort | Closes |
|---|------|-------|--------|--------|--------|--------|
| 1 | Shared confinement helper | `main/paths.js` (new), `context.js` | `confine(root,p)`: reject falsy root; resolve; compare `realpath` of target (or parent for new paths) to `realpath(root)` prefix; throw `EPATHESCAPE`. `confineRel(root,rel)`: reject absolute/`..` then confine | `confine(root,'../etc/passwd')` throws; in-root returns realpath; `confine(null,…)` throws | 2h | S1,S3 |
| 2 | Confine every `fs:*` handler | `ipc-fs.js:24-71` | Pass ctx; at top of readDir/readFile/writeFile/createFile/createDir/rename/delete resolve root via `ctx.getRoot(_e.sender)` + `confine` (rename: both paths); reject on null root/escape | In-root ops work; out-of-root `fs:delete` rejected; no-folder-open rejects | 2h | S1 |
| 3 | Validate + confine `git:diff` relPath | `ipc-git.js:85-114` | `confineRel(root,relPath)`; normalize git show specs to POSIX-relative; use confined abs path for the working-tree readFile; try/catch→empty-diff on reject | Nested-file diff works; `../../etc/passwd` / absolute → empty, nothing read | 1.5h | S3 |
| 4 | Null-root guards on remaining git handlers | `ipc-git.js:117,130,148,179,190` | Return false/`{error}` when `!root` (never `simpleGit(undefined)`→cwd); run stage/unstage/discard paths through `confineRel` | No folder open → all no-op safely, never touch cwd | 1.5h | S1,S7 |
| 5 | Make `git discard` non-destructive + atomic | `ipc-git.js:148-176` | Re-derive untracked set from a fresh `git.status()`; untracked → `shell.trashItem(confine(root,p))` (recoverable) not `fs.rm(force)`; tracked → checkout; return false when nothing actionable | Untracked discard → Trash; tracked → reverts; clean → false; no blind rm | 2h | S7 |
| 6 | **Restore the Electron sandbox** | `main/index.js:38-41`, audit `preload` | Remove `sandbox:false`; set `sandbox:true, contextIsolation:true, nodeIntegration:false`. First audit preload uses only contextBridge/ipcRenderer (no direct Node imports) | Full IPC + UX retest gate: folder/tree/terminals/git/diff/search/Pulse/drag-drop/menu all work, no console errors | 3h | S2 |
| 7 | Pin + audit SDK; tighten native ranges | `package.json:18-24`, `package-lock.json` | `"latest"`→exact audited version (matches ipc-pulse call sites); tighten node-pty/simple-git; **commit lockfile** | `npm ci` deterministic; `npm audit --omit=dev` clean; Pulse smoke-test passes | 2h | S4 |
| 8 | npm audit gate | `package.json` scripts, CI | `"audit":"npm audit --omit=dev --audit-level=high"` wired into dist/CI | Passes on pinned tree; fails on an injected vuln | 1h | S4 |
| 9 | Harden rc-file temp writes + confine cwd | `ipc-pty.js:47-85, 97-139` | rc files → `app.getPath('userData')` mode 0700 + `crypto.randomUUID()` name (not predictable `os.tmpdir()`); validate `term:create` cwd is an existing dir, confine under root else fall back; harden `fs:saveDrop` dir too | Friendly prompt still renders (zsh+bash); rc under userData 0700; escaping cwd falls back | 2.5h | rc-file |
| 10 | Close verbatim innerHTML sink | `terminals.js:272-276` | Close-confirm dialog interpolates `${name}` (from agent-influenced tab label) into innerHTML — rebuild with DOM nodes / `textContent`. Leave static icon SVG calls as-is | Tab label `<img onerror=…>` shows as literal text; dialog still works | 1h | S6 |

**Top risks:** S2 is highest-risk (preload must work under sandbox — verify no direct Node imports; full retest).
`realpath` both sides for macOS symlinks (`/tmp`→`/private/tmp`). Pinning may pull a different SDK API — smoke-test
Pulse. Wrong rc path silently degrades to a bare prompt (easy to miss). **Open Qs:** exact SDK version; preload
Node imports?; CI host for audit gate; audit severity threshold; symlinked-workspace policy.

---

# PR-4 — Pulse cost + performance/footprint

**Goal:** cap Pulse's recurring per-pane LLM spend and shrink idle RAM/CPU.
**Split:** 4a Pulse cost (P1+P2) · 4b idle timers + async PTY init (P7+P3) · 4c lazy Monaco (P4) ·
4d footprint: scrollback + file-tree patch (P5+P6). **Effort:** 4–6d.

| # | Step | Files | Change | Verify | Effort | Closes |
|---|------|-------|--------|--------|--------|--------|
| 1 | Prompt-cache the stable SYSTEM block | `ipc-pulse.js:144-153, 39-65` | system → `[{type:'text',text:SYSTEM,cache_control:{type:'ephemeral'}}]`, keep output_config; try/catch fallback to string. Token-count SYSTEM to confirm it clears min cacheable size | 2nd consecutive Haiku call shows `cache_read_input_tokens>0`; output unchanged | 2h | P1 |
| 2 | Shrink the tail sent to the model | `ipc-pulse.js:69` (TAIL_MAX), `terminals.js:1147` (maxLines) | TAIL_MAX 8000→~2500, tailOf 40→~24; keep larger tail for alternate-buffer/TUI panes | Verdicts unchanged on representative transcripts; payload ~3× smaller | 1h | P1 |
| 3 | Edge-trigger + per-pane min-interval | `terminals.js:1207-1235, 1162-1194` | Summarize only on a real state-edge OR hash-change (not every 2s); add `lastSummarizeAt` + `MIN_SUMMARIZE_MS≈12s` floor. Keep the 2s tick for settling, not for level-triggering the model | Scripted working→quiet→awaiting = 1 call/edge; two edges in 12s coalesce; idle = 0 | 3h | P1 |
| 4 | Global concurrency semaphore + stale-drop | `ipc-pulse.js:215-261` | `MAX_CONCURRENT=3-4` + FIFO queue; keep per-pane inFlight; TTL-drop stale queued requests | 8 panes at once → ≤MAX concurrent, rest queue; superseded request dropped | 3h | P2 |
| 5 | Capture timer handles + `dispose()` | `terminals.js:1207-1235`, createTerminals return | Store `pulseTimer`; add `dispose()` clearing it + per-pane stream timers | DevTools `dispose()` stops the tick; resumes on re-create | 1h | P7 |
| 6 | Gate timers on visibility | `terminals.js:1207`, `renderer/main.js:338, 339-341` | Pause the **4s save** timer on `document.hidden`, resume + immediate save on visible. **Keep Pulse tick running hidden** (or slower cadence) — don't drop edge detection | Background → save timer stops, Pulse continues; foreground → immediate save | 2h | P7 |
| 7 | Cache prompt detection + once-per-session async rc | `ipc-pty.js:13-28, 47-85, 87-139` | Compute `userHasCustomPrompt` once at startup; memoize `friendlyPromptSetup` by shellPath; switch to `fs.promises` but **await** the one-time generation before first spawn | 10 rapid terminals → friendly prompt every pane, rc written once not per-spawn | 3h | P3 |
| 8 | Dynamic-import Monaco + lazy file editor | `editor.js:1-17, 73-108, 313, 361`, `renderer/main.js:61, 434-439` | Move `import monaco` + 5 workers + MonacoEnvironment into `ensureMonaco()`; add `ensureFileEditor()` (mirror lazy `ensureDiffEditor`); createEditor() stays sync but loads nothing; openFile/openDiff await ensure; restore tolerates not-yet-created editor | Terminals-only boot → 0 monaco workers until first file open; then editor+diff+restore work | 4h | P4 |
| 9 | Adaptive scrollback by paneRole | `terminals.js:645-652, 981-991` | Tiers (primary 10000 / preview 2000 / hidden 1000); set `term.options.scrollback` on role change, restore on promotion; construct at primary; soft pane-count warning past N | Preview/hidden panes report smaller scrollback; promote restores; warning past N | 3h | P5 |
| 10 | Diff-and-patch file tree | `fileTree.js:169-201, 214-260, 262-281` | `Map<absPath,rowEl>`; `applyGitStatus` patches only changed badges (diff old/new maps); reconcile expand/collapse incrementally; keep full `render()` as fallback for first load/root change | Only changed rows repaint; expansion + in-progress rename survive; no orphan rows | 5h | P6 |
| 11 | Stretch: footprint follow-ups | `ipc-git.js`, `ipc-search.js:99,106`, `watcher.js:17-22` | (a) git-status TTL cache 500ms-1s; (b) stream search / ripgrep; (c) prune watcher to visible subtree | bursts coalesce; first search results stream; collapsed deep subtrees unwatched | 4h | — |

**Top risks:** cache_control needs array-system + must clear Haiku's ~1–2K-token min (token-count first, may be a
no-op). Edge-trigger must still catch post-edge changes (gate on edge OR hash). Lazy Monaco: every caller must
tolerate a not-yet-created editor (restore opens files!). Diff-patch tree is the highest-bug-risk step — keep the
rebuild fallback. **Open Qs:** Pulse-while-hidden (recommend yes); target numbers; SDK+caching compatibility;
soft-cap count + per-pane RSS scope; are the stretch items in-scope.

---

# PR-5 — Dev-process foundation + consolidation

**Goal:** stand up lint/format/typecheck + Vitest, lock down the highest-risk pure functions, then collapse
confirmed drift (dead code + duplicated utilities). This is the net that makes every other PR safe.
**Split:** 5a tooling · 5b tests · 5c dead-code · 5d util-layer · 5e channels+ipc. **Effort:** 3–4d.
**Sequence:** 5a/5b first (Wave 0); 5c–5e in Wave 4.

| # | Step | Files | Change | Verify | Effort | Closes |
|---|------|-------|--------|--------|--------|--------|
| 1 | ESLint flat config + Prettier | `package.json`, `eslint.config.js` (new), `.prettierrc` (new) | Per-path configs (main/preload=node ESM, renderer=browser ESM); rules no-undef/no-unused-vars/no-dupe-keys/import/*; `eslint-config-prettier` last; match existing style | `npm run lint` flags the dup `setLayout` at terminals.js:1297 | 2h | C6 |
| 2 | Loose `jsconfig.json` + typecheck | `jsconfig.json` (new), `package.json` | `checkJs:true, strict:false, skipLibCheck:true, allowJs:true`, scoped include; `typecheck: tsc --noEmit` | `npm run typecheck` passes (or documented small suppressions) | 2-3h | C6 |
| 3 | Fix surfaced lint/typecheck violations | flagged files | Triage no-undef/unused/import; leave the 3 known dead-code items for 5c (or inline-disable w/ TODO) | `lint && typecheck` exit 0 | 2h | C6 |
| 4 | Vitest harness | `package.json`, `vitest.config.js` (new), `test/` | Add vitest (node env, jsdom per-file); `test`/`test:watch` scripts; one smoke test | `npm test` runs green | 1h | tests |
| 5 | Test already-pure fns | `ipc-pulse.js:85`, `ipc-search.js:33,39` + new tests | `export` parseVerdict/looksBinary/buildRegex; test code-fenced JSON / NUL vs text / regex flag combos | `npm test` green; fails if logic drifts | 2h | tests |
| 6 | Extract+test paneRole, shellEscapePath, AWAIT_PROMPT_RE | `terminals.js:981, 179, 63` + new files | Make `paneRole({layout,isActive,…})` pure (caller unchanged); export shellEscapePath + AWAIT_PROMPT_RE; snapshot regex vs a real-prompt corpus + negatives | `npm test` green; layouts still fit in dev app | 3h | tests |
| 7 | Dead code cleanup | `terminals.js:1297, 1034-1039`, `editor.js:173-176` | Remove dup `setLayout` key; collapse `fitActive`/`fitAll` (grep callers first); resolve empty `if` per author decision | `lint` (no-dupe-keys) + `test` green; layouts re-fit; editor re-activate correct | 0.5h | C5 |
| 8 | Extract `util/dom.js` | `commandPalette.js:215`, `beginnerHud.js:87`, `search.js:125`, `git.js:170`, `fileTree.js:565,642` + new | `escapeHtml` (dedupe ×2); `makeCollapsibleGroup` (factor search/git makeGroup ~50 lines); `confirmDialog`/`contextMenu` primitives; update call sites | `npm test` green; search/git groups, tree menu+delete, palette/HUD all render | 4h | C1-C4 |
| 9 | Extract `util/paths.js` | `fileTree.js:107,112,117`, `projectType.js:11` + new | `basename`/`dirname`/`joinPath` kept **platform-aware** (copy verbatim); replace dup joinPath | `npm test` green; tree path-building + project detection work | 1.5h | C2 |
| 10 | Extract `util/gitStatus.js` | `git.js:6-22`, `fileTree.js:7-22` + new | `STATUS_COLOR/TITLE/RANK` + GitStatus JSDoc typedef; reconcile any drift between the two copies | `npm test` green; badges identical colors/titles/ranking | 1.5h | C3 |
| 11 | Shared channel registry | `src/shared/channels.js` (new), `preload/index.js`, all `ipc-*.js` | Frozen string map of every channel; import in preload + main. **Security:** pure constant, must not widen renderer surface or expose main-only channels; don't touch contextBridge shape | No raw channel literals remain; every IPC path works in dev app | 3h | C4 |
| 12 | Thin renderer `util/ipc.js` (one error contract) | `renderer/util/ipc.js` (new) + a few call sites | `ipc.invoke/ipc.on` + `safe()`: queries→`{ok,data,error}`, mutations throw; migrate 1-2 representative sites + document | `npm test` green; migrated sites behave identically | 2.5h | C4 |
| 13 | **PLAN-ONLY:** big-file splits (follow-on workstream) | `terminals.js`→`terminalSession.js`/`terminalLayout.js`(+layout **registry**)/`pulse.js`; `main.js`→`workspace.js`/`layout.js`/`settings.js` | **Do not implement in PR-5.** Only after the test net exists; each split its own PR preceded by tests for the moved logic (paneRole pure fn is the registry seed) | A follow-on ticket captures the sequence + test prerequisites | 0 | refactor-plan |

**Top risks:** `tsc --checkJs` can flood with false positives (scope loosely). ESLint flat config needs per-path
env (node vs browser vs preload). Making paneRole/shellEscapePath "pure" = minimal signature change only.
Channel registry touches the security boundary — must not expose new channels. AWAIT_PROMPT_RE snapshot needs a
*real* prompt corpus or it's false confidence. **Open Qs:** `editor.js:174` intent; checkJs strictness; ipc.js
retrofit-now vs lazy; CI workflow now?; where utils live (`src/renderer/util/`, `src/shared/channels.js`).

---

## Out of scope here — the distribution/ops/commercial epics

These are real and required for 100M users, but they are **infrastructure projects, not quick code fixes** — track
them as separate epics (see `00-EXECUTIVE-SUMMARY.md` → Roadmap, Tiers 0–2):

- **Tier 0 (can't ship externally):** code signing + notarization + Windows/x64 targets; auto-update
  (`electron-updater`, staged rollout, signature verify, API-version handshake); crash reporting.
- **Tier 1 (can't operate at scale):** consent-gated telemetry (redact secrets, never upload pane tails);
  feature flags / remote kill-switch; CI/CD (sign+notarize+publish on tag; decouple version bump from build);
  per-user footprint caps; versioned per-workspace session sync.
- **Tier 2 (commercial):** accounts/auth, offline-tolerant licensing, billing, settings sync.

These should be scoped as their own design docs; the five PRs above are the engineering backlog that's ready to
start now.
