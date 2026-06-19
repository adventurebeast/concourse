import { contextBridge, ipcRenderer } from 'electron'

// The complete, stable API surface exposed to the renderer.
// Renderer modules (fileTree, editor, git, terminals) code against this contract.
contextBridge.exposeInMainWorld('api', {
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    open: () => ipcRenderer.invoke('workspace:open')
  },

  // Filesystem — handlers implemented in src/main/ipc-fs.js
  fs: {
    readDir: (p) => ipcRenderer.invoke('fs:readDir', p),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, content) => ipcRenderer.invoke('fs:writeFile', p, content),
    createFile: (p) => ipcRenderer.invoke('fs:createFile', p),
    createDir: (p) => ipcRenderer.invoke('fs:createDir', p),
    rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    delete: (p) => ipcRenderer.invoke('fs:delete', p)
  },

  // Git — handlers implemented in src/main/ipc-git.js (uses simple-git over the workspace root)
  git: {
    status: () => ipcRenderer.invoke('git:status'),
    // Returns { original, modified } file contents for a Monaco diff. staged=true diffs index vs HEAD.
    diff: (path, staged = false) => ipcRenderer.invoke('git:diff', path, staged),
    stage: (paths) => ipcRenderer.invoke('git:stage', paths),
    unstage: (paths) => ipcRenderer.invoke('git:unstage', paths),
    discard: (paths) => ipcRenderer.invoke('git:discard', paths),
    commit: (message) => ipcRenderer.invoke('git:commit', message),
    init: () => ipcRenderer.invoke('git:init')
  },

  // Terminals — handlers implemented in src/main/ipc-pty.js
  term: {
    create: (id, cwd, opts = {}) => ipcRenderer.send('term:create', { id, cwd, ...opts }),
    input: (id, data) => ipcRenderer.send('term:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('term:kill', { id }),
    onData: (cb) => ipcRenderer.on('term:data', (_e, payload) => cb(payload)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_e, payload) => cb(payload))
  }
})
