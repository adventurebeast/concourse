# Concourse — Product Readiness Plan (Road to Public 1.0)

> **Companion to [`PLAN.md`](PLAN.md), not a replacement.** `PLAN.md` is the *engineering hardening*
> backlog (reliability, security, persistence, Pulse cost — the five PRs from the audit). This document
> covers the layer that backlog deliberately omits: the **user-facing product completeness** that turns
> "the author's working build" into "an app a stranger can download, set up, and trust" — plus the
> **distribution/operations epics** that a *public* 1.0 specifically requires.
>
> **Target chosen:** **Public 1.0** (anyone can download and use it, including non-technical users). That
> sets the full bar — settings UI, in-app API-key flow, onboarding, signing/notarization, auto-update,
> crash reporting, and consent-gated telemetry are all in scope.
>
> Style matches `PLAN.md`: every step lists Files · Change · Verify · Effort, with file:line targets the
> planners confirmed against the actual source.

---

## State of the tree (read this first — it differs from `RESUME.md`)

`RESUME.md` describes "Wave 1 applied, uncommitted." The working tree has since moved **well past** that.
Confirmed already-landed (so this plan does **not** re-recommend them):

- **Persistence is already hardened** — `src/main/store-io.js` exists (atomic tmp+fsync+rename, serialized
  `enqueue()`, `flushSync()`); `main/index.js:127` wires `flushSync()` into `before-quit`; `renderer/main.js`
  has session `version`+`migrateSession()` (`:316-384`), `saveSync` beforeunload (`:369-371`), and a
  visibility-gated save timer (`:356-365`).
- **Pulse cost work is largely in** — `ipc-pulse.js` has prompt-cache `cache_control` (`:163`), `TAIL_MAX=2500`
  (`:69`), a global concurrency semaphore `MAX_CONCURRENT=3` with stale-drop (`:237-280`), and a
  `pulse:status` handler returning `{enabled, provider, model, reachable}` (`:289-304`).
- **Live file tree is wired** — `api.fs.onChanged` → `fileTree.refresh()`+`git.refresh()` (`renderer/main.js:93-96`);
  watcher status channel exists (`preload:61`); Refresh button present (`index.html:44`).

**What this means:** the remaining gap to 1.0 is **mostly product surface + distribution**, not core plumbing.
Two seams are notably *built but unconsumed*:

- `pulse:status` (provider/model/reachable) — exposed in preload (`:112`) but **no renderer caller** → no Pulse
  status badge anywhere in the UI. (PR-B6 below.)
- The North-Star `onAwait` working→awaiting notification — still the open product decision from `PLAN.md` PR-1b.
  Listed here too (PR-D) because the *user-facing* half (sound/OS-notification/badge) is product work.

> ⚠️ The working tree is **uncommitted and unverified** (no app launch since these changes, per the
> no-build-without-permission gate). **Commit + verify the current tree before starting any PR below** — every
> PR here edits files that already carry unverified changes.

---

## The three gates to 1.0

| Gate | Question it answers | Where it's covered | State |
|------|---------------------|--------------------|-------|
| **A — Distribution & trust** | Can a stranger install, launch, and stay updated? | This doc, §"Distribution & Ops epics" | ❌ not started |
| **B — Won't lose data / silently break** | Will it corrupt or frustrate users? | `PLAN.md` (mostly landed; see above) | 🟡 code in tree, unverified |
| **C — Feels like a finished product** | Does it behave like 1.0? (settings, errors, help, onboarding) | **This doc, PR-A…PR-F** | ❌ not started |

This plan owns **Gate C in full** and **scopes Gate A** (the latter as infra epics, not quick code fixes).

---

## ⚠️ Product decisions needed before coding

These are human/product calls that change the work. Resolve before the affected PR.

