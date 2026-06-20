import { ipcMain, shell } from 'electron'

// Thin bridge to the OS shell. Used for "Reveal in Finder" (and a general
// open-path helper). Both are no-ops on an empty path so the renderer can call
// them unconditionally.
export function registerShell() {
  // Reveal a file or folder in the OS file manager, selected in its parent.
  ipcMain.handle('shell:showItemInFolder', (_e, p) => {
    if (p) shell.showItemInFolder(p)
    return true
  })

  // Open a path with its default handler (folders open in the file manager).
  ipcMain.handle('shell:openPath', async (_e, p) => {
    if (!p) return ''
    return shell.openPath(p) // resolves to '' on success, or an error string
  })
}
