// Shared, mutable app state passed to every IPC-registering module.
export function createContext() {
  let workspaceRoot = null // no folder open until the user picks one
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
