import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/renderer/main.js', import.meta.url), 'utf8')
const folderCode = source.slice(source.indexOf('function workspaceOpenOptions()'), source.indexOf("document.getElementById('open-folder').addEventListener"))
const saveCode = source.slice(source.indexOf('async function saveSession()'), source.indexOf('// A periodic dirty-check'))

function harness({ startup = 'welcome', requestedRoot = null, fresh = false } = {}) {
  const state = { tabs: [], restored: null }
  const blob = { terminals: { tabs: [{ customLabel: 'Agent task' }, {}], layout: 'grid' } }
  const api = {
    workspace: { get: vi.fn(async () => requestedRoot), openPath: vi.fn(async (root) => root) },
    settings: { getAll: vi.fn(async () => ({ values: { 'appearance.startup': startup } })) },
    session: {
      load: vi.fn(async () => blob), save: vi.fn(async () => {}), lastRoot: vi.fn(async () => '/saved')
    }
  }
  const terminals = { getState: () => state, create: vi.fn(() => state.tabs.push({})) }
  const fileTree = { load: vi.fn(async () => {}) }
  const git = { refresh: vi.fn() }
  const welcome = { show: vi.fn(), hide: vi.fn() }
  const restoreSession = vi.fn(async (saved) => { state.tabs.push(...saved.terminals.tabs); state.restored = saved })
  const setup = new Function('api', 'terminals', 'fileTree', 'git', 'welcome', 'restoreSession', 'setTitle', 'gatherSession', `
    let currentRoot = null
    let loadingWorkspace = false
    let lastSavedJSON = null
    ${folderCode}
    ${saveCode}
    return { setWorkspace, workspaceOpenOptions, saveSession }
  `)
  const flow = setup(api, terminals, fileTree, git, welcome, restoreSession, vi.fn(), () => state)
  const bootCode = source.slice(source.indexOf('const isFreshWindow =')).replace(';(async () => {', 'return (async () => {')
  const boot = () => new Function('api', 'location', 'setWorkspace', 'setTitle', 'fileTree', 'git', 'terminals', 'setTerminalsOnly', 'welcome', bootCode)(
    api, { search: fresh ? '?fresh=1' : '' }, flow.setWorkspace, vi.fn(), fileTree, git, terminals, vi.fn(), welcome
  )
  return { ...flow, api, terminals, welcome, state, restoreSession, boot, blob }
}

describe('workspace renderer restore flow', () => {
  it('shows Welcome without a starter PTY and restores the chosen project once', async () => {
    const h = harness()
    await h.boot()
    expect(h.welcome.show).toHaveBeenCalledOnce()
    expect(h.terminals.create).not.toHaveBeenCalled()
    await h.setWorkspace('/chosen')
    expect(h.api.session.load).toHaveBeenCalledWith('/chosen')
    expect(h.state.tabs).toHaveLength(2)
    await h.setWorkspace('/chosen')
    expect(h.restoreSession).toHaveBeenCalledOnce()
  })

  it('restores an explicitly requested root even in a fresh window with Welcome preferred', async () => {
    const h = harness({ requestedRoot: '/requested', fresh: true })
    await h.boot()
    expect(h.api.session.load).toHaveBeenCalledWith('/requested')
    expect(h.api.session.lastRoot).not.toHaveBeenCalled()
    expect(h.state.restored).toBe(h.blob)
  })

  it('still restores the last project on startup when that preference is set', async () => {
    const h = harness({ startup: 'last-project' })
    await h.boot()
    expect(h.api.workspace.openPath).toHaveBeenCalledWith('/saved')
    expect(h.api.session.load).toHaveBeenCalledWith('/saved')
  })

  it('requests a separate workspace window if standalone terminals exist', () => {
    const h = harness()
    h.terminals.create()
    expect(h.workspaceOpenOptions()).toEqual({ newWindow: true })
  })

  it('does not autosave a partial restoration over the existing fleet', async () => {
    const h = harness()
    let finish
    h.api.session.load.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const opening = h.setWorkspace('/chosen')
    await vi.waitFor(() => expect(h.api.session.load).toHaveBeenCalled())
    await h.saveSession()
    expect(h.api.session.save).not.toHaveBeenCalled()
    finish(h.blob)
    await opening
    await h.saveSession()
    expect(h.api.session.save).toHaveBeenCalledWith('/chosen', h.state)
  })
})
