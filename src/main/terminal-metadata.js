import fs from 'node:fs/promises'
import path from 'node:path'

// The only shell metadata Concourse accepts: cwd at a prompt.
// Payload: ESC ] 5152 ; base64(cwd) BEL (or ST). No command/input marker is parsed.
const CWD_MARK = '\x1b]5152;'
const MAX_CARRY = 64 * 1024

function partialMarkTail(value) {
  const max = Math.min(CWD_MARK.length - 1, value.length)
  for (let length = max; length > 0; length--) {
    const tail = value.slice(-length)
    if (CWD_MARK.startsWith(tail)) return tail
  }
  return ''
}

function decodeCwd(payload) {
  try {
    // Buffer's base64 decoder accepts arbitrary junk, and UTF-8 replacement
    // characters can silently turn damaged metadata into a different path.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload))
      return null
    const decoded = Buffer.from(payload, 'base64')
    const cwd = decoded.toString('utf8')
    if (!cwd || cwd.length > 4096 || !Buffer.from(cwd, 'utf8').equals(decoded)) return null
    if (/[\x00-\x1f\x7f]/.test(cwd)) return null
    // Prompt hooks emit absolute paths. Preserve meaningful surrounding spaces
    // instead of trimming them, and accept POSIX, drive, and UNC roots.
    return /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(cwd) ? cwd : null
  } catch {
    return null
  }
}

export function extractCwds(buffer) {
  const cwds = []
  let rest = buffer
  if (rest.length > MAX_CARRY) {
    const start = rest.lastIndexOf(CWD_MARK)
    rest = start === -1 ? '' : rest.slice(start)
    if (rest.length > MAX_CARRY) return { cwds, rest: '' }
  }
  for (;;) {
    const at = rest.indexOf(CWD_MARK)
    if (at === -1) {
      rest = partialMarkTail(rest)
      break
    }
    const payloadStart = at + CWD_MARK.length
    let end = rest.indexOf('\x07', payloadStart)
    let terminatorLength = 1
    const stringTerminator = rest.indexOf('\x1b\\', payloadStart)
    if (stringTerminator !== -1 && (end === -1 || stringTerminator < end)) {
      end = stringTerminator
      terminatorLength = 2
    }
    if (end === -1) {
      rest = rest.slice(at)
      break
    }
    const cwd = decodeCwd(rest.slice(payloadStart, end))
    if (cwd) cwds.push(cwd)
    rest = rest.slice(end + terminatorLength)
  }
  return { cwds, rest }
}

// OSC is untrusted output, even when our prompt hook normally emits it. Only a
// real directory inside this pane's workspace may become restoration metadata.
// Resolve symlinks on both sides, and never log a rejected marker or path.
export async function validateTerminalCwd(root, cwd) {
  if (
    !root ||
    typeof cwd !== 'string' ||
    !path.isAbsolute(cwd) ||
    cwd.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(cwd)
  )
    return null
  try {
    const [realRoot, realCwd] = await Promise.all([fs.realpath(root), fs.realpath(cwd)])
    const relative = path.relative(realRoot, realCwd)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      return null
    return (await fs.stat(realCwd)).isDirectory() ? realCwd : null
  } catch {
    return null
  }
}