| Decision | Affects | Recommendation |
|----------|---------|----------------|
| **Where is the API key stored?** plaintext `settings.json` vs OS keychain (`safeStorage`) | PR-B | **`safeStorage`** (Keychain-backed, encrypted at rest). Key still lives only in main; renderer sends it once over IPC and never reads it back. A plaintext key in userData is a 1.0 no-go. |
| **Settings UI shape** — in-app modal/overlay vs a dedicated BrowserWindow | PR-A | **In-app overlay** (like `#welcome-overlay`) — reuses CSS, no second window/IPC surface, matches the app's single-window-per-workspace model. |
| **Can Pulse provider/model change at runtime, or only on restart?** | PR-B | **Runtime** — `createProvider()` currently runs once at `registerPulse()`. Refactor to read from the config store on each settings-save (re-instantiate provider). Restart-only is a worse UX and invites "why isn't my key working" support tickets. |
| **What does "awaiting" *do*?** (the North Star) | PR-D | Quiet in-app tab/title badge + **optional** sound; OS `Notification` behind a settings toggle (default on for unfocused window). Mirrors `PLAN.md` PR-1b. |
| **Keybinding customization for 1.0?** full rebind UI vs view-only cheatsheet | PR-D vs later | **Cheatsheet for 1.0** (cheap, high value); full rebinding + a `keybindings.json` is post-1.0. Don't block launch on a rebind editor. |
| **First-run onboarding depth** — single API-key/Pulse step vs multi-screen tour | PR-E | **Single optional step** (set up Pulse now or skip → env/Layer-A still work). A heavy tour reads as bloat for a "stupidly simple IDE." |
| **Telemetry: opt-in or opt-out?** | Ops epic | **Opt-in** with a clear first-run prompt (GDPR/CCPA-safe). Opt-out is legally riskier for a public launch. |

---

## Effort roll-up (product layer)

| PR | Workstream | Effort |
|----|-----------|--------|
| PR-A | Settings substrate (config store + IPC + Preferences overlay) | 2–3d |
| PR-B | In-app API-key + Pulse provider config + status badge | 2–3d |
| PR-C | Error/feedback surface (toasts + dialogs + degraded states) | 2d |
| PR-D | Menus: Preferences/Help/About/Check-for-Updates + North-Star notify | 1.5–2d |
| PR-E | First-run / onboarding | 2–3d |
| PR-F | Window-state + accessibility polish (bounds, zoom, fonts, drag-folder) | 1.5–2d |
| | **Product layer total** | **~11–15d** |

Distribution/Ops epics (Gate A + telemetry + flags + CI) are **separate** and partly calendar-bound (Apple
enrollment, cert issuance, update-feed hosting) — scoped at the end, not in the day count above.

---

# PR-A — Settings substrate + Preferences UI

**Goal:** stand up the thing that doesn't exist at all today — a persisted user-settings store and a place to
edit it. Everything user-configurable is currently hardcoded, env-var'd, or split across two localStorage keys
(`concourse-theme`, `concourse-mode` in `renderer/main.js:222,246`). This PR builds the **substrate**; PR-B/PR-F
fill it with controls. **Effort:** 2–3d.

| # | Step | Files | Change | Verify | Effort |
|---|------|-------|--------|--------|--------|
| 1 | Main-process config store | `src/main/config.js` (new) | `getConfig()/setConfig(patch)` over `userData/settings.json`, reusing `store-io.js` (`writeJsonAtomic`+`enqueue`+`trackPending`). Versioned (`{version:1, …}`) with a `migrate()` seam, mirroring the session schema | 50 concurrent writes + kill mid-write → file always valid; defaults returned when absent | 3h |
| 2 | Config IPC + preload api | `src/main/ipc-config.js` (new), `main/index.js:97-100`, `preload/index.js:36` | `config:get`/`config:set` handlers (register in `index.js` next to the others); expose `api.config = { get, set, onChange }`. `config:set` broadcasts `config:changed` to all windows so multi-window stays in sync | `window.api.config.get()` returns defaults; set persists; a 2nd window sees `onChange` | 2h |
| 3 | Migrate the 2 localStorage prefs into config | `renderer/main.js:222-239, 246-268` | Move theme + mode out of `localStorage` into `api.config` (keep the same `applyTheme`/`applyMode` behavior + `<html data-theme/data-mode>`). One-time read-localStorage-then-migrate so existing users keep their choice | Theme/mode persist across restart via settings.json; old localStorage value imported once | 2h |
| 4 | Preferences overlay shell | `index.html:122-144` (sibling overlay), `src/renderer/settings.js` (new), `settings.css` (new) | A `#settings-overlay` modeled on `#welcome-overlay`: left nav (General · Pulse · Editor & Terminal · Keyboard · About) + a content pane. Open/close, Esc-to-close, click-outside. Sections are filled by later PRs | Opens over the workbench, Esc/click-out closes, no layout shift | 4h |
| 5 | Wire entry points | `index.html:19-26` (titlebar gear btn), `menu.js` (PR-D), `renderer/main.js:293-297` | Add a `settings` gear `.title-btn` to `titlebar-right`; route `menu:command === 'settings'` and the gear click to `settings.open()`. Bind `mod+,` in `keybindings`/`main.js:120-156` | Gear + ⌘, + (PR-D) menu all open Preferences | 1.5h |
| 6 | General section: theme + mode + reset | `settings.js`, reuse `applyTheme/applyMode` | Move the titlebar theme/mode toggles' authority here (keep the toolbar toggles as shortcuts that call the same fns); add "Reset to defaults" | Toggling in Preferences updates the workbench live and persists | 2h |

