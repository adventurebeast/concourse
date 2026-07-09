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
  // Windows paths are case-insensitive and realpathSync can normalise the drive
  // letter differently between the two sides (C:\ vs c:\) — compare case-folded
  // there so a legitimate in-root path isn't rejected. POSIX stays case-exact.
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s)
  if (fold(real) !== fold(realRoot) && !fold(real).startsWith(fold(realRoot) + path.sep)) {
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
