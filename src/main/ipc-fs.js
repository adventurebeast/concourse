import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { confine } from './paths.js'

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

// Pick a non-colliding path for `name` inside `dir`: the bare name if it's free,
// else "name (1).ext", "name (2).ext", … The bound stops a pathologically full
// directory from spinning forever (the caller treats a throw as a skipped drop).
async function uniqueDest(dir, name) {
  let candidate = path.join(dir, name)
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let n = 1; n < 1000; n++) {
    try {
      await fs.access(candidate)
    } catch {
      return candidate // access threw → nothing there → free to use
    }
    candidate = path.join(dir, `${stem} (${n})${ext}`)
  }
  throw new Error('ETOOMANY')
}

// Filesystem IPC handlers. Mutations return `true` on success or throw, and the
// renderer is responsible for surfacing any failures.
export function registerFs(ctx) {
  ipcMain.handle('fs:readDir', async (_e, dirPath) => {
    dirPath = confine(ctx.getRoot(_e.sender), dirPath)
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
    filePath = confine(ctx.getRoot(_e.sender), filePath)
    return fs.readFile(filePath, 'utf8')
  })

  ipcMain.handle('fs:writeFile', async (_e, filePath, content) => {
    filePath = confine(ctx.getRoot(_e.sender), filePath)
    await fs.writeFile(filePath, content)
    return true
  })

  ipcMain.handle('fs:createFile', async (_e, filePath) => {
    filePath = confine(ctx.getRoot(_e.sender), filePath)
    // 'wx' throws if the file already exists.
    await fs.writeFile(filePath, '', { flag: 'wx' })
    return true
  })

  ipcMain.handle('fs:createDir', async (_e, dirPath) => {
    dirPath = confine(ctx.getRoot(_e.sender), dirPath)
    await fs.mkdir(dirPath, { recursive: true })
    return true
  })

  ipcMain.handle('fs:rename', async (_e, oldPath, newPath) => {
    const root = ctx.getRoot(_e.sender)
    oldPath = confine(root, oldPath)
    newPath = confine(root, newPath)
    await fs.rename(oldPath, newPath)
    return true
  })

  ipcMain.handle('fs:delete', async (_e, p) => {
    p = confine(ctx.getRoot(_e.sender), p)
    await fs.rm(p, { recursive: true, force: true })
    return true
  })

  // Persist the bytes of a dropped item that has no on-disk path (e.g. an image
  // dragged straight from a web page or app, which arrives in-memory) to a temp
  // file, and return that absolute path. The terminal drop handler types the path
  // into the pane so the agent has a real file to read. Lives in the system temp
  // dir so it never clutters the user's workspace.
  // Copy a dropped EXTERNAL file/folder into the workspace. The source is dragged
  // from Finder and lives outside the root, so only the DESTINATION is confined;
  // the source is validated as an existing path and copied verbatim (recursively
  // for a folder). A name clash is resolved by suffixing " (n)" so an existing
  // file is never clobbered. Returns the final absolute path created.
  ipcMain.handle('fs:importDrop', async (_e, destDir, srcPath) => {
    const root = ctx.getRoot(_e.sender)
    destDir = confine(root, destDir)
    const src = path.resolve(String(srcPath || ''))
    const stat = await fs.stat(src) // throws if missing/unreadable — surfaced to the renderer
    const dest = confine(root, await uniqueDest(destDir, path.basename(src)))
    await fs.cp(src, dest, { recursive: stat.isDirectory() })
    return dest
  })

  // Copy a dropped PATHLESS item (an image dragged from a web page, which arrives
  // as in-memory bytes) into the workspace. Same destination confinement and
  // clash-safe naming as importDrop; mirrors saveDrop's name sanitising.
  ipcMain.handle('fs:importBytes', async (_e, destDir, name, type, bytes) => {
    const root = ctx.getRoot(_e.sender)
    destDir = confine(root, destDir)
    let safe = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[_.]+/, '').slice(-80)
    const ext = MIME_EXT[type] || ''
    if (!safe) safe = ext ? `image.${ext}` : 'dropped-file'
    else if (!safe.includes('.') && ext) safe = `${safe}.${ext}`
    const dest = confine(root, await uniqueDest(destDir, safe))
    await fs.writeFile(dest, Buffer.from(bytes), { flag: 'wx' })
    return dest
  })

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