**Top risks:** config store must be the **single source of truth** — don't leave a second localStorage writer
that drifts. Multi-window `config:changed` broadcast must not loop (set-from-broadcast must not re-emit). Keep
`applyTheme/applyMode` as the one apply-path so the titlebar toggles and Preferences never disagree.
**Open Qs:** overlay vs separate window (recommend overlay); do per-workspace settings exist or only global (1.0 = global).

---

# PR-B — In-app API key + Pulse provider configuration

**Goal:** make the headline feature reachable by a non-technical user. **Today Pulse Layer B is
environment-variable-only** (`ipc-pulse.js:226-230` reads `process.env` once at startup) — a user with no shell
knowledge literally cannot turn on Claude/Ollama summaries, and there is **no UI** showing whether Pulse is even
active. This PR adds the settings-driven provider + the long-missing status badge. **Effort:** 2–3d.
**Depends on:** PR-A (config store).

| # | Step | Files | Change | Verify | Effort |
|---|------|-------|--------|--------|--------|
| 1 | Secure key storage in main | `ipc-config.js`/`config.js`, new `pulse:setKey` in `ipc-pulse.js` | Store the Anthropic key via Electron `safeStorage.encryptString` → an opaque blob in settings.json (never plaintext). **Renderer sends the key once; main never returns it** — only a `hasKey:boolean`. Preserves the existing "key lives only in main" invariant (`ipc-pulse.js:16-18`) | Key set from UI → encrypted blob on disk, not readable; `get` exposes only `hasKey` | 3h |
| 2 | Config-driven provider selection | `ipc-pulse.js:226-230, 282-287` | `createProvider()` reads config (provider · model · baseUrl · decrypted key) with **env vars as fallback** (back-compat). Hoist the captured `provider` in `registerPulse` behind a `getProvider()` that rebuilds on config change | Setting provider=claude+key in UI enables Pulse with no env vars and no restart | 3h |
| 3 | Runtime re-init on settings change | `ipc-pulse.js`, `config:changed` listener | On a Pulse-settings change, rebuild the provider (clear the memoized `clientPromise`); in-flight summaries finish on the old one | Switch claude→local in UI → next tick summaries hit the new backend | 2h |
| 4 | Pulse settings section (UI) | `settings.js`, `settings.css` | Pulse pane: enable toggle · provider radio (Off / Claude / Local OpenAI-compatible) · model field (placeholder = current default) · API-key field (write-only, shows "•••• set" once `hasKey`) · base-URL field for local · a **"Test connection"** button calling `pulse:status.reachable` | Enter key → "reachable ✓"; bad key → clear error; toggle off → Layer A only | 4h |
| 5 | First-class "clear key" + provider reset | `settings.js`, `ipc-pulse.js` | A "Remove key" action that deletes the encrypted blob; switching to Off tears down the provider | Remove key → `hasKey:false`, Pulse disabled, no leftover blob | 1h |
| 6 | **Pulse status badge (wire the dead seam)** | `statusbar.js:18-25, 109`, `index.html:154-158`, `renderer/main.js` | Consume the already-built `api.pulse.status()` — add a `#status-pulse` item (mirror the version-badge pattern at `statusbar.js:18-25`): "Pulse: Claude · Haiku ✓" / "Local · llama3.2 ⚠ unreachable" / "Pulse off". Click → opens Preferences ▸ Pulse. Refresh on `config:changed` | Badge reflects provider/model/reachability; updates live when settings change | 3h |

