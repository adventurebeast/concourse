#!/usr/bin/env node
// Run after npm run build. Uses a fresh Electron process, fixture workspace,
// profile, logs, and shell without user startup files. Never attaches to a user's
// running app. Artifacts remain in a temporary directory for inspection.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import electron from 'electron'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-application-smoke-'))
)
const workspace = path.join(fixture, 'workspace')
const secondWorkspace = path.join(fixture, 'second-workspace')
const profileBase = path.join(fixture, 'profile')
const profile = profileBase + '-dev'
const logs = path.join(fixture, 'logs')
for (const dir of [
  workspace,
  secondWorkspace,
  profileBase,
  profile,
  logs,
  path.join(fixture, 'crashes')
])
  fs.mkdirSync(dir)
fs.mkdirSync(path.join(workspace, 'folder'))
fs.writeFileSync(path.join(workspace, 'notes.txt'), 'Fixture document\n')
const trashName = 'concourse-trash-probe-' + randomUUID() + '.txt'
fs.writeFileSync(path.join(workspace, trashName), 'Disposable Concourse smoke fixture\n')
fs.writeFileSync(path.join(workspace, 'folder', 'child.txt'), 'Fixture child\n')
const fixtureShell = path.join(fixture, 'shell')
fs.writeFileSync(fixtureShell, '#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n', { mode: 0o700 })
fs.writeFileSync(
  path.join(profile, 'settings.json'),
  JSON.stringify({
    version: 1,
    values: {
      'appearance.startup': 'last-project',
      'general.confirmQuit': false,
      'terminal.confirmClose': false,
      'pulse.provider': 'off',
      'pulse.localAutostart': false,
      'terminal.shell': 'custom',
      'terminal.shellPath': fixtureShell,
      'notifications.enabled': false
    }
  })
)
fs.writeFileSync(
  path.join(profile, 'session-meta.json'),
  JSON.stringify({ version: 1, lastRoot: workspace })
)
// A tiny native executable exercises real OS identity and awaiting detection
// without starting any actual AI agent or contacting a model provider.
execFileSync('/usr/bin/cc', ['-x', 'c', '-', '-o', path.join(workspace, 'claude')], {
  input:
    '#include <stdio.h>\n#include <unistd.h>\nint main(void) { for(int i=0;i<20;i++){printf("Fixture agent step %d\\n",i);fflush(stdout);usleep(150000);} printf("Continue? [y/N] ");fflush(stdout);getchar();return 0; }\n'
})
const config = {
  repo,
  fixture,
  workspace,
  secondWorkspace,
  trashName,
  profileBase,
  profile,
  logs,
  secret: 'SYNTHETIC_' + randomUUID()
}

