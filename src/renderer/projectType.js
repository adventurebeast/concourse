// Best-effort "what kind of project is this?" detector for the beginner heads-up
// line. It reads the workspace root's top-level entries (and, when present,
// package.json's dependency list) and maps them to a friendly { icon, label }.
//
// This is Layer A work: it stays entirely in the renderer over the existing fs
// bridge, costs nothing, and degrades to null (generic folder) when it can't tell.
// The label carries the specificity ("a React app"); the icon carries the family.

const api = window.api

function joinPath(dir, name) {
  return dir.replace(/[/\\]+$/, '') + '/' + name
}

function t(icon, label) {
  return { icon, label }
}

// Read and parse package.json at the root; returns its merged dependency map (or
// {} when missing/unreadable) so framework detection can branch off real deps
// rather than guessing from filenames alone.
async function readPackageDeps(root) {
  try {
    const pkg = JSON.parse(await api.fs.readFile(joinPath(root, 'package.json')))
    return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  } catch {
    return {}
  }
}

export async function detectProjectType(root) {
  if (!root) return null

  let names
  try {
    const entries = await api.fs.readDir(root)
    names = new Set(entries.map((e) => e.name))
  } catch {
    return null
  }
  const has = (n) => names.has(n)

  // Node / JS ecosystem — refine by what's actually depended on.
  if (has('package.json')) {
    const deps = await readPackageDeps(root)
    const dep = (n) => Object.prototype.hasOwnProperty.call(deps, n)
    if (dep('next')) return t('globe', 'a Next.js app')
    if (dep('@angular/core')) return t('globe', 'an Angular app')
    if (dep('svelte') || dep('@sveltejs/kit')) return t('globe', 'a Svelte app')
    if (dep('vue')) return t('globe', 'a Vue app')
    if (dep('react') || dep('react-dom')) return t('react', 'a React app')
    if (dep('electron')) return t('monitor', 'an Electron desktop app')
    if (dep('express') || dep('fastify') || dep('koa') || dep('@nestjs/core'))
      return t('hexagon', 'a Node.js server')
    if (dep('vite')) return t('globe', 'a web app')
    return t('hexagon', 'a Node.js project')
  }

  // Other ecosystems, keyed off their canonical manifest / marker files.
  if (has('Cargo.toml')) return t('cog', 'a Rust project')
  if (has('go.mod')) return t('code', 'a Go project')
  if (has('Gemfile')) return t('gem', 'a Ruby project')
  if (has('pubspec.yaml')) return t('smartphone', 'a Flutter app')
  if (has('Package.swift')) return t('smartphone', 'a Swift project')
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts'))
    return t('coffee', 'a Java project')
  if (has('composer.json')) return t('code', 'a PHP project')
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('Pipfile'))
    return t('code', 'a Python project')
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml'))
    return t('box', 'a Docker project')
  if (has('index.html')) return t('globe', 'a website')

  return null
}