**Top risks:** `safeStorage` returns false for `isEncryptionAvailable()` on some Linux setups — fall back to a
clearly-labeled obfuscated-but-not-secure store *or* refuse and tell the user (don't silently plaintext a key).
The provider rebuild must not race in-flight summaries (let them drain on the old client). Keep env vars working
so existing power-users aren't broken. **Open Qs:** keychain vs DPAPI parity on Windows; show token/cost usage in
the badge (defer — needs the telemetry/metering work).

---

# PR-C — Error & feedback surface

**Goal:** stop failing silently. Today there is **no user-visible error channel** — git commit/save/fs failures,
an unreachable Pulse endpoint, a degraded file-watcher, and PTY spawn failures all go to console only (invisible
in a packaged build). For a public app this is both a trust problem and a support-cost problem. **Effort:** 2d.

| # | Step | Files | Change | Verify | Effort |
|---|------|-------|--------|--------|--------|
| 1 | Toast primitive | `src/renderer/toast.js` (new), `toast.css` (new), `index.html` (host node) | `toast.show(msg, {kind:'info'|'success'|'error', action?})` — non-blocking, auto-dismiss, stacked, accessible (`role="status"`/`aria-live`). One host element appended in `main.js` | `toast.show('Saved','success')` appears + auto-dismisses; errors persist until dismissed | 3h |
| 2 | Surface git failures | `renderer/git.js` (commit/stage/discard/init paths) | The current silent `try/catch` (per audit C1, `git.js`) → `toast` on failure ("Commit failed: …"), success confirmation on commit | Commit with nothing staged / in a non-repo → clear toast, not a console-only no-op | 2h |
| 3 | Surface file + editor failures | `editor.js` (save/open), `renderer/main.js` openFile callers | Save error → error toast (pairs with the `PLAN.md` PR-1 read-only-on-error gate); open of a binary → an info toast ("Opened read-only — binary file") | Trigger a save failure → toast; open an image → toast + no corruption | 2h |
| 4 | Watcher-degraded indicator | `renderer/main.js` (`api.fs.onWatchStatus`), `fileTree.js`/`index.html` explorer header | Consume the already-exposed `onWatchStatus` (`preload:61`): when `degraded`, show a subtle "File changes may be stale — Refresh" affordance in the Explorer header (the Refresh button already exists at `index.html:44`) | Force a watcher error → indicator shows; Refresh recovers; back to `watching` clears it | 2h |
| 5 | Pulse-unreachable feedback | `statusbar.js` (PR-B6 badge), `terminals.js` pulse path | When a configured provider goes unreachable, the badge flips to ⚠ (PR-B6) and a **one-time** toast explains "Pulse can't reach <provider> — falling back to basic detection." Don't toast every tick | Kill the local endpoint → one toast + badge ⚠, Layer A keeps working, no toast spam | 1.5h |
| 6 | Empty-state copy | `index.html` search/scm panels, `search.js` | "No results" for an empty search (today blank); a hint in an empty SCM panel ("No changes" / "Not a git repo — Initialize?") | Search a nonsense string → "No results"; open a non-repo → friendly SCM empty state | 1.5h |

**Top risks:** toast spam — rate-limit/coalesce repeated identical errors (especially the per-tick Pulse path).
Keep toasts off the hot render path. **Open Qs:** do destructive failures (discard) warrant a modal vs a toast
(recommend modal for confirmation, toast for result).

---

# PR-D — Menus, About, Help, Check-for-Updates + North-Star notify

**Goal:** fill the standard-menu gaps a Mac/Windows user expects, and ship the user-facing half of the North-Star
notification. The current menu (`menu.js:26-82`) has **no Preferences, no Help, no About, no Check-for-Updates**.
**Effort:** 1.5–2d. **Depends on:** PR-A (Preferences), and the updater epic for the *functional* update check.

| # | Step | Files | Change | Verify | Effort |
|---|------|-------|--------|--------|--------|
| 1 | Preferences menu item (⌘,) | `menu.js:74` (appMenu) / a `settings` command | On mac, inject a `Preferences…` item into the app menu (or a top-level item elsewhere) forwarding `menu:command:'settings'` (PR-A5). Standard `CmdOrCtrl+,` accelerator | ⌘, and the menu item open Preferences | 1h |
| 2 | Help menu | `menu.js:73-79` (template) | New `Help` submenu: Documentation (opens external — `setWindowOpenHandler` already routes external, `index.js:68`), Report an Issue (GitHub issues URL), Keyboard Shortcuts (opens Preferences ▸ Keyboard cheatsheet), Check for Updates… | Help menu present on all platforms; links open in the browser | 1.5h |
| 3 | About Concourse | `menu.js`, new `about` command or native `dialog` | Custom About: name, **version** (`app.getVersion()`, already wired at `index.js:105`), a one-line description, links (site/license). Native `dialog.showMessageBox` is the cheap path; an in-app pane in Preferences ▸ About is the polished one | About shows the running build version + links | 2h |
| 4 | Keyboard cheatsheet (Preferences ▸ Keyboard) | `settings.js`, derive from `renderer/main.js:120-156` | Render the existing hardcoded bindings as a read-only reference table (no rebinding for 1.0 per the decision). Single source: export the binding list so the cheatsheet can't drift from the registrations | Cheatsheet lists every shortcut; matches actual behavior | 2.5h |
| 5 | Check-for-Updates wiring | `menu.js`, main (updater epic) | The menu item calls into `electron-updater` (built in the Gate-A epic): "Up to date" / "Downloading…" / "Restart to update". Until the updater lands, ship the item **disabled** or hidden behind dev — don't ship a dead button | With updater present: manual check reports status; without: item not shipped | 1h |
| 6 | **North-Star: working→awaiting notify (user half)** | `renderer/main.js:104-108`, `statusbar.js`, `terminals.js:25,529` (consume only) | Pass an `onAwait` consumer into `createTerminals`: quiet tab/title badge + **optional** sound + OS `Notification` behind a settings toggle (PR-A). Fire only on the edge, only for unfocused panes. **Don't** change the firing logic — just consume it. This is `PLAN.md` PR-1b's product half | Unfocused pane going working→awaiting fires once; active pane never does; toggle silences it | 3h |

**Top risks:** a dead "Check for Updates" button is worse than none — gate it on the updater existing. North-Star
default must be **quiet** (badge on, sound/OS-notify opt-in) or it reads as noisy. The cheatsheet must derive from
the real registrations, not a hand-copied list (it will drift). **Open Qs:** About as native dialog vs in-app pane;
notification sound asset.

---

# PR-E — First-run / onboarding

**Goal:** orient a brand-new user and offer the one setup step that matters (Pulse). Today first launch goes
straight to `#welcome-overlay` (`index.html:122-144`, `welcome.js`) — a folder picker with no explanation of what
Concourse is, no API-key path, and no first-run flag. **Effort:** 2–3d. **Depends on:** PR-A (config store for the
"seen onboarding" flag) and PR-B (the Pulse setup step).

| # | Step | Files | Change | Verify | Effort |
|---|------|-------|--------|--------|--------|
| 1 | First-run detection | `config.js`/`ipc-config.js`, `renderer/main.js:450-484` (boot) | A persisted `onboardedAt` in the config store; absent → run onboarding before/over the welcome screen | Fresh userData → onboarding shows once; subsequent launches skip it | 1.5h |
| 2 | Onboarding overlay | `src/renderer/onboarding.js` (new), `onboarding.css`, `index.html` | A short, **skippable** overlay: (a) one-line "what Concourse is" + the Beginner/Expert choice (writes `data-mode`), (b) **optional** Pulse setup reusing the PR-B controls (provider + key, or "Skip — set up later"), (c) "Open a folder" → hands off to the existing welcome flow | Walk it once → mode set, Pulse optionally configured, lands on folder picker | 4h |
| 3 | Make the welcome screen self-explanatory | `welcome.js`, `index.html:122-144` | Add a one-line "what is this" under the tagline + a small "Preferences" and "Docs" affordance, so even users who skipped onboarding aren't lost | Welcome screen communicates purpose + a path to settings/help | 2h |
| 4 | Project-load progress feedback | `renderer/main.js:271-282` (`setWorkspace`), `fileTree.load` | A lightweight loading state while a large tree scans (today silent) — spinner/skeleton in the Explorer, cleared on first paint | Opening a huge repo shows progress, not a frozen-looking blank tree | 2h |
| 5 | Re-run onboarding from Help | `menu.js` Help, `onboarding.js` | "Setup / Getting Started" in Help re-opens onboarding (useful after the fact) | Help ▸ Getting Started replays the flow | 1h |

**Top risks:** onboarding must be **fast and skippable** — for a "stupidly simple IDE," a multi-screen tour is
anti-brand. Don't block reaching the workbench on completing it. The Pulse step must degrade gracefully (skip →
Layer A still works). **Open Qs:** single optional step vs 3-card tour (recommend single); collect telemetry consent
here vs separately (recommend here, as its own explicit prompt).

