// braille-thinker.js — the WORKING animation engine.
//
// A figure on a 6×4 dot grid. Fifteen effects live in one array (each is `(t, st) => grid`).
// ONE PATTERN PER WORKING PHASE: a pane picks a single effect when it starts working and
// animates only that effect for the whole stint; the next working phase picks the next effect
// from a shared shuffle-bag (all 15 play before any repeat). So it reads think(A) → rest →
// think(B) → rest, never churning patterns mid-stint.
//
// Render-only and host-agnostic: createThinker() gives a pane its own animator (its own effect
// + per-instance state for the stateful effects); dot-figure.js draws the returned grid as SVG.
// No timers, no DOM — the caller owns the ticker (see the working ticker in terminals.js).

const W = 6, H = 4, N = W * H

const blank = () => new Uint8Array(N)
const setp = (g, x, y) => {
  x = Math.round(x); y = Math.round(y)
  if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = 1
}

// ---- shared helpers -------------------------------------------------------
const tri = (ph, span) => { const p = ((ph % (2 * span)) + 2 * span) % (2 * span); return p <= span ? p : 2 * span - p }
function perim() {
  const p = []; let x, y
  for (x = 0; x < W; x++) p.push([x, 0])
  for (y = 1; y < H; y++) p.push([W - 1, y])
  for (x = W - 2; x >= 0; x--) p.push([x, H - 1])
  for (y = H - 2; y >= 1; y--) p.push([0, y])
  return p
}
function snakePath() {
  const p = []; let x, y
  for (y = 0; y < H; y++) {
    if (y % 2 === 0) for (x = 0; x < W; x++) p.push([x, y])
    else for (x = W - 1; x >= 0; x--) p.push([x, y])
  }
  return p
}
const PER = perim(), SNK = snakePath()

