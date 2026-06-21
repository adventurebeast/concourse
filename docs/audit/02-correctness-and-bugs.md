# Concourse — Correctness, Races & Lifecycle Audit

**Scope:** Highest-value bug hunt across `src/renderer/terminals.js` (read in full), `fileTree.js`, `editor.js`, `git.js`, `main/ipc-pty.js`, `watcher.js`, `ipc-git.js`, `ipc-fs.js`, `statusbar.js`, plus supporting `main.js`, `index.js`, `ipc-pulse.js`, `preload`, `session.js`, `recents.js`, `search.js`, `ipc-search.js`, `ipc-workspace.js`, `context.js`.

**Method:** Read each file. For each bug: trigger → consequence the user sees → fix. Confidence marked honestly. The Anthropic SDK call in `ipc-pulse.js` was checked against the current Claude API reference.

Legend: **C** critical, **H** high, **M** medium, **L** low.

---

## C1 — Drag-reordering a tab mid-rename silently destroys a session's bookkeeping (PTY + observer + DOM leak)

**File:** `src/renderer/terminals.js:153-161` (`reorderFromDom`), interacting with `renameStart` at `:867-893`.

```js
function reorderFromDom() {
  const ordered = [...tabBar.querySelectorAll('.term-tab')]
    .map((el) => [...sessions.values()].find((s) => s.tabEl === el))
    .filter(Boolean)
  sessions.clear()
  for (const s of ordered) sessions.set(s.id, s)
  ...
}
```

`reorderFromDom` rebuilds the `sessions` Map purely from the current DOM order. Any `.term-tab` element that does **not** map back to a live session via `s.tabEl === el` is dropped by `.filter(Boolean)`. The drop is the bug: a dropped session is removed from the Map but its PTY (main process), its `term` (xterm), its `cellBody` ResizeObserver registration, and its `cell`/`stub` DOM all stay alive and orphaned.

**Trigger:** Reorder logic relies on `s.tabEl` still being the live tab node. During a rename, `renameStart` does `labelEl.replaceWith(input)` (`:871`) — that swaps the *label span*, not the tab; the tab element itself stays, so this specific path is usually safe. The real exposure is any state where `querySelectorAll('.term-tab')` returns a different set than `sessions` knows about — e.g. the inline new-tab "+" button is `term-tab-add` (excluded), but a half-constructed tab, a tab being removed in `destroy()` racing a `dragend`, or a future DOM tweak that re-tags tabs will cause `.find` to miss and the session to vanish from the Map while its PTY keeps running.

**Consequence:** A terminal pane that's still on screen and still has a live shell, but the app no longer tracks it: closing/activating it does nothing, `fitAll`/pulse/fleet counts ignore it, and its node-pty process leaks until the window closes. On a "fleet of agents" product this is a silent orphaned agent.

**Fix:** Don't reconstruct the Map by DOM matching. Either (a) reorder by reading `el.dataset.id` (store `tabEl.dataset.id = id` at creation) and assert every session is accounted for, throwing/logging if `ordered.length !== sessions.size`; or (b) keep an explicit order array of ids and reorder that. At minimum, guard: `if (ordered.length !== sessions.size) return` so a mismatch aborts rather than dropping sessions.

**Confidence:** Medium-high that the `.filter(Boolean)` drop is a latent correctness hole; medium that it fires in normal use today (the most obvious mid-rename path keeps `tabEl` intact). Confirm by adding a 9th tab, starting a rename on tab 3, and drag-reordering while the rename input is focused; watch `sessions.size` vs visible panes.

---

## C2 — `confirmClose` dialog can call `destroy()` on an already-destroyed session (double free) and leaks a capture-phase keydown listener

**File:** `src/renderer/terminals.js:268-316` (`confirmClose`) and `:805-836` (`destroy`).

`confirmClose(s)` captures `s` and, on confirm, calls `destroy(s.id)`. The dialog installs a document-level capture keydown listener (`:310`). Two issues:

1. **No idempotency / liveness recheck.** If the same session is closed by another path while the dialog is open (e.g. the PTY exits and some future code calls `destroy`, or the user opens two confirm dialogs via tab X + cell X + context-menu before clicking), `destroy(s.id)` runs against a session that may already be gone. `destroy` does guard with `if (!s) return` at the top (`:807`), so a *second* `destroy` is a no-op — but the dialog itself doesn't re-check, and the more dangerous case is two simultaneously-open confirm overlays: clicking confirm on the first destroys the session; the second overlay's `ok` handler still references the stale `s` and re-enters `destroy` (no-op) but leaves the second overlay and its capture keydown listener installed because only the *first* `finish()` ran.