---

# PR-F — Window-state & accessibility polish

**Goal:** the small "it remembers me / I can make it readable" details that separate 1.0 from a prototype. Today
window size/position reset every launch (`index.js:31-35` hardcodes 1400×900), zoom isn't persisted, and editor/
terminal fonts are hardcoded (`editor.js` ~`fontSize:13`, `terminals.js` ~`fontFamily`/`fontSize:12.5`).
**Effort:** 1.5–2d. **Depends on:** PR-A (config store).

| # | Step | Files | Change | Verify | Effort |
|---|------|-------|--------|--------|--------|
| 1 | Persist + restore window bounds | `index.js:30-43, 72-78`, `config.js` | Save `win.getBounds()` on move/resize (debounced) + on close; restore on `createWindow` (clamp to a visible display). Keep the 1400×900 default for true first run | Resize/move, quit, relaunch → window reappears where it was; off-screen clamps back on | 2.5h |
| 2 | Persist zoom level | `renderer/main.js`/`menu.js` zoom roles, `config.js` | Store the webContents zoom factor in config; reapply on boot (the View ▸ Zoom roles exist at `menu.js:53-56`) | Zoom in, restart → zoom retained | 1.5h |
| 3 | Editor & Terminal font settings | `settings.js`, `editor.js` (fontSize/fontFamily), `terminals.js:~693` (font), config | Preferences ▸ Editor & Terminal: font family + size sliders driving `editor.setFont`/`term.options.fontSize`+`fontFamily` live; persisted. Also expose terminal scrollback (the `PLAN.md` PR-4 adaptive-scrollback default) | Change size → both editor and terminals reflow live and persist | 4h |
| 4 | Drag-a-folder-to-open | `renderer/main.js`, `preload pathForFile` (`:9`) | Accept a folder dropped on the welcome/workbench → `api.workspace.openPath`. `webUtils.getPathForFile` already exists in preload | Drag a Finder folder onto the window → it opens as the workspace | 2h |
| 5 | Reduced-motion + focus-visible pass | `*.css` | Honor `prefers-reduced-motion`; ensure keyboard focus rings on the new overlays/toasts (a11y baseline for a public app) | Tabbing through Preferences/onboarding shows focus; reduced-motion disables animations | 1.5h |

