import { ipcMain, BrowserWindow } from 'electron'
import { getProjectCommands } from './command-sources.js'
import { historyForRoot } from './command-history.js'
import { favoritesForRoot, addFavorite, removeFavorite } from './command-store.js'

// Backs the command palette's three sources. The renderer asks for everything at
// once (favorites + project commands + frecency-ranked history) scoped to the
// window's open folder, and toggles favorites. The window's root is read from the
// trusted per-window context, never from a renderer-supplied path. All three
// sources are per-project: favorites are pinned to the open folder, project
// commands come from its script files, and history is what's been run in this
// project's panes (captured via the shell hook in ipc-pty.js).

// Tell every window its favorites changed so an open palette re-renders live.
function broadcast() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('commands:changed')
  }
}

export function registerCommands(ctx) {
  ipcMain.handle('commands:list', async (e) => {
    const root = ctx.getRoot(e.sender)
    const [history, project, favorites] = await Promise.all([
      historyForRoot(root),
      getProjectCommands(root),
      favoritesForRoot(root)
    ])
    return { favorites, project, history }
  })

  ipcMain.handle('commands:favorite', async (e, payload) => {
    const { cmd, label } = payload || {}
    // Favorites are per-project: pin to the open folder. With no folder open
    // there's no project to scope to, so fall back to a global favorite.
    const scope = ctx.getRoot(e.sender) || 'global'
    const changed = await addFavorite({ cmd, label, scope })
    if (changed) broadcast()
    return changed
  })

  ipcMain.handle('commands:unfavorite', async (_e, id) => {
    const changed = await removeFavorite(id)
    if (changed) broadcast()
    return changed
  })
}
