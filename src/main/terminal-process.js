import { execFile } from 'node:child_process'
import { classifyProcessName, processContext } from '../shared/terminal-process.js'

// Read only processes attached to Concourse's own PTYs. macOS `comm` is an alias
// for command (and can contain arguments): use the kernel accounting name ucomm.
// Linux `comm` is the corresponding name-only field. Never request args, command,
// environment, or /proc/*/cmdline, and never use node-pty's process/title getter.
export function processQuery(terminals, platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'linux') return null
  const devices = [...new Set(terminals.map((entry) => entry.term.ptsName))].filter(
    (device) => typeof device === 'string' && /^\/dev\/(?:ttys[\da-z]+|pts\/\d+)$/.test(device)
  )
  if (!devices.length) return null
  return {
    file: '/bin/ps',
    args: [
      '-t',
      devices.join(','),
      '-o',
      `pid=,pgid=,tpgid=,${platform === 'darwin' ? 'ucomm' : 'comm'}=`
    ]
  }
}

// Parse and immediately discard raw names. The remainder of the application
// receives only numeric process IDs and keys from the fixed shared vocabulary.
export function parseProcessSnapshot(value) {
  if (typeof value !== 'string') return []
  const rows = []
  for (const line of value.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S.*?)\s*$/.exec(line)
    if (!match) continue
    const [, pid, group, foreground, name] = match
    rows.push({
      pid: Number(pid),
      group: Number(group),
      foreground: Number(foreground),
      process: classifyProcessName(name)
    })
  }
  return rows
}

export function contextForTerminal(rows, shellPid) {
  const shell = rows.find((row) => row.pid === shellPid)
  if (!shell || shell.foreground <= 0) return processContext(null)
  const foreground = rows.filter((row) => row.group === shell.foreground)
  if (!foreground.length) return processContext(null)
  // A nested native agent launched by a Node/Python wrapper retains the shell's
  // foreground process group. Prefer the agent; its helper subprocesses should
  // not make the terminal title bounce between Git, Node.js, and Claude.
  const agent = foreground.find((row) => processContext(row.process).kind === 'agent')
  const leader = foreground.find((row) => row.pid === shell.foreground)
  const tool = foreground.find((row) => processContext(row.process).kind === 'tool')
  const chosen = agent || tool || leader || foreground[0]
  const running = shell.foreground !== shell.group
  return processContext(chosen.process, running)
}

export function readProcessSnapshot(terminals, platform = process.platform) {
  const query = processQuery(terminals, platform)
  if (!query) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      query.file,
      query.args,
      { timeout: 1200, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        // No process text in logs, errors, or fallback titles. Unknown is honest if
        // the OS denies access or the shell has already exited.
        resolve(error ? null : parseProcessSnapshot(stdout))
      }
    )
  }).catch(() => null) // Sandbox/OS policies can also make execFile throw synchronously.
}
