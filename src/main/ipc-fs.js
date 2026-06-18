import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'

// Entries we never surface in the explorer.
const HIDDEN = new Set(['.git', '.DS_Store'])

// Filesystem IPC handlers. Mutations return `true` on success or throw, and the
// renderer is responsible for surfacing any failures.
export function registerFs(ctx) {
  ipcMain.handle('fs:readDir', async (_e, dirPath) => {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries = []
    for (const d of dirents) {
      if (HIDDEN.has(d.name)) continue
      entries.push({
        name: d.name,
        path: path.join(dirPath, d.name),
        isDir: d.isDirectory()
      })
    }
    // Directories first, then files; each group alphabetical (locale-aware).
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  })

  ipcMain.handle('fs:readFile', async (_e, filePath) => {
    return fs.readFile(filePath, 'utf8')
  })

  ipcMain.handle('fs:writeFile', async (_e, filePath, content) => {
    await fs.writeFile(filePath, content)
    return true
  })

  ipcMain.handle('fs:createFile', async (_e, filePath) => {
    // 'wx' throws if the file already exists.
    await fs.writeFile(filePath, '', { flag: 'wx' })
    return true
  })

  ipcMain.handle('fs:createDir', async (_e, dirPath) => {
    await fs.mkdir(dirPath, { recursive: true })
    return true
  })

  ipcMain.handle('fs:rename', async (_e, oldPath, newPath) => {
    await fs.rename(oldPath, newPath)
    return true
  })

  ipcMain.handle('fs:delete', async (_e, p) => {
    await fs.rm(p, { recursive: true, force: true })
    return true
  })
}
