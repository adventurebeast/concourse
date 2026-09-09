import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// Exercise the real renderer with small DOM/Monaco doubles. Controlled IPC
// promises reproduce races that a fast local filesystem rarely exposes.
const source = readFileSync(new URL('../src/renderer/editor.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '')
  .replace('export function createEditor', 'function createEditor')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

class Element {
  children = []
  dataset = {}
  style = {}
  events = new Map()
  className = ''
  classList = {
    toggle: (name, on) => {
      const names = new Set(this.className.split(' ').filter(Boolean))
      if (on) names.add(name)
      else names.delete(name)
      this.className = [...names].join(' ')
    }
  }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child }
  append(...children) { children.forEach((child) => this.appendChild(child)) }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
  contains(target) { return this === target || this.children.some((child) => child.contains(target)) }
  addEventListener(name, cb) { this.events.set(name, cb) }
  removeEventListener(name) { this.events.delete(name) }
  focus() {}
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1))) return child
      const found = child.querySelector(selector)
      if (found) return found
    }
    return null
  }
  click() { return this.events.get('click')?.({ target: this, stopPropagation() {} }) }
}

function harness() {
  const elements = Object.fromEntries(['editor-tabs', 'editor', 'editor-welcome'].map((id) => [id, new Element()]))
  const body = new Element()
  Object.values(elements).forEach((el) => body.appendChild(el))
  const document = new Element()
  Object.assign(document, { body, getElementById: (id) => elements[id], createElement: () => new Element() })
  const fs = {
    readFile: vi.fn(async () => 'original'),
    stat: vi.fn(async () => ({ mtimeMs: 1 })),
    writeFile: vi.fn(async () => {}),
    onChanged: vi.fn()
  }
  const window = new Element()
  window.api = { fs, platform: 'darwin' }
  const models = []
  let selectedModel
  const fileEditor = {
    getOption: () => 'monospace',
    setModel: (model) => { selectedModel = model },
    updateOptions() {}, focus() {}, restoreViewState() {}, revealLineInCenter() {}, setSelection() {},
    saveViewState: () => ({}), getPosition: () => ({ lineNumber: 1 })
  }
  const monaco = { editor: {
    EditorOption: { fontFamily: 'fontFamily' },
    create: () => fileEditor,
    createDiffEditor: () => ({ setModel() {}, layout() {}, saveViewState() {}, updateOptions() {} }),
    setModelLanguage: vi.fn(),
    createModel: (initial) => {
      let content = initial
      let version = 1
      let listener = () => {}
      let disposed = false
      const model = {
        getValue: () => { if (disposed) throw new Error('Disposed model'); return content },
        getVersionId: () => version,
        setValue: (value) => { if (disposed) throw new Error('Disposed model'); content = value; version++; listener() },
        onDidChangeContent: (cb) => { listener = cb },
        dispose: () => { disposed = true }
      }
      models.push(model)
      return model
    }
  } }
  const create = new Function('monaco', 'window', 'document', 'self', 'setInterval', 'showToast', source + '\nreturn createEditor()')
  const editor = create(monaco, window, document, {}, () => 0, vi.fn())
  return {
    editor, fs, models, elements, body,
    model: () => selectedModel,
    reconcile: () => window.events.get('focus')(),
    clickButton: (label) => {
      const find = (el) => el.textContent === label ? el : el.children.map(find).find(Boolean)
      const button = find(body)
      expect(button, `button ${label}`).toBeTruthy()
      return button.click()
    }
  }
}

