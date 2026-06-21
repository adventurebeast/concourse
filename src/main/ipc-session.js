import { ipcMain } from 'electron'
import { getLastRoot, getSession, setSession, stageSession } from './session.js'

export function registerSession() {
  // Root that was open when the app last closed (for auto-reopen on launch).
  ipcMain.handle('session:lastRoot', () => getLastRoot())

  // Per-workspace saved state (open editor tabs, terminal layout, UI sizes).
  ipcMain.handle('session:load', (_e, root) => getSession(root))
  ipcMain.handle('session:save', async (_e, root, blob) => {
    await setSession(root, blob)
    return true
  })

  // Synchronous save on window unload. The async save above can't be trusted to
  // finish during unload, so stage the blob into store-io's pending map; the
  // before-quit flush (src/main/index.js) drains it synchronously on quit.
  ipcMain.on('session:saveSync', (e, { root, blob } = {}) => {
    stageSession(root, blob)
    e.returnValue = true
  })
}
