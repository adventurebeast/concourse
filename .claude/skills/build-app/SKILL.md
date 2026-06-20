---
name: build-app
description: Build the launchable Concourse macOS app (.app / .dmg). Use when the user says "build app", wants a packaged/installable build, or a real launched app to double-click — not the dev server.
---

# Build App

Produce the packaged macOS Concourse app from source.

## Steps

Always run all three steps in order. Building without launching is incomplete — step 3 is mandatory, not optional.

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

3. Launch the built app — this completes every build:
   - First quit any running instance so the fresh build loads: `osascript -e 'quit app "Concourse"' 2>/dev/null; sleep 1`
   - Then: `open release/mac-arm64/Concourse.app`
   - **Confirm the new build loaded:** the bumped version shows as `vX.Y.Z` at
     the far-right of the bottom status bar. It must match the `version` in
     `package.json`. If it doesn't, an old instance is still running — quit and
     reopen.

## Notes

- Target is arm64, unsigned (`identity: null`) — for personal use, no notarization.
- The version bump writes `package.json` (and `package-lock.json`); commit it so the repo version tracks the latest build. To build WITHOUT bumping (e.g. a re-pack of the same version), run the steps manually: `npm run clean && electron-vite build && electron-builder --mac --dir`.
- `node-pty` is a native module: if you hit a runtime load error, run `npm install` (its `postinstall` rebuilds node-pty for this Electron via `electron-rebuild`).
- Config: `electron-builder.yml`. For the dev server instead, use `npm run dev`.
