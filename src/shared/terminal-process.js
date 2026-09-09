// Terminal identity is a vocabulary, never a captured string. These labels are
// the only process metadata allowed across IPC or into the terminal UI. Process
// names (including names set by a running program) cannot become display text.
const PROCESSES = Object.freeze({
  zsh: ['Zsh', 'shell'],
  bash: ['Bash', 'shell'],
  fish: ['Fish', 'shell'],
  sh: ['Shell', 'shell'],
  dash: ['Dash', 'shell'],
  ksh: ['Ksh', 'shell'],
  nu: ['Nushell', 'shell'],
  powershell: ['PowerShell', 'shell'],
  pwsh: ['PowerShell', 'shell'],
  cmd: ['Command Prompt', 'shell'],
  claude: ['Claude', 'agent'],
  codex: ['Codex', 'agent'],
  aider: ['Aider', 'agent'],
  gemini: ['Gemini', 'agent'],
  amp: ['Amp', 'agent'],
  goose: ['Goose', 'agent'],
  opencode: ['OpenCode', 'agent'],
  node: ['Node.js', 'tool'],
  python: ['Python', 'tool'],
  ruby: ['Ruby', 'tool'],
  deno: ['Deno', 'tool'],
  bun: ['Bun', 'tool'],
  npm: ['npm', 'tool'],
  pnpm: ['pnpm', 'tool'],
  yarn: ['Yarn', 'tool'],
  git: ['Git', 'tool'],
  ssh: ['SSH', 'tool'],
  docker: ['Docker', 'tool'],
  make: ['Make', 'tool'],
  cmake: ['CMake', 'tool'],
  cargo: ['Cargo', 'tool'],
  go: ['Go', 'tool'],
  java: ['Java', 'tool'],
  vim: ['Vim', 'tool'],
  nvim: ['Neovim', 'tool'],
  nano: ['Nano', 'tool'],
  top: ['Top', 'tool'],
  htop: ['Htop', 'tool'],
  btop: ['Btop', 'tool'],
  less: ['Less', 'tool'],
  curl: ['curl', 'tool'],
  wget: ['Wget', 'tool']
})

export function processContext(processKey, running = false) {
  const known = typeof processKey === 'string' && Object.hasOwn(PROCESSES, processKey)
  const [label, kind] = known ? PROCESSES[processKey] : ['Terminal', 'unknown']
  return { process: known ? processKey : null, kind, label, running: running === true }
}

// Used only on OS executable/accounting names and the configured shell binary,
// never commands, arguments, terminal bytes, window titles, or shell history.
export function classifyProcessName(name) {
  if (typeof name !== 'string' || name.length > 4096) return null
  let key = name
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (/^python(?:[23](?:\.\d{1,2})?)?$/.test(key)) key = 'python'
  if (key === 'nodejs') key = 'node'
  return Object.hasOwn(PROCESSES, key) ? key : null
}
