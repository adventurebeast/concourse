// dot-figure.js — draws the thinking figure as a real SVG dot matrix.
//
// Why not braille font glyphs: in the GUI the braille block falls back to a proportional
// braille font, so cell widths shift frame-to-frame and the figure renders garbled. Drawing
// the engine's dot grid as actual SVG circles is crisp, fixed-width, and identical everywhere
// (browser preview == Electron). Colour comes from CSS `color` via fill:currentColor, so the
// existing state styling (working = hue, resting = grey, active tab = white) just works.

import { GRID } from './braille-thinker.js'

const NS = 'http://www.w3.org/2000/svg'
const R = 0.74 // dot radius in grid half-units (cell pitch = 2) — round, lightly separated

// Build an SVG figure (one per `.dot`). N circles laid out on the W×H grid, all off to start.
// The circle elements are cached on the node (`__dots`) so paint() is a cheap opacity flip.
export function makeFigure() {
  const { w, h } = GRID
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'dot-fig')
  svg.setAttribute('viewBox', `0 0 ${w * 2} ${h * 2}`)
  svg.setAttribute('aria-hidden', 'true')
  const dots = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = document.createElementNS(NS, 'circle')
      c.setAttribute('cx', x * 2 + 1)
      c.setAttribute('cy', y * 2 + 1)
      c.setAttribute('r', R)
      c.setAttribute('fill', 'currentColor')
      c.style.opacity = '1' // default to the full "resting" figure; the ticker animates it once working
      svg.appendChild(c)
      dots.push(c) // index === y*w + x, matching the engine's row-major grid
    }
  }
  svg.__dots = dots
  return svg
}

// Apply a dot grid (Uint8Array, 0/1 per cell) to a figure: each lit cell's circle is shown.
// Skips no-op writes so an unchanged frame costs nothing.
export function paint(svg, grid) {
  const dots = svg && svg.__dots
  if (!dots) return
  for (let i = 0; i < dots.length; i++) {
    const on = grid[i] ? '1' : '0'
    if (dots[i].style.opacity !== on) dots[i].style.opacity = on
  }
}
