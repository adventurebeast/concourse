export const meta = {
  name: 'concourse-bughunt-wave-b',
  description: 'Lean breadth pass: bug-hunt the UNTOUCHED files Wave A never opened + cross-subsystem integration bugs',
  phases: [
    { title: 'Find', detail: '4 finders: untouched main, untouched renderer, glue, whole-flow integration' },
    { title: 'Verify', detail: '1 refute-by-default skeptic per finding' },
  ],
}

const ROOT = '/Users/Admin/local_development/concourse'

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string' },
          severity: { type: 'string', enum: ['launch-blocker', 'data-loss', 'security', 'correctness', 'minor'] },
          description: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'file', 'line', 'severity', 'description', 'evidence', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    real: { type: 'boolean' },
    falsePositiveReason: { type: 'string' },
    severityAdjusted: { type: 'string', enum: ['launch-blocker', 'data-loss', 'security', 'correctness', 'minor'] },
    notes: { type: 'string' },
  },
  required: ['real', 'falsePositiveReason', 'severityAdjusted', 'notes'],
}

const COMMON = `You are auditing the Concourse Electron app (an IDE for AI CLI agents) for a 1.0 launch. Find REAL bugs that manifest at runtime — NOT style, NOT speculative perf. Priority order: launch-blocker > data-loss > security > correctness > minor. Cite exact file:line and quote the code. You MAY read beyond your listed files (grep/Read across ${ROOT}/src) to confirm a cross-file issue — dive as deep as the bug requires. Do not invent bugs you cannot prove from the code. Empty array if clean. Repo root: ${ROOT}.`

const BUCKETS = [
  {
    key: 'untouched-main',
    files: ['src/main/ipc-workspace.js', 'src/main/ipc-search.js', 'src/main/context.js'],
    focus: 'Per-window context map lifecycle (set/forget/leak on window close), workspace root resolution + watcher start/replace on open, search confinement (can search escape the root? ReDoS / huge-result DoS? command injection if it shells out to grep/rg?), and how these interplay with the (changed) paths.js confinement. Look for: a window context never forgotten, a search that walks outside root, an unbounded result set.',
  },
  {
    key: 'untouched-renderer',
    files: ['src/renderer/git.js', 'src/renderer/search.js', 'src/renderer/welcome.js'],
    focus: 'Git UI (commit/stage/discard/init) silent failure paths, search panel rendering + result handling, welcome/recents flow + folder open handoff. Look for: an unhandled rejection on a failed git/fs call, a result list that XSS-injects unescaped paths via innerHTML, a recents entry that breaks the open flow.',
  },
  {
    key: 'glue',
    files: ['src/renderer/keybindings.js', 'src/renderer/commandPalette.js', 'src/renderer/projectType.js', 'src/renderer/beginnerHud.js', 'src/renderer/icons.js'],
    focus: 'Keybinding registration (duplicate/leaked listeners, mod-key matching, conflicts with menu accelerators), command palette actions wiring to real handlers, project-type detection edge cases (missing files, throws), beginner HUD lifecycle, icons. Look for: a binding that throws, a palette command pointing at a removed function, a detector that throws on an empty/odd repo.',
  },
  {
    key: 'whole-flow-integration',
    files: ['src/main/index.js', 'src/main/ipc-workspace.js', 'src/main/ipc-pty.js', 'src/main/ipc-pulse.js', 'src/main/session.js', 'src/main/watcher.js', 'src/renderer/main.js'],
    focus: 'CROSS-SUBSYSTEM integration bugs that span files, not single-file defects. Trace the real user flows end to end: (1) boot -> restore last session -> open folder -> start watcher -> spawn PTY with correct cwd -> Pulse summarize -> persist recents/session; (2) quit -> before-quit flushSync drains ALL stores (session, recents, settings) -> PTYs killed -> watchers stopped -> contexts forgotten; (3) open Settings window -> change a setting -> settings:changed broadcasts -> workbench applies live without a loop. Look for ordering bugs, a store that flushSync forgets, a per-window resource leaked across the multi-window model, a setting that does not take effect until restart, an await missing between two dependent steps.',
  },
]

phase('Find')
const results = await pipeline(
  BUCKETS,
  (b) =>
    agent(
      `${COMMON}\n\nYOUR SCOPE — bucket "${b.key}". Start from these files under ${ROOT}:\n${b.files.map((f) => '  - ' + f).join('\n')}\n\nFOCUS: ${b.focus}\n\nReturn structured findings.`,
      { label: `find:${b.key}`, phase: 'Find', schema: FINDING_SCHEMA, effort: 'high' }
    ),
  (res, b) => {
    const findings = (res && res.findings) || []
    return parallel(
      findings.map((f) => () =>
        agent(
          `Adversarially judge this claimed bug. Default to real=false unless you can PROVE from the code it manifests at runtime on a normal path. Read ${ROOT}/${f.file} near line ${f.line} and any cross-file dependency. Claim: "${f.title}". ${f.description}. Evidence: ${f.evidence}. Mark real=false if already mitigated, misread, speculative, or style-only.`,
          { label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'medium' }
        ).then((v) => ({ ...f, bucket: b.key, confirmed: !!(v && v.real), verdict: v }))
      )
    )
  }
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter((f) => f.confirmed)
const order = { 'launch-blocker': 0, 'data-loss': 1, security: 2, correctness: 3, minor: 4 }
confirmed.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))

log(`Wave B complete: ${all.length} raw findings, ${confirmed.length} survived verification`)
return {
  totalRaw: all.length,
  confirmedCount: confirmed.length,
  confirmed: confirmed.map((f) => ({
    title: f.title, file: f.file, line: f.line, severity: f.severity,
    description: f.description, evidence: f.evidence, fix: f.fix, bucket: f.bucket,
  })),
  rejected: all.filter((f) => !f.confirmed).map((f) => ({ title: f.title, file: f.file, severity: f.severity })),
}
