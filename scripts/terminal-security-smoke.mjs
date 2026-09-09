#!/usr/bin/env node
// End-to-end privacy probe for a running packaged Concourse instance launched
// with --remote-debugging-port. It sends a synthetic password through xterm's
// real input path and verifies every Concourse terminal header remains unchanged.

const port = Number(process.argv[2] || 9333)
const secret = process.argv[3] || 'SYNTHETIC_PASSWORD_v38_DO_NOT_STORE'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json())
const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
if (!page) throw new Error(`No Concourse page found on debugging port ${port}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
})

function call(method, params = {}) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed')
  return result.result.value
}

async function pressEnter() {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 }
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: '\r',
    unmodifiedText: '\r',
    ...key
  })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

const headerSnapshot = `(() => {
  const selectors = ['.term-tab-label', '.cell-label', '.card-label']
  return {
    labels: selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((el) => el.textContent)),
    titles: [...document.querySelectorAll('.term-tab, .term-cell')].map((el) => el.getAttribute('title') || ''),
    activeClass: document.activeElement?.className || ''
  }
})()`

try {
  await call('Runtime.enable')
  await evaluate(`document.querySelector('.xterm-helper-textarea')?.focus()`)
  // Let the first process-name poll replace the launch placeholder before taking
  // the baseline. Automatic fixed labels and explicit user names are both valid.
  await sleep(1800)
  const before = await evaluate(headerSnapshot)
  if (!before.labels.length) throw new Error('No terminal labels found')

  await call('Input.insertText', { text: 'read -s terminal_security_probe' })
  await pressEnter()
  await sleep(500)
  await call('Input.insertText', { text: secret })
  await pressEnter()
  await sleep(1500)

  const after = await evaluate(headerSnapshot)
  if ([...after.labels, ...after.titles].some((value) => value.includes(secret))) {
    throw new Error('Synthetic password reached terminal header metadata')
  }
  if (JSON.stringify(after.labels) !== JSON.stringify(before.labels)) {
    throw new Error('Terminal labels changed during password entry')
  }

  // Allow the normal session autosave interval to run; the caller can scan the
  // isolated user-data directory after this process exits.
  await sleep(5000)
  console.log(
    JSON.stringify(
      { ok: true, labelsChecked: after.labels.length, titlesChecked: after.titles.length },
      null,
      2
    )
  )
} finally {
  socket.close()
}
