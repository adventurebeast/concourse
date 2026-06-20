import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

// Entries we never surface in the explorer.
const HIDDEN = new Set(['.git', '.DS_Store'])

// Map an image MIME type to a file extension so a dropped image gets a name an
// agent can recognise. Browser drags often hand us bytes with no usable filename.
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff'
}

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

  // Persist the bytes of a dropped item that has no on-disk path (e.g. an image
  // dragged straight from a web page or app, which arrives in-memory) to a temp
  // file, and return that absolute path. The terminal drop handler types the path
  // into the pane so the agent has a real file to read. Lives in the system temp
  // dir so it never clutters the user's workspace.
  ipcMain.handle('fs:saveDrop', async (_e, name, type, bytes) => {
    const dir = path.join(os.tmpdir(), 'concourse-drops')
    await fs.mkdir(dir, { recursive: true })
    let safe = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[_.]+/, '').slice(-80)
    const ext = MIME_EXT[type] || ''
    if (!safe) safe = ext ? `image.${ext}` : 'dropped-file'
    else if (!safe.includes('.') && ext) safe = `${safe}.${ext}`
    const out = path.join(dir, `${Date.now().toString(36)}-${safe}`)
    await fs.writeFile(out, Buffer.from(bytes))
    return out
  })
}
