import { contextBridge, ipcRenderer, webUtils } from 'electron'

// The complete, stable API surface exposed to the renderer.
// Renderer modules (fileTree, editor, git, terminals) code against this contract.
contextBridge.exposeInMainWorld('api', {
  // Resolve a dropped File to its absolute filesystem path. Electron 33 removed
  // the old File.path property; webUtils.getPathForFile is the supported way, and
  // it can only run here in the preload. Returns '' for non-file drags.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },

  // App metadata — handler in src/main/index.js. version() resolves the running
  // build's version string (auto-bumped on every pack/dist build).
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },

  // Windows — handlers in src/main/index.js. open() spawns another independent app
  // window (its own folder, terminals, and session) at the welcome screen;
  // openSettings() opens (or focuses) the shared Settings window.
  window: {
    open: () => ipcRenderer.send('window:open'),
    openSettings: () => ipcRenderer.send('window:openSettings'),
    // Bring THIS window to the foreground — used by the Pulse awaiting notification's
    // click handler to pull you back to the agent that needs you.
    focusSelf: () => ipcRenderer.send('window:focusSelf')
  },

  // Application-menu commands (File ▸ New File / New Folder / Open Folder). The
  // main process forwards the menu click here; the renderer runs the same action
  // as the matching toolbar button. See src/main/menu.js.
  menu: {
    onCommand: (cb) => ipcRenderer.on('menu:command', (_e, command) => cb(command))
  },

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
    delete: (p) => ipcRenderer.invoke('fs:delete', p),
    // Write the bytes of a dropped, pathless item (e.g. an image dragged from a
    // web page) to a temp file and return its absolute path. See ipc-fs.js.
    saveDrop: (name, type, bytes) => ipcRenderer.invoke('fs:saveDrop', name, type, bytes),
    // The workspace watcher fired — something changed on disk outside the app.
    // The renderer responds by refreshing the file tree. See src/main/watcher.js.
    onChanged: (cb) => ipcRenderer.on('fs:changed', () => cb()),
    // Watcher health ('watching' | 'degraded') so the UI can flag a stalled watcher.
    onWatchStatus: (cb) => ipcRenderer.on('fs:watch-status', (_e, status) => cb(status))
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
    save: (root, blob) => ipcRenderer.invoke('session:save', root, blob),
    // Synchronous save for the beforeunload path: an async invoke can't be relied
    // on to complete during unload, so this stages the blob for `root` in the main
    // process (drained by the before-quit flush). Returns synchronously.
    saveSync: (root, blob) => ipcRenderer.sendSync('session:saveSync', { root, blob })
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

  // OS shell — handlers in src/main/ipc-shell.js (Reveal in Finder / open path)
  shell: {
    showItemInFolder: (p) => ipcRenderer.invoke('shell:showItemInFolder', p),
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p)
  },

  // Pulse — Layer B model summariser, handlers in src/main/ipc-pulse.js.
  // The API key lives only in the main process; the renderer sends a text tail and
  // gets back a { state, summary, question } verdict (or null when disabled).
  pulse: {
    status: () => ipcRenderer.invoke('pulse:status'),
    summarize: (payload) => ipcRenderer.invoke('pulse:summarize', payload)
  },

  // Local model provisioning — the one-click "run the Local LLM" flow, handlers in
  // src/main/ipc-model.js. status() says whether the built-in model is already on
  // disk; provision() starts a local runtime and downloads the model, streaming
  // progress via onProgress(); cancel() aborts an in-flight download.
  model: {
    status: () => ipcRenderer.invoke('model:status'),
    provision: (opts) => ipcRenderer.invoke('model:provision', opts),
    cancel: () => ipcRenderer.invoke('model:cancel'),
    onProgress: (cb) => ipcRenderer.on('model:progress', (_e, p) => cb(p))
  },

  // Settings — central user preferences, handlers in src/main/ipc-settings.js.
  // schema() returns the grouped registry that drives the Settings UI; getAll()
  // returns current values with secrets redacted (plus a secretsSet map); set()
  // writes one key; reset() resets one key (or all when called with no key).
  // onChanged() fires (in every window) whenever any setting changes, carrying the
  // redacted snapshot so the workbench can re-theme / re-font itself live.
  settings: {
    schema: () => ipcRenderer.invoke('settings:schema'),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    reset: (key) => ipcRenderer.invoke('settings:reset', key),
    onChanged: (cb) => ipcRenderer.on('settings:changed', (_e, payload) => cb(payload))
  },

  // Command palette sources — handlers in src/main/ipc-commands.js. list() returns
  // { favorites, project, history } scoped to the window's open folder; favorite()
  // / unfavorite() toggle ♥ favorites (favorite with { project: true } pins to the
  // open folder); onChanged() fires in every window when favorites change.
  commands: {
    list: () => ipcRenderer.invoke('commands:list'),
    favorite: (cmd, label, opts = {}) =>
      ipcRenderer.invoke('commands:favorite', { cmd, label, project: !!opts.project }),
    unfavorite: (id) => ipcRenderer.invoke('commands:unfavorite', id),
    onChanged: (cb) => ipcRenderer.on('commands:changed', () => cb())
  }
})
