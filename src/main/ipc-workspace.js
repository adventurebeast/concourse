import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import { getRecents, addRecent } from './recents.js'
import { setLastRoot } from './session.js'
import { refreshAppMenu } from './menu.js'

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
export function registerWorkspace(ctx, watchers, { openWindow } = {}) {
  ipcMain.handle('workspace:get', (e) => ctx.getRoot(e.sender))

  async function openDirectory(e, raw, opts = {}) {
    const dir = await canonical(raw)
    // A workbench belongs to one workspace. Switching that root in place would
    // strand live agents and unsaved editor buffers, then save them under the
    // wrong project's session. Open another window and keep this one intact.
    await addRecent(dir)
    await setLastRoot(dir)
    refreshAppMenu()
    // Read the current root after the awaits: two rapid folder-open requests
    // must not both see an empty window and replace each other's root.
    const current = ctx.getRoot(e.sender)
    const separate = (current && current !== dir) || opts?.newWindow === true
    if (separate && !openWindow) return null
    if (separate) {
      openWindow(dir)
      return null
    }
    ctx.setRoot(e.sender, dir)
    watchers.start(BrowserWindow.fromWebContents(e.sender), dir)
    return dir
  }

  ipcMain.handle('workspace:open', async (e, opts) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return openDirectory(e, result.filePaths[0], opts)
  })

  // Open a known path (e.g. a click on a recent project, or session restore on
  // launch). Validates that the directory still exists; returns null if it's gone
  // so the renderer can prune.
  ipcMain.handle('workspace:openPath', async (e, raw, opts) => {
    if (!raw) return null
    try {
      const stat = await fs.stat(raw)
      if (!stat.isDirectory()) return null
    } catch {
      return null
    }
    return openDirectory(e, raw, opts)
  })

  ipcMain.handle('workspace:recents', () => getRecents())
}
