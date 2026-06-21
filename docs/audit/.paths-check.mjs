// Verification of the path-confinement security boundary (paths.js is pure Node).
// confine() must reject every attempt to escape the workspace root; confineRel()
// must additionally reject absolute paths and any '..' segment up front.
import os from 'os'
import path from 'path'
import fs from 'fs'
import { confine, confineRel } from '../../src/main/paths.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-paths-'))
const root = path.join(base, 'workspace')
fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'hi')
// Sibling OUTSIDE root sharing a name prefix (prefix-match attack: /workspace vs /workspaceEVIL)
const evil = root + 'EVIL'
fs.mkdirSync(evil, { recursive: true })
fs.writeFileSync(path.join(evil, 'secret.txt'), 'secret')
// A symlink INSIDE root that points OUTSIDE it.
const link = path.join(root, 'escape-link')
try {
  fs.symlinkSync(evil, link)
} catch {
  /* symlink may fail in some sandboxes; that test will just be skipped */
}

let pass = 0,
  fail = 0
const ok = (name, cond) => {
  if (cond) {
    pass++
    console.log('  ok  ' + name)
  } else {
    fail++
    console.log('FAIL  ' + name)
  }
}
const allows = (fn) => {
  try {
    fn()
    return true
  } catch {
    return false
  }
}
const blocks = (fn) => {
  try {
    fn()
    return false
  } catch (e) {
    return e && e.message === 'EPATHESCAPE'
  }
}

// confine() — absolute targets
ok('confine allows an existing file inside root', allows(() => confine(root, path.join(root, 'sub', 'file.txt'))))
ok('confine allows a not-yet-existing target inside root', allows(() => confine(root, path.join(root, 'sub', 'new.txt'))))
ok('confine blocks an absolute path outside root', blocks(() => confine(root, path.join(evil, 'secret.txt'))))
ok('confine blocks the prefix-match sibling (rootEVIL)', blocks(() => confine(root, path.join(evil, 'x'))))
ok('confine blocks a null/empty root', blocks(() => confine('', path.join(root, 'a'))))
if (fs.existsSync(link)) {
  ok('confine blocks a symlink inside root that escapes it', blocks(() => confine(root, path.join(link, 'secret.txt'))))
}

// confineRel() — relative targets
ok('confineRel allows a clean relative path', allows(() => confineRel(root, 'sub/file.txt')))
ok('confineRel blocks an absolute path', blocks(() => confineRel(root, '/etc/passwd')))
ok('confineRel blocks a leading ../ traversal', blocks(() => confineRel(root, '../workspaceEVIL/secret.txt')))
ok('confineRel blocks an embedded /../ traversal', blocks(() => confineRel(root, 'sub/../../workspaceEVIL/secret.txt')))
ok('confineRel returns an absolute confined path', (() => {
  const r = confineRel(root, 'sub/file.txt')
  return path.isAbsolute(r) && r.endsWith(path.join('sub', 'file.txt'))
})())

fs.rmSync(base, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