async function runInElectron(config, phase) {
  const { app, BrowserWindow } = await import('electron')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const assert = (await import('node:assert/strict')).default
  app.setPath('userData', config.profileBase)
  app.setPath('sessionData', config.profile)
  app.setPath('crashDumps', path.join(config.fixture, 'crashes'))
  app.setAppLogsPath(config.logs)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const results = []
  const record = (name) => results.push(name)
  await import(pathToFileURL(path.join(config.repo, 'out/main/index.js')).href)
  let win
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    if (win && !win.webContents.isLoading()) break
    await sleep(100)
  }
  assert.ok(win, 'Application window did not open')
  const wc = win.webContents
  const evaluate = (expression) => wc.executeJavaScript(expression, true)
  const until = async (expression, message, timeout = 10000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return
      await sleep(100)
    }
    throw new Error(message)
  }
  const key = (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const input = async (value) => {
    await wc.insertText(value)
    key('Return')
    await sleep(100)
  }
  const focusTerminal = () =>
    evaluate(`document.querySelector('.term-cell.active .xterm-helper-textarea')?.focus()`)
  const headerSnapshot = `(() => ({
    labels: [...document.querySelectorAll('.term-tab-label, .cell-label, .card-label')].map(el => el.textContent),
    metadata: [...document.querySelectorAll('.term-tab, .term-card, .cell-context, .card-context')].map(el => [el.getAttribute('title') || '', el.getAttribute('aria-label') || '', el.dataset.tip || '', el.matches('.cell-context, .card-context') ? el.textContent : ''].join(' '))
  }))()`
  const rename = async (selector, name) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`
    )
    await until(`!!document.querySelector('.rename-input')`, 'Rename field missing')
    await evaluate(`document.querySelector('.rename-input').value = ${JSON.stringify(name)}`)
    key('Return')
    await until(`!document.querySelector('.rename-input')`, 'Rename field did not close')
  }
  const layout = async (name) => {
    await evaluate(
      `[...document.querySelectorAll('#terminal-region .panel-controls button')].find(el => (el.dataset.tip || el.title || '').toLowerCase().startsWith(${JSON.stringify(name)})).click()`
    )
    await sleep(150)
  }
  const firstLabel = `document.querySelector('.term-tab-label')?.textContent`
  await until(`document.querySelectorAll('.term-tab-label').length > 0`, 'Terminals did not open')
  await until(
    `Array.from(document.querySelectorAll('.term-tab-label')).some(el => el.textContent.includes('Bash')) || ${firstLabel} === 'Release agent'`,
    'Automatic shell name unavailable'
  )
  if (phase === 2) {
    assert.equal(
      await evaluate(firstLabel),
      'Release agent',
      'Explicit name did not survive restart'
    )
    await until(
      `!!document.querySelector('.pane-launcher')`,
      'Agent resume card did not survive restart'
    )
    const text = await evaluate(`document.querySelector('.pane-launcher').textContent`)
    assert.ok(text.includes('claude --continue'), 'Resume card did not use a fixed agent command')
    assert.ok(!text.includes(config.secret), 'Secret reached resume card')
    record('restart preserves explicit name and fixed agent resume card')
  } else {
    record('fresh shell gets automatic Bash identity')
    await focusTerminal()
    const before = await evaluate(headerSnapshot)
    await input('read -s terminal_security_probe')
    await sleep(200)
    await input(config.secret)
    await sleep(1800)
    const after = await evaluate(headerSnapshot)
    assert.deepEqual(after.labels, before.labels, 'Password entry changed terminal labels')
    assert.ok(!JSON.stringify(after).includes(config.secret), 'Password reached terminal metadata')
    record('silent password entry leaves all terminal labels and metadata clean')

    await input('./claude --token ' + config.secret)
    await until(`${firstLabel} === 'Claude · 1'`, 'Native foreground agent identity unavailable')
    await until(
      `document.querySelector('.term-tab').dataset.state === 'working'`,
      'Typed agent did not activate Pulse',
      2500
    )
    await until(
      `document.querySelector('.term-tab').dataset.state === 'awaiting'`,
      'Agent prompt did not settle to awaiting'
    )
    assert.ok(
      !JSON.stringify(await evaluate(headerSnapshot)).includes(config.secret),
      'Argument reached terminal metadata'
    )
    record(
      'typed agent gets Claude identity, working Pulse, and awaiting state without argument capture'
    )
    await input('y')
    await until(`${firstLabel} === 'Bash · 1'`, 'Agent exit did not restore shell identity')
    record('agent exit restores shell identity')

    await rename('.term-tab-label', 'Planning')
    assert.equal(await evaluate(firstLabel), 'Planning')
    await evaluate(
      `document.querySelector('.term-tab').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:200}))`
    )
    await evaluate(
      `[...document.querySelectorAll('.term-menu-item')].find(el => el.textContent === 'Use Automatic Name').click()`
    )
    assert.equal(await evaluate(firstLabel), 'Bash · 1')
    await evaluate(
      `document.querySelector('.term-tab-add').click(); document.querySelector('.term-tab-add').click()`
    )
    await until(
      `document.querySelectorAll('.term-tab-label').length === 3`,
      'New terminals did not open'
    )
    await evaluate(`document.querySelector('.term-tab').click()`)
    await layout('grid')
    await rename('.cell-label', 'Grid agent')
    assert.equal(await evaluate(firstLabel), 'Grid agent')
    await layout('master-stack')
    await rename('.card-label', 'Stack agent')
    assert.equal(await evaluate(firstLabel), 'Stack agent')
    await layout('master-deck')
    await rename('.card-label', 'Release agent')
    assert.equal(await evaluate(firstLabel), 'Release agent')
    await layout('album flow')
    await rename('.flow-center .cell-label', 'Release agent')
    await layout('tabs')
    record('rename, automatic reset, new panes, and all five layouts')

    const rowSelector = '.ft-row[data-path="' + config.workspace + '/notes.txt"]'
    await until(
      `!!document.querySelector(${JSON.stringify(rowSelector)})`,
      'Explorer fixture file missing'
    )
    await evaluate(
      `document.querySelector(${JSON.stringify(rowSelector)}).focus(); document.querySelector(${JSON.stringify(rowSelector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:window.innerWidth-2,clientY:window.innerHeight-2}))`
    )
    assert.ok(
      await evaluate(
        `(() => {const r=document.querySelector('.ft-menu').getBoundingClientRect();return r.right<=innerWidth && r.bottom<=innerHeight && r.left>=0 && r.top>=0})()`
      ),
      'Explorer menu overflows window'
    )
    key('Down')
    key('Escape')
    await until(`!document.querySelector('.ft-menu')`, 'Explorer Escape did not close menu')
    assert.ok(
      await evaluate(`document.activeElement.matches(${JSON.stringify(rowSelector)})`),
      'Explorer focus not restored'
    )
    key('F10', ['shift'])
    await until(`!!document.querySelector('.ft-menu')`, 'Shift-F10 did not open explorer menu')
    await evaluate(
      `[...document.querySelectorAll('.ft-menu-item')].find(el => el.firstElementChild?.textContent === 'Rename').click()`
    )
    await until(`!!document.querySelector('.ft-input')`, 'Explorer rename field missing')
    await evaluate(`document.querySelector('.ft-input').value = 'renamed.txt'`)
    key('Return')
    await until(
      `!!document.querySelector('.ft-row[data-path="'+${JSON.stringify(config.workspace)}+'/renamed.txt"]')`,
      'Explorer rename did not finish'
    )
    assert.ok(fs.existsSync(path.join(config.workspace, 'renamed.txt')))
    await evaluate(
      `document.querySelector('.ft-row[data-path="'+${JSON.stringify(config.workspace)}+'/renamed.txt"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:200}))`
    )
    await evaluate(
      `[...document.querySelectorAll('.ft-menu-item')].find(el => /Move to Trash|Recycle Bin/.test(el.firstElementChild?.textContent || '')).click()`
    )
    await until(`!!document.querySelector('[role="alertdialog"]')`, 'Trash confirmation missing')
    assert.equal(
      await evaluate(`document.activeElement.textContent`),
      'Cancel',
      'Trash confirmation does not default to Cancel'
    )
    key('Return')
    await until(
      `!document.querySelector('[role="alertdialog"]')`,
      'Trash cancellation did not close dialog'
    )
    assert.ok(
      fs.existsSync(path.join(config.workspace, 'renamed.txt')),
      'Cancel removed fixture file'
    )
    record('explorer pointer/keyboard menus, edge placement, rename, and safe Trash cancellation')

    const trashSelector = '.ft-row[data-path="' + config.workspace + '/' + config.trashName + '"]'
    await evaluate(
      `document.querySelector(${JSON.stringify(trashSelector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:200}))`
    )
    await evaluate(
      `[...document.querySelectorAll('.ft-menu-item')].find(el => /Move to Trash|Recycle Bin/.test(el.firstElementChild?.textContent || '')).click()`
    )
    await until(
      `!!document.querySelector('[role="alertdialog"]')`,
      'Synthetic Trash confirmation missing'
    )
    await evaluate(`document.querySelector('.ft-btn-danger').click()`)
    await until(
      `!document.querySelector('[role="alertdialog"]')`,
      'System Trash action did not complete'
    )
    assert.ok(
      !fs.existsSync(path.join(config.workspace, config.trashName)),
      'Trashed fixture remains in workspace'
    )
    if (process.platform === 'darwin') {
      const trashPath = path.join((await import('node:os')).homedir(), '.Trash', config.trashName)
      try {
        assert.ok(
          fs.statSync(trashPath).isFile(),
          'Synthetic fixture is not recoverable from Trash'
        )
        record('system Trash removes a unique fixture and leaves it recoverable in macOS Trash')
      } catch (error) {
        if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error
        record('system Trash accepted fixture; macOS denied verification of its recovery location')
      }
    } else record('system Trash removes only the unique synthetic fixture')

    await evaluate(`document.querySelector('.term-tab').click()`)
    await focusTerminal()
    await input('clear')
    await input('./claude')
    await until(
      `document.querySelector('.cell-context').textContent.includes('Claude')`,
      'Custom name did not retain live agent context'
    )
    assert.equal(
      await evaluate(firstLabel),
      'Release agent',
      'Agent context replaced explicit name'
    )
    const opened = await evaluate(
      `window.api.workspace.openPath(${JSON.stringify(config.secondWorkspace)})`
    )
    assert.equal(opened, null, 'Another workspace replaced the live source window')
    let other
    for (let i = 0; i < 100; i++) {
      other = BrowserWindow.getAllWindows().find((item) => item !== win && !item.isDestroyed())
      if (
        other &&
        !other.webContents.isLoading() &&
        (await other.webContents.executeJavaScript(
          `document.querySelectorAll('.term-tab-label').length === 1`
        ))
      )
        break
      await sleep(100)
    }
    assert.ok(other, 'Another workspace did not open its own window')
    assert.equal(
      await other.webContents.executeJavaScript('window.api.workspace.get()'),
      config.secondWorkspace
    )
    assert.equal(await evaluate('window.api.workspace.get()'), config.workspace)
    assert.equal(await evaluate(`document.querySelectorAll('.term-tab-label').length`), 3)
    other.close()
    await sleep(1800)
    assert.equal(await evaluate(firstLabel), 'Release agent')
    assert.ok(
      await evaluate(`document.querySelector('.cell-context').textContent.includes('Claude')`),
      'Closing another workspace killed the original agent'
    )
    await evaluate(`window.api.workspace.openPath(${JSON.stringify(config.workspace)})`)
    record('another project opens its own window and leaves the original live agent intact')
    await layout('master-stack')
    await sleep(4500)
    fs.writeFileSync(path.join(config.fixture, 'application.png'), (await wc.capturePage()).toPNG())
    record('custom name coexists with live context; session autosave completed')
  }
  fs.writeFileSync(
    path.join(config.fixture, `phase-${phase}.json`),
    JSON.stringify({ ok: true, checks: results }, null, 2)
  )
  app.quit()
}

