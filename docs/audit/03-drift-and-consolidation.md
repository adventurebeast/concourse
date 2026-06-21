# Audit 03 — Code Drift, Duplication, Dead Code & Consolidation

Scope: every file under `src/renderer/*`, `src/main/ipc-*.js`, and the supporting
main/preload modules. Read-only review. Each finding cites a file:line and a concrete fix.

Repo: `/Users/Admin/local_development/concourse` · Stack: Electron 33, ESM plain JS, no TypeScript.

---

## TL;DR — the highest-leverage items

1. **Dead feature: the fs-watcher refresh is never wired up.** `watcher.js` sends
   `fs:changed`, but no preload bridge exposes it and `main.js` never calls
   `fileTree.refresh()` on it. The whole "file tree stays in sync with on-disk changes"
   story is non-functional. (Finding D1 — confirmed.)
2. **Dead seam: `onAwait`.** `terminals.js` destructures, calls, and documents an
   `onAwait` hook that `main.js` never passes — the "notification/sound/badge on
   working→awaiting" North-Star seam is a no-op today. (Finding D2 — confirmed.)
3. **No IPC-client abstraction.** `const api = window.api` is re-declared in 8 renderer
   modules; the preload hand-maintains ~30 `ipcRenderer.invoke/send` wrappers; the main
   process repeats the `ipcMain.handle(name, async () => { try {…} catch { return fallback } })`
   shape ~25 times across `ipc-*.js`. One typed channel registry collapses all of it.
4. **Copy-pasted DOM/string helpers.** `escapeHtml` (×2 identical), `basename` (×3
   variants), `joinPath` (×2), shell-quote (×3), `STATUS_COLOR`/`STATUS_TITLE` (×2),
   and a near-identical collapsible "group with header + count + chevron" renderer in
   `search.js` and `git.js`.
5. **`setLayout` is listed twice in the `terminals.js` public return object** — a literal
   duplicate key. (Finding C1 — confirmed.)

---

## A. Dead / orphaned code (high confidence — these are bugs, not style)

### D1 — `fs:changed` watcher fires into the void; file tree never auto-refreshes
**Confidence: high.** `src/main/watcher.js:63` does
`win.webContents.send('fs:changed')` after debouncing on-disk changes. But:

- `src/preload/index.js` exposes **no** `fs.onChanged` / `onFsChanged` bridge (grep for
  `changed` in the preload returns nothing).
