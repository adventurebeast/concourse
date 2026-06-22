import { describe, it, expect } from 'vitest'
import { matchesAwaitPrompt } from '../src/renderer/pulse-detect.js'

// Pulse · Layer 1 awaiting detector. Two duties, and the second matters more:
//   1. catch a genuine prompt the cursor is parked at (true positives), and
//   2. NEVER fire on flowing mid-output text (false positives are the cardinal sin —
//      docs/pulse-engine.md — they train you to ignore the signal).

describe('matchesAwaitPrompt — true positives (parked at a prompt)', () => {
  const yes = [
    'Overwrite existing file? (y/N)',
    'Delete 3 items? [Y/n]',
    'Continue? yes/no',
    'Enter passphrase for key /Users/me/.ssh/id_ed25519:',
    "[sudo] password for me:",
    'Do you want to proceed?',
    'Are you sure you want to remove node_modules?',
    'Press ENTER to continue',
    'Choose a template:',
    'Select an option:',
    // A multi-line tail whose LAST line is the prompt (what tailOf produces).
    'Building project...\nDone.\nProceed with deploy? (y/n)',
    // Claude-Code-style numbered permission menu with a cursor.
    'Do you want to make this edit?\n❯ 1. Yes\n  2. No',
    'Pick one:\n> 1) main\n  2) dev',
    'Restart now? [yes/no]'
  ]
  for (const tail of yes) {
    it(`fires on: ${JSON.stringify(tail).slice(0, 60)}`, () => {
      expect(matchesAwaitPrompt(tail)).toBe(true)
    })
  }
})

describe('matchesAwaitPrompt — false positives are the cardinal sin', () => {
  const no = [
    '', // empty
    '   \n  ', // whitespace only
    'Running tests... 42 passed', // ordinary progress
    'Updated password hashing to bcrypt in auth.js', // "password" mid-sentence, no prompt
    'The function returns yes/no depending on the flag.', // y/no mid-sentence, not at end
    'Why does this fail?\nLet me investigate the stack trace.', // a '?' but more output follows
    'Downloading model — 47%', // a Pulse provisioning line
    'commit 9f2a1: fix overwrite bug', // "overwrite" but not a question
    'console.log("press enter handler wired")\nWiring done.', // "press enter" mid-output, more after
    '$ ', // a bare shell prompt is idle, not awaiting
    'me@host ~/project % ', // zsh prompt — idle, not awaiting
    'error: continue statement not in loop' // "continue" but no question
  ]
  for (const tail of no) {
    it(`stays quiet on: ${JSON.stringify(tail).slice(0, 60)}`, () => {
      expect(matchesAwaitPrompt(tail)).toBe(false)
    })
  }
})

describe('matchesAwaitPrompt — guards', () => {
  it('tolerates non-strings', () => {
    expect(matchesAwaitPrompt(null)).toBe(false)
    expect(matchesAwaitPrompt(undefined)).toBe(false)
    expect(matchesAwaitPrompt(42)).toBe(false)
  })
})
