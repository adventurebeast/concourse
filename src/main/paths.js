import fs from 'fs'
import path from 'path'

// Path confinement for the IPC boundary. Every renderer-supplied path that the
// main process turns into a filesystem operation must be proven to live INSIDE
// the open workspace root before use. Symlinks are resolved on both sides so a
// link inside the workspace can't point the operation outside it.

// Resolve `p` to an absolute path and verify it sits inside `root`. Returns the
// safe absolute path, or throws a tagged Error('EPATHESCAPE'). `p` may name a
// not-yet-existing target (a create/rename destination); in that case the parent
// directory is resolved and the basename re-appended.
export function confine(root, p) {
  if (!root) throw new Error('EPATHESCAPE')
  const resolved = path.resolve(p)
  const realRoot = fs.realpathSync(root)
  let real
  try {
    // Existing target: resolve it directly (follows any symlinks).
    real = fs.realpathSync(resolved)
  } catch {
    // Target doesn't exist yet: resolve its parent and re-attach the name.
    real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved))
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error('EPATHESCAPE')
  }
  return real
}

// Confine a renderer-supplied RELATIVE path against `root`. Rejects absolute
// paths and any '..' traversal segment outright before delegating to confine().
export function confineRel(root, relPath) {
  if (typeof relPath !== 'string') throw new Error('EPATHESCAPE')
  if (path.isAbsolute(relPath)) throw new Error('EPATHESCAPE')
  if (relPath.split(/[\\/]/).includes('..')) throw new Error('EPATHESCAPE')
  return confine(root, path.join(root, relPath))
}
