import { contextBridge, ipcRenderer } from 'electron'

// The complete, stable API surface exposed to the renderer.
// Renderer modules (fileTree, editor, git, terminals) code against this contract.
contextBridge.exposeInMainWorld('api', {
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    open: () => ipcRenderer.invoke('workspace:open'),
    // Open a known folder path (recent project). Returns the root, or null if gone.
    openPath: (dir) => ipcRenderer.invoke('workspace:openPath', dir),
    // Recently-opened folders, most-recent first: [{ path, name }].
    recents: () => ipcRenderer.invoke('workspace:recents')
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

  // Session restore — handlers in src/main/ipc-session.js (per-workspace state + last root)
  session: {
    lastRoot: () => ipcRenderer.invoke('session:lastRoot'),
    load: (root) => ipcRenderer.invoke('session:load', root),
    save: (root, blob) => ipcRenderer.invoke('session:save', root, blob)
  },

  // Text search — handler implemented in src/main/ipc-search.js (walks the workspace root)
  search: {
    find: (query, opts = {}) => ipcRenderer.invoke('search:find', query, opts)
  },

  // Terminals — handlers implemented in src/main/ipc-pty.js
  term: {
    create: (id, cwd, opts = {}) => ipcRenderer.send('term:create', { id, cwd, ...opts }),
    input: (id, data) => ipcRenderer.send('term:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('term:kill', { id }),
    onData: (cb) => ipcRenderer.on('term:data', (_e, payload) => cb(payload)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_e, payload) => cb(payload))
  },

  // Watchdog — Layer B model summariser, handlers in src/main/ipc-watchdog.js.
  // The API key lives only in the main process; the renderer sends a text tail and
  // gets back a { state, summary, question } verdict (or null when disabled).
  watchdog: {
    status: () => ipcRenderer.invoke('watchdog:status'),
    summarize: (payload) => ipcRenderer.invoke('watchdog:summarize', payload)
  }
})
