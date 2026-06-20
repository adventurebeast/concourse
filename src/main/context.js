// Shared app state passed to every IPC-registering module.
//
// The app supports several open windows at once, each holding its own workspace
// folder, so state is kept PER WINDOW rather than as a single global. Each entry
// is keyed by the window's webContents id; IPC handlers resolve their own window
// from the event sender (event.sender, a WebContents), and the PTY layer routes
// terminal output back to the window that created each shell. A window's entry is
// dropped (forget) when it closes so the map never leaks.
export function createContext() {
  const byId = new Map() // webContents.id -> { root }

  // Accept either a WebContents (the usual IPC event.sender) or a raw id — close
  // handlers only have the id once the WebContents is gone.
  const idOf = (wc) => (typeof wc === 'number' ? wc : wc && wc.id)

  const ensure = (id) => {
    let s = byId.get(id)
    if (!s) {
      s = { root: null }
      byId.set(id, s)
    }
    return s
  }

  return {
    // The open folder for the calling window, or null if none / no folder open.
    getRoot: (wc) => {
      const id = idOf(wc)
      return id != null && byId.has(id) ? byId.get(id).root : null
    },
    setRoot: (wc, root) => {
      const id = idOf(wc)
      if (id != null) ensure(id).root = root
    },
    // Drop a window's state when it closes.
    forget: (wc) => {
      const id = idOf(wc)
      if (id != null) byId.delete(id)
    }
  }
}
