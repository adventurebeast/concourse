# Concourse application runthrough — 2026-09-09

This review covers the current source, including the existing uncommitted explorer
and terminal naming work. The June audit files are historical reports: many of
their findings were fixed subsequently and should not be treated as current bugs.

## Product direction

Concourse's central job is to make a fleet of agents understandable: which agent
is in each pane, where it is working, whether it needs attention, and how to get
back to that work. A stable manual task name, safe automatic agent identity, and
an attention signal complement one another. Free-form terminal input, output,
password echoes, shell titles, and generated summaries must not become header or
session metadata.

Specific task descriptions should come from explicit user naming or a deliberate,
structured integration with the agent. Process identity alone cannot reliably
explain the task an agent is performing. A quiet terminal also cannot establish
whether an agent is waiting for input, working without output, or finished.

## Changes made during this runthrough

| Area | Observed problem | Result |
| --- | --- | --- |
| Editor save | Typing while a write awaited IPC could be marked clean, then lost on tab close. Concurrent saves could finish out of order. | Saves serialize per buffer and preserve newer edits as dirty. Save-and-close only closes a clean buffer. |
| External agent edits | An automatic reload could overwrite typing that began during the read, or access a tab closed during the read. | Reload verifies the model revision and tab identity before applying content. It also rejects unstable disk snapshots and binary replacement content. |
| Editor conflict dialog | Choosing Reload returned success even if reading the file failed. | A failed reload keeps the dirty buffer open. |
| Explorer/editor integration | Renaming or moving a file/folder left open editor tabs saving to the old path. | Open file tabs retain their model, edits, order, and focus while updating paths, language, labels, and tab controls. Pending opens follow moves. |
| Workspace restore | Only the “Reopen last project” startup branch restored saved sessions. Opening a recent project from the default Welcome screen did not. | Every first project open uses the same session restoration path. Welcome defers creating a PTY until “Empty Window” is chosen. |
| Workspace isolation | Opening another folder changed the root beneath existing agents/editor tabs and could save the old fleet into the new project's session. | Another project opens in an independent window. Existing agents, editor buffers, watchers, and workspace identity stay together. Standalone terminal windows are preserved too. |
| Session autosave | The timer could persist an incomplete restoration; failed writes suppressed retries. | Saving pauses until restoration finishes, and a snapshot is marked saved only after the write succeeds. |
| Command palette | npm script names were interpolated into shell commands without quoting. | Unusual POSIX names become one literal shell argument. Control characters and option-like names are omitted. Windows omits names requiring dialect-specific escaping because the active pane can use cmd or PowerShell. Just recipe names must match a whole token; Make targets already use a strict name alphabet. |
| Command palette focus | Closing the palette left keyboard focus on a hidden input. | Focus returns to the terminal/editor that opened it. |
| Git review | Changes compared HEAD to working content, re-showing already staged edits; staged/unstaged views reused one misleadingly titled tab. | Changes compares index to working content. Staged compares HEAD to index. Each has its own clearly titled diff tab. |
| Git rename review | A staged rename read the new path from HEAD, leaving the original side blank. | Main derives the old path from current Git status and compares it with the new index path. |
| Git file actions | Option-like or wildcard-like filenames could act on unrelated files. | Stage, unstage, and tracked-file discard use literal pathspecs with an argument separator. |
| Git discard | One click immediately replaced uncommitted tracked-file changes. | A confirmation explains the permanent discard and defaults to Cancel. Untracked files continue to use the recoverable OS Trash. |

Terminal/Pulse and explorer improvements are implemented alongside these workbench
fixes:

- Terminal headers can show fixed, allowlisted process identities while explicit
  user names take precedence. Rename and return-to-automatic actions are available
  across terminal layouts. Password input, output text, shell titles, and command
  arguments do not supply these automatic names.
- Pulse distinguishes visible activity and high-confidence input requests, while
  preserving the limits of screen heuristics. The [Pulse design](../pulse-engine.md)
  documents the current boundary and a structured agent-event integration path.
- Explorer exposes its actions through accessible context menus: create, rename,
  copy/cut/paste, move/duplicate, path copying, terminal/search shortcuts, and Trash.
  Main-process filesystem checks cover collisions, workspace confinement, and
  symlinks. Moves notify the editor so unsaved buffers continue to save correctly.

## Verification

- Final integrated checks: **131 tests passed across 18 suites**, lint passed
  with one existing unused-function warning in `recents.js`, and the production
  bundle built successfully.
- Ten isolated macOS runtime groups passed across two app launches: automatic
  process identity, silent password privacy, typed-agent Pulse transitions, shell
  return, rename/reset and all five layouts, Explorer pointer/keyboard menus and
  rename, recoverable system Trash, workspace isolation with a live agent,
  autosave, and restored explicit names/allowlisted resume actions. A byte scan
  found the synthetic secret in none of the app profile, session, or log files.
- The Trash probe checked only its uniquely named synthetic file and verified it
  existed in macOS Trash after removal from the test workspace. The user's
  installed application and live terminal sessions were not used or replaced.
- Initial baseline: lint passed with two existing unused-variable warnings; all
  84 tests across 11 files passed.
- The additional workbench tests execute real renderer functions with controlled
  DOM/Monaco/IPC doubles to force delayed save, reload, rename, and restore races.
- Git IPC tests use a real temporary Git repository. They verify HEAD/index/worktree
  content and ensure option/glob-like filenames affect only the selected file.
- Workspace IPC tests use real temporary directories and a real per-window context,
  with Electron window creation and persistence mocked. They include concurrent
  folder-open requests and preservation of the original watcher/root.
- The six focused editor, command-source, Git, workspace IPC, workspace restore,
  and dialog suites passed (32 tests); lint passed for their changed source files.
- Full integrated build/runtime checks are separate from these focused tests. The
  existing `scripts/smoke.mjs` only establishes that a packaged process stays alive;
  it does not establish that the workbench flows or privacy boundary behave correctly.
  The new [application smoke](../../scripts/application-smoke.mjs), run with
  `npm run smoke:application`, uses a separate profile/workspace and synthetic
  terminal input to exercise the integrated application without disturbing live
  user agents. Its final result should accompany the release check.

## Follow-up work

| Priority | Gap | Reproduction / next acceptance check |
| --- | --- | --- |
| Medium | A workspace opened inside a larger Git repository needs explicit path-base handling. | Open a repository subfolder, change a file there and outside it, then verify status paths, diffs, and file actions resolve to the intended repository paths without violating workspace confinement. |
| Medium | Editor disk conflict detection is based on mtime rather than an atomic compare-and-write operation. | Run an agent writing the same file while saving in Monaco. The new renderer guards protect edits during asynchronous operations, but filesystem replacement between the final check and write remains a separate concurrency concern. |
| Medium | Large-file editor behavior lacks an explicit size budget. | Open a very large text file from Explorer; verify responsive terminals and an actionable preview/size-limit message. Search already runs in a worker with a timeout. |
| Medium | Expand the new isolated runtime smoke. | Add actual Monaco dirty-buffer rename/move, Search result navigation, Settings changes, and Git diff rendering. Current regression tests cover their data paths; the runtime smoke now covers terminals, layouts, Explorer menus/rename/Trash, restart, and a second workspace window. |

Windows-specific shell behavior and OS-level dialogs/notifications require actual
Windows runtime checks; POSIX command-quoting coverage does not establish them.
