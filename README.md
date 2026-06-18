# Concourse

A stupidly simple IDE for running **many CLI coding agents (Claude Code) at once**. VS Code-style shell, but the terminal multiplexer is the star.

- **Terminal multiplexer** — the core. Many PTY-backed shells as tabs, a **grid view** (`▦`) to watch every agent at once, **quick-spawn presets** (`▾` → "Claude Code" launches `claude` in the workspace), per-tab **attention dots** (blue = new output you haven't seen, orange pulse = the agent rang the bell / wants you), and **double-click to rename** a tab ("frontend", "backend"…).
- **File tree sidebar** — file-type icons, lazy expand, refresh/collapse, right-click New/Rename/Delete.
- **Source Control** — VS Code-style git panel: branch in the status bar, staged/unstaged groups, stage/unstage/discard, commit box (⌘Enter), click a file for an inline diff.
- **Editor** — Monaco with multi-file tabs, dirty indicators, `Cmd/Ctrl+S` to save, and read-only diff tabs for git.

Built on Electron + Monaco + xterm.js + node-pty — the same core tech as VS Code, without the 2M-line fork.

## Architecture

Per-feature modules with hard contracts (IPC channel names in `preload`, DOM IDs in `index.html`, module interfaces wired in `renderer/main.js`):

```
src/
  main/
    index.js          window + wires register*(ctx)
    context.js        shared workspace-root / window state
    ipc-workspace.js  open/get folder
    ipc-fs.js         file CRUD
    ipc-git.js        simple-git status/diff/stage/commit
    ipc-pty.js        node-pty terminals
  preload/index.js    window.api contract (built to out/preload/index.mjs)
  renderer/
    main.js           boot + activity bar + pane resizing + wiring
    terminals.js      terminal multiplexer (tabs + grid + presets + attention)
    fileTree.js       explorer
    git.js            source control panel
    editor.js         Monaco tabs + diff
    *.css             one stylesheet per module
```

## Run it

```bash
npm install      # also rebuilds node-pty for Electron (postinstall)
npm run dev      # launch in dev mode (hot reload)
```

```bash
npm run build    # bundle main/preload/renderer into ./out
npm start         # preview the built app
```

## Requirements / gotchas

- **macOS native builds:** node-pty compiles C++. If `npm install` fails with `'functional' file not found`, your Command Line Tools are incomplete — point at full Xcode:
  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  npx electron-rebuild -f -w node-pty
  ```

## Layout

```
src/
  main/index.js       Electron main: window, fs IPC, PTY (node-pty) IPC
  preload/index.js    contextBridge — safe window.api surface
  renderer/
    index.html        three-pane shell
    main.js           file tree + Monaco editor + xterm terminals + resizers
    style.css         dark theme
```

## Next ideas

- Per-terminal agent presets (one-click "new Claude Code session in this folder")
- Tab labels that reflect the running command / cwd
- Diff view to watch what an agent changed
- File-tree refresh + create/rename/delete
- Search across files
