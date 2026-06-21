# Audit 05 — Performance & Engineering Process

**Domain:** Runtime performance + the engineering process (build, test, dev loop, CI/CD).
**Reviewer role:** Performance + developer-productivity engineer.
**Method:** Files were opened and read in full. Every finding cites a file and line/range. Confidence is marked per finding; inferred-but-unconfirmed items say so and state what would confirm them.

The product is "Concourse" — an Electron 33 desktop app that runs N terminal-native AI coding agents in xterm.js panes driven by node-pty, with a Monaco editor, a file tree, git, search, and "Pulse" (a per-pane LLM state summariser whose Anthropic SDK call runs in the main process).

---

## Executive summary

The renderer hot paths are, on the whole, **carefully built** — output writes, fit/resize, and the fleet summary are coalesced through `requestAnimationFrame`, the per-pane `ResizeObserver` is debounced, and the `paneRole` rule keeps previews from SIGWINCH-ing their PTYs. That is better than most apps of this size. The dominant scaling risks are not the per-frame work; they are: (1) **two `setInterval` loops per terminal-manager that never stop** and a Pulse summarisation cadence that, at fleet scale, becomes a real recurring **$ cost** (quantified below); (2) **unbounded per-user resource footprint** — every terminal is a full xterm instance with a 10k-line scrollback plus a node-pty process, and Monaco loads 5 web workers up front; (3) **synchronous fs in the main process** (`fs.readFileSync` of shell rc files on every PTY spawn, `fs.watch({recursive})` on the whole workspace) that blocks the IPC thread; and (4) on the **process** side, the near-total absence of tests, lint, typecheck, and CI, combined with a `dist`/`pack` pipeline that does a version bump + full clean + full rebuild every single time.

The Pulse LLM integration is the highest-leverage perf + cost item. Verified against the current Anthropic API: the model id `claude-haiku-4-5` is correct and active (200K context), Haiku 4.5 pricing is **$1/MTok input, $5/MTok output**, and the `output_config: { format: { type: 'json_schema', schema } }` parameter is the correct current structured-outputs shape (the legacy `output_format` is deprecated). So the integration is *correct*; the issue is **cadence and the lack of prompt caching**, not the API shape.

This report is exhaustive; the structured summary returned to the orchestrator is a capped subset.

---

## A. Runtime performance — hot paths

### A1. Two `setInterval`s per `createTerminals()` run forever and are never cleared — wasted wakeups, and a leak if the manager is ever re-created
**Confidence: high.**
`src/renderer/terminals.js:1207` (the Pulse Layer-A tick, every 2000 ms) and the implicit Pulse summarise cadence both run on a global `setInterval` that is created inside `createTerminals()` and **never stored, never cleared**. The 2s tick walks every session on every fire regardless of whether anything changed:

```js
setInterval(() => {
  const t = now()
  for (const s of sessions.values()) {
    if (s.status === 'exited') continue
    const quietFor = t - s.lastOutputAt
    ...
  }
}, 2000)
```

- Today `createTerminals()` is called once (`src/renderer/main.js:95`), so it does not leak across re-creations — but it **does fire forever even when the app is idle / backgrounded**, defeating any wakeup-coalescing the OS would otherwise do and keeping the renderer from quiescing. On 100M desktops, a background app waking every 2s is a measurable battery/CPU cost and a common cause of "why is this Electron app eating my laptop" support tickets.
- There is no teardown path. If a future refactor recreates the manager (e.g. multi-window-in-one-renderer, hot-swap on workspace change), each call stacks another永-running interval. `destroy(id)` (`terminals.js:805`) clears per-session timers but nothing clears the manager-level interval.
- **Recommendation:** (a) gate the tick on `document.visibilityState` — pause when hidden; (b) skip the tick entirely when `sessions.size === 0` or when no session is in a `working`/`quiet`/`awaiting` state; (c) store the interval handle and expose a `dispose()` from `createTerminals()` that clears it (and the `submitTimer`/`streamTimer`/`titleTimer` already handled per-session). Even simpler: drive the silence check off the existing `onData` flow with per-session `setTimeout`s instead of a global poll.

