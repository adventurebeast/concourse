import { describe, it, expect } from 'vitest'
import {
  buildCandidates,
  planSuggestions,
  buildUserText,
  finalizeSuggestions,
  MAX_SUGGESTIONS
} from '../src/main/command-suggest-core.js'

// command-suggest-core.js is pure (no electron / no IO), so the risky bits behind the
// palette's "Suggested" group are unit-testable directly: candidate assembly, the
// deterministic baseline ordering, and — most importantly — the GROUNDING that drops
// any command the model invents. The electron-wired shell (stores + model + cache)
// lives in command-suggest.js.

const script = (cmd, label) => ({ cmd, label, source: 'npm' })
const recent = (cmd, score) => ({ cmd, score })

describe('buildCandidates', () => {
  it('merges scripts + history, friendly-labels known scripts, keeps the command as the recent label', () => {
    const cands = buildCandidates({
      project: [script('npm run dev', 'dev'), script('npm run deploy', 'deploy')],
      thisProject: [recent('git push', 10)],
      global: []
    })
    const byCmd = Object.fromEntries(cands.map((c) => [c.cmd, c]))
    expect(byCmd['npm run dev']).toMatchObject({
      kind: 'script',
      label: 'Start the app in development'
    })
    // Unknown script name falls back to the bare name as its label.
    expect(byCmd['npm run deploy']).toMatchObject({ kind: 'script', label: 'deploy' })
    // A recent command uses the command itself as its label.
    expect(byCmd['git push']).toMatchObject({ kind: 'recent', label: 'git push', score: 10 })
  })

  it('excludes already-favorited commands (suggest complements the ♥ list)', () => {
    const cands = buildCandidates({
      project: [script('npm run dev', 'dev')],
      thisProject: [recent('git push', 5)],
      favorites: [{ cmd: 'git push' }, { cmd: 'npm run dev' }]
    })
    expect(cands).toHaveLength(0)
  })

  it('a script that is also frequently run keeps its script label but gains the run score', () => {
    const [only] = buildCandidates({
      project: [script('npm test', 'test')],
      thisProject: [recent('npm test', 42)]
    })
    expect(only).toMatchObject({ kind: 'script', label: 'Run the tests', score: 42 })
  })
})

describe('planSuggestions — deterministic baseline', () => {
  it('interleaves priority entrypoints with most-run commands and caps at 5', () => {
    const cands = buildCandidates({
      project: [script('npm run dev', 'dev'), script('npm run build', 'build')],
      thisProject: [
        recent('git push', 30),
        recent('git status', 20),
        recent('docker compose up', 5)
      ]
    })
    const { baseline } = planSuggestions(cands)
    expect(baseline.length).toBeLessThanOrEqual(MAX_SUGGESTIONS)
    // Leads with a priority script, then the top recent — a useful spread, not 5 scripts.
    expect(baseline[0].cmd).toBe('npm run dev')
    expect(baseline[1].cmd).toBe('git push')
  })
})

describe('buildUserText', () => {
  it('lists candidates verbatim with a kind tag and names the project', () => {
    const cands = buildCandidates({
      project: [script('npm run dev', 'dev')],
      thisProject: [recent('git push', 1)]
    })
    const { candidateOrder } = planSuggestions(cands)
    const text = buildUserText('my-app', candidateOrder)
    expect(text).toContain('project: my-app')
    expect(text).toContain('- npm run dev  [script]')
    expect(text).toContain('- git push  [you run this]')
  })
})

describe('finalizeSuggestions — grounding', () => {
  const cands = buildCandidates({
    project: [script('npm run dev', 'dev'), script('npm run build', 'build')],
    thisProject: [recent('git push', 10)]
  })
  const { baseline } = planSuggestions(cands)

  it('falls back to the baseline (degraded) when there is no model reply', () => {
    expect(finalizeSuggestions(null, cands, baseline)).toEqual({ list: baseline, degraded: true })
  })

  it('keeps model picks that exist and uses the model’s label', () => {
    const raw = JSON.stringify({
      commands: [{ cmd: 'npm run dev', label: 'Boot the dev server' }]
    })
    const { list, degraded } = finalizeSuggestions(raw, cands, baseline)
    expect(degraded).toBe(false)
    expect(list[0]).toEqual({ cmd: 'npm run dev', label: 'Boot the dev server' })
  })

  it('DROPS invented commands not in the candidate set (the safety property)', () => {
    const raw = JSON.stringify({
      commands: [
        { cmd: 'rm -rf /', label: 'clean everything' }, // hallucinated + dangerous
        { cmd: 'npm run deploy --prod', label: 'ship it' }, // edited/invented flag
        { cmd: 'npm run build', label: 'Build it' } // real
      ]
    })
    const { list } = finalizeSuggestions(raw, cands, baseline)
    const cmds = list.map((c) => c.cmd)
    expect(cmds).not.toContain('rm -rf /')
    expect(cmds).not.toContain('npm run deploy --prod')
    expect(cmds).toContain('npm run build')
  })

  it('backfills from the baseline so a thin reply still returns a useful list', () => {
    const raw = JSON.stringify({ commands: [{ cmd: 'npm run dev', label: 'Dev' }] })
    const { list } = finalizeSuggestions(raw, cands, baseline)
    expect(list.length).toBeGreaterThan(1)
    expect(list[0].cmd).toBe('npm run dev') // model pick leads
    expect(list.map((c) => c.cmd)).toContain('git push') // baseline fills in
  })

  it('tolerates a code-fenced reply and de-dupes repeated picks', () => {
    const raw =
      '```json\n{"commands":[{"cmd":"npm run dev","label":"a"},{"cmd":"npm run dev","label":"b"}]}\n```'
    const { list } = finalizeSuggestions(raw, cands, baseline)
    expect(list.filter((c) => c.cmd === 'npm run dev')).toHaveLength(1)
  })

  it('treats unparseable output as no model contribution', () => {
    expect(finalizeSuggestions('sorry, I could not help', cands, baseline)).toEqual({
      list: baseline,
      degraded: true
    })
  })
})
