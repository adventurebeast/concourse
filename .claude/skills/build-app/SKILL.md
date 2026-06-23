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

   Both run, in order: `npm run bump` (auto-increments the patch version in
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

5. Launch the installed app — this completes every build. **ALWAYS launch with `open -n`**,
   never quit/relaunch:
   ```
   open -n /Applications/Concourse.app
   ```
   `open -n` starts the NEW build as a *separate* instance, so it never kills a Concourse that
   may be hosting this very session (this app sets no `requestSingleInstanceLock`, so multiple
   instances coexist fine). This is the rule whether or not the session is running inside
   Concourse — do not use `osascript -e 'quit app "Concourse"'` or plain `open -a`.
   - **Confirm the new build loaded:** the bumped version shows as `vX.Y.Z` at the far-right of
     the bottom status bar of the newly-opened window. It must match the `version` in
     `package.json`.

## Notes

- Target is arm64, unsigned (`identity: null`) — for personal use, no notarization.
- The version bump writes `package.json` (and `package-lock.json`) — step 3 commits it. To build WITHOUT bumping (e.g. a re-pack of the same version), run the steps manually: `npm run clean && electron-vite build && electron-builder --mac --dir`.
- `node-pty` is a native module: if you hit a runtime load error, run `npm install` (its `postinstall` rebuilds node-pty for this Electron via `electron-rebuild`).
- Config: `electron-builder.yml`. For the dev server instead, use `npm run dev`.