### A2. `tailOf()` rebuilds the pane's visible text from the xterm buffer on every summarise and every await-check — string churn on the hot path
**Confidence: high.**
`src/renderer/terminals.js:1147` `tailOf()` walks up to 40 (or 8) buffer lines, calls `line.translateToString(true)` per line, reverses, joins, and runs two regex replaces — and it is called from `hasAwaitPrompt()` (`terminals.js:75`), which runs **on every output-settle** (`terminals.js:1115`) and **on every 2s tick** (`terminals.js:1214`), plus from `summarize()`. `translateToString` allocates a fresh string per line; for a wall of 20+ panes each settling independently this is a steady stream of short-lived allocations and GC pressure.
- **Recommendation:** cache the last computed tail + a cheap dirty flag keyed on `s.lastOutputAt` (already tracked). `hasAwaitPrompt` only needs the last ~8 lines — compute that once per settle, not once per call site. The `hashStr` in `summarize` (`terminals.js:1157`) already exists to skip no-op model calls; extend the same memoisation to the tail extraction itself.

### A3. `xterm.write(data)` is called synchronously per IPC chunk with no batching of bursts
**Confidence: medium (xterm internally buffers, but the IPC + per-chunk bookkeeping is not coalesced).**
`src/renderer/terminals.js:1077` writes each `term:data` IPC payload straight into xterm, and around it runs `now()`, state transitions, `clearTimeout`/`setTimeout` for the stream timer, and conditionally `updateIndicators` (`terminals.js:1074-1124`). xterm's own renderer coalesces draws, but the **per-chunk JS bookkeeping** (timestamp, timer reset, dot-class recompute) is not coalesced — a fast-streaming agent (Claude Code repainting its TUI) emits many small chunks/sec, and each one resets `streamTimer` and may call `updateIndicators` → `emitFleet`. `emitFleet` is rAF-coalesced (`terminals.js:550`) so that part is fine, but `updateIndicators` itself touches three DOM `className`s per call.
- **Recommendation:** the indicator/stream bookkeeping per chunk is cheap individually but multiplies by panes × chunks/sec. Consider coalescing the `streamTimer` reset and the `updateIndicators` call to at most once per rAF per pane (the same pattern already used for fits). What would confirm the cost: profiling a grid of 9+ panes each running an animated TUI and watching the renderer's scripting time per frame.

### A4. Pulse: model call cadence + token cost at fleet scale — quantified
**Confidence: high on the API facts (verified against current Anthropic docs); medium on the per-minute call count (depends on user behaviour).**

Verified API facts:
- `claude-haiku-4-5` (`src/main/ipc-pulse.js:20`) is a **correct, active** model id (200K context).
- Haiku 4.5 pricing is **$1.00 / MTok input, $5.00 / MTok output**.
- `output_config: { format: { type: 'json_schema', schema: SCHEMA } }` (`ipc-pulse.js:152`) is the **correct current** structured-outputs parameter; the old top-level `output_format` is deprecated. So the call shape is right.

Cost mechanics:
- `max_tokens: 200` (`ipc-pulse.js:148`) caps output; the **input** is the dominant cost. Input per call = the system prompt (`SYSTEM`, ~400 tokens, `ipc-pulse.js:39-65`) + context lines + the pane tail (capped at `TAIL_MAX = 8000` chars ≈ ~2000 tokens, `ipc-pulse.js:69`). Call it ~1.2–2.4K input tokens per summarise.
- **The system prompt is re-sent uncached on every call.** There is no `cache_control` breakpoint anywhere in `ipc-pulse.js`. The `SYSTEM` block is byte-identical across every call and is a textbook prompt-caching candidate. At Haiku's $1/MTok input, caching the ~400-token system prefix saves ~$0.0004/call on the prefix alone — small per call, but it multiplies by every pane every turn for every user.
- Cadence: `summarize()` fires on (a) the working→quiet edge after `QUIET_MS = 8000`ms (`terminals.js:1218`), (b) every explicit await-prompt settle (`terminals.js:1118`), (c) every user submit after `SUBMIT_DELAY_MS = 1200` (`terminals.js:715`), and (d) **every 2s tick** for any quiet/awaiting pane (`terminals.js:1226`). The `hashStr` guard (`terminals.js:1168`) and `summarizing` in-flight guard prevent re-asking about an *unchanged* screen — this is the saving grace. But an agent whose TUI keeps changing (timers, spinners, token streaming) changes the hash continuously, so the tick **can** fire a model call every 2s per active pane.

