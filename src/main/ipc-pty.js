import { ipcMain } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import pty from 'node-pty'

// Does the user customize their own shell prompt? If so we leave it alone.
// We scan the rc files a login shell sources for an explicit prompt assignment
// or a known prompt framework (starship, oh-my-zsh, powerlevel10k, pure…).
function userHasCustomPrompt(shellPath) {
  const home = os.homedir()
  const isZsh = /zsh/.test(shellPath)
  const files = isZsh
    ? ['.zshrc', '.zprofile', '.zshenv', '.zlogin']
    : ['.bashrc', '.bash_profile', '.profile']
  const promptRe =
    /^\s*(export\s+)?(PS1|PROMPT|RPROMPT|PROMPT_COMMAND|precmd)\s*[+=(]|starship|oh-my-zsh|powerlevel10k|p10k|prompt_|pure/im
  for (const f of files) {
    try {
      const txt = fs.readFileSync(path.join(home, f), 'utf8')
      // Ignore commented-out lines when checking, by stripping leading-# lines.
      if (promptRe.test(txt.replace(/^\s*#.*$/gm, ''))) return true
    } catch {
      // File doesn't exist — keep looking.
    }
  }
  return false
}

export function registerPty(ctx) {
  // Live PTY sessions keyed by a renderer-generated id.
  const terminals = new Map()

  ipcMain.on('term:create', (_e, { id, cwd, friendlyPrompt = true }) => {
    const isWin = os.platform() === 'win32'
    const shellPath = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
    // Login shell (-l) so it sources the user's profile (/etc/profile, ~/.bash_profile,
    // ~/.zprofile…) — gives the normal prompt (PS1), aliases, and PATH like Terminal/Cursor.
    const args = isWin ? [] : ['-l']
    const term = pty.spawn(shellPath, args, {
      // 256-color terminfo. (The old 'xterm-color' is only 8-color.) xterm.js on
      // the renderer side handles 256-color + truecolor fine.
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || ctx.getRoot() || os.homedir(),
      env: {
        ...process.env,
        // Silence macOS's "default shell is now zsh" deprecation nag in bash.
        BASH_SILENCE_DEPRECATION_WARNING: '1',
        // Pin the color environment so terminals render identically whether the
        // app was launched from a terminal (dev) or from Finder/Dock (packaged).
        // When launched from Finder the process inherits the bare launchd env,
        // which lacks COLORTERM — without this, CLIs like Claude Code detect no
        // truecolor support and fall back to a dimmer palette.
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    })

    // Give newbies a calm, friendly prompt instead of the default `Mac:dir user$`.
    // Runs after the user's profile loads, then clears the screen so any shell
    // startup noise (deprecation notices, MOTD) is gone. We only do this when the
    // user hasn't set up their own prompt — a custom PS1/framework is left untouched.
    if (!isWin && friendlyPrompt && !userHasCustomPrompt(shellPath)) {
      // One short line: just the current folder name and a simple cursor — no
      // full path, no hostname/username, no color. Calm and unintimidating.
      const setup =
        " PS1=$'\\W ❯ '" +
        " PROMPT=$'%1~ ❯ '" +
        " && clear\r"
      setTimeout(() => term.write(setup), 250)
    }

    term.onData((data) => {
      const win = ctx.getWindow()
      if (win) win.webContents.send('term:data', { id, data })
    })
    term.onExit((e) => {
      const win = ctx.getWindow()
      // Forward the exit code so the renderer can tell a clean finish (0) from a
      // failure (non-zero) — the watchdog maps that to its done/error state.
      if (win) win.webContents.send('term:exit', { id, exitCode: e?.exitCode ?? 0 })
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