describe('editor concurrent filesystem operations', () => {
  it('keeps edits made while a save is in flight dirty and saves them on the next request', async () => {
    const h = harness()
    await h.editor.openFile('/workspace/file.txt')
    h.model().setValue('first edit')
    const write = deferred()
    h.fs.writeFile.mockReturnValueOnce(write.promise)
    const first = h.editor.save()
    await vi.waitFor(() => expect(h.fs.writeFile).toHaveBeenCalledOnce())
    h.model().setValue('second edit')
    const second = h.editor.save()
    expect(h.fs.writeFile).toHaveBeenCalledOnce()
    write.resolve()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(h.fs.writeFile.mock.calls.map((args) => args[1])).toEqual(['first edit', 'second edit'])
    expect(h.editor.hasUnsavedTabs()).toBe(false)
  })

  it('does not replace edits made while an external reload is reading', async () => {
    const h = harness()
    await h.editor.openFile('/workspace/file.txt')
    h.fs.stat.mockResolvedValue({ mtimeMs: 2 })
    const read = deferred()
    h.fs.readFile.mockReturnValueOnce(read.promise)
    const reconcile = h.reconcile()
    await vi.waitFor(() => expect(h.fs.readFile).toHaveBeenCalledTimes(2))
    h.model().setValue('my in-progress edit')
    read.resolve('agent edit')
    await reconcile
    expect(h.model().getValue()).toBe('my in-progress edit')
    expect(h.editor.hasUnsavedTabs()).toBe(true)
  })

  it('safely ignores a reload completing after its tab closes', async () => {
    const h = harness()
    await h.editor.openFile('/workspace/file.txt')
    h.fs.stat.mockResolvedValue({ mtimeMs: 2 })
    const read = deferred()
    h.fs.readFile.mockReturnValueOnce(read.promise)
    const reconcile = h.reconcile()
    await vi.waitFor(() => expect(h.fs.readFile).toHaveBeenCalledTimes(2))
    const tab = h.elements['editor-tabs'].children[0]
    const close = tab.querySelector('.etab-close')
    tab.events.get('click')({ target: close, stopPropagation() {} })
    read.resolve('agent edit')
    await expect(reconcile).resolves.toBeUndefined()
    expect(h.editor.listOpenFiles().files).toEqual([])
  })

  it('does not close a dirty tab when Reload from Disk fails', async () => {
    const h = harness()
    await h.editor.openFile('/workspace/file.txt')
    h.model().setValue('my edit')
    h.fs.stat.mockResolvedValue({ mtimeMs: 2 })
    const saving = h.editor.save()
    await vi.waitFor(() => expect(h.body.querySelector('.term-confirm-overlay')).toBeTruthy())
    h.fs.readFile.mockRejectedValueOnce(new Error('File removed'))
    h.clickButton('Reload from Disk')
    expect(await saving).toBe(false)
    expect(h.model().getValue()).toBe('my edit')
    expect(h.editor.hasUnsavedTabs()).toBe(true)
  })

  it('preserves edits and tab controls when a parent folder is renamed', async () => {
    const h = harness()
    await h.editor.openFile('/workspace/src/file.txt')
    h.model().setValue('unsaved edit')
    const originalModel = h.model()
    h.editor.handlePathChanged('/workspace/src', '/workspace/lib')
    expect(h.editor.listOpenFiles().files).toEqual([{ path: '/workspace/lib/file.txt', line: 1, active: true }])
    const tab = h.elements['editor-tabs'].children[0]
    tab.click()
    expect(h.model()).toBe(originalModel)
    expect(h.editor.hasUnsavedTabs()).toBe(true)
    await h.editor.save()
    expect(h.fs.writeFile).toHaveBeenCalledWith('/workspace/lib/file.txt', 'unsaved edit')
    const close = tab.querySelector('.etab-close')
    tab.events.get('click')({ target: close, stopPropagation() {} })
    expect(h.editor.listOpenFiles().files).toEqual([])
  })

  it('follows a move that completes while a file is opening', async () => {
    const h = harness()
    const read = deferred()
    h.fs.readFile.mockReturnValueOnce(read.promise)
    const opening = h.editor.openFile('/workspace/old.txt')
    h.editor.handlePathChanged('/workspace/old.txt', '/workspace/new.txt')
    read.resolve('before rename')
    await opening
    expect(h.editor.listOpenFiles().files[0].path).toBe('/workspace/new.txt')
    expect(h.models).toHaveLength(1)
  })

  it('keeps staged and working-tree diffs distinct for the same file', async () => {
    const h = harness()
    await h.editor.openDiff({ path: 'file.txt', original: 'head', modified: 'index', staged: true })
    await h.editor.openDiff({ path: 'file.txt', original: 'index', modified: 'working' })
    expect(h.elements['editor-tabs'].children.map((tab) => tab.querySelector('.etab-label').textContent))
      .toEqual(['file.txt (Staged)', 'file.txt (Working Tree)'])
    expect(h.models.map((model) => model.getValue())).toEqual(['head', 'index', 'index', 'working'])
    await h.editor.openDiff({ path: 'file.txt', original: 'head', modified: 'new index', staged: true })
    expect(h.models).toHaveLength(4)
    expect(h.models[1].getValue()).toBe('new index')
  })
})