Worked cost estimate (illustrative, to make the scaling real):
- Assume a power user runs 8 agent panes, each producing a screen-changing-then-resting cycle ~every 30s during a 4-hour session ⇒ ~8 panes × (3600s×4 / 30s) ≈ 8 × 480 ≈ 3,840 summarise calls/session. At ~1.5K input tokens/call that's ~5.76M input tokens ⇒ **~$5.76/user/session** at $1/MTok, plus output. That is the *Anthropic-key* path; most users will be on the local OpenAI-compatible path (free) — but **for any cohort on the Anthropic key, this is a real recurring per-user cost** that scales linearly with fleet size and session length, and 100M users makes the tail enormous.
- **Recommendations (highest ROI first):**
  1. **Add a `cache_control` breakpoint on the `SYSTEM` block.** It is stable and re-sent every call — exactly what prompt caching is for. ~0.1× input cost on the cached prefix.
  2. **Rate-limit per pane.** Even with the hash guard, a continuously-changing TUI permits a call every 2s. Add a per-pane minimum interval (e.g. one model call per pane per ≥10–15s) and only summarise on the *working→awaiting/quiet edge*, not on every tick while quiet. The product's own north star (per MEMORY: "notify on the working→awaiting edge") argues for edge-triggered, not level-triggered, summarisation.
  3. **Coalesce across panes.** A fleet of 20 panes settling together fires 20 independent calls. Batch the tails into one request (the model already returns a single verdict per pane; a batched prompt returning an array would cut request overhead) or stagger them.
  4. **Cap tail tokens lower.** `TAIL_MAX = 8000` chars is generous for an "≤8 word summary" task; 2–3K chars is plenty and roughly halves input cost.
  5. The `pulse:status` reachability for the local path does a `GET /models` (`ipc-pulse.js:176`) — fine — but the Claude path's `reachable()` returns `true` without a ping (`ipc-pulse.js:140`), so `pulseEnabled` can be set even when the key is invalid; the first real call then fails. Low cost, but it means every Claude-path user with a bad key still triggers the renderer to *attempt* summaries. Consider a cheap token-count or 1-token probe once at startup.

