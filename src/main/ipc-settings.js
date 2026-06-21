import { ipcMain, BrowserWindow } from 'electron'
import { SETTINGS_GROUPS } from './settings-schema.js'
import { getAllRedacted, setSetting, resetSetting, resetAll } from './settings.js'

// Push the current (redacted) settings to every open window so a change applies
// live everywhere — the workbench re-themes / re-fonts itself, and any other open
// Settings window updates its controls. Secrets are redacted in the snapshot, so a
// key value never travels to a renderer.
function broadcast(key) {
  const snapshot = getAllRedacted()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('settings:changed', { key, ...snapshot })
    }
  }
}

export function registerSettings() {
  // The declarative registry that drives the Settings UI (labels, types, options).
  ipcMain.handle('settings:schema', () => SETTINGS_GROUPS)

  // Current values, with secrets redacted to '' + a secretsSet:{key:bool} map.
  ipcMain.handle('settings:getAll', () => getAllRedacted())

  ipcMain.handle('settings:set', async (_e, key, value) => {
    const changed = await setSetting(key, value)
    if (changed) broadcast(key)
    return changed
  })

  // No key => reset everything; a key => reset just that one.
  ipcMain.handle('settings:reset', async (_e, key) => {
    const changed = key ? await resetSetting(key) : await resetAll()
    if (changed) broadcast(key || null)
    return changed
  })
}