- `src/renderer/main.js` never subscribes to it, and `fileTree.refresh()` (which exists
  at `fileTree.js:344` and is even named in the watcher's own comment, `watcher.js:10`) is
  **never called** anywhere outside `fileTree.js` itself.

Net effect: the entire per-window recursive watcher — `createWatchers()`, the `IGNORED`
regex, the 150ms debounce, the `start`/`stop` lifecycle in `ipc-workspace.js` — runs and
costs an `fs.watch` handle per window but produces **zero** observable behavior. The tree
only updates after in-app mutations (which call `refresh()` directly from `fileTree.js`).

**Fix:** add to preload `fs`:
```js
onChanged: (cb) => ipcRenderer.on('fs:changed', () => cb())
```
and in `main.js` after `fileTree` is created:
```js
api.fs.onChanged?.(() => fileTree.refresh())
```
Confirms the watcher's documented purpose. This is the single most impactful fix in the audit.

### D2 — `onAwait` hook is dead wiring
**Confidence: high.** `terminals.js:25` destructures `onAwait` from its options;
`terminals.js:529` fires `onAwait?.(s)` on the working→awaiting edge; comments at
`terminals.js:523` and `:723` describe it as "the seam a notification/sound/badge
subscribes to." But the only call site, `main.js:95`, passes **only** `{ getRoot, onFleet }`.
Per MEMORY.md, "notify on the working→awaiting edge" is the product North Star — and the
seam built for it is unsubscribed. Either wire a subscriber in `main.js` or delete the
parameter; right now it is misleading dead surface.

### D3 — `attachCustomKeyEventHandler` Cmd+Backspace vs. global keybinding overlap
**Confidence: medium.** Not strictly dead, but note `editor.js:459` registers its own
`window` keydown for Cmd+S, `terminals.js:1243` registers its own `window` keydown for
Alt+Arrow, and `main.js:112` builds a *central* `createKeybindings()` registry whose stated
purpose (`keybindings.js:1-6`) is "every hotkey lives in a single place rather than being
scattered across modules." Three modules bypass it. The central registry is therefore only
"central" for the subset registered in `main.js`. Consolidation: route editor-save and
flow-cycle through `keys.register` too (the registry already supports per-handler veto via
return value), or document that module-local keys are intentional.

### D4 — `activate()` dead `if (activeKey === key)` block
**Confidence: high (cosmetic).** `editor.js:174-176`:
```js
if (activeKey === key) {
  // Still ensure focus/host correctness.
}
```
An empty `if` with only a comment — vestigial. Remove it (the function correctly re-runs
the focus/host logic below regardless).

### D5 — `fitActive` and `fitAll` are now identical aliases
**Confidence: high.** `terminals.js:1034-1039`: both `fitAll()` and `fitActive()` just call
`fitSoon()`. The header comment at `:1030` admits "Both now mean the same thing." They are
kept only for caller compatibility (`main.js` calls both). Collapse to one name and update
the ~4 call sites, or keep one as a documented alias rather than two full function bodies.

---

## B. Duplication (copy-paste that should be one shared module)

### Dup1 — `escapeHtml` defined twice, byte-identical
**Confidence: high.** `commandPalette.js:215` and `beginnerHud.js:87` are the **same**
function:
```js
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
```
**Fix:** add `export function escapeHtml` to a new `src/renderer/dom.js` (see Consolidation
map) and import in both. Two call sites collapse to one definition.

### Dup2 — `basename` reimplemented 3 ways
**Confidence: high.** Three different implementations of the same idea:
- `main.js:166` — `p.split('/').filter(Boolean).pop()` (POSIX-only, returns 'Concourse' fallback)
- `beginnerHud.js:22` — `String(p).replace(/[/\\]+$/, '').split(/[/\\]/)` (cross-platform)
- `fileTree.js:107` — identical to beginnerHud's (cross-platform)

Plus `editor.js:68` `baseName` (note the capital N — naming drift) does
`p.split(/[\\/]/).pop()`, and `welcome.js`/`statusbar.js` derive names too. **Fix:** one
exported `basename(p)` in a shared `paths.js`. Collapses ≥4 call sites and removes the
POSIX-only bug in `main.js` (a Windows path in the title bar would mis-split).

### Dup3 — shell single-quote escaping in 3 places, two of them identical
**Confidence: high.** Identical logic at:
- `terminals.js:181` `shellEscapePath` (bare-or-quote)
- `terminals.js:1275` `cdInto` inline `"'" + String(path).replace(/'/g, "'\\''") + "'"`
- `ipc-pty.js:32` `shq()` — same expression in the **main** process

The two renderer copies in the *same file* are especially egregious (`cdInto` could call
`shellEscapePath`). **Fix:** export `shquote()` once. The renderer pair can share immediately;
the main copy can share via a tiny `src/shared/` module since both processes are ESM.

### Dup4 — `STATUS_COLOR` + `STATUS_TITLE` git-status maps duplicated
**Confidence: high.** `git.js:6-21` and `fileTree.js:7-20` carry **identical**
`STATUS_COLOR` (M/A/U/D/R → color var) and `STATUS_TITLE` maps. `fileTree.js:22` adds
`STATUS_RANK`. The git status alphabet is itself defined a *third* time in the main process
(`ipc-git.js:12` `mapCode`). **Fix:** a shared `src/renderer/gitStatus.js` exporting
`STATUS_COLOR`, `STATUS_TITLE`, `STATUS_RANK`. Two large literal blocks collapse to one
import each. (The implicit M/A/U/D/R contract between main's `mapCode` and these two renderer
maps is exactly the kind of thing a shared constant — or a TS union — would lock down; today
adding a code in `mapCode` silently renders uncolored.)

### Dup5 — collapsible "group" renderer in `search.js` and `git.js`
**Confidence: high.** `search.js:125 makeGroup` and `git.js:170 makeGroup` build the same
widget: a `*-group` div, a `*-group-header` with a `›` chevron span, a title/name, a count
badge, a hidden-toggling list, and a header `click` handler that flips a collapsed flag and
toggles `.collapsed` + `list.hidden`. The class prefixes differ (`search-` vs `scm-`) and
the collapsed state store differs (`Set<path>` vs `{staged,changes}` object), but the DOM
shape and the toggle handler are line-for-line parallel (~25 lines each). **Fix:** a
`makeCollapsibleGroup({ title, count, collapsed, onToggle, classPrefix })` helper in
`dom.js`. Collapses ~50 lines to ~25 + two thin callers. This is the single largest
DOM-construction duplication in the renderer.

### Dup6 — relative-path → `{ name, dir }` split in 3 places
**Confidence: high.** `git.js:24 splitPath`, `ipc-search.js:128-136` (inline `lastIndexOf('/')`
→ name/dir), and `search.js` consumes the latter while `git.js` recomputes it. The
`norm = p.replace(/\\/g,'/'); idx = norm.lastIndexOf('/')` pattern recurs verbatim. **Fix:**
one `splitPath(rel)` shared by `git.js` and the search IPC (or have the search IPC stop
pre-splitting and let the renderer use the same `splitPath` git.js already has).

### Dup7 — `joinPath` defined twice
**Confidence: high.** `fileTree.js:117` (platform-aware separator) and `projectType.js:11`
(`dir.replace(/[/\\]+$/, '') + '/' + name`, POSIX-only). Two slightly different
implementations of the same name → naming/behavior drift. Consolidate into `paths.js`;
prefer the platform-aware version.

### Dup8 — auto-grow textarea logic duplicated
**Confidence: medium.** `search.js:36 autoGrow` (`Math.min(scrollHeight,120)`) and
`git.js:76 autoGrow` (`Math.min(scrollHeight,160)`) are the same two-line pattern with a
different cap. Minor, but a `autoGrow(el, max)` helper removes a third copy if more inputs
are added.

### Dup9 — `const api = window.api` boilerplate ×8
**Confidence: high (low individual severity).** Declared in git, terminals, fileTree,
welcome, main, editor, projectType, search. Harmless, but it is the symptom of "no shared
api module." When the IPC client wrapper below lands, these become `import { ipc } from './ipc.js'`.

### Dup10 — confirm/modal-overlay scaffolding repeated
**Confidence: medium.** Three hand-rolled modal overlays with near-identical structure
(overlay div + box + actions + Esc/Enter keydown + click-backdrop-to-dismiss + focus the
primary button):
- `terminals.js:268 confirmClose`
- `fileTree.js:642 confirmDelete`
- `git.js` init/clean hints are simpler, but the empty-hint + button pattern recurs in
  `git.js:225-262`, `fileTree.js:328-336`, `search.js:84`.

A `confirmDialog({ title, message, danger, confirmLabel })` returning a Promise<boolean>
would collapse `confirmClose` and `confirmDelete` (~45 lines each) into two ~5-line calls
and unify Esc/Enter/backdrop behavior (which currently differs subtly — `confirmClose`
focuses the danger button, `confirmDelete` also focuses it but wires keys differently).

### Dup11 — context-menu builder duplicated
**Confidence: medium.** `fileTree.js:565 openContextMenu` and `terminals.js:232 openTabMenu`
both: create a positioned floating menu, clamp to viewport, build items, and dismiss on
outside-mousedown. `fileTree`'s is data-driven (items array with `sep`/`danger`);
`terminals`' is hand-built. **Fix:** reuse fileTree's data-driven menu builder as a shared
`contextMenu(x, y, items)`. Collapses `openTabMenu` to a 2-item array.

---

## C. Inconsistent patterns & naming drift

### C1 — `setLayout` listed twice in the terminals public API
**Confidence: high.** `terminals.js:1297`:
```js
return { create, fitActive, fitAll, setLayout, setTheme, cdInto, typeIntoActive,
         stepActive, activateIndex, setLayout, cycleLayout, closeActive, getState, restore }
```
`setLayout` appears at position 4 **and** position 11. The second silently overwrites the
first (same reference, so no functional bug today) but it is a clear copy-paste slip and
will mislead anyone reading the surface. Remove the duplicate.

### C2 — IPC error-handling styles are inconsistent across handlers
**Confidence: high.** Three different contracts coexist:
- **`ipc-fs.js`**: mutations `throw` on failure; renderer is "responsible for surfacing"
  (`ipc-fs.js:21-22`). E.g. `fs:createFile` lets `wx` EEXIST propagate.
- **`ipc-git.js`**: every handler swallows and returns a sentinel (`return false`,
  `return { isRepo: false }`, `return { error: ... }`) — three *different* sentinel shapes
  within one file (`:80`, `:125`, `:185`).
- **`ipc-pulse.js` / `ipc-search.js`**: return `null` / `{ error: 'Invalid pattern' }`.

So a renderer caller can't know whether a given channel rejects or resolves-with-sentinel
without reading the handler. `git.js:288` and `fileTree.js:487` both wrap calls in
`try/catch` *and* check return values defensively — belt-and-suspenders precisely because
the contract is unclear. **Recommendation:** pick one convention (suggest: queries return
`{ ok, data, error }`, mutations `throw`) and document it at the top of a shared IPC module.
This is the most dangerous implicit contract in a no-types codebase.

### C3 — `baseName` vs `basename` naming drift
**Confidence: high.** `editor.js:68` exports `baseName` (camel hump on N); `fileTree.js:107`,
`beginnerHud.js:22` use `basename` (all lowercase); `main.js:166` `basename`. Same concept,
two spellings — a grep hazard. Standardize on `basename` when consolidating (Dup2).

### C4 — Two different DOM-creation idioms
**Confidence: medium.** The codebase mixes:
- **`innerHTML` template strings** with interpolation: `commandPalette.js:70-82, 111-116`,
  `beginnerHud.js:43-64`, `statusbar.js`, `main.js:25`.
- **Imperative `document.createElement`** chains: `git.js`, `fileTree.js`, `search.js`,
  `welcome.js`, most of `terminals.js`.

Both appear within single files (e.g. `terminals.js` uses `innerHTML` for icons at `:596`
but `createElement` for everything structural). This forces every `innerHTML` path to carry
its own `escapeHtml` (hence Dup1) while the `createElement` paths are inherently safe. A tiny
`el(tag, props, ...children)` helper (hyperscript-style) would unify the imperative paths and
remove the escaping burden from the template paths. Lists ~30 `createElement` blocks that
could each shrink 3–5x.

### C5 — Mixed async idioms for the same job
**Confidence: medium.** Status fetching: `git.js:288 refresh` uses `async/await + try/catch`;
`terminals.js:931 refreshBranch` uses `.then/.catch/.finally` promise chains; `statusbar.js:18`
uses `.then/.catch`. `welcome.js:22` uses `async/await`. Not wrong, but four styles for
"call an IPC method, tolerate failure" — a shared `ipc.safe(channel, ...args)` that returns
`[data, err]` or a fallback would normalize this and remove the per-call-site try/catch noise.

### C6 — `git.js` reaches across module boundaries via global DOM IDs
**Confidence: medium.** `git.js:212 setBranch` does
`document.getElementById('status-branch')` and writes the status bar branch — but
`statusbar.js` *also* owns the status bar and has its own `setGit`. So the status-bar branch
is written by `git.js` while the change-counts are written by `statusbar.js` (`statusbar.js:37`).
Ownership of one widget is split across two modules. Similarly `git.js:233` and
`fileTree.js:333` both do `document.getElementById('open-folder').click()` to trigger the
toolbar button from inside a panel — coupling panels to a specific button ID rather than a
passed-in callback (which `git.js` *does* accept for `onOpenDiff`/`onStatus`, just not here).
Consolidate: have `git.refresh` hand the branch to `statusbar.setGit` (it already passes the
full status to `onStatus` → `statusbar.setGit`, so `setBranch` is redundant plumbing).

### C7 — IPC channel-style inconsistency: `invoke` vs `send`
**Confidence: low (informational).** Most channels use request/response `invoke`; `term:*`
and `window:open`/`menu:command` use fire-and-forget `send`. That's a reasonable split
(streaming PTY data can't be `invoke`d), but there's no naming convention marking which is
which — `workspace:open` invokes, `window:open` sends, and the names give no hint. A typed
channel registry (below) would make the request/event split explicit.

---

## D. Missing abstraction / type-safety (proposed shared layers)

The codebase is plain ESM JS with **no** types, so every IPC payload shape is an implicit,
unenforced contract. The most dangerous ones:

1. **The git-status object** (`{ isRepo, noFolder, branch, ahead, behind, staged[], changes[] }`)
   is produced in `ipc-git.js:71`, consumed in `git.js`, `fileTree.js:175 applyGitStatus`,
   `statusbar.js:37`, `beginnerHud.js:80`, and `terminals.js:937`. Six readers, zero schema.
   `statusbar.js:73` reads `fleet.counts`/`fleet.total`; `terminals.js:560` produces it.
2. **The pulse verdict** `{ state, summary, question }` — schema *does* exist for the model
   (`ipc-pulse.js:28 SCHEMA`) but not for the IPC boundary back to the renderer.
3. **The session blob** (`main.js:307 gatherSession` ↔ `main.js:344 restoreSession` ↔
   `terminals.js:789 getState`/`:797 restore` ↔ `editor.js:444 listOpenFiles`) — a deeply
   nested shape passed through `session.js` as opaque JSON.

**Proposed shared layer (small, high-leverage):**

- **`src/preload/channels.js` + `src/renderer/ipc.js`** — a single source of truth for
  channel names and a thin client. Today the preload (`preload/index.js`) hand-writes ~30
  wrappers and the renderer calls `window.api.git.status()` etc. A channel registry collapses
  the preload to a generated map and gives one `ipc.invoke('git:status')` / `ipc.on('term:data', cb)`
  entry point. **Call sites it collapses:** all 8 `const api = window.api`, all
  `try { await api.X } catch` pairs (Dup9, C5), and makes C2's error contract enforceable in
  one place.
- **`src/renderer/dom.js`** — `escapeHtml`, `el(tag, props, ...kids)`, `makeCollapsibleGroup`,
  `confirmDialog`, `contextMenu`, `autoGrow`. Collapses Dup1, Dup5, Dup8, Dup10, Dup11, C4.
- **`src/renderer/paths.js`** — `basename`, `dirname`, `joinPath`, `splitPath`, `shquote`,
  `prettyDir`. Collapses Dup2, Dup3, Dup6, Dup7, C3.
- **`src/renderer/gitStatus.js`** — `STATUS_COLOR`, `STATUS_TITLE`, `STATUS_RANK`. Collapses Dup4.

Even without TypeScript, a single JSDoc `@typedef` block per shared shape (GitStatus,
PulseVerdict, SessionBlob) on these modules gives editor-level checking and one place to read
the contract.

---

## E. Consolidation map (concrete merge / extract / delete)

| Action | What | Where | Collapses |
|---|---|---|---|
| **DELETE** | duplicate `setLayout` key | `terminals.js:1297` | C1 |
| **DELETE** | empty `if (activeKey === key) {}` | `editor.js:174-176` | D4 |
| **WIRE** | `fs:changed` → preload bridge → `fileTree.refresh()` | `preload/index.js:46`, `main.js:~107` | D1 |
| **WIRE or DELETE** | `onAwait` subscriber (notification seam) | `main.js:95` ↔ `terminals.js:529` | D2 |
| **MERGE** | `fitActive`/`fitAll` → one fn | `terminals.js:1034-1039` | D5 |
| **EXTRACT** | `escapeHtml` → `dom.js` | `commandPalette.js:215`, `beginnerHud.js:87` | Dup1 |
| **EXTRACT** | `basename`/`baseName` → `paths.js` | main:166, beginnerHud:22, fileTree:107, editor:68 | Dup2, C3 |
| **EXTRACT** | `shquote` → shared | terminals:181, terminals:1275, ipc-pty:32 | Dup3 |
| **EXTRACT** | git-status maps → `gitStatus.js` | git.js:6-21, fileTree.js:7-22 | Dup4 |
| **EXTRACT** | `makeCollapsibleGroup` → `dom.js` | search.js:125, git.js:170 | Dup5 |
| **EXTRACT** | `splitPath` → `paths.js` | git.js:24, ipc-search.js:128 | Dup6 |
| **EXTRACT** | `joinPath` → `paths.js` | fileTree.js:117, projectType.js:11 | Dup7 |
| **EXTRACT** | `confirmDialog` → `dom.js` | terminals.js:268, fileTree.js:642 | Dup10 |
| **EXTRACT** | `contextMenu` → `dom.js` | fileTree.js:565, terminals.js:232 | Dup11 |
| **MERGE** | status-bar branch ownership into statusbar | git.js:212 → statusbar.setGit | C6 |
| **INTRODUCE** | IPC client + channel registry | preload + new `ipc.js` | Dup9, C2, C5, C7 |

Quantified: the four proposed shared modules remove roughly **9 duplicated helpers**, **~120
lines of copy-pasted DOM construction** (Dup5 + Dup10 + Dup11), and the preload's ~30
hand-written wrappers, while giving one enforceable home for the GitStatus / PulseVerdict /
SessionBlob contracts.

---

## F. Scaling to 100M users (desktop framing)

For a desktop Electron app, "scale" = distribution/update safety, per-user resource footprint,
crash/error visibility, and support burden. Drift findings that bite at scale:

- **No crash/error telemetry.** Every failure path swallows silently: `ipc-git.js` catches →
  sentinel, `session.js:28`/`recents.js:25` "best-effort" silent writes, `ipc-pulse.js:255`
  `console.log` only, `editor.js:414`/`:421` empty catches. At 100M users you have **zero**
  signal when `fs.writeFile` of `session.json` starts failing on a class of machines, or when
  the Anthropic SDK lazy-import (`ipc-pulse.js:128`) fails for a cohort. The inconsistent error
  contract (C2) makes adding telemetry an N-place change rather than one wrapper. **Fix order:**
  unify the IPC error layer (D-section) *first*, then a single `reportError()` seam.
- **Per-user process footprint is unbounded.** Each terminal is a real `pty.spawn`
  (`ipc-pty.js:131`) keyed per window (`tkey`), scrollback 10000 lines per xterm
  (`terminals.js:650`), plus Monaco's 5 web workers (`editor.js:9-17`) per window, plus an
  `fs.watch(recursive)` handle per window (`watcher.js:49`) **that currently does nothing**
  (D1). A power user with 20 panes × 2 windows is a lot of native processes; there's no cap or
  back-pressure. The dead watcher (D1) is pure footprint with no payoff — fixing or removing it
  is a footprint win either way.
- **Update safety / session corruption blast radius.** `session.js` stores *all* roots'
  blobs in one `session.json`; a corrupt write (no atomic temp-file-rename — `session.js:27`
  writes in place) loses every workspace's layout, not one. The dirty-check + 4s interval +
  `beforeunload` save (`main.js:338-341`) writes the whole file repeatedly. At scale, atomic
  writes (`write tmp → rename`) and per-root files de-risk the auto-update + crash combination.
- **Pulse cost at scale.** With an Anthropic key, every quiet/awaiting pane fires Haiku calls
  on a 2s tick (`terminals.js:1207`). The hash guard (`terminals.js:1168`) and per-pane
  in-flight guard (`ipc-pulse.js:247`) bound it well *per pane*, but there's no global rate
  limit across panes/windows — 20 active agents = 20 concurrent model calls. A shared token
  bucket in `registerPulse` would protect both the user's bill and Anthropic rate limits.
- **Licensing/auth/billing backend: absent.** Pulse Layer B is the only cloud dependency and
  it reads `ANTHROPIC_API_KEY` from the *user's* env (`ipc-pulse.js:211`). There is no app-level
  auth/billing surface — fine for a dev tool, but the "100M users" framing implies a managed
  key path; today there is no seam for it (the provider factory at `ipc-pulse.js:209` is the
  natural insertion point and is cleanly isolated, which is good).

Net: the code is well-commented and the per-pane guards are thoughtful, but the **silent-error
posture** (no telemetry, inconsistent swallow contracts) and the **dead watcher footprint** are
the two themes that convert directly into support burden at scale. Fix the IPC error/telemetry
layer and D1 first.
