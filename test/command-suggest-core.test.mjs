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

describe('buildCandidates', () => {
  it('uses only declared scripts and friendly-labels known entries', () => {
    const cands = buildCandidates({
      project: [script('npm run dev', 'dev'), script('npm run deploy', 'deploy')]
    })
    const byCmd = Object.fromEntries(cands.map((c) => [c.cmd, c]))
    expect(byCmd['npm run dev']).toMatchObject({
      kind: 'script',
      label: 'Start the app in development'
    })
    // Unknown script name falls back to the bare name as its label.
    expect(byCmd['npm run deploy']).toMatchObject({ kind: 'script', label: 'deploy' })
    expect(byCmd['git push']).toBeUndefined()
  })

  it('excludes already-favorited commands (suggest complements the ♥ list)', () => {
    const cands = buildCandidates({
      project: [script('npm run dev', 'dev')],
      favorites: [{ cmd: 'npm run dev' }]
    })
    expect(cands).toHaveLength(0)
  })
})

describe('planSuggestions — deterministic baseline', () => {
  it('prioritizes familiar project entrypoints and caps at 5', () => {
    const cands = buildCandidates({
      project: [
        script('npm run deploy', 'deploy'),
        script('npm run build', 'build'),
        script('npm run dev', 'dev')
      ]
    })
    const { baseline } = planSuggestions(cands)
    expect(baseline.length).toBeLessThanOrEqual(MAX_SUGGESTIONS)
    expect(baseline[0].cmd).toBe('npm run dev')
    expect(baseline[1].cmd).toBe('npm run build')
  })
})

describe('buildUserText', () => {
  it('lists candidates verbatim with a kind tag and names the project', () => {
    const cands = buildCandidates({ project: [script('npm run dev', 'dev')] })
    const { candidateOrder } = planSuggestions(cands)
    const text = buildUserText('my-app', candidateOrder)
    expect(text).toContain('project: my-app')
    expect(text).toContain('- npm run dev  [script]')
    expect(text).not.toContain('git push')
  })
})

describe('finalizeSuggestions — grounding', () => {
  const cands = buildCandidates({
    project: [
      script('npm run dev', 'dev'),
      script('npm run build', 'build'),
      script('npm test', 'test')
    ]
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
    expect(list.map((c) => c.cmd)).toContain('npm run build') // baseline fills in
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
