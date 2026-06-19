# Concourse Arrangements — Design Notes

> Ideation for new **arrangements** (window layout / view modes) for supervising a
> fleet of 10+ CLI coding agents. Captured 2026-06-19. Source: a 3-lens design
> fan-out (control-room ops · attention science · power-tooling) synthesized against
> the actual signals in `src/renderer/terminals.js`.

---

## The reframe

The four arrangements that ship today — **Tabs · Grid · Stack · Flow** — all answer
one question: *"How do I see them?"* They're **geometry**: ways to tile raw terminal
pixels.

Given the fleet problem cold, three independent expert lenses each proposed *zero* new
geometry. They converged on a different framing:

> The job isn't **displaying** 10+ agents. A human can only meaningfully supervise
> ~3–5 at once. The job is **continuously reducing the wall to the few that matter
> right now, ranked by who's wasting your throughput — and hiding the rest without
> killing them.**

**Two convergent findings (the headline):**

1. **Same #1.** All three lenses independently picked the same flagship arrangement —
   a **triage queue**: show only the agents that need you, ranked, and burn the list
   down. (See *The Queue*, below.)
2. **Same missing primitive.** All three flagged that Concourse has no concept of a
   **silently-stalled agent** — running but producing nothing for minutes (thinking?
   looping? hung?). Every existing signal is positive-presence (bell rang, output
   moved, exited). The silent-stall is the biggest throughput leak in a fleet and is
   *invisible* today.

**Ranking insight:** a `BLOCKED` agent outranks an `ERROR`ed one. The blocked agent is
holding your throughput hostage and costs one keystroke to clear; the errored one has
already stopped and can wait. **Sort by opportunity cost, not alarm severity.**

---

## What already exists (don't re-propose these)

| Mode | Behavior |
|------|----------|
| `tabs`  | one terminal visible at a time (accordion) |
| `grid`  | every terminal as an equal tile, ~√n columns (mosaic wall) |
| `stack` | active pane = big primary column on the left; the rest = small **live** thumbnails in a scrollable right rail |
| `flow`  | coverflow — one large centered pane + slim live side previews, `⌥←/→` to cycle |

All four are pure geometry. None are driven by attention, urgency, or meaning.

### Per-session signals tracked today (`terminals.js`)
- `status`: `running` | `exited`
- `activity`: produced output while unfocused (ambient "something moved")
- `attention`: the program rang the bell (OSC bell) → it wants you. Strongest existing
  "needs you" signal; surfaced only as a small colored dot.
- a stable identity **color** per terminal (8-color cycle)
- an auto-title: live OSC title › heuristic (last command + git branch) › base name
- git branch per session (cached); 10k lines of scrollback per pane

