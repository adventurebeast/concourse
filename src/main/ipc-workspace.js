import { ipcMain, dialog } from 'electron'
import fs from 'fs/promises'
import { getRecents, addRecent } from './recents.js'
import { setLastRoot } from './session.js'

export function registerWorkspace(ctx) {
  ipcMain.handle('workspace:get', () => ctx.getRoot())

  ipcMain.handle('workspace:open', async () => {
    const win = ctx.getWindow()
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    ctx.setRoot(result.filePaths[0])
    await addRecent(result.filePaths[0])
    await setLastRoot(result.filePaths[0])
    return ctx.getRoot()
  })

  // Open a known path (e.g. a click on a recent project). Validates that the
  // directory still exists; returns null if it's gone so the renderer can prune.
  ipcMain.handle('workspace:openPath', async (_e, dir) => {
    if (!dir) return null
    try {
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) return null
    } catch {
      return null
    }
    ctx.setRoot(dir)
    await addRecent(dir)
    await setLastRoot(dir)
    return ctx.getRoot()
  })

  ipcMain.handle('workspace:recents', () => getRecents())
}
