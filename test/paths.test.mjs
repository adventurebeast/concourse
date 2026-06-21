import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { confine, confineRel } from '../src/main/paths.js'

// The path-confinement security boundary: confine() must reject every escape from
// the workspace root; confineRel() additionally rejects absolute paths and '..'.

let base, root, evil, link
beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-paths-'))
  root = path.join(base, 'workspace')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'sub', 'file.txt'), 'hi')
  // Sibling OUTSIDE root sharing a name prefix (prefix-match attack).
  evil = root + 'EVIL'
  fs.mkdirSync(evil, { recursive: true })
  fs.writeFileSync(path.join(evil, 'secret.txt'), 'secret')
  // A symlink INSIDE root pointing OUTSIDE it.
  link = path.join(root, 'escape-link')
  try {
    fs.symlinkSync(evil, link)
  } catch {
    link = null // symlink may be unavailable in some sandboxes
  }
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

const isEscape = (fn) => {
  try {
    fn()
    return false
  } catch (e) {
    return e && e.message === 'EPATHESCAPE'
  }
}

describe('confine (absolute targets)', () => {
  it('allows an existing file inside root', () => {
    expect(() => confine(root, path.join(root, 'sub', 'file.txt'))).not.toThrow()
  })
  it('allows a not-yet-existing target inside root', () => {
    expect(() => confine(root, path.join(root, 'sub', 'new.txt'))).not.toThrow()
  })
  it('blocks a path outside root', () => {
    expect(isEscape(() => confine(root, path.join(evil, 'secret.txt')))).toBe(true)
  })
  it('blocks the prefix-match sibling (rootEVIL)', () => {
    expect(isEscape(() => confine(root, path.join(evil, 'x')))).toBe(true)
  })
  it('blocks a null/empty root', () => {
    expect(isEscape(() => confine('', path.join(root, 'a')))).toBe(true)
  })
  it('blocks a symlink inside root that escapes it', () => {
    if (!link) return
    expect(isEscape(() => confine(root, path.join(link, 'secret.txt')))).toBe(true)
  })
})

describe('confineRel (relative targets)', () => {
  it('allows a clean relative path and returns an absolute confined path', () => {
    const r = confineRel(root, 'sub/file.txt')
    expect(path.isAbsolute(r)).toBe(true)
    expect(r.endsWith(path.join('sub', 'file.txt'))).toBe(true)
  })
  it('blocks an absolute path', () => {
    expect(isEscape(() => confineRel(root, '/etc/passwd'))).toBe(true)
  })
  it('blocks a leading ../ traversal', () => {
    expect(isEscape(() => confineRel(root, '../workspaceEVIL/secret.txt'))).toBe(true)
  })
  it('blocks an embedded /../ traversal', () => {
    expect(isEscape(() => confineRel(root, 'sub/../../workspaceEVIL/secret.txt'))).toBe(true)
  })
})
