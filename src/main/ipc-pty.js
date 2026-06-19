import { ipcMain } from 'electron'
import os from 'os'
import pty from 'node-pty'

export function registerPty(ctx) {
  // Live PTY sessions keyed by a renderer-generated id.
  const terminals = new Map()

  ipcMain.on('term:create', (_e, { id, cwd }) => {
    const shellPath =
      os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
    const term = pty.spawn(shellPath, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: cwd || ctx.getRoot() || os.homedir(),
      env: process.env
    })

    term.onData((data) => {
      const win = ctx.getWindow()
      if (win) win.webContents.send('term:data', { id, data })
    })
    term.onExit(() => {
      const win = ctx.getWindow()
      if (win) win.webContents.send('term:exit', { id })
      terminals.delete(id)
    })

    terminals.set(id, term)
  })

  ipcMain.on('term:input', (_e, { id, data }) => {
    const term = terminals.get(id)
    if (term) term.write(data)
  })

  ipcMain.on('term:resize', (_e, { id, cols, rows }) => {
    const term = terminals.get(id)
    if (term) term.resize(cols, rows)
  })

  ipcMain.on('term:kill', (_e, { id }) => {
    const term = terminals.get(id)
    if (term) term.kill()
    terminals.delete(id)
  })

  // Kill every PTY (called on window close).
  return () => {
    for (const term of terminals.values()) term.kill()
    terminals.clear()
  }
}
