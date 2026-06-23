// Animated braille "thinking" matrix for working panes.
//
// JS-driven ON PURPOSE (CSS `content` keyframes don't animate reliably in this Chromium):
// one global ticker writes a 4×4 braille pattern into every `.dot.working`. The figure is a
// Matrix-style RAIN — droplets fall down each of the 4 columns with a short trailing streak,
// spawning at random so the grid never settles into an obvious short loop. Two braille cells
// side by side = a 4-wide, 4-tall dot grid. CSS owns size/colour/shimmer; this only swaps the
// characters. One shared rain state drives every working dot (cheap, and they stay in sync).

// Dot bits within one braille cell (Unicode U+2800 base), rows top→bottom.
const LEFT_COL = [0x01, 0x02, 0x04, 0x40] // the cell's left dot column
const RIGHT_COL = [0x08, 0x10, 0x20, 0x80] // the cell's right dot column

// A w×h dot grid backed by two side-by-side braille cells.
// x: 0..3 columns (left→right), y: 0..3 rows (top→bottom).
function makeCanvas(w, h) {
  const cells = [0, 0]
  return {
    w,
    h,
    clear() {
      cells[0] = 0
      cells[1] = 0
    },
    set(x, y) {
      const cell = x < 2 ? 0 : 1
      const colBits = x % 2 === 0 ? LEFT_COL : RIGHT_COL
      cells[cell] |= colBits[y]
    },
    glyph() {
      return String.fromCharCode(0x2800 + cells[0]) + String.fromCharCode(0x2800 + cells[1])
    },
  }
}

function makeRain(c) {
  const cols = new Array(c.w).fill(null) // null = idle column
  return function (spawn) {
    // spawn = chance an idle column starts a drop. Trails are short (1–2) so a drop reads as
    // a falling droplet, not a column-filling block — the grid is only 4 rows tall.
    c.clear()
    for (let x = 0; x < c.w; x++) {
      let col = cols[x]
      if (!col) {
        if (Math.random() < spawn) col = cols[x] = { y: 0, trail: 1 + ((Math.random() * 2) | 0) }
        else continue
      } else {
        col.y++ // fall one cell
      }
      for (let t = 0; t < col.trail; t++) {
        // head + streak above it
        const yy = col.y - t
        if (yy >= 0 && yy < c.h) c.set(x, yy)
      }
      if (col.y - col.trail >= c.h) cols[x] = null // fully off-screen → free the column
    }
  }
}

const SPAWN = 0.25 // per-fall chance an idle column starts a new drop
// Drops fall one row every FALL_EVERY ticks. The ticker runs at 70ms (CSS shimmer cadence),
// but falling a row every tick (~14 rows/s) is too fast to read as rain on a 4-row grid —
// every 3rd tick (~210ms/row) lets the eye actually follow a droplet down.
const FALL_EVERY = 3

const canvas = makeCanvas(4, 4)
const rain = makeRain(canvas)

// Honour prefers-reduced-motion: when set, we freeze on a single static frame (no churn).
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const staticGlyph = (() => {
  canvas.clear()
  for (let x = 0; x < canvas.w; x++) canvas.set(x, x % canvas.h) // a calm diagonal speckle
  return canvas.glyph()
})()

let tick = 0
setInterval(() => {
  // Cheap exits first — the common state is "nothing working", and a hidden/
  // reduced-motion window must not burn CPU churning textContent every 70ms.
  if (document.hidden) return // background tab/window: don't animate
  // Short-circuit the common idle case cheaply: if nothing is working, skip the
  // per-dot mutation pass entirely (no working dots to drive, none to clear).
  if (!document.querySelector('.dot.working')) return
  // Reduced motion: freeze on a single static frame; otherwise advance the rain on its own
  // (slower) fall cadence — the ticker fires every 70ms but drops only fall every FALL_EVERY.
  let glyph
  if (reduceMotion.matches) {
    glyph = staticGlyph
  } else {
    if (tick++ % FALL_EVERY === 0) rain(SPAWN)
    glyph = canvas.glyph()
  }
  for (const dot of document.querySelectorAll('.dot')) {
    if (dot.classList.contains('working')) {
      if (dot.textContent !== glyph) dot.textContent = glyph
    } else if (dot.textContent) {
      dot.textContent = '' // a dot that stopped working must not keep a stale glyph
    }
  }
}, 70)