2. **Listener leak on the no-op path:** each `confirmClose` adds `document.addEventListener('keydown', onKey, true)` and only removes it in `finish()`. If `destroy` is reached without `finish()` (it can't today, since `confirm()` calls `finish()` first — `:297-300`), or if multiple overlays stack, capture-phase keydown handlers accumulate and start intercepting Escape/Enter for the wrong dialog.

**Trigger:** Right-click a tab → "Close Terminal" (opens overlay), then while it's open, click the pane's X (opens a second overlay). Now Enter/Escape behavior is ambiguous and one overlay's listener outlives it.

**Consequence:** Stuck/duplicate confirm dialogs, Enter closing the wrong terminal, lingering global keydown handlers that swallow keys.

**Fix:** Make `confirmClose` single-instance (dismiss any existing `.term-confirm-overlay` on entry, like `openTabMenu` does for its menu at `:233-234`). Have `destroy` already-guards on `!s`, which is good; keep it. Ensure every exit path calls `finish()`.

**Confidence:** Medium. Single-overlay path is fine; the stacked-overlay path is reachable and leaks.

---

## H1 — `onTitleChange` debounce can write a stale program title into a label after a manual rename, and `setTimeout`-based fitting/focus race teardown

**File:** `src/renderer/terminals.js:731-735` (title debounce) and `:918-922` (`setAutoTitle`), plus `applyAutoLabels` guard at `:901-907`.

`onTitleChange` schedules `setTimeout(() => setAutoTitle(s, title), 150)` and stores the handle in `s.titleTimer`. `destroy` clears `s.titleTimer` (`:808`) — good. But `setAutoTitle` → `applyTitle` → `applyAutoLabels` only guards `tabLabel.isConnected` / `cellLabel.isConnected` (`:903-904`); it unconditionally writes `s.stubLabel.textContent` and `s.tabEl.title`/`s.cell.title` (`:905-906`). If the session was destroyed between the OSC title arriving and the 150 ms timer, `s.tabEl`/`s.cell`/`s.stubLabel` are detached nodes — writing to them is harmless (no crash) but pointless. The sharper bug: `s.custom` is checked at schedule time *and* in `setAutoTitle`/`applyTitle`, but a manual rename that lands *during* the 150 ms window sets `s.custom = true`; `setAutoTitle` then early-returns via `applyTitle`'s `if (s.custom) return` (`:910`) — so this path is actually safe. The residual risk is purely the detached-node writes.

**Trigger:** Close a terminal whose agent is actively emitting OSC titles (e.g. a TUI updating its title) within ~150 ms of the close.

**Consequence:** None visible (writes to detached nodes), but it's a smell that the same pattern (`setTimeout(() => s.term.focus(), 0)` at `:462`, `:855`) can call `.focus()` on a disposed xterm if the pane is destroyed in the same tick.

**Fix:** In `setAutoTitle`/the focus timers, bail if `!sessions.has(s.id)`. Cheap and removes the whole class.

**Confidence:** Medium. Low user impact today; the `s.term.focus()` after dispose is the part most likely to throw if timing aligns.

---

## H2 — `summarize()` applies a model verdict to the wrong screen because the hash is computed on a tail that may have changed during the await

**File:** `src/renderer/terminals.js:1162-1199` (`summarize`).

```js
const tail = tailOf(s)
const h = hashStr(tail)
if (h === s.lastSummaryHash) return
s.summarizing = true
... res = await api.pulse.summarize({ id: s.id, tail, ... })
...
s.lastSummaryHash = h   // committed after the await
setState(s, res.state)
const label = res.question ? `⏳ ${res.question}` : res.summary
s.summaryText = ...
```

The hash `h` is taken from the tail captured *before* the await. During the (potentially multi-second, or 20 s for the local provider — `ipc-pulse.js:198`) round trip, the pane keeps producing output and the on-screen tail changes. On return, the code commits `s.lastSummaryHash = h` for a screen that no longer exists, and applies `res.summary`/`res.question` as the label. The guards check `s.status !== 'exited'` and `s.state` membership (`:1189-1192`) but **not** whether the screen still matches `h`. So a verdict like "⏳ overwrite file? (y/N)" can be pinned onto a pane that has already moved past that prompt and is now scrolling new output — a stale, misleading label, and `lastSummaryHash` now blocks re-summarizing the *current* screen until it changes again.

**Trigger:** A slow Layer-B provider + a pane that's intermittently active. Most reproducible with the 20 s local-provider timeout.

**Consequence:** Tab/cell label shows the wrong state ("awaiting: proceed?") for a pane that's actually working, and the fleet status bar's `awaiting` count is wrong — directly undermining the product's headline signal (the working→awaiting edge).

**Fix:** After the await, recompute `const fresh = hashStr(tailOf(s))` and only apply if `fresh === h` (the screen the model actually saw). Otherwise drop the verdict and leave `lastSummaryHash` unset so the next tick re-asks.

**Confidence:** Medium-high. Logic is plainly racy; impact depends on provider latency and pane churn.

---

## H3 — `setInterval` pulse tick and clock are never cleared; multi-window leaves them running per renderer but the deeper issue is unbounded growth of summarize calls

**File:** `src/renderer/terminals.js:1207-1235` (2 s pulse tick) and `src/renderer/statusbar.js:107` (15 s clock).

Both `setInterval`s are created at module init and never cleared. In this Electron app each window is its own renderer process, so on window close the whole process tears down and the intervals die with it — **not** a cross-window leak. The real concern is inside the pulse tick: for **every** session every 2 s it may call `summarize(s)` (`:1218`, `:1226`). With many panes and a configured provider, that's a steady stream of model calls. The in-flight + hash guards throttle it, but a flood of distinct screens (an agent streaming changing output that repeatedly settles to "quiet") can drive a summarize per pane per tick. Cost/rate-limit exposure scales linearly with pane count.

**Trigger:** 10+ active agent panes with Pulse enabled (Anthropic key set), all intermittently going quiet.

**Consequence:** Bursty Anthropic/Haiku spend and possible 429s (handled gracefully — returns null — but wasteful). On the local provider, repeated 20 s-timeout fetches.

**Fix:** Add a per-window minimum interval between *successful* summarize calls per pane (e.g. don't re-summarize a given pane more than once per N seconds regardless of hash), and/or a global concurrency cap across panes. Track the interval handles so a future multi-pane teardown can clear them.

**Confidence:** High that it's unbounded-by-pane-count; the per-call guards prevent the pathological tight loop, so severity is cost, not crash.

---

## H4 — `fs.watch({ recursive: true })` on a huge tree fires a renderer `fs:changed` that re-reads every expanded dir, with no error budget and a known macOS reliability cliff

**File:** `src/main/watcher.js:41-66` and the renderer handler path `fileTree.refresh` (`fileTree.js:344-363`), wired in `main.js` via `api` → `fs:changed`.

`fs.watch(root, { recursive: true })` on macOS is backed by FSEvents and is documented-unreliable for very large trees and across some network/edge cases; `node-pty`-driven agents writing thousands of files (an `npm install`, a build) generate change storms. The 150 ms debounce (`watcher.js:22`) coalesces bursts into one `fs:changed`, but each `fs:changed` triggers `fileTree.refresh()` which `childrenCache.clear()` + re-`readDir`s `[root, ...expanded]` (`fileTree.js:348-350`) and then a full `render()` that rebuilds the entire visible DOM (`fileTree.js:276-281`). For a deeply-expanded tree this is O(visible nodes) DOM churn on every settle.

Two concrete defects:
1. **Watcher silently dies and never restarts.** `watcher.on('error', () => stop(id))` (`watcher.js:56`) tears the watcher down on the first error (EMFILE from too many watches on a giant tree, or an FSEvents hiccup) and **nothing re-arms it**. The user gets no external-change updates for the rest of the session with no indication why. The comment claims "manual refresh still works" but there is no manual refresh button in `fileTree.js` (only `ft-collapse`, `ft-new-file`, `ft-new-folder`, `ft-reveal` — `:711-720`).
2. **`IGNORED` regex still watches the subtree.** As the comment admits (`watcher.js:17-20`), recursive watch can't prune, so `node_modules`/`.git` are watched and only filtered post-hoc — the OS-level watch cost (descriptors, FSEvents load) is still paid on huge dependency trees.

**Trigger:** Open a folder with a large `node_modules`, run an agent that does `npm install`; or open a monorepo and let a build run.

**Consequence:** First defect → file tree quietly stops reflecting disk after an error, permanently, with no recovery and no manual refresh. Second → elevated CPU/descriptor pressure on big repos.

**Fix:** (a) On `error`, attempt a bounded restart (e.g. re-`start(win, root)` after a backoff, a few times) instead of permanent `stop`; surface a one-time toast/indicator if watching is unavailable. (b) Add an explicit "Refresh" button to the file-tree header so the "manual flow still works" promise is true. (c) Consider `chokidar` with `ignored` to actually prune, or accept the watch cost knowingly.

**Confidence:** High on the "dies and never restarts, no manual refresh exists" defect — that's a concrete user-visible regression on the exact stress case (agents writing files).

---

## H5 — Git `discard` and `diff` build a `simpleGit(root)` with a possibly-null root and shell out paths without validating the workspace

**File:** `src/main/ipc-git.js:85-114` (`git:diff`), `:148-176` (`git:discard`).

Unlike `git:status` (which guards `if (!root) return { isRepo: false, noFolder: true }` at `:39`), the `git:diff`, `git:stage`, `git:unstage`, `git:discard`, `git:commit`, and `git:init` handlers call `simpleGit(ctx.getRoot(e.sender))` with **no null check**. `ctx.getRoot` returns `null` when no folder is open (`context.js:27-30`). `simpleGit(null)` / `simpleGit(undefined)` falls back to the process cwd — which for a packaged app launched from Finder is `/` or the app bundle. A `git checkout -- <path>` or `fs.rm(join(root, p))` (`ipc-git.js:168`) with `root` null becomes `join(null, p)` → throws TypeError (caught) for `discard`, but `git.checkout(['--', p])` runs against the *wrong repo* (process cwd) if that happens to be a git repo.

`git:discard` is the dangerous one: `await fs.rm(join(root, p), { force: true })` with a null `root` throws `TypeError [ERR_INVALID_ARG_TYPE]` inside the try, is swallowed (`:171-173`), and the function returns `true` — so the renderer thinks the discard succeeded when nothing happened.

**Trigger:** These IPCs are only invoked from the SCM panel which requires a repo, so reaching them with a null root requires a race (folder closed between status load and an action click) — but the renderer never closes a folder to null in normal flow, so this is primarily a robustness gap, not a daily bug.

**Consequence:** With a null/empty root, `discard` silently no-ops while reporting success; `diff`/`checkout` could operate on the process cwd repo. The bigger smell is the inconsistent guard — `git:status` guards, the mutating handlers don't.

**Fix:** Add `const root = ctx.getRoot(e.sender); if (!root) return <safe default>` to every git handler, mirroring `git:status`. For `discard`, return `false` (not `true`) when nothing was removed.

**Confidence:** Medium. The null-root path is hard to hit from the UI, but the swallow-and-return-`true` in `discard` is a real correctness bug if it ever does.

---

## M1 — `git:discard` deletes untracked files with `fs.rm(force:true)` but classifies tracked-vs-untracked from a *separate* `git.status()` that can be stale

**File:** `src/main/ipc-git.js:148-176`.

`discard` calls `git.status()` once to build `untracked = new Set(s.not_added)`, then for each path: if untracked → `fs.rm` (permanent delete), else → `git checkout -- path`. The status snapshot is taken at discard time, but if a file's tracked/untracked state changed between the SCM panel's last refresh and this call (e.g. the user staged it elsewhere, or an agent committed), a file the user believes is a tracked "discard my edits" can be classified untracked and **permanently deleted** instead of reverted — there's no trash, `force:true` is unconditional.

**Trigger:** Discard a file whose index state changed since the panel rendered.

**Consequence:** Irreversible file deletion when the user expected a revert-to-HEAD. Data loss.

**Fix:** Re-derive per-path status atomically, and for the untracked branch consider moving to OS trash (`shell.trashItem`) instead of `fs.rm`, so a misclassification is recoverable.

**Confidence:** Medium. Window is narrow but the consequence (silent permanent delete) is severe — worth hardening for a product that hands the repo to autonomous agents.

---

## M2 — `fileTree` row click handlers and the whole DOM are rebuilt on every `refresh`/`render`, but selection/expansion CSS-escaping uses an unsafe fallback

**File:** `src/renderer/fileTree.js:295` and `:309-312` (`cssEscape`), used in `querySelector(\`.ft-row[data-path="${cssEscape(path)}"]\`)`.

```js
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s)
  return s.replace(/["\\]/g, '\\$&')
}
```

`CSS.escape` exists in Electron 33, so the fallback won't run — fine. But `selectRow`/`childDepthOf`/`placeInlineInDir`/`startRename` all do `querySelector` by `data-path` with a path that can contain characters the *attribute selector* still chokes on even after escaping quotes/backslashes if the fallback ever runs (newlines, `]`). More importantly, building selectors from filesystem paths is fragile; a path with an embedded `"` on the fallback path would break selection silently. Low severity given `CSS.escape` is present.

**Trigger:** Only on the fallback path (no `CSS.escape`), with exotic filenames.

**Consequence:** Selection/expansion lookups silently fail for such files (row not found → no select, wrong depth).

**Fix:** Key rows by an internal id (a counter on the entry) rather than the raw path, or trust `CSS.escape` and drop the fragile fallback. Low priority.

**Confidence:** Low — guarded by `CSS.escape` presence.

---

## M3 — Editor `openFile` swallows read errors and presents a silent empty buffer that, if saved, truncates the real file

**File:** `src/renderer/editor.js:313-358` (`openFile`), `:407-425` (`save`).

```js
let content = ''
try {
  content = await api.fs.readFile(path)
} catch (err) {
  content = ''   // <-- error swallowed, no surfacing
}
if (content == null) content = ''
const model = monaco.editor.createModel(content, langForPath(path))
```

If `api.fs.readFile` throws (permissions, transient I/O, file deleted between tree render and click), the editor opens an **empty** tab with no error shown. The tab is not marked dirty initially, but the moment the user types (or, worse, hits Cmd+S thinking the file loaded), `save()` writes the empty/edited buffer back via `fs.writeFile` (`ipc-fs.js:47-50`), **overwriting the real on-disk content with empty/partial data**. There is no "file failed to load" state and no read-only guard.

`ipc-fs.js:readFile` reads as `utf8` (`:43-45`) — opening a binary file returns garbage/replacement chars, and saving re-encodes it, corrupting the binary. No binary guard exists in the editor open path (the file tree happily lists images/archives and `onOpenFile` will try to open them in Monaco).

**Trigger:** Click a file the process can't read, or a binary file (e.g. a `.png` in the tree), then save.

**Consequence:** Silent data loss / file corruption — the user sees an empty or mojibake editor, edits/saves, and clobbers the original.

**Fix:** On read error, surface it (toast/inline) and either refuse to open the tab or open it read-only. For binaries, detect (the search layer already has `looksBinary` at `ipc-search.js:33-37` — reuse it in `fs:readFile` or gate `openFile` by extension/MIME) and open a non-editable preview rather than a Monaco text model.

**Confidence:** High. The empty-on-error-then-save path is a real data-loss vector; the binary path is trivially reproducible (click any image in the tree).

---

## M4 — Two `setInterval(saveSession, 4000)` + `beforeunload` save can race the async session write and persist a half-built state

**File:** `src/renderer/main.js:325-341` (`saveSession`, periodic interval, `beforeunload`) and `src/main/session.js:26-32`/`51-57` (`setSession` read-modify-write).

`session.js` does a non-atomic read-modify-write of `session.json` (`readStore()` → mutate `data.roots[root]` → `writeStore(data)`) on every `session:save`. The renderer fires `saveSession` every 4 s *and* on `beforeunload`. If two saves overlap (periodic timer fires while a previous save's `readStore`/`writeStore` is in flight, or two windows save concurrently for different roots), the later `writeStore` clobbers the earlier with a stale `data` snapshot it read before the first write landed — last-writer-wins on the *whole file*, so one window's session can drop another window's `roots[...]` entry or `lastRoot`.

**Trigger:** Two windows open on different folders, both auto-saving every 4 s; or a `beforeunload` save racing the periodic one.

**Consequence:** Lost session state for one window (tabs/layout don't restore), or `lastRoot` flapping between windows so the next launch reopens the wrong folder.

**Fix:** Serialize writes in the main process (a per-file write queue / async mutex around `readStore`+`writeStore`), or write per-root files instead of one shared `session.json`. The `beforeunload` save (`main.js:340`) is also fire-and-forget (`api.session.save(...)` not awaited) and may be cut off by process exit — a known Electron limitation; consider a synchronous final flush via a dedicated IPC.

**Confidence:** Medium-high on the multi-window file-clobber; the single-window case is mostly benign because saves are fast and same-origin.

---

## M5 — `restore()` re-creates terminals then calls `setLayout`/`activateIndex`, but `create()` already auto-activates/centers, causing redundant fits and a focus war; preset `command` panes restored as plain shells

**File:** `src/renderer/terminals.js:796-803` (`restore`), `:574-784` (`create`), `main.js:344-368` (`restoreSession`).

`restore` loops `create({ label })` for each saved tab. Each `create` calls `applyLayout()` + `activate(id)`/`centerOn(id)` (`:772-775`) and schedules fits. Then `restore` calls `setLayout(state.layout)` (another `applyLayout` + `fitAll` + `activate`) and `activateIndex(state.active)`. So for N restored tabs there are N+2 layout/fit passes and several `setTimeout` focus calls competing. Functionally it settles, but it's wasteful and the focus `setTimeout(()=>s.term.focus(),0)` calls can land in any order, occasionally leaving focus on the wrong pane after restore.

Separately, session restore intentionally drops live process state (documented), so a tab that was running an agent (`command`) comes back as a bare shell with just a label — the user sees "claude" as a tab title but an idle shell underneath. That's a product decision, not a bug, but the label/state mismatch (`state: command ? 'working' : 'idle'` is never restored, so it's always `idle`) can confuse the pulse indicator on first paint.

**Trigger:** Restore a multi-tab session, especially in `flow`/`stack` layout.

**Consequence:** Brief layout thrash and occasional wrong-pane focus after reopening a project; restored "agent" tabs show stale labels with no running agent.

**Fix:** In `restore`, create all tabs *without* per-tab activate/center (pass a flag to suppress), then do a single `setLayout` + `activateIndex` + one fit. Consider clearing/neutralizing the restored label so it doesn't imply a live agent.

**Confidence:** Medium. Cosmetic/perf, but the focus-race is user-visible.

---

## M6 — `cdInto` types ` cd … && clear\r` into every un-used running shell, including ones whose PTY hasn't drawn its first prompt yet

**File:** `src/renderer/terminals.js:1273-1281` (`cdInto`), called from `main.js:269` on every `setWorkspace`.

`cdInto` iterates sessions and, for any `status === 'running' && !used`, sends ` cd '<path>' && clear\r` via `api.term.input`. There's no check that the shell has finished starting up. The friendly-prompt refactor (`ipc-pty.js:47-85`) specifically moved prompt setup into rc files *to avoid racing the shell's startup output*, but `cdInto` reintroduces exactly that race from the renderer side: if `setWorkspace` runs while a freshly-created shell is still sourcing `.zshrc`, the injected `cd … && clear` can interleave with startup output (the same `%1~`→`clear1~` tearing the rc-file comment warns about).

The boot sequence (`main.js:411-439`) creates a terminal and *then* may call `setWorkspace`/`cdInto`; on the launch path the order is restore-first, but on "Open Folder" with a brand-new shell created seconds earlier, the race is live.

**Trigger:** Open a folder immediately after a new shell tab is created (or on first launch into a folder).

**Consequence:** Occasional garbled first line in the terminal; the `clear` may not run, leaving startup chrome on screen.

**Fix:** Either gate `cdInto` on having seen first output from the pane (you already track `lastOutputAt`/`streaming`), or pass the cwd into the PTY at spawn (the PTY already accepts `cwd` — `ipc-pty.js:137`) and skip live `cd` injection entirely for newly-created shells. The cleanest fix is: new shells spawn directly in the workspace root, so `cdInto` only handles *pre-existing* shells.

**Confidence:** Medium. Same class as the documented prompt race; intermittent.

---

## M7 — `api.term.onData`/`onExit` global IPC listeners are registered once but route by id with no per-window scoping in the renderer; a stale `term:data` for a destroyed pane silently no-ops (good) — but `term.create` is fire-and-forget so early input can be lost

**File:** `src/preload/index.js:84-91`, `src/renderer/terminals.js:707-718` (`onData` input), `:779-782` (preset command), `ipc-pty.js:97-154`.

`api.term.create(id, …)` is `ipcRenderer.send` (fire-and-forget, `preload:85`). The renderer immediately wires `term.onData` to forward keystrokes via `api.term.input(id, …)` (`:717`). If the user types (or the preset `command` setTimeout fires at `:781`, 500 ms later) before the main process has finished `pty.spawn` and registered the session in `terminals` Map, those `term:input` messages hit `ipcMain.on('term:input')` → `terminals.get(key)` → `undefined` → **dropped silently** (`ipc-pty.js:156-159`). The 500 ms delay before sending the preset command mitigates this, but it's a magic number, not a handshake.

**Trigger:** Very fast typing into a brand-new pane, or a slow `pty.spawn` (cold start, heavy shell rc).

**Consequence:** First keystrokes/preset command silently lost; the agent never receives its launch command and the pane just sits at a prompt.

**Fix:** Make `term:create` a `handle/invoke` that resolves once the PTY is spawned and registered, and have the renderer await it before enabling input / firing the preset command. Or queue input in main keyed by id until the PTY exists.

**Confidence:** Medium. The 500 ms guard usually covers it; cold starts and heavy rc files can exceed it.

---

## L1 — `applyGitStatus` ancestor roll-up loop can run unbounded on Windows-style mixed separators

**File:** `src/renderer/fileTree.js:188-197`.

```js
let dir = dirname(abs)
while (dir && dir.length >= root.length) {
  ...
  if (dir === root) break
  const parent = dirname(dir)
  if (parent === dir) break
  dir = parent
}
```

`dirname` (`:112-116`) returns `trimmed.slice(0, idx)` where `idx = max(lastIndexOf('/'), lastIndexOf('\\'))`. The `parent === dir` guard prevents an infinite loop, but `absOf` normalizes to forward slashes (`:140-143`) while `dirname` checks both separators — on a path that mixes them the `dir === root` comparison can miss (root normalized one way, `dir` another), so the loop walks to the `parent === dir` fixpoint instead of stopping at root, marking dirs above root. Cosmetic (extra dir badges), self-terminating.

**Trigger:** Windows paths with mixed separators (app targets macOS, so effectively unreachable today).

**Consequence:** Git roll-up badges painted on the wrong/extra folders. None on macOS.

**Fix:** Normalize `root` and `abs` to a single separator before the loop. Low priority given macOS target.

**Confidence:** Low / theoretical on macOS.

---

## L2 — Search regex with `useRegex` is built unescaped and can hang the main process on a catastrophic-backtracking pattern despite the per-line match cap

**File:** `src/main/ipc-search.js:39-44` (`buildRegex`), `:108-126` (per-line loop).

With `useRegex: true`, the user's pattern is used verbatim (`buildRegex`). The per-line loop caps matches at `MAX_MATCHES_PER_LINE` (50) and advances on zero-width matches (`:116`), but `regex.exec` itself can catastrophically backtrack on a single long line (e.g. `(a+)+$` against a long non-matching line) **before** ever producing a match — the cap counts matches, not exec time. That blocks the main process (search runs in main via `ipc-search.js`), freezing the whole app including all PTYs and IPC.

**Trigger:** User enables regex mode and types a pathological pattern; one long line in any scanned file triggers exponential backtracking.

**Consequence:** App-wide freeze (main process blocked) until the regex finishes or the user force-quits.

**Fix:** Run search in a worker/child process, or wrap with a time budget, or (cheapest) reject obviously-dangerous patterns and cap line length fed to `exec`. At minimum move search off the main thread so a runaway regex can't freeze PTYs.

**Confidence:** Medium-high that it can freeze; reproducible with a known evil pattern.

---

## L3 — `pulse:summarize` trusts `payload.id` for the in-flight key but the model schema requires `question` always present; a provider that omits it yields a verdict with empty fields applied as a blank label

**File:** `src/main/ipc-pulse.js:85-104` (`parseVerdict`), `:144-158` (claude `output_config`), `terminals.js:1195-1196`.

The Anthropic call uses `output_config: { format: { type: 'json_schema', schema: SCHEMA } }` with `SCHEMA.required = ['state','summary','question']`. **This shape is correct** per the current Claude API (`output_config.format`, not the deprecated `output_format`), and `claude-haiku-4-5` supports structured outputs — verified against the reference. `parseVerdict` tolerantly extracts the first `{…}` and validates `state` against `STATES`, defaulting `summary`/`question` to `''`. In the renderer, `const label = res.question ? ... : res.summary` and then `s.summaryText = label && label.trim() ? label.trim() : null` (`:1195-1196`) — so an empty summary/question correctly falls back to `null` (no blank label). This path is actually robust.

The one real gap: the **local OpenAI-compatible** provider uses `response_format: { type: 'json_object' }` (`ipc-pulse.js:191`) which many local servers ignore or partially honor; `parseVerdict` handles stray prose, but a model returning `{"state":"working"}` with no summary is accepted and yields a `null` label (fine). No bug — noting it because the dual-provider verdict shapes diverge and only the prompt enforces keys on the local path.

**Consequence:** None observed; included to record that the Anthropic SDK usage was checked and is correct, and the local-provider path degrades safely.

**Fix:** None required. Optionally validate `state` presence is enough (already done).

**Confidence:** High that the SDK call shape is correct and the empty-field path is safe.

---

## L4 — `emitFleet` rAF coalescing leaks a pending rAF if all sessions are destroyed before it runs (benign) and `onAwait` fires on bell even for the active pane's race

**File:** `src/renderer/terminals.js:549-562` (`emitFleet`), `:720-725` (`onBell`).

`emitFleet` schedules one rAF and clears `fleetRaf` inside it. If `destroy` empties `sessions` before the rAF fires, the callback still runs against an empty Map and emits `{ total: 0 }` — correct. The bell handler (`:720-725`) sets `attention = true` and `setState(s,'awaiting')`; `setState` only fires `onAwait` when `s.id !== activeId` (`:529`). A bell on the *active* pane sets state to awaiting but skips `onAwait` — intended. No bug; the residual nit is that a bell never clears even after the user interacts (only output→working clears it via `clearFlags`/onData), so a noisy program that rings the bell once leaves a sticky `awaiting` until it emits more output.

**Consequence:** A pane that bells once but is actually working can show `awaiting` until its next output settles.

**Fix:** Consider clearing `attention` on focus (currently `clearFlags` clears `attention` at `:565` on activate — so focusing does clear it). Likely fine.

**Confidence:** Low. Mostly a note.

---

## Cross-cutting themes

1. **Fire-and-forget IPC with no acknowledgement** (`term:create`, `term:input`, session save) creates ordering races: input before spawn (M7/H?), saves clobbering each other (M4). Moving the lifecycle-critical ones to `invoke`/`handle` with a queue removes a class of "silently lost" bugs.
2. **Errors swallowed into safe-looking defaults** that then drive destructive actions: editor read-error → empty buffer → save truncates (M3); git discard error → returns `true` (H5); these turn transient failures into data loss.
3. **Async verdict applied to a screen that has since changed** (H2) and **stale-DOM Map reconstruction** (C1) are the two genuine concurrency bugs that will mislabel/orphan panes under real agent load.
4. **No watcher recovery + no manual refresh** (H4) means the file tree silently goes stale on exactly the stress case the product targets (agents writing many files).
5. **Main-thread work that can block all PTYs** (L2 search regex; session read-modify-write) — anything CPU-bound or contended in main freezes the whole fleet.
6. **The Anthropic SDK integration is correct** (`output_config.format` + `claude-haiku-4-5`, key confined to main) — no findings there beyond cost-scaling (H3).

---

## Scaling to 100M users (desktop framing)

- **Per-user process/resource footprint dominates.** Each pane = 1 node-pty + 1 xterm + 1 ResizeObserver + scrollback (10k lines × N panes). The orphan-pane leak (C1) and never-restarted watcher (H4) directly inflate per-user RAM/descriptor counts over a long session — at fleet scale these become support tickets ("app got slow / stopped updating after hours"). Add a periodic self-audit that reconciles `sessions` against live PTYs and reaps orphans.
- **LLM cost is unbounded by pane count** (H3). At 100M users with Pulse on, summarize-per-pane-per-tick is a direct, linear API-spend liability and a 429 amplifier. Needs a hard per-user rate limit and a global concurrency cap before it ships broadly; prefer the free local provider as default.
- **Crash reporting / telemetry is absent.** Every `catch {}` in this codebase (editor read, git ops, fs ops, session writes) swallows silently — there's no Sentry/breadcrumb, so the data-loss paths (M3, M5, H5) would be invisible in production. Add structured error reporting (opt-in) before scale, specifically instrumenting the swallow sites.
- **Update safety:** session.json is a single shared file with last-writer-wins (M4); a bad write or schema change on upgrade can wipe all users' restore state. Move to per-root files with atomic write-rename and a schema version.
- **Offline behavior is fine** (Layer A pulse is deterministic/free; git/fs are local). The only network dependency (Anthropic) degrades to null — good.
- **Support burden:** the silent-failure pattern (no surfaced errors for read/save/watch) will generate "it didn't save / didn't update / lost my file" reports that are un-diagnosable without telemetry. Surfacing these to the user *and* to telemetry is the highest-leverage scaling investment.
