import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createContext } from '../src/main/context.js'

const mocks = vi.hoisted(() => ({
  handlers: new Map(),
  dialog: vi.fn(),
  addRecent: vi.fn(async () => {}),
  setLastRoot: vi.fn(async () => {}),
  refreshAppMenu: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name, handler) => mocks.handlers.set(name, handler) },
  dialog: { showOpenDialog: mocks.dialog },
  BrowserWindow: { fromWebContents: (sender) => ({ webContents: sender }) }
}))
vi.mock('../src/main/recents.js', () => ({ getRecents: vi.fn(), addRecent: mocks.addRecent }))
vi.mock('../src/main/session.js', () => ({ setLastRoot: mocks.setLastRoot }))
vi.mock('../src/main/menu.js', () => ({ refreshAppMenu: mocks.refreshAppMenu }))
import { registerWorkspace } from '../src/main/ipc-workspace.js'

describe('workspace routing preserves live workbenches', () => {
  let base, first, second, ctx, watchers, openWindow
  const event = { sender: { id: 42 } }
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-workspace-'))
    first = path.join(base, 'first')
    second = path.join(base, 'second')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    first = fs.realpathSync(first)
    second = fs.realpathSync(second)
  })
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createContext()
    watchers = { start: vi.fn() }
    openWindow = vi.fn()
    registerWorkspace(ctx, watchers, { openWindow })
  })

  it('opens the first folder in its empty welcome window', async () => {
    const result = await mocks.handlers.get('workspace:openPath')(event, first)
    expect(result).toBe(first)
    expect(ctx.getRoot(event.sender)).toBe(first)
    expect(watchers.start).toHaveBeenCalledOnce()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('opens another project separately without changing the original root or watcher', async () => {
    ctx.setRoot(event.sender, first)
    const result = await mocks.handlers.get('workspace:openPath')(event, second)
    expect(result).toBeNull()
    expect(ctx.getRoot(event.sender)).toBe(first)
    expect(watchers.start).not.toHaveBeenCalled()
    expect(openWindow).toHaveBeenCalledWith(second)
    expect(mocks.addRecent).toHaveBeenCalledWith(second)
  })

  it('preserves standalone terminals when the renderer requests a separate window', async () => {
    mocks.dialog.mockResolvedValue({ canceled: false, filePaths: [first] })
    expect(await mocks.handlers.get('workspace:open')(event, { newWindow: true })).toBeNull()
    expect(ctx.getRoot(event.sender)).toBeNull()
    expect(watchers.start).not.toHaveBeenCalled()
    expect(openWindow).toHaveBeenCalledWith(first)
  })

  it('does not replace the first root when two requests arrive together', async () => {
    const results = await Promise.all([
      mocks.handlers.get('workspace:openPath')(event, first),
      mocks.handlers.get('workspace:openPath')(event, second)
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(openWindow).toHaveBeenCalledOnce()
    expect(watchers.start).toHaveBeenCalledOnce()
    expect(openWindow.mock.calls[0][0]).not.toBe(ctx.getRoot(event.sender))
  })

  it('keeps the same project in its current window and rejects missing folders', async () => {
    ctx.setRoot(event.sender, first)
    expect(await mocks.handlers.get('workspace:openPath')(event, first)).toBe(first)
    expect(await mocks.handlers.get('workspace:openPath')(event, path.join(base, 'missing'))).toBeNull()
    expect(openWindow).not.toHaveBeenCalled()
  })
})
