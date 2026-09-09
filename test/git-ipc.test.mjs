import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const handlers = vi.hoisted(() => new Map())
vi.mock('electron', () => ({
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  shell: { trashItem: vi.fn() }
}))
import { registerGit } from '../src/main/ipc-git.js'

describe('git IPC with a real temporary repository', () => {
  let root
  const event = { sender: { id: 42 } }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'concourse-git-'))
    git('-c', 'init.defaultBranch=main', 'init', '--quiet')
    git('config', 'user.name', 'Concourse Test')
    git('config', 'user.email', 'test@concourse.invalid')
    fs.writeFileSync(path.join(root, 'file.txt'), 'HEAD content\n')
    fs.writeFileSync(path.join(root, 'old-name.txt'), 'Rename original\n')
    git('add', '--', 'file.txt', 'old-name.txt')
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Test fixture')
    registerGit({ getRoot: () => root })
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('compares staged content to HEAD and working changes to the index', async () => {
    fs.writeFileSync(path.join(root, 'file.txt'), 'Staged content\n')
    git('add', '--', 'file.txt')
    fs.writeFileSync(path.join(root, 'file.txt'), 'Working content\n')
    const diff = handlers.get('git:diff')
    expect(await diff(event, 'file.txt', true)).toEqual({
      original: 'HEAD content\n', modified: 'Staged content\n'
    })
    expect(await diff(event, 'file.txt', false)).toEqual({
      original: 'Staged content\n', modified: 'Working content\n'
    })
  })

  it('stages an option-looking filename without staging unrelated files', async () => {
    fs.writeFileSync(path.join(root, '--all'), 'literal filename')
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'leave untracked')
    expect(await handlers.get('git:stage')(event, ['--all'])).toBe(true)
    const staged = git('diff', '--cached', '--name-only').trim().split('\n')
    expect(staged).toContain('--all')
    expect(staged).not.toContain('unrelated.txt')
    expect(await handlers.get('git:unstage')(event, ['--all'])).toBe(true)
    expect(git('diff', '--cached', '--name-only')).not.toContain('--all')
  })

  it('loads the old HEAD path for a staged rename', async () => {
    git('mv', '--', 'old-name.txt', 'new-name.txt')
    expect(await handlers.get('git:diff')(event, 'new-name.txt', true)).toEqual({
      original: 'Rename original\n', modified: 'Rename original\n'
    })
  })

  it('treats wildcard-looking filenames literally', async () => {
    if (process.platform === 'win32') return // Windows does not allow * in filenames.
    fs.writeFileSync(path.join(root, 'literal*.txt'), 'one')
    fs.writeFileSync(path.join(root, 'literal-other.txt'), 'two')
    expect(await handlers.get('git:stage')(event, ['literal*.txt'])).toBe(true)
    const staged = git('diff', '--cached', '--name-only').trim().split('\n')
    expect(staged).toContain('literal*.txt')
    expect(staged).not.toContain('literal-other.txt')
  })
})
