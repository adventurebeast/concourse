---
name: build-app
description: Build the launchable Concourse macOS app (.app / .dmg). Use when the user says "build app", wants a packaged/installable build, or a real launched app to double-click — not the dev server.
---

# Build App

Produce the packaged macOS Concourse app from source.

## Steps

Run all five steps in order: build → locate → commit → install → launch. Installing to
/Applications is what makes it a real, Spotlight-launchable app; launching completes the
build and always uses `open -n` (a separate instance, safe even when this session runs
inside Concourse).

1. From the project root, run the build:
   - **Unpacked `.app` (fast, for local launch):** `npm run pack`
   - **DMG installer:** `npm run dist`

   Both run, in order: **`npm run preflight`** (`npm run lint && npm test` — the
   EXACT gate CI runs; the build ABORTS here on any lint error or failing test, so
   you never package, install, or ship code that CI would reject — green preflight
   ⇒ green PR), `npm run bump` (auto-increments the patch version in
   `package.json`), `npm run clean` (`rm -rf out release` — deletes stale
   compiled output and old packages so nothing old leaks into the new build),
   `electron-vite build` (recompiles ALL of `src/` → `out/`), then
   `electron-builder --mac` (packages `out/` + `package.json`).

   Because of `clean`, every build is from scratch — whatever is in `src/` is
   what ships. New modules are picked up automatically as long as they're
   imported from an entry point (`src/main/index.js`, `src/preload/index.js`,
   or reachable from `src/renderer/index.html`).

2. Output lands in `release/`:
   - `.app`: `release/mac-arm64/Concourse.app`
   - `.dmg`: `release/Concourse-<version>-arm64.dmg`

3. **Commit the result** — the build is not "done" until the repo records it. The
   build wrote `package.json` + `package-lock.json` (version bump), and there are
   usually feature changes in `src/` too. Per the repo's standard flow, work goes via
   a **branch + PR, never direct to `main`**:
   - `git switch -c <feat-branch>` (skip if already on a feature branch).
   - Commit the feature change(s) and the version bump — separate commits is cleaner
     (`feat: …` then `chore: bump version to X.Y.Z`). End commit messages with the
     `Co-Authored-By` trailer.
   - `git push -u origin <feat-branch>` → `gh pr create` → wait for **CI green**
     (`gh pr checks <n>`) → `gh pr merge <n> --merge --delete-branch`.
   - If you're only re-packing with no source changes, at minimum commit the bump so
     the repo version tracks the latest build.

4. **Install to /Applications** so the app is a permanent, Spotlight-launchable install
   (⌘-Space → "Concourse") rather than something buried in `release/`. Replace any old copy
   and use `ditto`, which copies macOS app bundles faithfully (preserves symlinks/permissions
   that a plain `cp -R` can mangle):
   ```
   rm -rf /Applications/Concourse.app
   ditto release/mac-arm64/Concourse.app /Applications/Concourse.app
   ```
   /Applications is auto-indexed, but you can make it searchable immediately:
   `mdimport /Applications/Concourse.app`. (Because the app is unsigned, the FIRST launch may
   need right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Concourse.app`
   to clear Gatekeeper.)

5. Smoke-launch the installed app — this completes every build AND verifies it actually boots:
   ```
   npm run smoke
   ```
   `npm run smoke` snapshots the running Concourse PIDs, launches a NEW instance with `open -n`,
   waits a few seconds, then **fails loudly if that instance crashed or never started** (printing
   any crash-report path). A compile-clean build can still die on launch (a node-pty native
   mismatch, a missing bundled asset, a bad llama path) — this catches it before you install over
   a known-good copy or ship it. Use `npm run smoke -- --wait 10` to allow a slower boot.
   - **ALWAYS via `open -n`** (which `smoke` uses): the NEW build runs as a *separate* instance, so
     it never kills a Concourse that may be hosting this very session (this app sets no
     `requestSingleInstanceLock`, so instances coexist). Never `osascript -e 'quit app "Concourse"'`
     or plain `open -a`. Raw launch without the check is still `open -n /Applications/Concourse.app`.
   - **Confirm the new build loaded:** the bumped version shows as `vX.Y.Z` at the far-right of
     the bottom status bar of the newly-opened window. It must match the `version` in
     `package.json`.

## Publish (optional) — put the DMG on GitHub for users to download

The five steps above are LOCAL only (build → install → launch); they never upload
anything. To distribute a build, first run the **DMG** variant (`npm run dist`, not
`pack` — `--dir` produces no installer), then publish the resulting
`release/Concourse-<version>-arm64.dmg` as a GitHub Release:

```
npm run release             # create (or update) the release for the current version
npm run release -- --dry-run  # preview the tag/title/auto-notes first, touch nothing
npm run release -- --draft    # publish as a draft to review on GitHub before going live
npm run release -- --notes path/to/body.md   # supply hand-written notes verbatim
```

Ship only what you've verified: run **`npm run smoke`** (step 5) and confirm CI is green
on the merged PR before `npm run release`, since this DMG goes to real users.

`scripts/release.mjs` does NOT build — run it AFTER `npm run dist` and after the
version-bump commit is in place (it tags `vX.Y.Z` at HEAD). It mirrors the existing
convention: title `Concourse X.Y.Z — developer beta`, the unsigned-beta notes with the
one-time `xattr -dr com.apple.quarantine` bypass, and a "What's new" changelog
auto-generated from commits since the previous release tag (edit on GitHub to polish).
Re-running for the same version is safe — it re-uploads the DMG (`--clobber`) and
refreshes the notes. Requires `gh auth`. Builds stay **unsigned** until the
sign/notarize work lands, so users still need the quarantine bypass.

## Notes

- Target is arm64, unsigned (`identity: null`) — for personal use, no notarization.
- The version bump writes `package.json` (and `package-lock.json`) — step 3 commits it. To build WITHOUT bumping (e.g. a re-pack of the same version), run the steps manually: `npm run preflight && npm run clean && electron-vite build && electron-builder --mac --dir` (keep the preflight gate even when bypassing the bump).
- `node-pty` is a native module: if you hit a runtime load error, run `npm install` (its `postinstall` rebuilds node-pty for this Electron via `electron-rebuild`). `npm run smoke` is what surfaces this class of failure — a mismatched node-pty compiles but crashes the app on boot.
- `npm run fetch:llama` (auto-run by dist/pack) needs network on the FIRST build to vendor the llama-server binary into `build/bin`, but it's already safe for frequent builds: it **caches** (skips when the binary is present) and is **non-fatal** offline/rate-limited (it warns and ships without the bundled runtime, falling back to Ollama / deterministic Pulse — packaging never breaks). Delete `build/bin/llama-server` to force a re-fetch.
- Config: `electron-builder.yml`. For the dev server instead, use `npm run dev`.
