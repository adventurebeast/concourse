import os from 'os'

// Shared, mutable app state passed to every IPC-registering module.
export function createContext() {
  let workspaceRoot = os.homedir()
  let mainWindow = null
  return {
    getRoot: () => workspaceRoot,
    setRoot: (r) => {
      workspaceRoot = r
    },
    getWindow: () => mainWindow,
    setWindow: (w) => {
      mainWindow = w
    }
  }
}
