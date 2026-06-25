import { ipcMain, app } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import pty from 'node-pty'
import { confine } from './paths.js'
import { extractCommands } from './command-capture.js'
import { recordCommand } from './command-history.js'
import { getRaw } from './settings.js'

// Private, per-app directory for the generated shell rc/init files. We write them
// under userData (not the world-readable os.tmpdir()) with 0o700 so another local
// user can't read or pre-create our init files, and we use randomUUID filenames
// so the paths aren't predictable/guessable.
let rcCleaned = false
function rcDir() {
  const dir = path.join(app.getPath('userData'), 'pty-rc')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // One-time purge of rc/init files left by previous app runs. The memo map that
  // tracks "already generated this run" (promptSetupByShell) is process-scoped and
  // empty at startup, so nothing in THIS process needs the old files yet — this
  // runs before the first rc file is written. Without it pty-rc grows by a file/dir
  // per launch forever.
  if (!rcCleaned) {
    rcCleaned = true
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true })
        } catch {
          // ignore an entry we can't remove
        }
      }
    } catch {
      // ignore — dir just created / unreadable
    }
  }
  return dir
}

// The user's real login shell. process.env.SHELL is the right answer when present,
// but a packaged app launched from Finder/Dock/`open` inherits the bare launchd
// env where SHELL is UNSET — and falling straight back to /bin/zsh forced a
// bash user into zsh (wrong prompt) AND skipped their bash profile, so PATH
// additions like ~/.local/bin (where `claude` lives) vanished. os.userInfo()
// reads the shell from the system password DB (getpwuid), so it recovers the true
// login shell even with no SHELL var; /bin/zsh stays only as a last resort.
function loginShell() {
  if (process.env.SHELL) return process.env.SHELL
  try {
    const s = os.userInfo().shell
    if (s && s !== '/dev/null') return s
  } catch {
    // No passwd entry (rare/sandboxed) — fall through to the OS default.
  }
  return '/bin/zsh'
}

// Named shells → the first install path that actually exists, so the friendly
// "Bash"/"Zsh" Settings choices map to a real binary wherever it lives (system,
// Homebrew, …) without the user typing a path.
const SHELL_PATHS = {
  bash: ['/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/usr/bin/bash'],
  zsh: ['/bin/zsh', '/opt/homebrew/bin/zsh', '/usr/local/bin/zsh', '/usr/bin/zsh']
}
function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      // unreadable path — keep looking
    }
  }
  return null
}

