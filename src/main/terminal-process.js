import { execFile } from 'node:child_process'
import { classifyProcessName, processContext } from '../shared/terminal-process.js'

const AGENT_WRAPPERS = new Set(['node', 'python', 'ruby', 'deno', 'bun', 'npm', 'pnpm', 'yarn'])

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
      `pid=,ppid=,pgid=,tpgid=,tty=,${platform === 'darwin' ? 'ucomm' : 'comm'}=`
    ]
  }
}

// Parse and immediately discard raw names. The remainder of the application
// receives only numeric process IDs, OS terminal identifiers, and vocabulary keys.
export function parseProcessSnapshot(value) {
  if (typeof value !== 'string') return []
  const rows = []
  for (const line of value.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line)
    if (!match) continue
    const [, pid, parent, group, foreground, tty, name] = match
    rows.push({
      pid: Number(pid),
      parent: Number(parent),
      group: Number(group),
      foreground: Number(foreground),
      tty,
      process: classifyProcessName(name)
    })
  }
  return rows
}

export function contextForTerminal(rows, shellPid) {
  const shell = rows.find((row) => row.pid === shellPid)
  if (!shell || shell.foreground <= 0) return processContext(null)
  const foreground = rows.filter((row) => row.group === shell.foreground && row.tty === shell.tty)
  if (!foreground.length) return processContext(null)
  const leader = foreground.find((row) => row.pid === shell.foreground)
  const running = shell.foreground !== shell.group || processContext(shell.process).kind !== 'shell'
  if (!leader) return processContext(null, running)

  // The foreground owner takes precedence over helpers it starts, including
  // helpers from another agent. ps row order is not evidence of ownership.
  if (processContext(leader.process).kind === 'agent') return processContext(leader.process, true)

  // Interpreter/package wrappers can own the job while the native agent is a
  // descendant. Walk numeric parent links, stopping at the first agent on each
  // branch so Node -> Codex -> Claude remains Codex. Separate agent branches are
  // ambiguous; never choose a provider just because it appears first or is nearer.
  const children = new Map()
  for (const row of foreground) {
    if (!children.has(row.parent)) children.set(row.parent, [])
    children.get(row.parent).push(row)
  }
  const pending = [leader]
  const seen = new Set()
  const agents = new Set()
  for (let index = 0; index < pending.length; index++) {
    const row = pending[index]
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    const kind = processContext(row.process).kind
    if (kind === 'agent') agents.add(row.process)
    else if (kind === 'shell' || AGENT_WRAPPERS.has(row.process))
      pending.push(...(children.get(row.pid) || []))
    // Other tools and unknown executables own their work. A Vim plugin or Git
    // hook launching an agent must not rename the whole terminal for that helper.
  }
  if (agents.size === 1) return processContext([...agents][0], true)
  if (agents.size > 1) return processContext(null, true)
  return processContext(leader.process, running)
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
