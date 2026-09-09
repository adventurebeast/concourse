import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

function documentDouble() {
  const document = { listeners: new Map(), activeElement: null }
  document.createElement = () => ({
    children: [], events: new Map(), isConnected: true,
    append(...children) { this.children.push(...children); children.forEach((child) => { child.parent = this }) },
    appendChild(child) { this.append(child) },
    setAttribute() {},
    focus() { document.activeElement = this },
    addEventListener(name, cb) { this.events.set(name, cb) },
    remove() { this.isConnected = false; this.parent.children = this.parent.children.filter((child) => child !== this) },
    click() { this.events.get('click')?.() }
  })
  document.body = document.createElement()
  document.addEventListener = (name, cb) => document.listeners.set(name, cb)
  document.removeEventListener = (name) => document.listeners.delete(name)
  return document
}

describe('workbench modal behavior', () => {
  it('returns focus to the original terminal/editor when the palette closes', () => {
    const source = readFileSync(new URL('../src/renderer/commandPalette.js', import.meta.url), 'utf8')
    const code = source.slice(source.indexOf('function open() {'), source.indexOf('function toggle() {'))
    const document = documentDouble()
    const opener = document.createElement()
    const search = document.createElement()
    const overlay = { hidden: true }
    opener.focus()
    const palette = new Function('document', 'search', 'overlay', `
      let openGen = 0, opener = null
      const render = () => {}, load = async () => {}, loadSuggestions = async () => {}
      ${code}
      return { open, close }
    `)(document, search, overlay)
    palette.open()
    expect(document.activeElement).toBe(search)
    palette.open() // a repeated open must not replace the original focus target
    palette.close()
    expect(document.activeElement).toBe(opener)
    expect(overlay.hidden).toBe(true)
  })

  it('defaults tracked-file discard to Cancel and requires an explicit destructive choice', async () => {
    const source = readFileSync(new URL('../src/renderer/git.js', import.meta.url), 'utf8')
    const code = source.slice(source.indexOf('let discardOverlay = null'), source.indexOf('function stagedCount()'))
    const document = documentDouble()
    const api = { git: { discard: vi.fn(async () => true) } }
    const discardChanges = new Function('document', 'api', `
      const splitPath = (path) => ({ name: path })
      ${code}
      return discardChanges
    `)(document, api)
    const item = { path: 'tracked.txt', status: 'M' }
    const cancelled = discardChanges(item)
    expect(document.activeElement.textContent).toBe('Cancel')
    expect(api.git.discard).not.toHaveBeenCalled()
    document.activeElement.click()
    await cancelled
    expect(document.body.children).toHaveLength(0)
    expect(api.git.discard).not.toHaveBeenCalled()
    const approved = discardChanges(item)
    const box = document.body.children[0].children[0]
    expect(box.children[1].textContent).toContain('cannot be undone')
    box.children[2].children[1].click()
    await approved
    expect(api.git.discard).toHaveBeenCalledWith(['tracked.txt'])
  })
})
