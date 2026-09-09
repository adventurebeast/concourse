# Pulse: useful context without terminal input capture

Concourse should answer three questions at a glance: which agent is in this pane, which task did I give it, and does it need me? These are separate data sources. A command line or a screen scrape must not silently become a pane's identity.

## Current implementation

**Identity:** `src/main/terminal-process.js` queries executable accounting names for Concourse-owned PTY devices. On macOS it requests `ucomm`; on Linux it requests `comm`. It never requests arguments, environment variables, shell history, or node-pty's title/process getter. One bounded query runs every 1.5 seconds across the app's panes, and only changed results are sent to their owning windows. Foreground process groups exclude background jobs. A known agent takes priority over its Node/Python wrapper or helper tools.

`src/shared/terminal-process.js` maps those names into a fixed vocabulary. Unknown names are discarded. The renderer validates the key again, so even a malformed event's free-form `label` cannot reach a header. Examples: `Codex · 1`, `Claude · 2`, `Bash · 3`. Unsupported platforms, unrecognized wrappers, and denied process queries fall back to `Terminal N`. This is an identity hint, not proof of process authenticity or agent progress.

**Task:** double-click the tab, pane name, or rail-card name; or choose Rename from its context menu. Explicit names such as “Checkout tests” override the automatic identity. “Use Automatic Name” clears the override. Only explicit names persist. Automatic process names and activity remain transient. Existing cwd placement and allowlisted agent resume commands remain available; arbitrary command lines and legacy captured titles remain excluded from session storage.

Cwd markers are untrusted too: strict decoding, realpath resolution, and an existing-directory check confine them to the owning workspace before persistence. Validation is asynchronous and coalesced so terminal rendering does not wait on filesystem reads.

**Activity:** local screen changes drive Working. Recognized prompts drive Awaiting you after settling. Otherwise the header says Quiet or Shell ready. A quiet foreground process may still be computing or waiting on a network request. Merely entering an alternate screen or going silent does not establish that a program needs input. A password prompt can yield the fixed state Awaiting you, but its text and the password cannot supply a title or notification body.

The privacy fix had left `classifyOutput` gated on `used`, while ordinary terminal input no longer set that flag. Keyboard-launched agents consequently stayed idle. The repaired gate observes only a boolean DOM interaction or foreground-process transition; it never reads a key, pasted text, or stdin bytes. The xterm input callback remains a one-way transport to the PTY.

This fallback is useful for arbitrary tools and agents, but it cannot reliably distinguish thinking, a slow tool, a completed turn, or a silent failure. Agent lifecycle events should become authoritative when a supported integration supplies them.

## Codex integration direction

The installed CLI inspected during this audit is **0.153.4**. Its help supports app-server and a TUI connection using `--remote`, including Unix sockets. The official protocol documents `thread/status/changed`, `turn/started`, `turn/completed`, active flags for approval/input waits, typed work items, and agent messages. The CLI can generate schemas matching its own version. [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)

Recommended next implementation:

1. Add an explicit **New Codex Terminal** action. Concourse owns a local app-server instance and a private Unix socket for that pane, then connects the normal Codex TUI. Preserve existing arbitrary-shell terminals.
2. Bind the pane to the server/thread created through that action. Do not correlate by cwd alone, inspect global chat history, or attach indiscriminately to an existing daemon.
3. Consume only validated lifecycle enums into Pulse: active → Working; approval/input wait → Awaiting you; a completed turn → Ready; failure → Failed; interrupted/disconnected → an explicit corresponding state. These events take precedence over screen heuristics until the connection is lost.
4. Use typed work-item categories for optional fixed descriptions such as “Running a command” or “Editing files.” Discard command arguments, diffs, tool output, prompts, free-form errors, and reasoning before renderer IPC. Never automatically answer an approval request.
5. Offer the agent's commentary or final answer in an explicitly opened details view. A chat summary can repeat a secret from the task. Treat it as sensitive conversation content: no automatic header, notification, or session-store copy; no secondary model required.
6. Validate the second-client subscription behavior against a real owned server before shipping. The inspected schema has no read-only `thread/subscribe` capability. `thread/read` does not subscribe; `thread/resume` is control-capable even when turn content is excluded. Calling a client “read-only” is an application rule, not a server-enforced permission. Test that observing events cannot steal or duplicate approval handling from the TUI.

A candidate that avoids the extra subscriber is a private local transport gateway between the TUI and its owned server. Forward TUI traffic opaquely and unchanged; reduce only server-to-TUI lifecycle messages to fixed enums. The TUI stays the sole approval handler, and the gateway originates no protocol requests. The documented Unix transport uses a WebSocket handshake. This candidate still needs framing, backpressure, disconnect, approval-routing, and pane-ownership tests. [Transport specification](https://learn.chatgpt.com/docs/app-server#protocol)

Codex hooks are another supported seam: turn submission, permission requests, stop, and interruption can signal lifecycle changes. Their payloads can include prompts and tool inputs; transcript files are not a stable interface. A hook adapter would have to discard content immediately, bind events to the correct pane, preserve existing hooks, and honor Codex's hook trust process. [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)

This adapter is a proposed follow-up, **not enabled by the process-identity changes**. The current build makes no Codex API calls, reads no Codex chat history, and installs no Codex hooks.

## Verification

- Policy tests reject unknown process names, forged labels, terminal-derived session fields, stale menu matches, and arbitrary resume arguments.
- Filesystem tests verify that Explorer deletion uses Trash with no permanent fallback.
- `npm run smoke:application` builds and runs the isolated workbench smoke with synthetic terminal input and a separate app profile/workspace. It checks rename, process transitions, Pulse, layouts, and persisted state without using a live user terminal. The macOS/Linux harness requires a C compiler to build its harmless agent fixture; it leaves its temporary artifacts for inspection.
- Before adding an agent adapter, require synthetic secrets in every discarded event field, two simultaneous panes, reconnect/exit behavior, and approval routing tests. Unsupported protocol versions must return to the generic terminal fallback.