**Top risks:** restoring bounds onto a now-disconnected external display → always validate against
`screen.getAllDisplays()` and clamp. Live font changes must re-fit terminals (call the existing `fitActive`/
`fitAll`). **Open Qs:** per-workspace vs global font/zoom (recommend global for 1.0).

---

## Distribution & Ops epics (Gate A — required for *public* 1.0, but not quick code fixes)

These are the difference between "my build" and "a stranger's install." They are **infrastructure projects with
calendar dependencies** (Apple/Microsoft enrollment, certificate issuance, an update-feed host), so they're scoped
here rather than as step tables — but for a **public 1.0 they are non-negotiable.** Detail and rationale already
live in [`00-EXECUTIVE-SUMMARY.md`](00-EXECUTIVE-SUMMARY.md) → Roadmap (Tiers 0–2); cross-refs below.

### Tier 0 — Cannot ship externally without these
- **Code signing + notarization** (Developer ID + hardened runtime + an **entitlements plist for node-pty's
  native `.node`**; Windows Authenticode). Add **x64 / universal mac** so it runs on Intel, not just the dev
  machine's arm64. *Without this, Gatekeeper blocks the DMG on every machine but yours.* → D3, S5
- **Auto-update** (`electron-updater` over a signed HTTPS feed, staged rollout, signature verification, and a
  renderer↔main API-version handshake that fails closed). Wires into PR-D5's menu item. → D1
