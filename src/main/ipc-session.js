import { ipcMain } from 'electron'
import { getLastRoot, getSession, setSession } from './session.js'

export function registerSession() {
  // Root that was open when the app last closed (for auto-reopen on launch).
  ipcMain.handle('session:lastRoot', () => getLastRoot())

  // Per-workspace saved state (open editor tabs, terminal layout, UI sizes).
  ipcMain.handle('session:load', (_e, root) => getSession(root))
  ipcMain.handle('session:save', async (_e, root, blob) => {
    await setSession(root, blob)
    return true
  })
}
