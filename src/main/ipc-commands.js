import { ipcMain, BrowserWindow } from 'electron'
import { favoritesForRoot, addFavorite, removeFavorite } from './command-store.js'
import { getProjectCommands } from './command-sources.js'
import { suggestCommands, invalidateSuggestions } from './command-suggest.js'

// Backs the command palette's explicit/declarative sources:
//   • favorites  → ♥ commands pinned to the open folder
//   • project    → named scripts/recipes/targets discovered in the open folder
//                  (package.json, justfile, Makefile) — declarative, no run-count
// The renderer asks for everything at once and toggles favorites. The window's
// root is read from the trusted per-window context, never from a renderer-supplied
// path.

// Tell every window its favorites changed so an open palette re-renders live.
function broadcast() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send('commands:changed')
  }
}

export function registerCommands(ctx) {
  ipcMain.handle('commands:list', async (e) => {
    const root = ctx.getRoot(e.sender)
    const [project, favorites] = await Promise.all([
      getProjectCommands(root),
      favoritesForRoot(root)
    ])
    return { favorites, project, thisProject: [], global: [] }
  })

  // The palette's "Suggested" group: up to 5 quick commands the Pulse model curates
  // from THIS project's declared scripts (grounded — see
  // command-suggest.js). Separate from commands:list so the palette can paint the rest
  // instantly and let suggestions fill in when the model answers. Cached per-root.
  ipcMain.handle('commands:suggest', async (e) => {
    const root = ctx.getRoot(e.sender)
    return suggestCommands(root)
  })

  ipcMain.handle('commands:favorite', async (e, payload) => {
    const { cmd, label } = payload || {}
    // Favorites are per-project: pin to the open folder. With no folder open
    // there's no project to scope to, so fall back to a global favorite.
    const scope = ctx.getRoot(e.sender) || 'global'
    const changed = await addFavorite({ cmd, label, scope })
    if (changed) {
      // A newly-pinned command shouldn't keep showing up as a fresh "suggestion".
      invalidateSuggestions(scope)
      broadcast()
    }
    return changed
  })

  ipcMain.handle('commands:unfavorite', async (_e, id) => {
    const changed = await removeFavorite(id)
    if (changed) broadcast()
    return changed
  })
}