// ---- the 15 effects -------------------------------------------------------
// `t` is the per-phase frame counter (starts at 0 each working stint). `st` is a per-pane,
// per-phase scratch object (reset to {} on every pick) so the stateful effects (rain, bars)
// never leak state between phases or between panes.
const EFFECTS = [
  { name: 'wave', draw(t) {
      const g = blank()
      for (let x = 0; x < W; x++) { const v = Math.sin(t * 0.28 + x * 0.95); setp(g, x, (v * 0.5 + 0.5) * (H - 1)) }
      return g
  } },
  { name: 'orbit', draw(t) {
      const g = blank(), n = PER.length
      for (let i = 0; i < 4; i++) { const p = PER[((t - i) % n + n) % n]; setp(g, p[0], p[1]) }
      return g
  } },
  { name: 'pulse', draw(t) {
      const g = blank(), cx = (W - 1) / 2, cy = (H - 1) / 2, ph = t % 6, r = ph <= 3 ? ph : 6 - ph
      for (let x = 0; x < W; x++) for (let y = 0; y < H; y++)
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= r) setp(g, x, y)
      return g
  } },
  { name: 'ripple', draw(t) {
      const g = blank(), cx = (W - 1) / 2, cy = (H - 1) / 2, r = t % 4
      for (let x = 0; x < W; x++) for (let y = 0; y < H; y++)
        if (Math.round(Math.max(Math.abs(x - cx), Math.abs(y - cy))) === r) setp(g, x, y)
      return g
  } },
  { name: 'sweep', draw(t) {
      const g = blank(), per = 2 * (W - 1), ph = t % per, x = ph < W ? ph : per - ph
      for (let y = 0; y < H; y++) setp(g, x, y)
      return g
  } },
  { name: 'scan', draw(t) {
      const g = blank(), y = tri(t, H - 1)
      for (let x = 0; x < W; x++) setp(g, x, y)
      return g
  } },
  { name: 'bounce', draw(t) {
      const g = blank(); setp(g, tri(t, 5), tri(t + 1, 3)); return g
  } },
  { name: 'snake', draw(t) {
      const g = blank(), n = SNK.length
      for (let i = 0; i < 7; i++) { const p = SNK[((t - i) % n + n) % n]; setp(g, p[0], p[1]) }
      return g
  } },
  { name: 'bars', draw(t, st) {
      if (!st.bars) st.bars = new Array(W).fill(0)
      const bars = st.bars, g = blank()
      for (let x = 0; x < W; x++) {
        const target = Math.abs(Math.sin(t * 0.22 + x * 1.3)) * 0.7 + Math.random() * 0.3
        const h = Math.round(Math.min(1, target) * H)
        bars[x] = h > bars[x] ? h : Math.max(h, bars[x] - 1)
        for (let y = H - 1; y >= H - bars[x]; y--) setp(g, x, y)
      }
      return g
  } },
  { name: 'spiral', draw(t) {
      const g = blank(), cx = (W - 1) / 2, cy = (H - 1) / 2, a = t * 0.45
      for (let r = 0; r <= 1.0001; r += 0.33) setp(g, cx + Math.cos(a) * r * 2.5, cy + Math.sin(a) * r * 1.5)
      return g
  } },
  { name: 'comet', draw(t) {
      const g = blank(), per = W + 3, ph = t % per, y = (Math.floor(t / per)) % H
      for (let i = 0; i < 3; i++) { const x = ph - i; if (x >= 0 && x < W) setp(g, x, y) }
      return g
  } },
  { name: 'rain', draw(t, st) {
      if (!st.rain) st.rain = new Array(W).fill(null)
      const rain = st.rain, g = blank(); let active = 0
      for (let x = 0; x < W; x++) { const c = rain[x]; if (c) { c.y++; if (c.y >= H) rain[x] = null; else active++ } }
      if (active < 2 && Math.random() < 0.5) {
        const empties = []; for (let x = 0; x < W; x++) if (!rain[x]) empties.push(x)
        if (empties.length) rain[empties[(Math.random() * empties.length) | 0]] = { y: 0 }
      }
      for (let x = 0; x < W; x++) if (rain[x]) setp(g, x, rain[x].y)
      return g
  } },
  { name: 'twinkle', draw() {
      const g = blank()
      for (let i = 0; i < 2; i++) setp(g, (Math.random() * W) | 0, (Math.random() * H) | 0)
      return g
  } },
  { name: 'ellipsis', draw(t) {
      const g = blank(), step = Math.floor(t / 2) % 5, xs = [1, 3, 5]
      for (let i = 0; i < step && i < 3; i++) setp(g, xs[i], 2)
      return g
  } },
  { name: 'heartbeat', draw(t) {
      const g = blank(), ph = t % 14, on = (ph < 2) || (ph >= 3 && ph < 5), cx = (W - 1) / 2, cy = (H - 1) / 2
      if (on) for (let x = 0; x < W; x++) for (let y = 0; y < H; y++)
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= 1.6) setp(g, x, y)
      return g
  } },
]

// ---- shared shuffle-bag: the order patterns are handed out across all panes/phases --------
// One bag for the whole app, so successive working phases (any pane) rotate through all 15
// before any repeats. lastIdx guards against the same effect landing twice across a refill.
const idxs = EFFECTS.map((_, i) => i)
let bag = [], lastIdx = -1
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]] } return a }
function pickIdx() {
  if (!bag.length) { bag = shuffle(idxs); if (bag[0] === lastIdx && bag.length > 1) bag.push(bag.shift()) }
  return (lastIdx = bag.shift())
}

// ---- public API -----------------------------------------------------------
// GRID: figure dimensions in dots (6 wide × 4 tall). Used to lay out the SVG dot matrix.
export const GRID = { w: W, h: H, n: N }

// RESTING_GRID / STATIC_GRID: the FULL figure — every dot on, static. RESTING is what a pane
// shows when NOT working (CSS greys it); STATIC is the frozen working frame for reduced motion.
export const RESTING_GRID = (() => { const g = blank(); for (let i = 0; i < N; i++) g[i] = 1; return g })()
export const STATIC_GRID = RESTING_GRID

// createThinker(): one animator per pane. It holds a single current effect (+ its per-phase
// scratch state) and draws that ONE pattern. Call pick() on the rest→work edge to advance to
// the next pattern for the new phase; call draw(t) each frame (t = frames since the phase began).
export function createThinker() {
  let idx = pickIdx() // chosen up front so a pane created already-working has a pattern
  let st = {}
  return {
    pick() { idx = pickIdx(); st = {} }, // new working phase → next pattern, fresh scratch state
    draw(t) { return EFFECTS[idx].draw(t, st) },
    get name() { return EFFECTS[idx].name }
  }
}
