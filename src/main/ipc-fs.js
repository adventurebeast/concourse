import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
      await fs.lstat(candidate)
    } catch (err) {
      if (err.code === 'ENOENT') return candidate
      throw err
    }
    candidate = path.join(dir, `${stem} (${n})${ext}`)
  }
  throw new Error('ETOOMANY')
}

// Validate the target and its parent, while preserving the final directory
// entry. Resolving the entire path before rename/trash would act on a symlink's
// target instead of the link the user selected in the explorer.
function entryPath(root, value) {
  const absolute = path.resolve(value)
  confine(root, absolute)
  return path.join(confine(root, path.dirname(absolute)), path.basename(absolute))
}

function protectRoot(root, target) {
  if (confine(root, target) === confine(root, root)) {
    throw new Error('The workspace root cannot be renamed, moved, or deleted.')
  }
}

async function requireUnused(destination, source) {
  let existing
  try {
    existing = await fs.lstat(destination)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  // Permit case-only renames on a case-insensitive filesystem, but never treat
  // another existing entry (including a dangling symlink) as an empty target.
  if (source && source.toLowerCase() === destination.toLowerCase()) {
    const original = await fs.lstat(source)
    if (existing.dev === original.dev && existing.ino === original.ino) return
  }
  throw new Error('An item with that name already exists.')
}

// Filesystem IPC handlers. Mutations return `true` on success or throw, and the
// renderer is responsible for surfacing any failures.
export function registerFs(ctx) {
  ipcMain.handle('fs:chooseDestination', async (e, startPath) => {
    const root = ctx.getRoot(e.sender)
    if (!root) return null
    let start = root
    try {
      start = confine(root, startPath || root)
    } catch {
      start = confine(root, root)
    }
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
      title: 'Choose a destination inside the workspace',
      defaultPath: start,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return confine(root, result.filePaths[0])
  })

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

  // Cheap on-disk metadata for the editor's stale-write guard. Returns null (not
  // a throw) when the file is missing/unreadable so a not-yet-saved buffer or a
  // deleted file is a clean "no known disk state", not an error the caller must
  // special-case.
  ipcMain.handle('fs:stat', async (_e, filePath) => {
    filePath = confine(ctx.getRoot(_e.sender), filePath)
    try {
      const st = await fs.stat(filePath)
      return { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
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
    protectRoot(root, oldPath)
    oldPath = entryPath(root, oldPath)
    newPath = entryPath(root, newPath)
    if (oldPath === newPath) return true
    await requireUnused(newPath, oldPath)
    await fs.rename(oldPath, newPath)
    return true
  })

  // Move an existing workspace entry into another workspace folder. Unlike an
  // external import, a move never invents a suffixed name or overwrites a clash:
  // the user's project structure should change only exactly as the drop implies.
  ipcMain.handle('fs:move', async (_e, srcPath, destDir) => {
    const root = ctx.getRoot(_e.sender)
    protectRoot(root, srcPath)
    const src = entryPath(root, srcPath)
    const dir = confine(root, destDir)
    const dirStat = await fs.stat(dir)
    if (!dirStat.isDirectory()) throw new Error('ENOTDIR')
    const dest = entryPath(root, path.join(dir, path.basename(src)))
    if (dest === src) return src
    const srcStat = await fs.lstat(src)
    if (srcStat.isDirectory()) {
      const rel = path.relative(src, dest)
      if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..')) {
        throw new Error('A folder cannot be moved into itself.')
      }
    }
    await requireUnused(dest)
    await fs.rename(src, dest)
    return dest
  })

  ipcMain.handle('fs:delete', async (_e, p) => {
    const root = ctx.getRoot(_e.sender)
    protectRoot(root, p)
    p = entryPath(root, p)
    await shell.trashItem(p)
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
    await fs.cp(src, dest, { recursive: stat.isDirectory(), force: false, errorOnExist: true })
    return dest
  })

  // Copy a dropped PATHLESS item (an image dragged from a web page, which arrives
  // as in-memory bytes) into the workspace. Same destination confinement and
  // clash-safe naming as importDrop; mirrors saveDrop's name sanitising.
  ipcMain.handle('fs:importBytes', async (_e, destDir, name, type, bytes) => {
    const root = ctx.getRoot(_e.sender)
    destDir = confine(root, destDir)
    let safe = String(name || '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[_.]+/, '')
      .slice(-80)
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
    let safe = String(name || '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[_.]+/, '')
      .slice(-80)
    const ext = MIME_EXT[type] || ''
    if (!safe) safe = ext ? `image.${ext}` : 'dropped-file'
    else if (!safe.includes('.') && ext) safe = `${safe}.${ext}`
    const out = path.join(dir, `${Date.now().toString(36)}-${safe}`)
    await fs.writeFile(out, Buffer.from(bytes))
    return out
  })
}
