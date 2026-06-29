import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import { getRecents, addRecent } from './recents.js'
import { setLastRoot } from './session.js'

// Resolve symlinks once at the boundary so a folder is always bucketed under its
// canonical path. On macOS /tmp → /private/tmp (and iCloud/home paths) are
// symlinked, so an unresolved root could store captured commands under one form
// and look them up under another — making per-project history silently fall back
// to the Global list. Falls back to the raw path if realpath fails (e.g. perms).
async function canonical(dir) {
  try {
    return await fs.realpath(dir)
  } catch {
    return dir
  }
}

// The workspace root is per window (event.sender), so each open window can hold a
// different folder. `setLastRoot` still records the most-recently-opened folder
// across all windows for the launch / dock-activate window to reopen.
//
// `watchers` is the recursive fs-watcher manager (src/main/watcher.js): every time
// a window's root changes we (re)point its watcher at the new folder so the file
// tree stays in sync with on-disk changes.
export function registerWorkspace(ctx, watchers) {
  ipcMain.handle('workspace:get', (e) => ctx.getRoot(e.sender))

  ipcMain.handle('workspace:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = await canonical(result.filePaths[0])
    ctx.setRoot(e.sender, dir)
    watchers.start(win, dir)
    await addRecent(dir)
    await setLastRoot(dir)
    return ctx.getRoot(e.sender)
  })

  // Open a known path (e.g. a click on a recent project, or session restore on
  // launch). Validates that the directory still exists; returns null if it's gone
  // so the renderer can prune.
  ipcMain.handle('workspace:openPath', async (e, raw) => {
    if (!raw) return null
    try {
      const stat = await fs.stat(raw)
      if (!stat.isDirectory()) return null
    } catch {
      return null
    }
    const dir = await canonical(raw)
    ctx.setRoot(e.sender, dir)
    watchers.start(BrowserWindow.fromWebContents(e.sender), dir)
    await addRecent(dir)
    await setLastRoot(dir)
    return ctx.getRoot(e.sender)
  })

  ipcMain.handle('workspace:recents', () => getRecents())
}
