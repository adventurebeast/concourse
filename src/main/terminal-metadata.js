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
    const cwd = Buffer.from(payload, 'base64').toString('utf8').trim()
    return cwd && cwd.length <= 4096 ? cwd : null
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