### A5. `summarize()` has a single global in-flight guard per pane but no global concurrency cap across panes
**Confidence: high.**
`ipc-pulse.js:219` `inFlight` is a `Set` keyed by `wcId:paneId`, so it caps **one in-flight call per pane**, but there is **no cap on total concurrent calls** across panes. A fleet of 30 panes all settling at once issues 30 concurrent `messages.create` / fetches. On the Anthropic path that risks 429s (which then degrade to `null` and get retried next tick — a thundering-herd retry); on the local Ollama path it will serialise on the single local model and stall, with each call holding open for up to `20000`ms (`ipc-pulse.js:198`).
- **Recommendation:** add a small main-process semaphore (e.g. max 3–4 concurrent summaries) with a queue; drop (don't queue) stale requests whose pane has since moved on.

---

## B. Memory / CPU footprint per user at scale

### B1. Every terminal is a full xterm + 10,000-line scrollback + a node-pty process — this dominates RAM and grows unbounded with pane count
**Confidence: high.**
`src/renderer/terminals.js:645-652` each `new Terminal({ scrollback: 10000, ... })`. A 10k-line scrollback at typical column widths holds on the order of single-digit MB of buffer per terminal in the worst case, plus the xterm render layers. Each pane also spawns a node-pty (`src/main/ipc-pty.js:131`) — a real OS process (the user's login shell, often then running a full agent). There is **no upper bound on pane count** anywhere; `create({})` (`terminals.js:574`) can be called indefinitely (the "+" button, `Cmd+T`, restore).
- At scale the per-user footprint is: N × (xterm instance + 10k scrollback) in the renderer + N × (shell process + agent process + node-pty) at the OS level. The product is explicitly pitched at "10+ agents" / "The Queue" (per MEMORY: fleet arrangements). 20 panes is plausible; 20 × (shell + Claude Code) is a heavy machine load that the app does nothing to bound or warn about.
- **Recommendations:** (a) make `scrollback` adaptive — previews/hidden panes (which already have a `paneRole`, `terminals.js:981`) don't need 10k lines; drop hidden/preview scrollback to e.g. 1–2k and only grow the primary. (b) Consider a soft cap / warning when pane count crosses a threshold (e.g. > 12) tied to available RAM. (c) For long-running sessions, scrollback is the unbounded growth vector — confirm xterm honours the cap as a ring buffer (it does), but the *agent processes themselves* are the real footprint; surfacing per-pane RSS in the status bar would help users self-regulate.

### B2. Monaco loads five web workers eagerly at module import — fixed cost paid even in "terminals-only" mode
**Confidence: high.**
`src/renderer/editor.js:3-17` imports `editor.worker`, `json.worker`, `css.worker`, `html.worker`, `ts.worker` and wires `MonacoEnvironment.getWorker`. `createEditor()` (`editor.js:73`) is called unconditionally at boot (`main.js:61`) and immediately does `monaco.editor.create(...)` (`editor.js:105`), which initialises the editor and its worker plumbing **even though the app boots in terminals-only mode** (`main.js:438`, `setTerminalsOnly(true)`) and the user may never open a file.
- Monaco + its workers are the single largest renderer bundle and the largest fixed RAM cost. Paying it at boot for a user who only ever runs terminals is pure waste, and it slows first paint.
- **Recommendation:** lazy-init Monaco on first `openFile`/`openDiff`. `editor.js` already creates the diff editor lazily (`ensureDiffEditor`, `editor.js:112`) — apply the same pattern to the file editor and to the `monaco` import itself (dynamic `import()`), so terminals-only sessions never load it. This is likely the biggest single startup-time and idle-RAM win available.

### B3. `childrenCache` and the rendered DOM grow with the expanded tree; `render()` rebuilds the entire visible tree on every change
**Confidence: high.**
`src/renderer/fileTree.js:276` `render()` does `container.innerHTML = ''` then rebuilds the whole visible subtree via `buildChildrenEls` (`fileTree.js:264`, recursive). Every `toggleFolder`, `refresh`, git-status repaint, and inline-create calls `render()`. For a large repo with many folders expanded, this is a full teardown + rebuild of potentially thousands of DOM rows on every interaction — including on every `fs:changed` watcher fire (debounced to 150ms, `src/main/watcher.js:22`, but a busy `npm install` or `git checkout` still triggers a full re-render once the debounce settles).
- `decorateAll()` (`fileTree.js:169`) additionally re-queries `.ft-row[data-path]` and re-runs `decorateRow` for every visible row on every git status update.
- **Recommendation:** the tree is the classic case for incremental DOM updates or virtualization. At minimum, make `applyGitStatus` (`fileTree.js:175`) diff-and-patch existing rows instead of relying on a full `render()` for structural changes; for very large trees, virtualize (render only rows in the viewport). Confirmation of impact: open a monorepo with thousands of files, expand several deep folders, and watch the re-render time on a single `fs:changed`.

### B4. Search reads entire files into memory and `content.split('\n')` for every scanned file
**Confidence: high.**
`src/main/ipc-search.js:99` `buf = await fs.readFile(full)` then `content.split('\n')` (`ipc-search.js:106`) for up to `MAX_FILES = 5000` files (`ipc-search.js:23`), each up to `MAX_FILE_BYTES = 1MB`. Worst case the walk reads 5GB through the main process and allocates a line array per file. The limits prevent a true runaway, but `fs/promises.readFile` + full-buffer `toString('utf8')` + `split` is the heavyweight path, all on the main thread (it's `await`ed so it yields, but the CPU of `split`/regex still runs in the main process and competes with PTY IPC).
- **Recommendation:** stream files line-by-line (readline) rather than read-whole + split; or shell out to `ripgrep` (bundled) which is dramatically faster and offloads the work to a subprocess. For an app pitched at coding agents, `rg` is the expected substrate. Confirmation: time a project-wide search in a large repo and watch main-process CPU and PTY latency during it.

---

## C. Main-process blocking / synchronous fs

### C1. `fs.readFileSync` of shell rc files on **every** PTY spawn blocks the main (IPC) thread
**Confidence: high.**
`src/main/ipc-pty.js:21` `userHasCustomPrompt()` does `fs.readFileSync(path.join(home, f), 'utf8')` over up to four rc files (`.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`), synchronously, **inside the `term:create` IPC handler** (`ipc-pty.js:123`). `friendlyPromptSetup()` (`ipc-pty.js:47`) then does synchronous `fs.mkdirSync` + multiple `fs.writeFileSync` (`ipc-pty.js:59-80`), also in the handler.
- Every new terminal — and every terminal restored on session reload (`main.js:344`, `restoreSession` → `terminals.restore` → `create` → `api.term.create`) — blocks the main process on synchronous disk reads/writes. When restoring a saved layout of 10 panes, that's 10 × (4 sync reads + several sync writes) serialised on the IPC thread, during which **all** IPC (every pane's `term:data`, git, fs, search) is stalled.
- **Recommendation:** (a) read the rc files **once** at startup and cache the `userHasCustomPrompt` result + the generated init-file path (the rc files don't change between spawns within a session); (b) make the writes async (`fs/promises`) or, better, generate the init files once per session rather than per spawn. This directly reduces the "shells stutter when several panes restore at once" problem the code comments already acknowledge (`ipc-pty.js:40-43`).

### C2. `fs.watch(root, { recursive: true })` watches the entire workspace including ignored subtrees
**Confidence: high.**
`src/main/watcher.js:49` `fs.watch(root, { recursive: true })`. The comment (`watcher.js:17`) correctly notes recursive watch **cannot prune subtrees** — so `node_modules`, `.git`, `dist`, build dirs are all watched, and only *filtered after the fact* by the `IGNORED` regex (`watcher.js:19`) before deciding whether to refresh. On macOS this registers an FSEvents stream for the whole tree; for a repo with a large `node_modules` or an active build, the OS delivers a high volume of change events that the main process must regex-test one-by-one (`watcher.js:59`), even though they're ultimately ignored.
- One watcher per window (`watcher.js:24`, keyed by `webContents.id`); a multi-window power user multiplies this.
- **Recommendation:** the regex post-filter is the right idea but the event volume is the cost. Consider a watch library that supports ignore-globs at the OS level (e.g. `chokidar` with `ignored`, or `@parcel/watcher` which prunes), or watch only the expanded/visible directories rather than the whole tree. At minimum, confirm the debounce (`DEBOUNCE_MS = 150`, `watcher.js:22`) plus the regex aren't themselves a CPU sink during `npm install` — that's the likely worst case.

### C3. `simpleGit` is re-instantiated per call, and `git:status` runs on a 4s session-save cadence path indirectly
**Confidence: medium.**
`src/main/ipc-git.js` creates a fresh `simpleGit(root)` in every handler (e.g. `ipc-git.js:41`, `:88`, `:119`). `simple-git` spawns a `git` subprocess per command. `git.refresh()` is called on workspace open, on SCM view switch, on save (`main.js:109`), and `refreshBranch()` (`terminals.js:931`) calls `api.git.status()` on every terminal create and every captured command (`setHeuristic`, `terminals.js:967`). So typing commands in a shell pane triggers repeated `git status` subprocess spawns (guarded by `branchPending`, `terminals.js:930`, which prevents *concurrent* but not *frequent* calls).
- **Recommendation:** cache the `git status` result with a short TTL (e.g. 1–2s) keyed by root, and invalidate on `fs:changed`. The branch rarely changes mid-keystroke; spawning `git` per command is wasteful at fleet scale. Confirmation: count `git` subprocess spawns while typing into a shell pane.

---

## D. Engineering process — testing

### D1. There are **zero tests** — and the highest-risk logic is exactly the untested logic
**Confidence: high.**
No test files, no test runner in `package.json` (`package.json:8-17` has no `test` script), no testing dependency. The codebase has several pieces where a silent regression is both likely and costly:

Highest-ROI test seams, in priority order:
1. **IPC contract tests (main side).** `ipc-pty.js`, `ipc-fs.js`, `ipc-git.js`, `ipc-pulse.js`, `ipc-search.js` are pure-ish functions behind `ipcMain.handle`. Test the handlers directly (mock `event.sender`/`ctx`). The Pulse `parseVerdict` (`ipc-pulse.js:85`) and `cap`/`buildUserText` (`ipc-pulse.js:71-80`) are pure and trivially testable — they guard a paid API call, so a bug there is a money/UX bug. The security-relevant validators (path handling in `ipc-fs.js`, shell-escape in `terminals.js:179` `shellEscapePath` / `:1275` `cdInto`) are pure string functions and **must** have tests — a regression there is a shell-injection or path-traversal vector.
2. **`terminals.js` sizing logic.** `paneRole` (`terminals.js:981`) and the fit funnel (`fitPane`, `terminals.js:996`) encode the entire "previews never resize their PTY" invariant that the recent refactor (per git log: "paneRole-driven fitting") exists to protect. This is the most regression-prone logic in the app and is pure given a fake session shape. Extract `paneRole(layout, activeId, classList)` into a testable pure function and assert the role for each layout × position.
3. **Pulse state machine.** `dotClass` (`terminals.js:502`), `setState` (`terminals.js:524`), and the await-prompt regexes (`terminals.js:63`) are the product's core signal. The regexes especially: a single bad regex change silently breaks awaiting-detection for an agent. Snapshot-test `AWAIT_PROMPT_RE` against a corpus of real prompts.
4. **Search correctness/limits.** `buildRegex` (`ipc-search.js:39`), `looksBinary` (`ipc-search.js:33`), and the truncation limits — easy to test, and a bug means wrong/missing results.

**Pragmatic strategy:** add Vitest (it's ESM-native, fast, zero-config for plain JS, and shares Vite with `electron-vite` already in `devDependencies`). Start with the pure functions (no Electron needed) — `parseVerdict`, `paneRole` (after extraction), the regexes, the escapers, `looksBinary`/`buildRegex`. That's a few hours of work covering the highest-risk surface. Add a thin Electron-main integration layer later (e.g. a fake `ipcMain`) only if the pure-function layer proves insufficient. Do **not** chase renderer DOM tests first — they're high-effort, low-ROI here.

---

## E. Engineering process — build / release / CI

### E1. `dist` and `pack` do bump + full clean + full rebuild every time — slow, and the auto-bump pollutes version history
**Confidence: high.**
`package.json:14-15`:
```
"dist": "npm run bump && npm run clean && electron-vite build && electron-builder --mac",
"pack": "npm run bump && npm run clean && electron-vite build && electron-builder --mac --dir",
```
`bump` is `npm version patch` (`package.json:12`) and `clean` is `rm -rf out release` (`package.json:13`). So **every** packaged build: (a) increments the patch version with no git tag, (b) deletes all build output, (c) rebuilds from scratch with no cache. Per the git log ("auto-bump version and clean-rebuild on every pack/dist") this is intentional, but at scale it means:
- Every local `pack` to test a one-line change burns a full cold Vite build + electron-builder packaging (the slow part) and **bumps the version** — so version numbers climb on throwaway builds and no longer mean anything (per MEMORY, the version is surfaced in the status bar precisely to know which build is running; auto-bumping on every pack makes that number noise).
- `clean` defeats incremental builds. electron-vite/Vite caches are discarded each time.
- **Recommendations:** (a) decouple `bump` from `pack` — bump only on a real release (`dist`), never on `pack` (the dev/iterate path). (b) Drop the unconditional `clean` from `pack`; let Vite do incremental builds and only `clean` when something's actually stale (or add a separate `pack:clean`). (c) Tie version to git (tags) for releases rather than a tagless `npm version`, so the version is reproducible and traceable.

### E2. `postinstall` rebuilds node-pty on every install; no reproducibility pin
**Confidence: high.**
`package.json:16` `"postinstall": "electron-rebuild -f -w node-pty"`. `-f` forces a rebuild of node-pty against the Electron ABI on every `npm install`. This is necessary for the native module, but: (a) it's slow and runs even when nothing changed; (b) it requires the full native toolchain on every machine (per MEMORY: "CLT headers broken" — native builds need the Xcode toolchain, not just Command Line Tools), which is a known sharp edge; (c) `electron-builder.yml:25` sets `npmRebuild: false` relying on this postinstall having run — so the two are coupled and order-dependent.
- **Recommendation:** consider prebuilt binaries for node-pty (or pin/ship a prebuilt) so contributors and CI don't need the native toolchain. At minimum, document the Xcode requirement in the repo (it currently lives only in user auto-memory). For CI, cache the rebuilt `node_modules`/`.node` artifact keyed on Electron version + node-pty version so the rebuild isn't paid every run.

### E3. No CI/CD at all
**Confidence: high (no CI config present in the repo root inventory; no `.github/workflows` referenced).**
There is no CI: no automated build verification, no lint/format/typecheck gate, no test run (there are no tests), no release automation, **no crash reporting / telemetry**, and the mac build is explicitly unsigned/un-notarized (`electron-builder.yml:20-21` `identity: null`).
- For a desktop app heading toward scale, the scaling-relevant gaps are: **(1) no auto-update infrastructure** (electron-builder supports `electron-updater`, but there's no publish config / update feed) — without it, shipping a fix to 100M users means manual re-download, and a bad build can't be rolled forward safely; **(2) no code signing / notarization** — unsigned macOS apps are increasingly hard to distribute (Gatekeeper) and impossible to auto-update safely; **(3) no crash reporting** (no Sentry/Crashpad/`crashReporter`) — at scale you are blind to renderer crashes (`render-process-gone` is only logged to console in dev, `main/index.js:54`) and PTY/native failures; **(4) no telemetry** to know pane counts, Pulse provider mix, or error rates that would let you size the Pulse cost problem (D-section) empirically.
- **Recommendations (minimal, high-leverage):** add a GitHub Actions workflow that on PR runs lint + typecheck + the new unit tests, and on tag builds + signs + notarizes + publishes via `electron-updater`. Add `crashReporter`/Sentry in main + renderer guarded behind a consent flag. Add a tiny, privacy-respecting metric for pane count and Pulse provider (claude vs local vs disabled) — this is the only way to know how big the A4 cost actually is in production.

### E4. Dev loop: no lint, no format, no typecheck, no error monitoring in dev
**Confidence: high.**
`package.json:25-32` devDependencies are only Electron, electron-vite, vite, electron-builder, monaco, electron/rebuild. No ESLint, no Prettier, no type checker. The project is plain ESM JS with no TypeScript (a deliberate choice per the brief), so there's no compiler catching `undefined`/typo bugs — and there are real footguns the code already worked around (per MEMORY: "Preload .mjs path" — `window.api` silently undefined if the preload is referenced as `.js`; `main/index.js:39` hardcodes `index.mjs`). A linter with `no-undef` + a couple of Electron-security rules would catch a whole class of these.
- The duplicate `setLayout` in the returned API object (`terminals.js:1297` — `setLayout` appears **twice** in the returned object literal) is exactly the kind of thing a linter flags. Confidence high: it's literally `{ ..., setLayout, ..., setLayout, ... }`.
- **Recommendation (minimal toolchain, no bloat):** ESLint (flat config) with `eslint-plugin-import` and a small ruleset (`no-undef`, `no-unused-vars`, `no-dupe-keys` — which catches the `setLayout` dupe) + Prettier for format. Wire `lint`/`format`/`typecheck` (via `tsc --checkJs` with a loose `jsconfig.json` — gives type-ish checking on plain JS without converting to TS) as npm scripts and run them in CI (E3). This raises velocity (catches the silent-undefined class at edit time) without adopting TypeScript.

---

## F. Smaller correctness/efficiency notes (lower severity)

- **`cssEscape` fallback + attribute selectors built from paths** — `fileTree.js:295` builds `.ft-row[data-path="${cssEscape(path)}"]` selectors repeatedly to find rows. For large trees this is many full-tree `querySelector` scans per interaction. A `Map<path, rowEl>` maintained during render would make row lookup O(1) instead of O(n) per call. Confidence: medium.
- **`saveSession` JSON.stringify on a 4s interval** — `main.js:338` `setInterval(saveSession, 4000)` serialises the whole session (`gatherSession`, `main.js:307`) every 4s and string-compares to detect change (`main.js:327`). Cheap now, but it's another always-on timer (like A1) that should pause when hidden/idle. Confidence: medium.
- **`fitSoon`/`flushFits` both exist and both iterate sessions** — `terminals.js:1022` and `:1054` are two near-identical rAF-coalesced fit passes (one for layout changes, one for ResizeObserver). They can race (both scheduled in the same frame, both fitting every primary). Likely harmless because `fitPane` is idempotent, but it's redundant work. Confidence: medium; would confirm by logging fit calls during a window resize that also changes layout.
- **`@anthropic-ai/sdk: "latest"`** (`package.json:19`) — pinning a dependency to `"latest"` is a reproducibility and supply-chain risk: two installs days apart can resolve different SDK versions, and a breaking SDK change (the `output_config`/`output_format` migration is a live example of API drift) could silently break Pulse on a fresh `npm install` with no code change. Pin to a caret range (`^x.y.z`) and update deliberately. Confidence: high.
- **Anthropic SDK lazy-import per provider, but client created once** — `ipc-pulse.js:126` caches the client promise; good. No issue, noted as a positive.

---

## G. Scaling to 100M users — what this domain implies (desktop framing)

- **Per-user resource footprint is the dominant scaling axis, not server capacity.** The product encourages many concurrent agents; each is a shell + agent process + node-pty + a 10k-scrollback xterm, with Monaco's workers loaded on top (B1, B2). The single biggest wins are lazy-loading Monaco (B2) and adaptive scrollback (B1). Surface per-pane resource use so users self-regulate, and consider a soft pane cap.
- **The Pulse LLM cost is the only real recurring $ line and it scales linearly with users × panes × session length (A4).** Prompt-cache the system prompt, edge-trigger (not level-trigger) summarisation, rate-limit per pane, cap tail tokens, and add a global concurrency semaphore (A5). Most users on the free local path are fine; the Anthropic-key cohort is where the bill lives — you currently have no telemetry to even size it (E3).
- **Update safety + crash visibility are prerequisites for shipping to scale.** No auto-update, no signing/notarization, no crash reporting (E3) means a bad release can't be rolled forward and you're blind to field failures. This is the highest-leverage *process* investment before scaling distribution.
- **Idle/background efficiency** (A1, F) determines battery/CPU reputation — the always-on 2s tick and 4s save interval should pause when hidden. At 100M desktops, "drains my battery" is a top support/uninstall driver.
- **Reproducible builds + CI** (E1–E4) are what let a small team safely ship frequent updates to a large base. The current bump-clean-rebuild-every-time pipeline and absence of CI/tests will not survive the support burden of scale.
