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

// Shell-quote a path for safe interpolation into the generated rc files.
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// Configure the calm beginner prompt (`folder ❯`) through the shell's own init
// files instead of typing a command into the live shell.
//
// We used to inject ` PS1=… PROMPT=… && clear\r` as shell input once the PTY
// looked idle. That raced the shell's own startup output: when several panes
// restore at once the shells stutter, the idle heuristic fires mid-startup, and
// the bytes interleave — the setup line tears apart (`%1~`→`clear1~`, `clear`
// never runs). Seeding an init file sets the prompt before the first prompt is
// ever drawn, so there is nothing to race.
//
// Returns spawn overrides ({ args?, env? }) to merge in, or null to fall back to
// a plain login shell (bare prompt) if anything goes wrong.
function friendlyPromptSetup(shellPath) {
  try {
    const home = os.homedir()
    const dir = path.join(os.tmpdir(), 'concourse-shell-init')
    fs.mkdirSync(dir, { recursive: true })

    if (/zsh/.test(shellPath)) {
      // zsh reads its rc files from $ZDOTDIR (default $HOME). Point it at our
      // temp dir, forward each real rc file, set PROMPT after the user's .zshrc,
      // then restore ZDOTDIR so .zlogin and any child shells use the real one.
      const realZ = process.env.ZDOTDIR || home
      const fwd = (f) => `[ -f ${shq(path.join(realZ, f))} ] && source ${shq(path.join(realZ, f))}\n`
      fs.writeFileSync(path.join(dir, '.zshenv'), fwd('.zshenv'))
      fs.writeFileSync(path.join(dir, '.zprofile'), fwd('.zprofile'))
      fs.writeFileSync(
        path.join(dir, '.zshrc'),
        fwd('.zshrc') + "PROMPT='%1~ ❯ '\n" + `export ZDOTDIR=${shq(realZ)}\n`
      )
      return { env: { ZDOTDIR: dir } }
    }

    // bash: a login shell ignores --rcfile, so spawn interactive non-login and
    // replicate login by sourcing /etc/profile + the user's profile + .bashrc,
    // then set PS1 last. With --rcfile, bash sources ONLY this file.
    const rc = path.join(dir, 'concourse.bashrc')
    fs.writeFileSync(
      rc,
      '[ -f /etc/profile ] && source /etc/profile\n' +
        `if [ -f ${shq(path.join(home, '.bash_profile'))} ]; then source ${shq(path.join(home, '.bash_profile'))};\n` +
        `elif [ -f ${shq(path.join(home, '.bash_login'))} ]; then source ${shq(path.join(home, '.bash_login'))};\n` +
        `elif [ -f ${shq(path.join(home, '.profile'))} ]; then source ${shq(path.join(home, '.profile'))}; fi\n` +
        `[ -f ${shq(path.join(home, '.bashrc'))} ] && source ${shq(path.join(home, '.bashrc'))}\n` +
        "PS1='\\W ❯ '\n"
    )
    return { args: ['--rcfile', rc, '-i'] }
  } catch {
    return null
  }
}

export function registerPty(ctx) {
  // Live PTY sessions. The renderer numbers its terminals (term-1, term-2, …) and
  // restarts that counter in every window, so the ids collide across windows. We
  // key each session by the calling window's webContents id + the renderer id, and
  // remember which window owns it, so input/resize/kill hit the right shell, output
  // is routed back to exactly the window that created it, and a closing window only
  // tears down its own shells.
  const terminals = new Map() // "<wcId>:<id>" -> { term, wcId }
  const tkey = (wcId, id) => `${wcId}:${id}`

  ipcMain.on('term:create', (_e, { id, cwd, friendlyPrompt = true }) => {
    const wc = _e.sender
    const wcId = wc.id
    const isWin = os.platform() === 'win32'
    const shellPath = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
    // Login shell (-l) so it sources the user's profile (/etc/profile, ~/.bash_profile,
    // ~/.zprofile…) — gives the normal prompt (PS1), aliases, and PATH like Terminal/Cursor.
    let args = isWin ? [] : ['-l']
    const env = {
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

    // Give newbies a calm, friendly prompt (`folder ❯`) instead of the default
    // `Mac:dir user$`. We only do this when the user hasn't set up their own
    // prompt — a custom PS1/framework is left untouched. The prompt is seeded via
    // the shell's init files (see friendlyPromptSetup) rather than injected as
    // live input, so it never races the shell's startup output.
    if (!isWin && friendlyPrompt && !userHasCustomPrompt(shellPath)) {
      const setup = friendlyPromptSetup(shellPath)
      if (setup) {
        if (setup.args) args = setup.args
        if (setup.env) Object.assign(env, setup.env)
      }
    }

    const term = pty.spawn(shellPath, args, {
      // 256-color terminfo. (The old 'xterm-color' is only 8-color.) xterm.js on
      // the renderer side handles 256-color + truecolor fine.
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || ctx.getRoot(wc) || os.homedir(),
      env
    })

    // Route output back to the window that created this shell. Guard against a
    // destroyed WebContents (the window closed while the PTY was still draining).
    term.onData((data) => {
      if (!wc.isDestroyed()) wc.send('term:data', { id, data })
    })
    term.onExit((e) => {
      // Forward the exit code so the renderer can tell a clean finish (0) from a
      // failure (non-zero) — Pulse maps that to its done/error state.
      if (!wc.isDestroyed()) wc.send('term:exit', { id, exitCode: e?.exitCode ?? 0 })
      terminals.delete(tkey(wcId, id))
    })

    terminals.set(tkey(wcId, id), { term, wcId })
  })

  ipcMain.on('term:input', (_e, { id, data }) => {
    const entry = terminals.get(tkey(_e.sender.id, id))
    if (entry) entry.term.write(data)
  })

  ipcMain.on('term:resize', (_e, { id, cols, rows }) => {
    const entry = terminals.get(tkey(_e.sender.id, id))
    if (entry) entry.term.resize(cols, rows)
  })

  ipcMain.on('term:kill', (_e, { id }) => {
    const key = tkey(_e.sender.id, id)
    const entry = terminals.get(key)
    if (entry) entry.term.kill()
    terminals.delete(key)
  })

  // Kill every PTY owned by a window (called when that window closes), leaving
  // other windows' shells untouched.
  return (wcId) => {
    for (const [key, entry] of terminals) {
      if (entry.wcId !== wcId) continue
      entry.term.kill()
      terminals.delete(key)
    }
  }
}
