import { app } from 'electron'
import path from 'path'
import { writeJsonAtomic, enqueue, trackPending } from './store-io.js'

// Command capture was removed for privacy. Keep this migration seam until all
// supported installations have overwritten the legacy command-history store.
function storePath() {
  return path.join(app.getPath('userData'), 'command-history.json')
}

export async function purgeCommandHistory() {
  const snapshot = { version: 2, projects: {} }
  trackPending(storePath(), snapshot)
  await enqueue(() => writeJsonAtomic(storePath(), snapshot))
}
