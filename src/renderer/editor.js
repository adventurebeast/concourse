import './editor.css'
import { showToast } from './toast.js'
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

// Cheap renderer-side guard: decide whether a string we just read looks like
// non-text (binary) content rather than utf8 text. A NUL byte is a strong
// binary tell, and a high ratio of U+FFFD replacement chars means the bytes
// were mangled when decoded as utf8 (i.e. they were not valid utf8 text).
// Only scans the first ~8KB so it stays cheap on large files.
function looksBinary(text) {
  if (!text) return false
  const sample = text.length > 8192 ? text.slice(0, 8192) : text
  let replacements = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) return true // NUL — definitely not text
    if (c === 0xfffd) replacements++ // U+FFFD replacement char
  }
  // More than ~10% replacement chars => almost certainly mangled binary.
  return replacements > sample.length * 0.1
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

  // Monaco's resolved default font family. The Font Family setting reverts to this
  // when cleared — passing undefined to updateOptions means "no change", so we need
  // the concrete default to actually revert an earlier override.
  const DEFAULT_FONT_FAMILY = fileEditor.getOption(monaco.editor.EditorOption.fontFamily)

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
  // Last tab count we notified listeners with. syncWelcome() runs on every
  // activate() (i.e. plain tab switches too), but onTabsChange must only fire
  // on genuine open/close transitions — otherwise switching tabs would re-run
  // derived state like terminals-only and yank the editor around. -1 forces the
  // first sync to notify.
  let lastTabsCount = -1

  function fileKey(path) {
    return 'file:' + path
  }

  function syncWelcome() {
    welcome.style.display = tabs.size === 0 ? 'flex' : 'none'
    if (tabs.size === lastTabsCount) return
    lastTabsCount = tabs.size
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
      // Read-only tabs (read errors / binary previews) must never be editable;
      // the shared fileEditor toggles per-tab so a save can't clobber the file.
      fileEditor.updateOptions({ readOnly: !!tab.readOnly })
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

  // Closing a file tab with unsaved edits must never silently discard them. Guard the
  // real teardown (doCloseTab) behind a Save / Don't Save / Cancel dialog; clean (or
  // read-only) tabs close straight through. See confirmCloseDirty below.
  function closeTab(key) {
    const tab = tabs.get(key)
    if (!tab) return
    if (tab.kind === 'file' && tab.dirty && !tab.readOnly) {
      confirmCloseDirty(tab, () => doCloseTab(key))
      return
    }
    doCloseTab(key)
  }
  function doCloseTab(key) {
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

  // Save / Don't Save / Cancel before discarding a dirty buffer. No window.confirm
  // (it would block the whole renderer); reuses the terminal confirm overlay styling
  // so it needs no new CSS. One dialog at a time; Escape / Cancel / click-away backs
  // out, Save commits first and only closes if the write succeeds.
  let closeConfirmOverlay = null
  function confirmCloseDirty(tab, proceed) {
    if (closeConfirmOverlay) {
      closeConfirmOverlay.querySelector('.tc-cancel')?.focus()
      return
    }
    const overlay = document.createElement('div')
    overlay.className = 'term-confirm-overlay'
    const box = document.createElement('div')
    box.className = 'term-confirm'
    const title = document.createElement('div')
    title.className = 'tc-title'
    // baseName is plain (a real path), but build with textContent regardless.
    title.textContent = `Save changes to “${baseName(tab.path)}”?`
    const msg = document.createElement('div')
    msg.className = 'tc-msg'
    msg.textContent = 'Your changes will be lost if you don’t save them.'
    box.append(title, msg)
    const actions = document.createElement('div')
    actions.className = 'tc-actions'
    const cancel = document.createElement('button')
    cancel.className = 'btn tc-cancel'
    cancel.textContent = 'Cancel'
    const dont = document.createElement('button')
    dont.className = 'btn tc-danger'
    dont.textContent = 'Don’t Save'
    const saveBtn = document.createElement('button')
    saveBtn.className = 'btn'
    saveBtn.textContent = 'Save'
    actions.append(cancel, dont, saveBtn)
    box.appendChild(actions)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    closeConfirmOverlay = overlay
    saveBtn.focus()

    const finish = () => {
      if (closeConfirmOverlay !== overlay) return
      closeConfirmOverlay = null
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const saveThenClose = () => {
      finish()
      saveTab(tab).then((ok) => {
        if (ok) proceed() // a failed write keeps the tab open + dirty (toast already shown)
      })
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        saveThenClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    cancel.addEventListener('click', finish)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish()
    })
    dont.addEventListener('click', () => {
      finish()
      proceed()
    })
    saveBtn.addEventListener('click', saveThenClose)
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

  // Reveal a 1-based line (optionally a column range) in the file editor.
  function revealLine(line, column, endColumn) {
    if (!line) return
    const col = column || 1
    fileEditor.revealLineInCenter(line)
    fileEditor.setSelection({
      startLineNumber: line,
      startColumn: col,
      endLineNumber: line,
      endColumn: endColumn || col
    })
    fileEditor.focus()
  }

  // ---------- Public: openFile ----------
  // opts: { line, column, endColumn } — when given, scroll to and select that span.
  async function openFile(path, opts = {}) {
    if (!path) return
    const key = fileKey(path)
    const existing = tabs.get(key)
    if (existing) {
      activate(key)
      if (opts.line) revealLine(opts.line, opts.column, opts.endColumn)
      return
    }

    // readError / binary => open the tab READ-ONLY so a stray Cmd+S can never
    // overwrite the real file with an empty or mangled buffer. The normal utf8
    // text path below is kept byte-identical to preserve file-tree / search /
    // session-restore behaviour.
    let content = null
    let readError = null
    try {
      content = await api.fs.readFile(path)
    } catch (err) {
      readError = err
    }

    let readOnly = false
    if (readError != null) {
      const msg = (readError && readError.message) ? readError.message : String(readError)
      content =
        '// This file could not be read and is shown read-only to avoid\n' +
        '// accidentally overwriting it.\n' +
        '//\n' +
        '// ' + msg + '\n'
      readOnly = true
    } else if (content == null) {
      content = ''
    } else if (looksBinary(content)) {
      content =
        '// Binary file — shown read-only.\n' +
        '// Editing and saving have been disabled to avoid corrupting it.\n'
      readOnly = true
    }

    // Snapshot the file's on-disk mtime so a later Cmd+S can tell whether the file
    // changed underneath us — an agent, a terminal, or an external editor writing
    // to it — before blindly overwriting. Only for editable text tabs; read-only
    // previews are never written back. See saveTab / reconcileExternalChanges.
    let initialMtime = null
    if (readError == null && !readOnly) {
      const st = await api.fs.stat(path)
      initialMtime = st ? st.mtimeMs : null
    }

    // A concurrent openFile(path) for the same not-yet-open path (fast double-click,
    // or a reveal racing session-restore) may have created the tab while we awaited
    // the read. Re-check before allocating a Monaco model — otherwise the second
    // call leaks a model and orphans a duplicate, uncloseable tab.
    const raced = tabs.get(key)
    if (raced) {
      activate(key)
      if (opts.line) revealLine(opts.line, opts.column, opts.endColumn)
      return
    }

    // Read-only previews are plain text; only real text buffers get syntax lang.
    const model = monaco.editor.createModel(content, readOnly ? 'plaintext' : langForPath(path))

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
      readOnly,
      viewState: null,
      dirty: false,
      // Last-known on-disk mtime; compared on save + external-change events to
      // detect a stale buffer. null = no known disk state (never stat it away).
      diskMtime: initialMtime,
      // Set while we programmatically replace the model's content from disk, so the
      // resulting change event doesn't flip the tab dirty. See reloadTab.
      reloading: false,
      tabEl: el,
      dotEl,
      closeEl,
      labelEl
    }

    model.onDidChangeContent(() => {
      if (!tab.reloading) setDirty(tab, true)
    })

    tabs.set(key, tab)
    tabBar.appendChild(el)
    activate(key)
    if (opts.line) revealLine(opts.line, opts.column, opts.endColumn)
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
  // Write ONE specific file tab to disk. Returns true on success (or for a no-op
  // read-only / non-file tab), false if the write failed — callers that gate a close
  // on the save (confirmCloseDirty) must not proceed on failure. Keeping the tab dirty
  // + toasting on error beats silently dropping the change.
  async function saveTab(tab) {
    if (!tab || tab.kind !== 'file') return true
    // Never write back read-only tabs (read-error / binary previews); their
    // model holds a placeholder notice, not the real file contents.
    if (tab.readOnly) return true

    // Stale-write guard: if the file changed on disk since we loaded/last-saved it
    // (an agent or terminal wrote to it while it was open here), a blind overwrite
    // would destroy that work. Ask first. Cancel aborts; Reload adopts the disk
    // copy; Overwrite falls through to the write below.
    if (tab.diskMtime != null) {
      const st = await api.fs.stat(tab.path)
      if (st && st.mtimeMs !== tab.diskMtime) {
        const choice = await confirmOverwrite(tab)
        if (choice === 'cancel') return false
        if (choice === 'reload') {
          await reloadTab(tab)
          return true // disk copy is now loaded and clean; nothing to write
        }
        // choice === 'overwrite' → fall through
      }
    }

    const value = tab.model.getValue()
    try {
      await api.fs.writeFile(tab.path, value)
    } catch (err) {
      // Keep the tab dirty (the change is NOT on disk) and tell the user, instead
      // of silently swallowing the failure.
      const reason = (err && err.message) ? err.message : String(err)
      showToast('Could not save ' + baseName(tab.path) + ': ' + reason, { kind: 'error' })
      return false
    }
    setDirty(tab, false)
    // Re-baseline the mtime to what we just wrote, so the next save compares against
    // our own write (and the watcher echo of it doesn't look like an external edit).
    try {
      const st = await api.fs.stat(tab.path)
      if (st) tab.diskMtime = st.mtimeMs
    } catch {
      /* best-effort; a failed re-stat just leaves the old baseline */
    }
    tab.conflictNotified = false
    for (const cb of saveListeners) {
      try {
        cb(tab.path)
      } catch (_e) {
        /* ignore listener errors */
      }
    }
    return true
  }

  // Replace a tab's buffer with the current on-disk contents (used by the conflict
  // dialog's "Reload" and by auto-reconcile for clean tabs). Preserves cursor/scroll
  // best-effort and never flips the tab dirty (the reloading flag suppresses that).
  async function reloadTab(tab) {
    if (!tab || tab.kind !== 'file' || tab.readOnly) return
    let content
    try {
      content = await api.fs.readFile(tab.path)
    } catch {
      return // file vanished/unreadable — leave the buffer as-is
    }
    if (content == null) content = ''
    // Identical bytes (a touch, or our own write echoing back): re-baseline the
    // mtime but never call setValue — that would jolt the viewport and clear the
    // undo stack for nothing.
    if (content === tab.model.getValue()) {
      try {
        const st = await api.fs.stat(tab.path)
        if (st) tab.diskMtime = st.mtimeMs
      } catch {
        /* best-effort */
      }
      setDirty(tab, false)
      tab.conflictNotified = false
      return
    }
    const isActive = activeKey === tab.key
    const vs = isActive ? fileEditor.saveViewState() : tab.viewState
    tab.reloading = true
    tab.model.setValue(content)
    tab.reloading = false
    setDirty(tab, false)
    tab.conflictNotified = false
    if (isActive && vs) fileEditor.restoreViewState(vs)
    else if (vs) tab.viewState = vs
    try {
      const st = await api.fs.stat(tab.path)
      if (st) tab.diskMtime = st.mtimeMs
    } catch {
      /* best-effort */
    }
  }

  // "This file changed on disk" resolver, shown before a save that would clobber a
  // newer on-disk copy. Reuses the terminal confirm overlay styling. Resolves to
  // 'overwrite' | 'reload' | 'cancel'. One dialog at a time.
  let overwriteOverlay = null
  function confirmOverwrite(tab) {
    return new Promise((resolve) => {
      if (overwriteOverlay) {
        overwriteOverlay.querySelector('.tc-cancel')?.focus()
        resolve('cancel')
        return
      }
      const overlay = document.createElement('div')
      overlay.className = 'term-confirm-overlay'
      const box = document.createElement('div')
      box.className = 'term-confirm'
      const title = document.createElement('div')
      title.className = 'tc-title'
      title.textContent = `“${baseName(tab.path)}” changed on disk`
      const msg = document.createElement('div')
      msg.className = 'tc-msg'
      msg.textContent =
        'This file was modified outside the editor since you opened it — likely by an agent or another program. Overwriting will replace those changes with your version.'
      box.append(title, msg)
      const actions = document.createElement('div')
      actions.className = 'tc-actions'
      const cancel = document.createElement('button')
      cancel.className = 'btn tc-cancel'
      cancel.textContent = 'Cancel'
      const reload = document.createElement('button')
      reload.className = 'btn'
      reload.textContent = 'Reload from Disk'
      const overwrite = document.createElement('button')
      overwrite.className = 'btn tc-danger'
      overwrite.textContent = 'Overwrite'
      actions.append(cancel, reload, overwrite)
      box.appendChild(actions)
      overlay.appendChild(box)
      document.body.appendChild(overlay)
      overwriteOverlay = overlay
      cancel.focus()

      const finish = (result) => {
        if (overwriteOverlay !== overlay) return
        overwriteOverlay = null
        overlay.remove()
        document.removeEventListener('keydown', onKey, true)
        resolve(result)
      }
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          finish('cancel')
        }
      }
      document.addEventListener('keydown', onKey, true)
      cancel.addEventListener('click', () => finish('cancel'))
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) finish('cancel')
      })
      reload.addEventListener('click', () => finish('reload'))
      overwrite.addEventListener('click', () => finish('overwrite'))
    })
  }

  // The workspace watcher fired (something changed on disk). Reconcile open file
  // tabs: silently adopt the new content for clean buffers so the editor shows the
  // agent's latest work instead of a stale copy; for dirty buffers, leave the user's
  // edits untouched but flag the conflict once (the save guard will prompt).
  // Guard against overlapping runs: the watcher, the poll and a window focus can
  // all fire within the same tick, and two reconciles racing on one tab would
  // double-reload it (and could re-baseline the mtime from the wrong read).
  let reconciling = false
  async function reconcileExternalChanges() {
    if (reconciling) return
    reconciling = true
    try {
      await doReconcile()
    } finally {
      reconciling = false
    }
  }
  async function doReconcile() {
    for (const tab of tabs.values()) {
      if (tab.kind !== 'file' || tab.readOnly) continue
      let st
      try {
        st = await api.fs.stat(tab.path)
      } catch {
        continue
      }
      if (!st) continue
      // No baseline yet (the stat at open failed, e.g. the file didn't exist yet):
      // adopt this one silently rather than skipping the tab forever.
      if (tab.diskMtime == null) {
        tab.diskMtime = st.mtimeMs
        continue
      }
      if (st.mtimeMs === tab.diskMtime) continue // unchanged
      if (!tab.dirty) {
        await reloadTab(tab)
      } else if (!tab.conflictNotified) {
        tab.conflictNotified = true
        showToast(
          baseName(tab.path) + ' changed on disk — your unsaved edits are kept; saving will ask before overwriting.',
          { kind: 'warn' }
        )
      }
    }
  }
  async function save() {
    if (!activeKey) return
    await saveTab(tabs.get(activeKey))
  }
  // Any open file tab with unsaved edits? main.js consults this in beforeunload to
  // trigger the native "unsaved changes" prompt so quitting/reloading can't silently
  // drop in-memory edits (the session blob only persists path/line, not buffer text).
  function hasUnsavedTabs() {
    for (const tab of tabs.values()) {
      if (tab.kind === 'file' && tab.dirty && !tab.readOnly) return true
    }
    return false
  }

  function onSave(cb) {
    if (typeof cb === 'function') saveListeners.push(cb)
  }

  // Notify only when the number of open tabs actually changes (open/close),
  // not on plain tab switches. See lastTabsCount in syncWelcome().
  function onTabsChange(cb) {
    if (typeof cb === 'function') tabsListeners.push(cb)
  }

  // Switch Monaco theme ('vs' light / 'vs-dark' dark) — global to all editors.
  function setTheme(name) {
    monaco.editor.setTheme(name)
  }

  // Apply central editor preferences (from the Settings window), live, to the file
  // editor and the diff editor if it exists. A blank font family reverts to Monaco's
  // default rather than leaving a stale override in place.
  function applySettings(opts = {}) {
    const o = {}
    if (typeof opts.fontSize === 'number') o.fontSize = opts.fontSize
    if (typeof opts.fontFamily === 'string') o.fontFamily = opts.fontFamily.trim() || DEFAULT_FONT_FAMILY
    if (typeof opts.minimap === 'boolean') o.minimap = { enabled: opts.minimap }
    if (typeof opts.smoothScrolling === 'boolean') o.smoothScrolling = opts.smoothScrolling
    if (typeof opts.scrollBeyondLastLine === 'boolean') o.scrollBeyondLastLine = opts.scrollBeyondLastLine
    if (Object.keys(o).length === 0) return
    fileEditor.updateOptions(o)
    if (diffEditor) diffEditor.updateOptions(o)
  }

  // Snapshot of open *file* tabs for session restore (diffs are transient and skipped).
  // Returns { files: [{ path, line, active }] } in tab order.
  function listOpenFiles() {
    const files = []
    for (const [key, tab] of tabs) {
      if (tab.kind !== 'file') continue
      const active = key === activeKey
      // Cursor line: live from the editor for the active tab, else from saved view state.
      let line = 1
      if (active) line = fileEditor.getPosition()?.lineNumber || 1
      else line = tab.viewState?.cursorState?.[0]?.position?.lineNumber || 1
      files.push({ path: tab.path, line, active })
    }
    return { files }
  }

  // Cmd/Ctrl+S saves the active file tab.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      save()
    }
  })

  // Keep open buffers in sync with on-disk changes made outside the editor (an
  // agent or terminal writing files). Without this the editor holds a stale copy
  // and a later save silently overwrites that external work. Best-effort: the same
  // event also drives the file-tree refresh (separate listener).
  if (api?.fs?.onChanged) {
    api.fs.onChanged(() => {
      reconcileExternalChanges()
    })
  }

  // …and don't depend on the watcher alone. Recursive fs.watch is best-effort: it
  // can be degraded (see watcher.js backoff), it ignores whole subtrees (dist/,
  // build/ — an agent editing there would never repaint), and a long write burst
  // keeps resetting the debounce. Open file tabs are a handful of paths, so a
  // 1s stat poll is cheap insurance that the buffer you're looking at is never
  // more than a second stale. Only runs while the window is visible and something
  // is actually open.
  const POLL_MS = 1000
  setInterval(() => {
    if (document.hidden || tabs.size === 0) return
    reconcileExternalChanges()
  }, POLL_MS)

  // Immediate catch-up on the two moments a stale buffer is most visible: coming
  // back to the window after watching an agent work, and un-hiding it.
  window.addEventListener('focus', () => reconcileExternalChanges())
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reconcileExternalChanges()
  })

  syncWelcome()

  return { openFile, openDiff, save, onSave, onTabsChange, setTheme, applySettings, listOpenFiles, hasUnsavedTabs }
}
