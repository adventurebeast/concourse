<div align="center">

# Concourse

**The command center for your fleet of CLI coding agents.**

Run Claude Code, Codex, and every other terminal-native agent side by side — watch them all at once, know what each is doing, and step in only when one needs you.

`Electron` · `xterm.js` · `node-pty` · `Monaco`

<br/>

<!-- Drop a screenshot or GIF at docs/hero.png — the grid view with Pulse labels makes the best hero shot. -->
<img src="docs/hero.png" alt="Concourse — a grid of CLI coding agents with Pulse status labels" width="820" />

</div>

---

Coding agents live in the terminal. One is easy. Ten is chaos — a wall of scrollback, no idea which one is stuck on a prompt, which one finished, which one went off the rails.

Concourse is the workbench built for that reality. It treats the **terminal multiplexer as the product**, not an afterthought bolted onto an editor. Spawn an army of agents, lay them out so you can see them, and let **Pulse** tell you in plain language what each one is doing — so your attention goes only where it's needed.

It's agent-agnostic by design. Anything you can run in a shell — `claude`, `codex`, an SSH session, a long build — is a first-class pane.

> **Two ways to work, one app.** Concourse ships with **Beginner** and **Expert** modes. Beginners get a calm, friendly surface with plain-language labels and a clean prompt. Experts get conventional shell naming and their own untouched environment. Switch anytime.

## Quickstart

```bash
git clone <your-fork-or-repo-url> concourse
cd concourse
npm install      # also rebuilds node-pty for Electron (postinstall)
npm run dev      # launch in dev mode with hot reload
```

Build and preview a production bundle:

```bash
npm run build    # bundle main + preload + renderer into ./out
npm start        # preview the built app
npm run dist     # package a macOS .app (electron-builder)
```

> **macOS native builds:** node-pty compiles C++. If `npm install` fails with `'functional' file not found`, your Command Line Tools are incomplete — point the toolchain at full Xcode:
> ```bash
> sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
> npx electron-rebuild -f -w node-pty
> ```

## What makes it different

### A multiplexer built to watch many agents at once

Every agent runs in a real PTY-backed terminal. The difference is how you arrange and read them:

| Layout | Shortcut | Best for |
| --- | --- | --- |
| **Tabs** | `⌘U` | Focused work on one agent |
| **Grid** | `⌘I` | A wall view of the whole fleet at a glance |
| **Stack** | `⌘O` | One agent large, the rest compact in a rail |
| **Flow** | `⌘P` | Album-style — center pane live, neighbors previewed |

Cycle layouts with `⌘⇧L`. Jump to any pane with `⌘1`–`⌘9`, cycle with `⌘⇧←/→`, open a new one with `⌘T`. Drag tabs to reorder; double-click to rename them (`frontend`, `backend`, `tests`). Each pane carries its own identity color across every view.

### Pulse — know what every agent is doing

Watching ten scrollbacks is impossible. Pulse does it for you, in two layers:

- **Layer A (free, instant):** a deterministic activity model running in the renderer. Status dots tell you at a glance — **working**, **quiet**, **blocked** (awaiting input, pulsing orange), **done** (green), **error** (red), **idle**. Zero cost, no network.
- **Layer B (optional, model-powered):** when a pane goes quiet, Concourse summarizes its last screen into a one-line, human-readable label — *"running tests, 2 failing"* or *"waiting: overwrite config.json?"*. Pick a provider:
  - **Local (zero-config, recommended)** — just run a local server and Pulse auto-detects it. `ollama serve` + `ollama pull llama3.2:3b` is all it takes — fully offline, no key, no env var, and it works for a double-clicked app too. Auto-detect looks for an OpenAI-compatible server at `http://localhost:11434/v1`.
  - **Local on a custom endpoint** — point Pulse anywhere (a different port, LM Studio, llama.cpp, a remote box) with `CONCOURSE_PULSE_BASE_URL`. This always wins over auto-detect and the Anthropic key.
  - **Anthropic** — set `ANTHROPIC_API_KEY` (defaults to `claude-haiku-4-5`). Used only when no local server is reachable; a running local server is preferred.
  - **None available?** Layer A still runs. Pulse never blocks, never crashes the app, and the API key never touches the renderer.

Override the model with `CONCOURSE_PULSE_MODEL`.

### Beginner and Expert modes

The same app meets you where you are. Beginner mode injects a calm prompt (`folder ❯`), uses friendly tab names, and keeps the surface uncluttered. Expert mode leaves your shell, prompt, and environment exactly as you've configured them and uses conventional naming. The mode is a foundation that more of the UI will branch on over time.

### The IDE around it

Concourse is a full workbench, not just a terminal grid:

- **Explorer** — file-type icons, lazy expand, right-click New / Rename / Delete, refresh & collapse-all.
- **Source Control** — VS Code-style git: branch and ahead/behind in the status bar, staged / changed groups, stage · unstage · discard, a commit box (`⌘Enter`), and click-to-open inline diffs.
- **Editor** — Monaco with multi-file tabs, dirty indicators, `⌘S` to save, broad syntax highlighting, and read-only git diff tabs.
- **Search** — fast workspace-wide search with case / whole-word / regex toggles; click a result to jump to the exact line.
- **Welcome & Recents** — reopen recent projects in a click; the last workspace and its layout restore automatically on launch.
- **Session restore** — tab labels, layout, open editor tabs, and panel sizes come back per workspace. (Live process state intentionally does not — agents are relaunched fresh.)

## Architecture

Per-feature modules with hard contracts: IPC channel names defined in `preload`, DOM IDs in `index.html`, and module interfaces wired together in `renderer/main.js`.

```
src/
  main/                 Electron main process
    index.js            window creation + register*(ctx) wiring
    context.js          shared workspace-root / window state
    ipc-workspace.js    open / get folder, recents
    ipc-fs.js           file CRUD
    ipc-git.js          simple-git status / diff / stage / commit
    ipc-search.js       workspace-wide search
    ipc-pty.js          node-pty terminals
    ipc-pulse.js        per-pane state + model-powered summaries
    ipc-session.js      per-workspace session persistence
  preload/index.js      window.api contract (built to out/preload/index.mjs)
  renderer/
    main.js             boot + activity bar + pane resizing + wiring
    terminals.js        the multiplexer — tabs, grid, stack, flow, Pulse, attention
    fileTree.js         explorer
    git.js              source control panel
    editor.js           Monaco tabs + diff
    search.js           search panel
    welcome.js          welcome / recents screen
    *.css               one stylesheet per module
```

Built on Electron + Monaco + xterm.js + node-pty — the same core tech as VS Code, without the 2M-line fork.

## Roadmap

- **Curated agent presets** — one-click "new Claude Code / Codex session here" from the new-terminal menu (the spawn infrastructure already exists; the picker UI is next).
- **Deeper mode differences** — more of the UI gated on Beginner vs Expert.
- **Richer git** — branch switching, push / pull, stash.
- **Fleet arrangements** — purpose-built layouts for 10+ agents and a queue for pending work.

---

<div align="center">
<sub>Concourse — drive an army of agents from one workbench.</sub>
</div>
