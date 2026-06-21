import { ipcMain, app } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import pty from 'node-pty'
import { confine } from './paths.js'

// Private, per-app directory for the generated shell rc/init files. We write them
// under userData (not the world-readable os.tmpdir()) with 0o700 so another local
// user can't read or pre-create our init files, and we use randomUUID filenames
// so the paths aren't predictable/guessable.
function rcDir() {
  const dir = path.join(app.getPath('userData'), 'pty-rc')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

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
//
// The rc/init files are generated ONCE per shellPath and reused for every PTY:
// their contents don't depend on the cwd, only on the shell, so writing them on
// each spawn was pure waste (and a write race when 10 panes restore at once).
// We memoize the in-flight promise so concurrent callers share a single write.
async function friendlyPromptSetup(shellPath) {
  try {
    const home = os.homedir()
    const dir = rcDir()

    if (/zsh/.test(shellPath)) {
      // zsh reads its rc files from $ZDOTDIR (default $HOME). Point it at a
      // private per-shell dir, forward each real rc file, set PROMPT after the
      // user's .zshrc, then restore ZDOTDIR so .zlogin and any child shells use
      // the real one. randomUUID keeps the path unpredictable.
      const zdir = path.join(dir, `zsh-${crypto.randomUUID()}`)
      await fs.promises.mkdir(zdir, { recursive: true, mode: 0o700 })
      const realZ = process.env.ZDOTDIR || home
      const fwd = (f) => `[ -f ${shq(path.join(realZ, f))} ] && source ${shq(path.join(realZ, f))}\n`
      await fs.promises.writeFile(path.join(zdir, '.zshenv'), fwd('.zshenv'), { mode: 0o600 })
      await fs.promises.writeFile(path.join(zdir, '.zprofile'), fwd('.zprofile'), { mode: 0o600 })
      await fs.promises.writeFile(
        path.join(zdir, '.zshrc'),
        fwd('.zshrc') + "PROMPT='%1~ ❯ '\n" + `export ZDOTDIR=${shq(realZ)}\n`,
        { mode: 0o600 }
      )
      return { env: { ZDOTDIR: zdir } }
    }

    // bash: a login shell ignores --rcfile, so spawn interactive non-login and
    // replicate login by sourcing /etc/profile + the user's profile + .bashrc,
    // then set PS1 last. With --rcfile, bash sources ONLY this file.
    const rc = path.join(dir, `bash-${crypto.randomUUID()}.bashrc`)
    await fs.promises.writeFile(
      rc,
      '[ -f /etc/profile ] && source /etc/profile\n' +
        `if [ -f ${shq(path.join(home, '.bash_profile'))} ]; then source ${shq(path.join(home, '.bash_profile'))};\n` +
        `elif [ -f ${shq(path.join(home, '.bash_login'))} ]; then source ${shq(path.join(home, '.bash_login'))};\n` +
        `elif [ -f ${shq(path.join(home, '.profile'))} ]; then source ${shq(path.join(home, '.profile'))}; fi\n` +
        `[ -f ${shq(path.join(home, '.bashrc'))} ] && source ${shq(path.join(home, '.bashrc'))}\n` +
        "PS1='\\W ❯ '\n",
      { mode: 0o600 }
    )
    return { args: ['--rcfile', rc, '-i'] }
  } catch {
    return null
  }
}

// Memoize the friendly-prompt setup per shell so the rc files are written ONCE
// (the first spawn) and every later PTY — including 10 that fire near-instantly —
// reuses the same generated files instead of racing to rewrite them.
const promptSetupByShell = new Map() // shellPath -> Promise<{args?,env?}|null>
function getFriendlyPromptSetup(shellPath) {
  let p = promptSetupByShell.get(shellPath)
  if (!p) {
    p = friendlyPromptSetup(shellPath)
    promptSetupByShell.set(shellPath, p)
  }
  return p
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

  // Whether the user runs their own prompt is a property of their rc files, not
  // of any one terminal — compute it ONCE at startup instead of re-scanning the
  // rc files on every spawn (10 rapid terminals = 10 redundant disk scans).
  const isWinHost = os.platform() === 'win32'
  const hostShell = isWinHost ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
  const hasCustomPrompt = isWinHost ? true : userHasCustomPrompt(hostShell)

  ipcMain.on('term:create', async (_e, { id, cwd, friendlyPrompt = true }) => {
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
    if (!isWin && friendlyPrompt && !hasCustomPrompt) {
      // Await the once-per-shell rc generation so even the first spawn — and any
      // burst of spawns sharing the same in-flight promise — gets the friendly
      // prompt; the rc files are written ONCE, not per spawn.
      const setup = await getFriendlyPromptSetup(shellPath)
      if (setup) {
        if (setup.args) args = setup.args
        if (setup.env) Object.assign(env, setup.env)
      }
    }

    // Confine the requested cwd to the workspace root so a malicious/buggy
    // renderer can't spawn a shell in an arbitrary directory outside the open
    // folder. The cwd must also be an existing directory; on any failure we fall
    // back to the workspace root, then home, rather than spawning somewhere
    // unexpected.
    const root = ctx.getRoot(wc)
    let safeCwd = root || os.homedir()
    if (cwd) {
      try {
        const confined = confine(root, cwd)
        if (fs.statSync(confined).isDirectory()) safeCwd = confined
      } catch {
        // Escaping, non-existent, or non-directory cwd — keep the safe default.
      }
    }

    const term = pty.spawn(shellPath, args, {
      // 256-color terminfo. (The old 'xterm-color' is only 8-color.) xterm.js on
      // the renderer side handles 256-color + truecolor fine.
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: safeCwd,
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
