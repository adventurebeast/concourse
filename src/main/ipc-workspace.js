import { ipcMain, dialog } from 'electron'

export function registerWorkspace(ctx) {
  ipcMain.handle('workspace:get', () => ctx.getRoot())

  ipcMain.handle('workspace:open', async () => {
    const win = ctx.getWindow()
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    ctx.setRoot(result.filePaths[0])
    return ctx.getRoot()
  })
}
