# Pulse engine

How Concourse decides, for every terminal pane, **what state it's in** and **what it's
doing** — so you can run a fleet of agents without reading scrollback.

## North star: the agent's resting state

An agent's life is an oscillation between two states:

- **`working`** — actively producing output (or animating a spinner while it thinks/runs a tool).
- **`awaiting`** ("Awaiting User Input") — it has **come to rest**; the ball is in your court.

~90% of the time, the job isn't *watching* an agent work — it's **waiting to catch it back
at rest**. So `awaiting` is the dominant, highest-value signal, not an edge case. And the
thing of value is the **`working → awaiting` edge**: the *moment* an agent comes to rest is
an event worth **notifying** on — you've context-switched away, and the pane should pull you
back. You should never have to babysit the status bar.

`awaiting` covers two flavors that look identical when you're scanning the bar — keep them
**one state, one color**, with the difference only in the text label:

- **mid-task await** — paused *inside* a turn, needs an answer to continue (`y/N`, a
  permission prompt, a password).
- **end-of-turn await** — the turn finished; it's parked, waiting for your next instruction.

For an agent there is effectively no "done" — it oscillates `working` ↔ `awaiting`.
`done`/`error` remain meaningful only for **one-shot shell commands** (run `npm test`, it
finishes and the shell returns).

**False positives are the cardinal sin.** An edge that fires while the agent is still
thinking trains you to ignore it, and then the whole mechanism is worthless. The detector
must fail toward "still working," never toward crying wolf.

## State vocabulary

`working | quiet | awaiting | done | error | idle`

- `working` — output is flowing (or recently flowed). The spinner ring animates only while
  bytes are *actively* streaming (`streaming` flag); a working-but-paused pane shows a calm
  solid dot.
- `quiet` — went silent but we can't yet classify it (no prompt detected, not obviously an
  agent at rest). A transient "the model is about to look" state.
- `awaiting` — at rest, your move. The important one.
- `done` / `error` — a one-shot command finished (exit 0 / non-zero).
- `idle` — a bare shell prompt, nothing pending.

## Three layers + a memory

```
Layer 0  Shell integration (OSC 133/633)  → command boundaries + exit codes.
         Deterministic, instant, free, offline.                         [planned: step 3]
Layer 1  Pattern + buffer signals over the live stream → awaiting/error
         detection. Regex-cheap, instant, offline. The deterministic floor. [step 1]
Layer 2  Model summariser (ipc-pulse.js) — the LABEL, and the genuinely
         ambiguous cases Layers 0–1 can't resolve. Fed previous-verdict +
         delta, not a cold snapshot. Behind a fleet-wide scheduler.     [partly built; step 4]
   +     Per-pane event log (transitions + timestamps) = the "context"
         half. The transition IS the log entry the edge fires on.       [step 2]
```

### The deterministic `awaiting` tell (Layer 1)

A genuinely working agent **keeps emitting bytes** — its spinner/`✻` animation, an elapsed
timer, progress repaints. Byte flow never fully stops while it's alive and computing. So:

- **sustained byte-silence + an input affordance** ⇒ `awaiting`
- **ongoing bytes** ⇒ `working`

Signals, cheapest first:

1. **Explicit prompt patterns** in the visible tail — high confidence, surfaces fast
   (~1s after output settles): `(y/N)`, `[Y/n]`, `yes/no`, `Password:`, `proceed?`,
   `continue?`, `do you want to …?`, `overwrite …?`, `press enter`, `choose …:`. Plus
   optional per-agent matchers (e.g. Claude Code's permission prompt). Harness-agnostic core,
   optional adapters on top — see the auto-title harness-agnostic principle.
2. **Alternate-screen buffer + sustained silence** — a full-screen TUI app (`buffer.type ===
   'alternate'`) that's gone byte-silent past the quiet window is almost certainly at rest.
3. Everything else that's gone quiet with no clear tell stays `quiet` and is handed to
   **Layer 2** (the model) to call — that's what it's for.

Timing: the explicit-prompt path may fire on the short settle window (`STREAM_IDLE_MS`,
~1s) because those patterns are unambiguous. The implicit rest/alt-screen path waits the
conservative `QUIET_MS` (8s) silence window, to stay on the "still working" side.

### The edge (the notify seam)

All semantic transitions go through one setter so the `working → awaiting` edge can't be
missed. On entry to `awaiting` while the pane is unfocused, it (a) flags the pane `unseen`
(a soft come-look pulse on the dot) and (b) calls an `onAwait(session)` hook. Today that hook
is the seam; the actual surface (OS notification / sound / loud fleet badge) is a later,
explicit product choice.

## Build order

1. **Deterministic `awaiting` detector + rename `blocked` → `awaiting`** (enum, dot CSS,
   fleet bucket) + the edge hook. Renderer-only, no app rebuild, degrades gracefully with no
   LLM. Broaden the Layer 2 prompt to name the resting state explicitly (today it mislabels
   end-of-turn rest as `done`/`idle`, under-signaling that you should engage). ← **this step**
2. Per-pane event log (transition history → durations + better model context).
3. OSC 133 shell integration (Layer 0).
4. Fleet scheduler for Layer 2 at 10+ panes.

Keep the deterministic floor working with **no LLM configured** at every step.
