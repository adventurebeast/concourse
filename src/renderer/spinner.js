// Animated braille "thinking" matrix for working panes.
//
// JS-driven ON PURPOSE (CSS `content` keyframes don't animate reliably in this Chromium):
// one global ticker writes a 4×4 braille pattern into every `.dot.working`. The pattern is
// ALGORITHMIC — each of the 4 columns lights a vertical band whose centre rides an offset
// sine wave, so a ripple travels across the grid and the figure never settles into an
// obvious short loop ("numerous patterns"). Two braille cells side by side = a 4-wide,
// 4-tall dot grid. CSS owns size/colour/shimmer; this only swaps the characters.

// Dot bits within one braille cell (Unicode U+2800 base), rows top→bottom.
const LEFT_COL = [0x01, 0x02, 0x04, 0x40] // the cell's left dot column
const RIGHT_COL = [0x08, 0x10, 0x20, 0x80] // the cell's right dot column

function brailleWave(t) {
  const cells = [0, 0]
  for (let gridCol = 0; gridCol < 4; gridCol++) {
    const cell = gridCol < 2 ? 0 : 1
    const colBits = gridCol % 2 === 0 ? LEFT_COL : RIGHT_COL
    // band centre travels: each column phase-shifted so the ripple sweeps across.
    const centre = 1.5 + 1.45 * Math.sin(t * 0.17 + gridCol * 1.05)
    for (let row = 0; row < 4; row++) {
      if (Math.abs(row - centre) <= 1.05) cells[cell] |= colBits[row]
    }
  }
  return String.fromCharCode(0x2800 + cells[0]) + String.fromCharCode(0x2800 + cells[1])
}

// Honour prefers-reduced-motion: when set, we freeze the glyph (no per-tick churn).
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

let t = 0
setInterval(() => {
  // Cheap exits first — the common state is "nothing working", and a hidden/
  // reduced-motion window must not burn CPU churning textContent every 70ms.
  if (document.hidden) return // background tab/window: don't animate
  // Short-circuit the common idle case cheaply: if nothing is working, skip the
  // per-dot mutation pass entirely (no working dots to drive, none to clear).
  if (!document.querySelector('.dot.working')) return
  // Reduced motion: freeze on a single static frame; otherwise advance the wave.
  const glyph = reduceMotion.matches ? brailleWave(0) : brailleWave(++t)
  for (const dot of document.querySelectorAll('.dot')) {
    if (dot.classList.contains('working')) {
      if (dot.textContent !== glyph) dot.textContent = glyph
    } else if (dot.textContent) {
      dot.textContent = '' // a dot that stopped working must not keep a stale glyph
    }
  }
}, 70)