- **Crash reporting** (`crashReporter.start()` + a Sentry-class uploader covering main + renderer + **native**
  node-pty crashes), paired with the top-level `uncaughtException`/`unhandledRejection` handlers (audit R4). → D2

### Tier 1 — Cannot operate at scale without these
- **Consent-gated telemetry** (opt-in per the decision above; anonymous install id, version, OS, crash-free rate,
  pane count + Pulse provider mix to size cost). Build it in **main** like Pulse; **redact the API key / Pulse env
  and never upload pane tails.** Consent prompt lands in PR-E. → D4
- **Feature flags / remote kill-switch** (fail-open to last-known) so a bad Pulse provider or layout can be killed
  remotely without a release. → D5
- **CI/CD** — PRs run the `PLAN.md` PR-5 lint/typecheck/test net; tagged builds sign + notarize + publish;
  **decouple the version bump from `pack`/`dist`** (today `package.json:14-15` bumps + clean-rebuilds on every
  build). → D6
- **Bound per-user footprint** — the `PLAN.md` PR-4 items (PTY cap, lazy Monaco, adaptive scrollback, watcher
  pruning). Several are partly in; finish before the install base grows.

### Tier 2 — Commercial (only if 1.0 is monetized)
- Accounts (device-flow OAuth), offline-tolerant licensing (fail-open/grace), billing, optional settings/session
  sync (the per-workspace session store is the natural sync unit). Extend the Pulse credential boundary.

---

## Sequenced roadmap to 1.0 (interleaving this doc with `PLAN.md`)

| Wave | Theme | Lands | Rationale |
|------|-------|-------|-----------|
| **0** | Lock in what's built | **Commit + verify** the current tree; `PLAN.md` Wave-0 net (lint/test) | Everything below edits already-unverified files — verify first |
| **1** | Make Pulse usable + stop silent failures | **PR-A** (settings substrate) → **PR-B** (API-key/provider/badge) → **PR-C** (errors) | Highest product ROI: the headline feature becomes reachable and the app stops failing invisibly |
| **2** | Feel finished | **PR-D** (menus/About/Help/North-Star) · **PR-E** (onboarding) · **PR-F** (window/fonts) | The "this is 1.0" polish; PR-D6 closes the last dead seam |
| **3** | Ship externally (parallel track) | **Gate A Tier 0**: signing → notarization → crash reporting → auto-update | Calendar-bound; **start enrollment/cert work in Wave 0** so it's ready when the product layer is |
| **4** | Operate | **Gate A Tier 1**: telemetry (consent in PR-E) · feature flags · CI/CD · finish `PLAN.md` PR-4 footprint | Needed to run a public install base, not to cut the first build |

**First slice to cut:** Wave 0 (commit + verify) then **PR-A → PR-B** — that single chain takes Pulse from
"env-vars only, invisible" to "configurable in-app with a live status badge," which is the biggest perceived gap
between today and a finished product. Run the **Apple Developer enrollment + signing setup in parallel from day one**
because it has the longest lead time and gates the entire public launch.

---

## One-line summary

The plumbing is mostly done (Gate B has quietly landed; verify it). What stands between Concourse and a **public
1.0** is, in order: **(1) an in-app settings + API-key flow so Pulse is actually usable** (PR-A/PR-B), **(2) visible
error feedback** (PR-C), **(3) the standard menu/About/Help/onboarding polish** (PR-D/PR-E/PR-F), and — on a
parallel, calendar-bound track — **(4) signing, notarization, auto-update, and crash reporting**, without which no
stranger can run it at all.