### New signals we may build (flagged per concept)
- **Cadence / silence watchdog** — derived free from `onData` timestamps.
- **State classification** — `WORKING / BLOCKED-WAITING / DONE / ERROR / IDLE`.
- **Buffer summary** — cheap LLM/heuristic summary of recent buffer (needed because
  Claude Code's native title is a static "claude").
- **"What changed since I last looked"** diff/digest per pane.

---

## The unlock primitive — build this first (nearly free)

Almost every arrangement below needs each pane's **state**. We already have the cheap
half (`attention` = bell, `status` = exit). The missing half all three lenses flagged:

**A silence/cadence watchdog.** The `api.term.onData` handler already fires on every
byte. Stamp `s.lastOutputAt` there and tick a `setInterval`; an agent *running but
silent for N minutes* flips to a `stalled`/`idle` state. ~15 lines, no LLM. Build this
one signal and arrangements #1, #2, #4, #5 all light up. The richer buffer-summary is
the *second* upgrade, not the first.

```js
// terminals.js — inside the existing api.term.onData(({id, data}) => …) handler:
s.lastOutputAt = performance.now()
// + a ~5s setInterval that flips running → stalled after silence,
//   feeding the existing updateIndicators(s) (extend the dot → richer state).
// Split exit into DONE vs ERROR by exit code in api.term.onExit if available.
```

---

## The arrangements

### 1. The Queue ⭐ — the convergent winner
*(Strip Board / Triage Inbox — all three lenses' top pick)*

Stop showing all the agents. Show **only the ones that need you**, as a ranked worklist
you burn down top-to-bottom.

- **Layout:** narrow left column of "strips" (color chip · name · state pill · one-line
  summary · live `waiting 4m` timer); big primary pane on the right (the existing
  `stack` geometry).
- **Sort:** `ERROR > BLOCKED (longest-waiting first) > DONE`. Everything `WORKING`
  collapses to a calm footer: *"7 churning, nothing needed."*
- **Interaction:** `Enter` handles the top strip and auto-advances; `e` snoozes/archives;
  `j/k` move selection. Inbox-zero for agents — keyboard-drivable end to end.
- **Build:** literally `applyStack()` with the rail replaced by a *sorted, filtered*
  list of strip divs. Degrades gracefully — seed the queue from `attention`+exit until
  the state classifier exists. Risk lives entirely in the classifier (a false `WORKING`
  silently buries a stuck agent → the cadence watchdog is the safety net).
- **Inspiration:** ATC flight-strip boards · hospital triage · Gmail/Superhuman inbox-zero.

### 2. Fisheye — a grid that triages itself

One auto-sizing mosaic where **a pane's size IS its urgency** (focus + context).

- **Layout:** ERROR/BLOCKED pane = 4×4 grid tracks (readable); WORKING = 2×2; IDLE = a
  1×1 postage stamp with just a color bar + output sparkline. Only 2–3 panes are ever
  large; the rest tile around them. When urgency changes the cell **visibly swells** —
  motion is the pre-attentive alert.
- **Interaction:** click pins a pane large (manual override); `Tab`/`Shift-Tab` cycle
  focus in urgency order; a focused small pane temporarily inflates then deflates on blur.
- **Build:** pure CSS grid — each cell gets `grid-column/row: span N` from a score, with
  a transition. **Add hysteresis** (only resize after a state holds ~3s) so it doesn't
  jitter. This is what `grid` should become once state exists.
- **Inspiration:** Furnas fisheye views · macOS Dock magnification · Tufte macro/micro.

### 3. Reorientation Ribbon — the sleeper (build it second)
*Attacks the pain every other arrangement ignores: the re-read tax.*

Not a layout — a **decorator that rides on top of any arrangement, including the
existing four.**

- **Behavior:** a slim ribbon under each pane header that, on focus, reads *"Since you
  left (4m ago): ran tests → 12 pass / 2 fail, edited auth.js, now asking to install
  bcrypt."* A `+3 events` badge on unfocused panes so nothing silently drifts; `n` =
  jump to next pane with unread changes. Switching *into* an agent costs one line of
  reading, not a full scrollback re-read.
- **Build:** the unread badge + "jump to next changed" ships **today** on the existing
  `activity` flag + a per-pane `lastFocusedAt`. The free first tier of the digest is
  structured (not LLM): list "commands run since last focus" from the existing
  `captureCommand` keystroke capture. Upgrade to a prose summary later.
- **Inspiration:** interruption-recovery / resumption-lag research · "unread since last
  visit" · `git log` since last pull.

### 4. Fleet HUD + jump-keys — composes over *everything*
*An always-on index + keyboard nav that works under tabs/grid/stack/flow or any new mode.*

Three power-tool primitives sharing one keyboard story:

- **Minimap / status-line** — a corner grid (RTS minimap) or a dense tmux-style bottom
  bar: one color-coded state cell/segment per agent, urgent ones first. Cells **flash
  only on state change**, so motion in the periphery = "something just changed."
- **Hint-Jump** — leader key paints a home-row letter on every pane (vimium/easymotion);
  urgent panes get the easiest keys; hit the letter to jump. O(1) target acquisition.
- **Control Groups** — `Ctrl+Shift+3` binds a set of agents (e.g. all `feature/auth`
  panes); `Ctrl+3` recalls just them. Remember *that* they're group 3, not *where* they
  are on a wall of 18.
- **Build:** all CSS-cheap overlays + a window-capture keydown state machine modeled
  exactly on the existing flow `⌥←/→` listener. No new infra (urgency-ordering is
  optional polish). Persist groups by branch+title (pane ids are ephemeral counters).
- **Inspiration:** StarCraft control groups + minimap · tmux status line / `prefix-q` ·
  vimium/easymotion · i3 workspace numbers.

### 5. Calm Constellation — the second-monitor view
*Weiser's calm technology: the absence of motion is the information.*

Not terminals at all — an ambient canvas of orbs, one per agent, in stable positions
(clustered by git branch).

- **Encoding:** each orb breathes slowly while WORKING (calm, alive); stops + gains a
  steady amber ring when BLOCKED; **the one thing allowed to be loud** — a sharp red
  pulse — on ERROR; settles to soft green on DONE; dims when IDLE. A single red pulse
  among calm orbs is found in <200ms with no scanning. A faint thread links orbs on the
  same branch.
- **Interaction:** hover = live thumbnail + summary peek; click = dive into the pane;
  drag to arrange spatially; `Esc` = back to the constellation. Hub-and-spoke.
- **Build:** absolutely-positioned divs with CSS keyframe pulses; "breathing from
  activity" needs **zero** new infra. Cap ~25 orbs.
- **Inspiration:** Weiser & Brown calm technology / ambient displays (the Dangling
  String) · star-chart monitoring.

---

## Honorable mentions (compose with the above)

- **Watchlist** — arm per-agent trip conditions (*"chime only when the migration agent
  finishes / errors / goes quiet 5m"*); edge-triggered + explicit ack so it doesn't nag.
  Trading-desk threshold alarms. Converts a noisy flood of bells into operator-defined trips.
- **Zoom & Peek** — tmux `prefix-z` zoom + spring-loaded peek at another pane **without
  stealing focus** (don't call `term.focus()`); zero new infra — the stack rail already
  proves live offscreen rendering.
- **Takeover Cockpit** — drone-swarm "request operator" queue: blocked agents raise a
  card with the *extracted pending question* pulled out of the buffer tail; you resolve
  one in a focused cockpit and "release & next" auto-pulls the following request. (A
  heavier combination of #1 + #3 + question-extraction.)
- **BSP + marks** — full i3-style tiling tree with draggable gutters, a scratchpad to
  stash idle agents, and vim marks (`m`/`` ` ``) to teleport. For the tiling-WM power user.
- **Urgency Cascade** — a single vertical feed of full-width panes that **re-sorts itself
  live** by urgency; the most-urgent floats to your top reading position. `f` freezes the
  sort so the ground doesn't move while you read. (The Queue expressed as live panes
  rather than strips.)
- **Go/No-Go Board** — NASA flight-director wall: every agent as a compact **verdict card**
  (`GO / HOLD / FAULT / DONE`) with an output-cadence sparkline; shows *decisions*, not
  scrollback, so 16 agents fit legibly. Click a card to drop into its live terminal.

---

## Recommended build order

1. **Cadence/silence watchdog + state classifier** — nearly free; precondition for
   #1, #2, #4, #5.
2. **The Queue (#1)** as the flagship new arrangement **+ Reorientation Ribbon (#3)** as
   a decorator. Together they attack the two pains the four geometries completely miss —
   *triage* and *reorientation* — and both reuse existing code (`applyStack`, single-pane
   mount, the `activity` flag, `captureCommand`).
3. Then **Fisheye (#2)** as a better default `grid`, and the **Fleet HUD + jump-keys (#4)**
   overlays which multiply the value of *every* arrangement (old and new).

Naming fits the existing set: **Tabs · Grid · Stack · Flow · Queue · Fisheye · Constellation.**

---

## Appendix — cross-cutting insights from the three lenses

- **Control-room lens:** every real control room treats *silence* as the most dangerous
  signal, not noise. The highest-leverage new signal is the cadence/silence watchdog
  (free from `onData`), which turns "happily churning" vs "quietly stuck" into a
  detectable, alarmable state — and should underpin every arrangement.
- **Attention-science lens:** the most valuable signal is the **negative space** —
  *"these 11 agents need nothing from you, ignore them."* Calm tech inverts the default:
  make the healthy majority disappear and let the *absence* of an alert mean "all is
  well." And rank by opportunity cost: `BLOCKED > ERROR`.
- **Power-tooling lens:** a human can only supervise ~3–5 agents at once; every winning
  borrowed pattern (control-group recall, snooze/archive, scratchpad stash, urgency-
  sorted cycling) is fundamentally a **set-reduction tool, not a tiling tool**. The
  winning arrangement makes *"show me only what I should look at next"* a single keystroke
  and treats full-fleet visibility as the rare overview, not the default.

### Method
3 subagents, one per lens, run in parallel via a Workflow; each returned 5–6 structured
concepts (name · problem solved · appearance · interaction · signals used ·
implementability · inspiration). Synthesized here against `terminals.js`. ~95k subagent
tokens. The convergence (same #1, same missing primitive, same ranking insight) was
independent across all three.