for (const phase of [1, 2]) {
  const harness = path.join(fixture, `harness-${phase}.mjs`)
  fs.writeFileSync(
    harness,
    `(${runInElectron.toString()})(${JSON.stringify(config)}, ${phase}).catch(async error => { console.error(error.stack || error.message); const {app} = await import('electron'); app.exit(1) })\n`
  )
  const env = {
    ...process.env,
    SHELL: fixtureShell,
    HISTFILE: '/dev/null',
    BASH_SILENCE_DEPRECATION_WARNING: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.BASH_ENV
  delete env.ENV
  const output = fs.openSync(path.join(fixture, `electron-${phase}.log`), 'w')
  const child = spawn(electron, [harness], { env, stdio: ['ignore', output, output] })
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000)
  const status = await new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  clearTimeout(timer)
  fs.closeSync(output)
  if (status !== 0)
    throw new Error(
      `Isolated application check failed; inspect ${path.join(fixture, `electron-${phase}.log`)}`
    )
}
const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : []
  })
for (const file of [
  ...files(profile),
  ...files(logs),
  path.join(fixture, 'electron-1.log'),
  path.join(fixture, 'electron-2.log')
]) {
  if (fs.readFileSync(file).includes(Buffer.from(config.secret)))
    throw new Error(`Synthetic secret reached persisted app data: ${file}`)
}
const checks = [1, 2].flatMap(
  (phase) => JSON.parse(fs.readFileSync(path.join(fixture, `phase-${phase}.json`))).checks
)
console.log(
  JSON.stringify(
    {
      ok: true,
      checks,
      fixture,
      screenshot: path.join(fixture, 'application.png'),
      privacy: 'Synthetic secret absent from app profile, sessions, and logs'
    },
    null,
    2
  )
)
