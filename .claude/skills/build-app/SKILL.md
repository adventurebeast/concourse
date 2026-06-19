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

   Both first run `electron-vite build` (compiles `src/` → `out/`), then `electron-builder --mac`.

2. Output lands in `release/`:
   - `.app`: `release/mac-arm64/Concourse.app`
   - `.dmg`: `release/Concourse-<version>-arm64.dmg`

3. Launch the built app — this completes every build:
   - First quit any running instance so the fresh build loads: `osascript -e 'quit app "Concourse"' 2>/dev/null; sleep 1`
   - Then: `open release/mac-arm64/Concourse.app`

## Notes

- Target is arm64, unsigned (`identity: null`) — for personal use, no notarization.
- `node-pty` is a native module: if you hit a runtime load error, run `npm install` (its `postinstall` rebuilds node-pty for this Electron via `electron-rebuild`).
- Config: `electron-builder.yml`. For the dev server instead, use `npm run dev`.
