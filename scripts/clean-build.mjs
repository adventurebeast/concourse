#!/usr/bin/env node
// Start a fresh build without permanently deleting previous bundles. Keep the
// archive on the same filesystem so moving large artifacts is fast and atomic.
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputs = ['out', 'release'].filter((name) => existsSync(path.join(root, name)))
if (outputs.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archive = path.join(root, '.build-archive', `${stamp}-${randomUUID()}`)
  mkdirSync(archive, { recursive: true })
  for (const name of outputs) renameSync(path.join(root, name), path.join(archive, name))
  console.log(`Previous build artifacts preserved at ${archive}`)
}
