#!/usr/bin/env node
// Run after npm run build. --app-root PATH may point to an earlier copied build
// to reproduce a regression. Every run owns its Electron profile, workspace,
// shell, and harmless output fixture; it never attaches to an existing app.
// Temporary artifacts are retained for inspection.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import electron from 'electron'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootArg = process.argv.indexOf('--app-root')
const appRoot = rootArg === -1 ? repo : path.resolve(process.argv[rootArg + 1])
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-scroll-smoke-')))
const workspace = path.join(fixture, 'workspace')
const profileBase = path.join(fixture, 'profile')
const profile = profileBase + '-dev'
const logs = path.join(fixture, 'logs')
for (const dir of [workspace, profileBase, profile, logs, path.join(fixture, 'crashes')])
  fs.mkdirSync(dir)
const fixtureShell = path.join(fixture, 'shell')
const control = path.join(fixture, 'control')
const inputStats = path.join(fixture, 'input-stats.json')
const program = path.join(workspace, 'scroll-fixture')
fs.writeFileSync(control, 'hold')
fs.writeFileSync(inputStats, JSON.stringify({ mouse: 0, motion: 0, bytes: 0 }))
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

// A separate control file lets the test start output without sending a key to
// xterm (typing intentionally resumes following). Only numeric mouse/input
// counters are recorded, from this synthetic fixture's own terminal.
execFileSync('/usr/bin/cc', ['-x', 'c', '-', '-o', program], {
  input: `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <termios.h>
#include <sys/select.h>
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  struct termios mode;
  tcgetattr(0, &mode); cfmakeraw(&mode); tcsetattr(0, TCSANOW, &mode);
  for (int n=0;n<500;n++) printf("Scroll fixture history %04d\\r\\n",n);
  fflush(stdout);
  char previous[64] = "", command[64] = "hold", input[512];
  int line=500, mouse=0, motion=0, bytes=0, tick=0;
  while (1) {
    FILE *file = fopen(argv[1], "r");
    if (file) { if (!fgets(command,sizeof(command),file)) strcpy(command,"hold"); fclose(file); }
    if (strcmp(command,previous)) {
      if (!strcmp(command,"tracking")) printf("\\033[?1000h\\033[?1006h");
      if (!strcmp(command,"motion")) printf("\\033[?1003h\\033[?1006h");
      if (!strcmp(command,"alternate")) printf("\\033[?1049h\\033[?1000h\\033[?1006hAlternate mouse fixture\\r\\n");
      if (!strcmp(command,"normal")) printf("\\033[?1000l\\033[?1003l\\033[?1006l\\033[?1049l");
      strcpy(previous,command); fflush(stdout);
    }
    if (!strcmp(command,"stream") && (++tick % 3)==0) {
      printf("Scroll fixture live %04d\\r\\n",line++); fflush(stdout);
    }
    if (!strcmp(command,"redraw") && (++tick % 3)==0) {
      printf("\\r\\033[2KScroll fixture redraw %04d",line++); fflush(stdout);
    }
    fd_set readable; FD_ZERO(&readable); FD_SET(0,&readable);
    struct timeval timeout={0,0};
    if (select(1,&readable,NULL,NULL,&timeout)>0) {
      int n=read(0,input,sizeof(input)-1);
      if (n>0) {
        input[n]=0; bytes+=n;
        for (int i=0;i+5<n;i++) if (!memcmp(input+i,"\\033[<64;",6) || !memcmp(input+i,"\\033[<65;",6)) mouse++;
        for (int i=0;i+3<n;i++) if (!memcmp(input+i,"\\033[<",3) && (atoi(input+i+3)&32)) motion++;
        FILE *stats=fopen(argv[2],"w");
        if (stats) { fprintf(stats,"{\\"mouse\\":%d,\\"motion\\":%d,\\"bytes\\":%d}",mouse,motion,bytes); fclose(stats); }
      }
    }
    usleep(40000);
  }
}
`
})

