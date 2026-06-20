import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import { getRecents, addRecent } from './recents.js'
import { setLastRoot } from './session.js'

// The workspace root is per window (event.sender), so each open window can hold a
// different folder. `setLastRoot` still records the most-recently-opened folder
// across all windows for the launch / dock-activate window to reopen.
export function registerWorkspace(ctx) {
  ipcMain.handle('workspace:get', (e) => ctx.getRoot(e.sender))

  ipcMain.handle('workspace:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    ctx.setRoot(e.sender, result.filePaths[0])
    await addRecent(result.filePaths[0])
    await setLastRoot(result.filePaths[0])
    return ctx.getRoot(e.sender)
  })

  // Open a known path (e.g. a click on a recent project). Validates that the
  // directory still exists; returns null if it's gone so the renderer can prune.
  ipcMain.handle('workspace:openPath', async (e, dir) => {
    if (!dir) return null
    try {
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) return null
    } catch {
      return null
    }
    ctx.setRoot(e.sender, dir)
    await addRecent(dir)
    await setLastRoot(dir)
    return ctx.getRoot(e.sender)
  })

  ipcMain.handle('workspace:recents', () => getRecents())
}
