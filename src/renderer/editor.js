import './editor.css'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new jsonWorker()
    if (['css', 'scss', 'less'].includes(label)) return new cssWorker()
    if (['html', 'handlebars', 'razor'].includes(label)) return new htmlWorker()
    if (['typescript', 'javascript'].includes(label)) return new tsWorker()
    return new editorWorker()
  }
}

const api = window.api

// Extension -> Monaco language id.
const LANG_BY_EXT = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  php: 'php',
  rb: 'ruby',
  toml: 'toml'
}

function langForPath(p) {
  if (!p) return 'plaintext'
  const base = p.split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  const ext = base.slice(dot + 1).toLowerCase()
  return LANG_BY_EXT[ext] || 'plaintext'
}

function baseName(p) {
  if (!p) return ''
  return (p.split(/[\\/]/).pop() || p)
}

export function createEditor() {
  const tabBar = document.getElementById('editor-tabs')
  const editorRoot = document.getElementById('editor')
  const welcome = document.getElementById('editor-welcome')

  // Two host containers inside #editor: one for the standalone editor (file
  // tabs), one for the diff editor (diff tabs). We toggle which is visible.
  const fileHost = document.createElement('div')
  fileHost.className = 'editor-pane'
  const fileMount = document.createElement('div')
  fileMount.className = 'monaco-host'
  fileHost.appendChild(fileMount)

  const diffHost = document.createElement('div')
  diffHost.className = 'editor-pane'
  diffHost.hidden = true
  const diffMount = document.createElement('div')
  diffMount.className = 'monaco-host'
  diffHost.appendChild(diffMount)

  editorRoot.appendChild(fileHost)
  editorRoot.appendChild(diffHost)

  const editorOptions = {
    theme: 'vs',
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    smoothScrolling: true
  }

  const fileEditor = monaco.editor.create(fileMount, {
    ...editorOptions,
    model: null
  })

  // Diff editor is created lazily on first diff tab.
  let diffEditor = null
  function ensureDiffEditor() {
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(diffMount, {
        ...editorOptions,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true
      })
    }
    return diffEditor
  }

  // key -> tab descriptor.
  // file tab: { kind:'file', key, path, model, viewState, dirty, tabEl, dotEl, labelEl, closeEl }
  // diff tab: { kind:'diff', key, path, originalModel, modifiedModel, viewState, tabEl, ... }
  const tabs = new Map()
  let activeKey = null
  let diffSeq = 0

  const saveListeners = []
  const tabsListeners = []

  function fileKey(path) {
    return 'file:' + path
  }

  function syncWelcome() {
    welcome.style.display = tabs.size === 0 ? 'flex' : 'none'
    for (const cb of tabsListeners) {
      try {
        cb(tabs.size)
      } catch (_e) {
        /* ignore listener errors */
      }
    }
  }

  function showHost(kind) {
    fileHost.hidden = kind !== 'file'
    diffHost.hidden = kind !== 'diff'
  }

  function saveActiveViewState() {
    if (!activeKey) return
    const tab = tabs.get(activeKey)
    if (!tab) return
    if (tab.kind === 'file') {
      tab.viewState = fileEditor.saveViewState()
    } else if (tab.kind === 'diff' && diffEditor) {
      tab.viewState = diffEditor.saveViewState()
    }
  }

  function activate(key) {
    if (activeKey === key) {
      // Still ensure focus/host correctness.
    }
    const tab = tabs.get(key)
    if (!tab) return

    if (activeKey && activeKey !== key) saveActiveViewState()

    activeKey = key

    if (tab.kind === 'file') {
      showHost('file')
      fileEditor.setModel(tab.model)
      if (tab.viewState) fileEditor.restoreViewState(tab.viewState)
      fileEditor.focus()
    } else {
      showHost('diff')
      const de = ensureDiffEditor()
      de.setModel({ original: tab.originalModel, modified: tab.modifiedModel })
      if (tab.viewState) de.restoreViewState(tab.viewState)
      de.layout()
    }

    for (const [k, t] of tabs) t.tabEl.classList.toggle('active', k === key)
    syncWelcome()
  }

  function neighborKey(key) {
    const keys = [...tabs.keys()]
    const idx = keys.indexOf(key)
    if (idx < 0) return null
    if (idx + 1 < keys.length) return keys[idx + 1]
    if (idx - 1 >= 0) return keys[idx - 1]
    return null
  }

  function closeTab(key) {
    const tab = tabs.get(key)
    if (!tab) return

    const wasActive = activeKey === key
    const next = wasActive ? neighborKey(key) : null

    // Dispose models.
    if (tab.kind === 'file') {
      if (wasActive) fileEditor.setModel(null)
      if (tab.model) tab.model.dispose()
    } else {
      if (wasActive && diffEditor) diffEditor.setModel(null)
      if (tab.originalModel) tab.originalModel.dispose()
      if (tab.modifiedModel) tab.modifiedModel.dispose()
    }

    tab.tabEl.remove()
    tabs.delete(key)

    if (wasActive) {
      activeKey = null
      if (next) {
        activate(next)
      } else {
        showHost('file')
        fileEditor.setModel(null)
      }
    }
    syncWelcome()
  }

  function buildTabEl({ marker, label, key, title }) {
    const el = document.createElement('div')
    el.className = 'etab'
    el.title = title || label

    let markerEl = null
    if (marker) {
      markerEl = document.createElement('span')
      markerEl.className = 'etab-marker'
      markerEl.textContent = marker
      el.appendChild(markerEl)
    }

    const labelEl = document.createElement('span')
    labelEl.className = 'etab-label'
    labelEl.textContent = label
    el.appendChild(labelEl)

    const actions = document.createElement('span')
    actions.className = 'etab-actions'
    const dot = document.createElement('span')
    dot.className = 'etab-dot'
    const close = document.createElement('span')
    close.className = 'etab-close'
    close.textContent = '✕'
    close.title = 'Close'
    actions.appendChild(dot)
    actions.appendChild(close)
    el.appendChild(actions)

    el.addEventListener('mousedown', (e) => {
      // Middle-click closes (VS Code behavior); ignore close-button target.
      if (e.button === 1) {
        e.preventDefault()
        closeTab(key)
      }
    })
    el.addEventListener('click', (e) => {
      if (close.contains(e.target)) {
        e.stopPropagation()
        closeTab(key)
        return
      }
      activate(key)
    })

    return { el, labelEl, dotEl: dot, closeEl: close }
  }

  function setDirty(tab, dirty) {
    if (tab.dirty === dirty) return
    tab.dirty = dirty
    tab.tabEl.classList.toggle('dirty', dirty)
  }

  // ---------- Public: openFile ----------
  async function openFile(path) {
    if (!path) return
    const key = fileKey(path)
    const existing = tabs.get(key)
    if (existing) {
      activate(key)
      return
    }

    let content = ''
    try {
      content = await api.fs.readFile(path)
    } catch (err) {
      content = ''
    }
    if (content == null) content = ''

    const model = monaco.editor.createModel(content, langForPath(path))

    const { el, dotEl, closeEl, labelEl } = buildTabEl({
      label: baseName(path),
      key,
      title: path
    })

    const tab = {
      kind: 'file',
      key,
      path,
      model,
      viewState: null,
      dirty: false,
      tabEl: el,
      dotEl,
      closeEl,
      labelEl
    }

    model.onDidChangeContent(() => setDirty(tab, true))

    tabs.set(key, tab)
    tabBar.appendChild(el)
    activate(key)
  }

  // ---------- Public: openDiff ----------
  async function openDiff({ path, original, modified, title }) {
    // Focus an existing diff tab for the same path if present.
    for (const [k, t] of tabs) {
      if (t.kind === 'diff' && t.path === path) {
        // Refresh contents in case the working tree changed.
        if (t.originalModel) t.originalModel.setValue(original == null ? '' : original)
        if (t.modifiedModel) t.modifiedModel.setValue(modified == null ? '' : modified)
        activate(k)
        return
      }
    }

    const lang = langForPath(path)
    const originalModel = monaco.editor.createModel(original == null ? '' : original, lang)
    const modifiedModel = monaco.editor.createModel(modified == null ? '' : modified, lang)

    const key = 'diff:' + path + ':' + diffSeq++
    const labelText = (title || baseName(path) || 'diff') + ' (Working Tree)'

    const { el, dotEl, closeEl, labelEl } = buildTabEl({
      marker: '⇄',
      label: labelText,
      key,
      title: labelText
    })

    const tab = {
      kind: 'diff',
      key,
      path,
      originalModel,
      modifiedModel,
      viewState: null,
      dirty: false,
      tabEl: el,
      dotEl,
      closeEl,
      labelEl
    }

    tabs.set(key, tab)
    tabBar.appendChild(el)
    activate(key)
  }

  // ---------- Public: save ----------
  async function save() {
    if (!activeKey) return
    const tab = tabs.get(activeKey)
    if (!tab || tab.kind !== 'file') return
    const value = tab.model.getValue()
    try {
      await api.fs.writeFile(tab.path, value)
    } catch (err) {
      return
    }
    setDirty(tab, false)
    for (const cb of saveListeners) {
      try {
        cb(tab.path)
      } catch (_e) {
        /* ignore listener errors */
      }
    }
  }

  function onSave(cb) {
    if (typeof cb === 'function') saveListeners.push(cb)
  }

  // Notify whenever the number of open tabs changes (fires on open and close).
  function onTabsChange(cb) {
    if (typeof cb === 'function') tabsListeners.push(cb)
  }

  // Switch Monaco theme ('vs' light / 'vs-dark' dark) — global to all editors.
  function setTheme(name) {
    monaco.editor.setTheme(name)
  }

  // Cmd/Ctrl+S saves the active file tab.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      save()
    }
  })

  syncWelcome()

  return { openFile, openDiff, save, onSave, onTabsChange, setTheme }
}
