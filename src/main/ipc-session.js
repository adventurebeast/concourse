import { ipcMain } from 'electron'
import { getLastRoot, getSession, setSession, saveSessionSync } from './session.js'

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
  // finish during unload, and the before-quit flush has already run by this point
  // in the quit sequence — so write to disk synchronously here.
  ipcMain.on('session:saveSync', (e, { root, blob } = {}) => {
    saveSessionSync(root, blob)
    e.returnValue = true
  })
}
