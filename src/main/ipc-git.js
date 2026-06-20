import { ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { simpleGit } from 'simple-git'

// Source-control IPC. A fresh simpleGit instance is created per call so the
// workspace root can change at runtime. Every handler is wrapped so an
// exception never escapes to break the renderer.

// Normalize a single simple-git status digit to our small status alphabet.
// Returns one of 'M','A','D','R','U' (untracked) or null to skip.
function mapCode(code) {
  switch (code) {
    case 'M':
      return 'M'
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'C': // copied — treat like a rename/add for display
      return 'A'
    case 'T': // type change — treat as modified
      return 'M'
    case '?':
      return 'U'
    default:
      return null
  }
}

export function registerGit(ctx) {
  // ---- status ---------------------------------------------------------------
  ipcMain.handle('git:status', async (e) => {
    try {
      const root = ctx.getRoot(e.sender)
      // No folder open — don't fall back to the process cwd.
      if (!root) return { isRepo: false, noFolder: true }
      const git = simpleGit(root)
      const isRepo = await git.checkIsRepo().catch(() => false)
      if (!isRepo) return { isRepo: false }

      const s = await git.status()
      const staged = []
      const changes = []

      for (const f of s.files) {
        const indexCode = (f.index || ' ').trim()
        const workCode = (f.working_dir || ' ').trim()

        // Untracked files surface only on the working side as '?'.
        if (indexCode === '?' || workCode === '?') {
          changes.push({ path: f.path, status: 'U' })
          continue
        }

        // Index (left) digit => staged group.
        if (indexCode) {
          const st = mapCode(indexCode)
          if (st) staged.push({ path: f.path, status: st })
        }

        // Working-tree (right) digit => changes group.
        if (workCode) {
          const st = mapCode(workCode)
          if (st) changes.push({ path: f.path, status: st })
        }
      }

      return {
        isRepo: true,
        branch: s.current || '',
        ahead: s.ahead || 0,
        behind: s.behind || 0,
        staged,
        changes
      }
    } catch {
      return { isRepo: false }
    }
  })

  // ---- diff -----------------------------------------------------------------
  ipcMain.handle('git:diff', async (e, relPath, staged = false) => {
    const root = ctx.getRoot(e.sender)
    const git = simpleGit(root)

    // original = HEAD blob
    let original = ''
    try {
      original = await git.show(['HEAD:' + relPath])
    } catch {
      original = ''
    }

    // modified = index blob (staged) or working-tree file (unstaged)
    let modified = ''
    if (staged) {
      try {
        modified = await git.show([':' + relPath])
      } catch {
        modified = ''
      }
    } else {
      try {
        modified = await fs.readFile(join(root, relPath), 'utf8')
      } catch {
        modified = ''
      }
    }

    return { original: original ?? '', modified: modified ?? '' }
  })

  // ---- stage ----------------------------------------------------------------
  ipcMain.handle('git:stage', async (e, paths) => {
    try {
      const git = simpleGit(ctx.getRoot(e.sender))
      const list = Array.isArray(paths) ? paths : [paths]
      if (list.length === 0) return false
      await git.add(list)
      return true
    } catch {
      return false
    }
  })

  // ---- unstage --------------------------------------------------------------
  ipcMain.handle('git:unstage', async (e, paths) => {
    try {
      const git = simpleGit(ctx.getRoot(e.sender))
      const list = Array.isArray(paths) ? paths : [paths]
      if (list.length === 0) return false
      try {
        await git.raw(['restore', '--staged', ...list])
      } catch {
        // Older git / no commits yet: fall back to reset.
        await git.reset(['--', ...list])
      }
      return true
    } catch {
      return false
    }
  })

  // ---- discard --------------------------------------------------------------
  ipcMain.handle('git:discard', async (e, paths) => {
    const root = ctx.getRoot(e.sender)
    const git = simpleGit(root)
    const list = Array.isArray(paths) ? paths : [paths]

    // Determine which paths are tracked vs untracked so we know how to discard.
    let untracked = new Set()
    try {
      const s = await git.status()
      untracked = new Set(s.not_added || [])
    } catch {
      untracked = new Set()
    }

    for (const p of list) {
      try {
        if (untracked.has(p)) {
          // Untracked: simply remove from disk.
          await fs.rm(join(root, p), { force: true })
        } else {
          // Tracked: restore working tree to HEAD/index.
          await git.checkout(['--', p])
        }
      } catch {
        // Best effort per path — keep going.
      }
    }
    return true
  })

  // ---- commit ---------------------------------------------------------------
  ipcMain.handle('git:commit', async (e, message) => {
    try {
      const git = simpleGit(ctx.getRoot(e.sender))
      const result = await git.commit(message)
      return result
    } catch (err) {
      return { error: String((err && err.message) || err) }
    }
  })

  // ---- init -----------------------------------------------------------------
  ipcMain.handle('git:init', async (e) => {
    try {
      const git = simpleGit(ctx.getRoot(e.sender))
      await git.init()
      return true
    } catch {
      return false
    }
  })
}