// The shell binary a new pane should launch, honoring the `terminal.shell`
// setting and ALWAYS degrading to the auto-detected login shell when a choice is
// unusable (a Custom path that doesn't exist, a named shell that isn't installed)
// — a bad setting must never leave the user unable to open a terminal.
function resolveShell() {
  if (os.platform() === 'win32') return 'powershell.exe'
  const choice = getRaw('terminal.shell') || 'auto'
  if (choice === 'custom') {
    const p = (getRaw('terminal.shellPath') || '').trim()
    return p && firstExisting([p]) ? p : loginShell()
  }
  if (SHELL_PATHS[choice]) return firstExisting(SHELL_PATHS[choice]) || loginShell()
  return loginShell() // 'auto' (default) or anything unrecognized
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

// Shell-integration capture: emit each command the user runs as an invisible OSC
// marker (ESC ] 5151 ; base64(cmd) BEL) on the terminal's output stream, which
// the main process reads back to build the per-project "Frequent" list (see
// command-capture.js / command-history.js). Because the hook fires only for real
// shell commands, anything typed into a foreground program — Claude, vim, a REPL —
// is that program's stdin, never a shell command, so it is never captured. The
// command is base64'd so its body can't corrupt or split the marker.
//
// zsh: a preexec hook gets the command line as $1, before it runs.
const ZSH_CAPTURE =
  "_concourse_capture() { printf '\\033]5151;%s\\007' \"$(printf '%s' \"$1\" | base64 | tr -d '\\n')\" }\n" +
  'autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook preexec _concourse_capture 2>/dev/null || preexec_functions=(_concourse_capture $preexec_functions)\n'
// bash has no preexec, so read the just-run command off history at each prompt;
// a guard against the unchanged last entry avoids double-counting a bare Enter.
const BASH_CAPTURE =
  '_concourse_capture() {\n' +
  '  local c\n' +
  "  c=$(HISTTIMEFORMAT= history 1 2>/dev/null | sed 's/^ *[0-9][0-9]* *//')\n" +
  '  if [ -n "$c" ] && [ "$c" != "$_concourse_last" ]; then _concourse_last="$c"; ' +
  "printf '\\033]5151;%s\\007' \"$(printf '%s' \"$c\" | base64 | tr -d '\\n')\"; fi\n" +
  '}\n' +
  'PROMPT_COMMAND="_concourse_capture${PROMPT_COMMAND:+;$PROMPT_COMMAND}"\n'

// Seed the shell's own init files with two things: the command-capture hook
// (always) and — when `friendly` is true — the calm beginner prompt (`folder ❯`).
//
// We used to inject ` PS1=… PROMPT=… && clear\r` as shell input once the PTY
// looked idle. That raced the shell's own startup output: when several panes
// restore at once the shells stutter, the idle heuristic fires mid-startup, and
// the bytes interleave — the setup line tears apart (`%1~`→`clear1~`, `clear`
// never runs). Seeding an init file sets things up before the first prompt is
// ever drawn, so there is nothing to race — and it's the only reliable spot to
// install the capture hook without typing into the live shell.
//
// `friendly` is false when the user runs their own prompt (or asked for the raw
// prompt): we then forward/source their real rc untouched and only add capture.
//
// Returns spawn overrides ({ args?, env? }) to merge in, or null to fall back to
// a plain login shell if anything goes wrong.
//
// The rc/init files are generated ONCE per (shell, friendly) pair and reused for
// every PTY: their contents don't depend on the cwd, so writing them on each
// spawn was pure waste (and a write race when 10 panes restore at once). We
// memoize the in-flight promise so concurrent callers share a single write.
async function shellInitSetup(shellPath, friendly) {
  try {
    const home = os.homedir()
    const dir = rcDir()

    if (/zsh/.test(shellPath)) {
      // zsh reads its rc files from $ZDOTDIR (default $HOME). Point it at a
      // private per-shell dir, forward each real rc file, add the capture hook
      // and (optionally) set PROMPT after the user's .zshrc, then restore ZDOTDIR
      // so .zlogin and any child shells use the real one. randomUUID keeps the
      // path unpredictable.
      const zdir = path.join(dir, `zsh-${crypto.randomUUID()}`)
      await fs.promises.mkdir(zdir, { recursive: true, mode: 0o700 })
      const realZ = process.env.ZDOTDIR || home
      const fwd = (f) =>
        `[ -f ${shq(path.join(realZ, f))} ] && source ${shq(path.join(realZ, f))}\n`
      await fs.promises.writeFile(path.join(zdir, '.zshenv'), fwd('.zshenv'), { mode: 0o600 })
      await fs.promises.writeFile(path.join(zdir, '.zprofile'), fwd('.zprofile'), { mode: 0o600 })
      await fs.promises.writeFile(
        path.join(zdir, '.zshrc'),
        fwd('.zshrc') +
          (friendly ? "PROMPT='%1~ ❯ '\n" : '') +
          ZSH_CAPTURE +
          `export ZDOTDIR=${shq(realZ)}\n`,
        { mode: 0o600 }
      )
      return { env: { ZDOTDIR: zdir } }
    }

    // Beyond here we generate a BASH rcfile. A custom/unknown shell (fish, nushell,
    // …) has its own rc and prompt syntax that a bash --rcfile would corrupt, so
    // bail to a plain login shell (caller keeps `-l`): no friendly prompt and no
    // capture hook for those, which is the expected trade for "bring your own shell".
    if (!/bash/.test(shellPath)) return null

    // bash: a login shell ignores --rcfile, so spawn interactive non-login and
    // replicate login by sourcing /etc/profile + the user's profile + .bashrc,
    // then add capture and (optionally) set PS1 last. With --rcfile, bash sources
    // ONLY this file.
    const rc = path.join(dir, `bash-${crypto.randomUUID()}.bashrc`)
    await fs.promises.writeFile(
      rc,
      '[ -f /etc/profile ] && source /etc/profile\n' +
        `if [ -f ${shq(path.join(home, '.bash_profile'))} ]; then source ${shq(path.join(home, '.bash_profile'))};\n` +
        `elif [ -f ${shq(path.join(home, '.bash_login'))} ]; then source ${shq(path.join(home, '.bash_login'))};\n` +
        `elif [ -f ${shq(path.join(home, '.profile'))} ]; then source ${shq(path.join(home, '.profile'))}; fi\n` +
        `[ -f ${shq(path.join(home, '.bashrc'))} ] && source ${shq(path.join(home, '.bashrc'))}\n` +
        (friendly ? "PS1='\\W ❯ '\n" : '') +
        BASH_CAPTURE,
      { mode: 0o600 }
    )
    return { args: ['--rcfile', rc, '-i'] }
  } catch {
    return null
  }
}

// Memoize the init setup per (shell, friendly) so the rc files are written ONCE
// (the first spawn) and every later PTY — including 10 that fire near-instantly —
// reuses the same generated files instead of racing to rewrite them.
const initSetupByKey = new Map() // "<shell>|<friendly>" -> Promise<{args?,env?}|null>
function getShellInitSetup(shellPath, friendly) {
  const key = `${shellPath}|${friendly}`
  let p = initSetupByKey.get(key)
  if (!p) {
    p = shellInitSetup(shellPath, friendly)
    initSetupByKey.set(key, p)
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
  const hostShell = isWinHost ? 'powershell.exe' : resolveShell()
  const hasCustomPrompt = isWinHost ? true : userHasCustomPrompt(hostShell)

  ipcMain.on('term:create', async (_e, { id, cwd, friendlyPrompt = true }) => {
    const wc = _e.sender
    const wcId = wc.id
    const isWin = os.platform() === 'win32'
    const shellPath = isWin ? 'powershell.exe' : resolveShell()
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

    // Seed the shell's init files (see shellInitSetup): always installs the
    // command-capture hook that feeds the per-project palette history, and gives
    // newbies a calm `folder ❯` prompt instead of the default `Mac:dir user$`.
    // The friendly prompt is only applied when the user hasn't set up their own
    // (a custom PS1/framework is left untouched) and the renderer asked for it;
    // capture is installed either way. Seeding init files rather than injecting
    // live input means none of this races the shell's startup output.
    if (!isWin) {
      const friendly = friendlyPrompt && !hasCustomPrompt
      // Await the once-per-(shell,friendly) rc generation so even the first spawn
      // — and any burst of spawns sharing the same in-flight promise — gets the
      // setup; the rc files are written ONCE, not per spawn.
      const setup = await getShellInitSetup(shellPath, friendly)
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
    // En route, pull out any command-capture markers the shell hook emitted and
    // record them against this window's project for the palette's Frequent list.
    // The markers are invisible OSC sequences xterm.js ignores, so the data is
    // forwarded unchanged; capture is best-effort and never blocks output.
    let capBuf = ''
    term.onData((data) => {
      if (!wc.isDestroyed()) wc.send('term:data', { id, data })
      try {
        const { cmds, rest } = extractCommands(capBuf + data)
        capBuf = rest
        if (cmds.length) {
          const root = ctx.getRoot(wc)
          for (const cmd of cmds) recordCommand(root, cmd)
        }
      } catch {
        capBuf = '' // never let capture parsing disturb the terminal
      }
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
