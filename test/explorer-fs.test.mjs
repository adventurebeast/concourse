import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { handlers, trashItem, showOpenDialog } = vi.hoisted(() => ({
  handlers: new Map(),
  trashItem: vi.fn(),
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: { showOpenDialog },
  shell: { trashItem }
}))

import { registerFs } from '../src/main/ipc-fs.js'

let base, root, destination
const event = { sender: {} }
const invoke = (channel, ...args) => handlers.get(`fs:${channel}`)(event, ...args)

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'concourse-explorer-')))
  root = path.join(base, 'workspace')
  destination = path.join(root, 'destination')
  await fs.mkdir(destination, { recursive: true })
  await fs.writeFile(path.join(root, 'source.txt'), 'keep source')
  handlers.clear()
  trashItem.mockReset().mockResolvedValue(undefined)
  showOpenDialog.mockReset()
  registerFs({ getRoot: () => root })
})

afterEach(async () => {
  // Only this test's newly generated fixture directory; failures remain visible.
  await fs.rm(base, { recursive: true })
})

describe('explorer filesystem operations', () => {
  it('refuses a rename collision and preserves both files', async () => {
    const source = path.join(root, 'source.txt')
    const target = path.join(root, 'existing.txt')
    await fs.writeFile(target, 'keep destination')
    await expect(invoke('rename', source, target)).rejects.toThrow('already exists')
    expect(await fs.readFile(source, 'utf8')).toBe('keep source')
    expect(await fs.readFile(target, 'utf8')).toBe('keep destination')
  })

  it('refuses a move collision and preserves both files', async () => {
    const source = path.join(root, 'source.txt')
    const target = path.join(destination, 'source.txt')
    await fs.writeFile(target, 'keep destination')
    await expect(invoke('move', source, destination)).rejects.toThrow('already exists')
    expect(await fs.readFile(source, 'utf8')).toBe('keep source')
    expect(await fs.readFile(target, 'utf8')).toBe('keep destination')
  })

  it('renames and moves entries to the requested unused path', async () => {
    const renamed = path.join(root, 'renamed.txt')
    expect(await invoke('rename', path.join(root, 'source.txt'), renamed)).toBe(true)
    const moved = await invoke('move', renamed, destination)
    expect(moved).toBe(path.join(destination, 'renamed.txt'))
    expect(await fs.readFile(moved, 'utf8')).toBe('keep source')
    await expect(fs.lstat(renamed)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks moving a folder into itself and mutating the workspace root', async () => {
    const child = path.join(destination, 'child')
    await fs.mkdir(child)
    await expect(invoke('move', destination, child)).rejects.toThrow('itself')
    await expect(invoke('move', root, child)).rejects.toThrow('workspace root')
    await expect(invoke('rename', root, path.join(base, 'renamed'))).rejects.toThrow(
      'workspace root'
    )
    await expect(invoke('delete', root)).rejects.toThrow('workspace root')
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('uses system trash with no permanent deletion fallback', async () => {
    const source = path.join(root, 'source.txt')
    expect(await invoke('delete', source)).toBe(true)
    expect(trashItem).toHaveBeenCalledWith(source)
    trashItem.mockRejectedValueOnce(new Error('Trash unavailable'))
    await expect(invoke('delete', source)).rejects.toThrow('Trash unavailable')
    expect(await fs.readFile(source, 'utf8')).toBe('keep source')
  })

  it('renames and trashes the selected symlink rather than its target', async () => {
    const target = path.join(root, 'source.txt')
    const link = path.join(root, 'link.txt')
    const renamed = path.join(root, 'renamed-link.txt')
    await fs.symlink(target, link)
    await invoke('rename', link, renamed)
    expect((await fs.lstat(renamed)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('keep source')
    await invoke('delete', renamed)
    expect(trashItem).toHaveBeenCalledWith(renamed)
  })

  it('treats a dangling destination symlink as a collision', async () => {
    const link = path.join(destination, 'source.txt')
    await fs.symlink(path.join(root, 'missing.txt'), link)
    await expect(invoke('move', path.join(root, 'source.txt'), destination)).rejects.toThrow(
      'already exists'
    )
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('keeps imports clash-safe, including existing dangling symlinks', async () => {
    const link = path.join(destination, 'source.txt')
    await fs.symlink(path.join(root, 'missing.txt'), link)
    const copied = await invoke('importDrop', destination, path.join(root, 'source.txt'))
    expect(copied).toBe(path.join(destination, 'source (1).txt'))
    expect(await fs.readFile(copied, 'utf8')).toBe('keep source')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
  })

  it('blocks outside-workspace mutation and escaped destination selections', async () => {
    const outside = path.join(base, 'outside.txt')
    await fs.writeFile(outside, 'outside')
    await expect(invoke('delete', outside)).rejects.toThrow('EPATHESCAPE')
    await expect(invoke('move', path.join(root, 'source.txt'), base)).rejects.toThrow('EPATHESCAPE')
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [base] })
    await expect(invoke('chooseDestination', root)).rejects.toThrow('EPATHESCAPE')
    expect(trashItem).not.toHaveBeenCalled()
    expect(await fs.readFile(outside, 'utf8')).toBe('outside')
  })
})
