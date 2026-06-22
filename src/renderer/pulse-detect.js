// Pulse · Layer 1 — the deterministic "awaiting you" detector. Pure, synchronous, free,
// offline: the floor that works with NO model configured. Given the rendered tail of a
// settled pane (the last few visible rows, where a parked cursor sits), decide whether an
// agent has come to rest needing you — a y/N, a password, a permission, a numbered menu.
//
// False positives are the cardinal sin (docs/pulse-engine.md): an edge that fires while
// the agent is still thinking trains you to ignore it, and then the whole mechanism is
// worthless. So every pattern is ANCHORED to the end of the tail — a mention of "(y/n)"
// or "password" in flowing mid-output text must not trip it; only a prompt the cursor is
// actually parked at counts. Kept in its own module so it can be unit-tested without a DOM.

export const AWAIT_PROMPT_RES = [
  /\(y(?:es)?\/n(?:o)?\)\s*[?:]?\s*$/i, //          (y/N)  (yes/no)
  /\[y(?:es)?\/n(?:o)?\]\s*[?:]?\s*$/i, //          [Y/n]
  /\by(?:es)?\s*\/\s*no\b\s*[?:]?\s*$/i, //         yes / no
  /\b(?:pass(?:word|phrase)|passcode)\b[^\n]*:\s*$/i, // Password: / passphrase for …:
  /\b(?:proceed|continue|overwrite|replace|are you sure|do you want|ok to|allow)\b[^\n]*\?\s*$/i,
  /\bpress\s+(?:enter|return|any key)\b[^\n]*$/i, // press enter to continue
  /\b(?:choose|select|enter|type)\b[^?\n]{0,40}:\s*$/i, // choose an option:
  /[❯➤▶>]\s*\d+[.)]\s+\S/, //                      a numbered menu w/ a cursor (e.g. Claude Code)
  /\?\s+(?:\[[^\]]+\]|\([^)]+\))\s*$/ //            trailing "? [a/b]" or "? (default)"
]

// Does the settled tail show an explicit input affordance? Pure boolean over the text.
export function matchesAwaitPrompt(tail) {
  if (typeof tail !== 'string' || !tail) return false
  return AWAIT_PROMPT_RES.some((re) => re.test(tail))
}