const config = {
  appRoot,
  fixture,
  workspace,
  profileBase,
  profile,
  logs,
  program,
  control,
  inputStats
}

async function runInElectron(config) {
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
  await import(pathToFileURL(path.join(config.appRoot, 'out/main/index.js')).href)
  let win
  for (let i = 0; i < 200; i++) {
    win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    if (win && !win.webContents.isLoading()) break
    await sleep(100)
  }
  assert.ok(win, 'Application window did not open')
  win.show()
  app.focus({ steal: true })
  win.focus()
  const wc = win.webContents
  // CDP dispatches trusted Chromium input to this one WebContents, avoiding an
  // OS focus race with the user's apps or another isolated test window.
  wc.setBackgroundThrottling(false)
  wc.debugger.attach('1.3')
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const evaluate = (expression) => wc.executeJavaScript(expression, true)
  const until = async (expression, message, timeout = 10000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return
      await sleep(40)
    }
    throw new Error(message)
  }
  const key = async (keyCode, modifiers = [], text) => {
    const key = keyCode === 'Return' ? 'Enter' : keyCode
    const windowsVirtualKeyCode = { Enter: 13, PageUp: 33, X: 88 }[key]
    const event = {
      key,
      code: key === 'X' ? 'KeyX' : key,
      windowsVirtualKeyCode,
      modifiers: modifiers.includes('shift') ? 8 : 0
    }
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...event,
      ...(text ? { text } : {})
    })
    await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  const command = (value) => fs.writeFileSync(config.control, value)
  const session = `document.querySelector('.term-cell.active .cell-body').__session`
  const viewport = `document.querySelector('.term-cell.active .xterm-viewport')`
  const snapshot = () =>
    evaluate(`(() => {
    const s=${session},v=${viewport},b=s.term.buffer.active;
    return {follow:s.follow,baseY:b.baseY,viewportY:b.viewportY,scrollTop:v.scrollTop,
      scrollHeight:v.scrollHeight,clientHeight:v.clientHeight,buffer:b.type,
      lastLine:b.getLine(b.baseY+b.cursorY)?.translateToString(true) || '',focused:document.hasFocus(),
      mouseMode:s.term.modes.mouseTrackingMode,lastWheel:window.__scrollSmokeWheel || null};
  })()`)
  const reset = async () => {
    command('normal')
    await sleep(160)
    command('hold')
    await evaluate(`${session}.term.scrollToBottom(); ${session}.term.focus()`)
    await until(
      `${session}.term.buffer.active.viewportY === ${session}.term.buffer.active.baseY`,
      'Reset did not return to bottom'
    )
    await sleep(100)
  }
  const wheel = async () => {
    const point = await evaluate(
      `(() => {const r=${viewport}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`
    )
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...point,
      deltaX: 0,
      deltaY: -360
    })
    await sleep(220)
  }
  const nativeScrollUp = async () => {
    await evaluate(`${viewport}.scrollTop -= 300`)
    await sleep(150)
  }
  const checks = []
  const check = async (name, action) => {
    try {
      app.focus({ steal: true })
      win.focus()
      await until('document.hasFocus()', 'Isolated test window lost focus', 1500)
      const details = await action()
      checks.push({ name, ok: true, ...details })
    } catch (error) {
      checks.push({
        name,
        ok: false,
        error: error.message,
        ...error.details,
        current: await snapshot()
      })
    }
    command('hold')
  }
  const preserveWhileStreaming = async (scroll) => {
    await reset()
    await scroll()
    const before = await snapshot()
    assert.ok(before.viewportY < before.baseY - 2, 'Scroll action did not leave the bottom')
    command('redraw')
    await until(
      `(() => {const b=${session}.term.buffer.active;return b.getLine(b.baseY+b.cursorY)?.translateToString(true) !== ${JSON.stringify(before.lastLine)}})()`,
      'Fixture did not redraw its output'
    )
    await sleep(650)
    command('hold')
    await sleep(160)
    const after = await snapshot()
    try {
      assert.notEqual(before.lastLine, after.lastLine, 'Fixture redraw did not reach xterm')
      assert.ok(
        after.viewportY <= before.viewportY + 1,
        'Same-line redraw output snapped the viewport toward the bottom'
      )
      assert.equal(before.follow, false, 'Scrolling did not disable follow before output')
      assert.equal(after.follow, false, 'Streaming output re-enabled follow')
    } catch (error) {
      error.details = { before, after }
      throw error
    }
    return { before, after }
  }

  await until(
    `!!document.querySelector('.term-cell.active .cell-body')?.__session`,
    'Terminal did not open'
  )
  await evaluate(`${session}.term.focus()`)
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'"
  await wc.insertText([config.program, config.control, config.inputStats].map(quote).join(' '))
  await key('Return', [], '\r')
  await until(
    `${session}.term.buffer.active.baseY > 350`,
    'Fixture did not populate terminal history'
  )
  await evaluate(`(() => {
    ${session}.body.addEventListener('wheel', e => { window.__scrollSmokeWheel={deltaY:e.deltaY}; }, {capture:true});
  })()`)
  await sleep(200)

  await check('native viewport scrolling stays parked during live output', () =>
    preserveWhileStreaming(nativeScrollUp)
  )
  await check('real wheel without mouse tracking stays parked during live output', () =>
    preserveWhileStreaming(wheel)
  )
  await check('native scrollbar-position changes stay parked during live output', () =>
    preserveWhileStreaming(async () => {
      // Set the native scrollbar position directly. This exercises Chromium's
      // actual scroll event, including xterm's suppression path, without relying
      // on the OS-specific hit area of an auto-hidden scrollbar thumb. It does
      // not claim physical scrollbar-thumb dragging coverage.
      await evaluate(
        `${viewport}.scrollTop = (${viewport}.scrollHeight - ${viewport}.clientHeight) * 0.55`
      )
      await sleep(150)
    })
  )
  await check(
    'normal-buffer mouse tracking wheel scrolls locally without sending mouse input',
    () =>
      preserveWhileStreaming(async () => {
        command('tracking')
        await until(
          `${session}.term.modes.mouseTrackingMode !== 'none'`,
          'Mouse tracking did not enable'
        )
        command('hold')
        const before = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).mouse
        await wheel()
        const after = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).mouse
        assert.equal(after, before, 'Normal-buffer wheel reached the fixture as mouse input')
      })
  )
  await check('Shift-PageUp stays parked during live output', () =>
    preserveWhileStreaming(async () => {
      await evaluate(`${session}.term.focus()`)
      await key('PageUp', ['shift'])
      await sleep(150)
    })
  )
  await check(
    'normal-buffer mouse motion is forwarded while the viewport stays parked',
    async () => {
      await reset()
      command('motion')
      await until(
        `${session}.term.modes.mouseTrackingMode === 'any'`,
        'All-motion tracking did not enable'
      )
      command('hold')
      await nativeScrollUp()
      const before = await snapshot()
      assert.ok(before.viewportY < before.baseY - 2, 'Mouse-motion fixture never left bottom')
      const countBefore = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).motion
      const point = await evaluate(
        `(() => {const r=${viewport}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`
      )
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x + 50,
        y: point.y + 30
      })
      await sleep(180)
      const countAfter = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).motion
      assert.ok(countAfter > countBefore, 'Tracked mouse motion did not reach fixture')
      const after = await snapshot()
      assert.ok(
        after.viewportY <= before.viewportY + 1,
        'Mouse motion snapped the viewport toward the bottom'
      )
      assert.equal(after.follow, false, 'Mouse motion enabled follow')
      return { before, after, motionBefore: countBefore, motionAfter: countAfter }
    }
  )
  await check('typing returns to the bottom and resumes following', async () => {
    await reset()
    await nativeScrollUp()
    const before = await snapshot()
    assert.ok(before.viewportY < before.baseY - 2, 'Typing fixture never left bottom')
    await evaluate(`${session}.term.focus()`)
    await key('X', [], 'x')
    await until(
      `${session}.term.buffer.active.viewportY === ${session}.term.buffer.active.baseY`,
      'Typing did not return to the bottom'
    )
    const typed = await snapshot()
    assert.equal(typed.follow, true, 'Typing did not resume follow')
    command('stream')
    await until(
      `${session}.term.buffer.active.baseY > ${typed.baseY} + 3`,
      'Fixture did not resume streaming'
    )
    command('hold')
    await sleep(160)
    const after = await snapshot()
    assert.equal(
      after.viewportY,
      after.baseY,
      'Typing resumed once but subsequent output stopped following'
    )
    return { before, after }
  })
  await check(
    'paste at the xterm root resumes following without touching the OS clipboard',
    async () => {
      await reset()
      await nativeScrollUp()
      const before = await snapshot()
      assert.ok(before.viewportY < before.baseY - 2, 'Paste fixture never left bottom')
      const bytesBefore = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).bytes
      await evaluate(`(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'synthetic-paste');
      ${session}.term.element.dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData}));
    })()`)
      await until(
        `${session}.term.buffer.active.viewportY === ${session}.term.buffer.active.baseY`,
        'Paste did not return to bottom'
      )
      await sleep(150)
      const bytesAfter = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).bytes
      assert.ok(bytesAfter > bytesBefore, 'Synthetic paste did not reach the fixture PTY')
      assert.equal((await snapshot()).follow, true, 'Paste did not enable follow')
      command('stream')
      await until(
        `${session}.term.buffer.active.baseY > ${before.baseY} + 3`,
        'Fixture did not stream after paste'
      )
      command('hold')
      await sleep(160)
      const after = await snapshot()
      assert.equal(after.viewportY, after.baseY, 'Output after paste did not follow')
      return { before, after, bytesBefore, bytesAfter }
    }
  )
  await check('alternate-screen mouse tracking still forwards real wheel input', async () => {
    await reset()
    command('alternate')
    await until(
      `${session}.term.buffer.active.type === 'alternate' && ${session}.term.modes.mouseTrackingMode !== 'none'`,
      'Alternate mouse fixture did not start'
    )
    command('hold')
    const before = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).mouse
    await wheel()
    const after = JSON.parse(fs.readFileSync(config.inputStats, 'utf8')).mouse
    assert.ok(after > before, 'Alternate-screen wheel did not reach fixture as mouse input')
    return { mouseBefore: before, mouseAfter: after, current: await snapshot() }
  })
  command('normal')
  await sleep(100)
  fs.writeFileSync(path.join(config.fixture, 'application.png'), (await wc.capturePage()).toPNG())
  fs.writeFileSync(
    path.join(config.fixture, 'results.json'),
    JSON.stringify(
      {
        ok: checks.every((item) => item.ok),
        checks,
        fixture: config.fixture,
        appRoot: config.appRoot
      },
      null,
      2
    )
  )
  app.quit()
}

const harness = path.join(fixture, 'harness.mjs')
fs.writeFileSync(
  harness,
  `(${runInElectron.toString()})(${JSON.stringify(config)}).catch(async error => { console.error(error.stack || error.message); const {app} = await import('electron'); app.exit(1) })\n`
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
const output = fs.openSync(path.join(fixture, 'electron.log'), 'w')
const child = spawn(electron, [harness], { env, stdio: ['ignore', output, output] })
const timer = setTimeout(() => child.kill('SIGTERM'), 90000)
const status = await new Promise((resolve) => child.once('exit', (code) => resolve(code)))
clearTimeout(timer)
fs.closeSync(output)
if (status !== 0)
  throw new Error(
    `Isolated scrolling harness failed; inspect ${path.join(fixture, 'electron.log')}`
  )
const result = JSON.parse(fs.readFileSync(path.join(fixture, 'results.json'), 'utf8'))
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
