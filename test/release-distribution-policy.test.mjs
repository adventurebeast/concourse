import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

describe('macOS release trust boundary', () => {
  it('requires Developer ID signing, hardened runtime, and notarization', () => {
    const config = read('electron-builder.yml')

    expect(config).toMatch(/hardenedRuntime:\s*true/)
    expect(config).toMatch(/notarize:\s*true/)
    expect(config).toMatch(/entitlements:\s*build\/entitlements\.mac\.plist/)
    expect(config).not.toMatch(/^\s*identity:\s*(?:null|["']?-["']?)\s*$/m)
  })

  it('uploads macOS artifacts only after all trust checks pass', () => {
    const workflow = read('.github/workflows/build-mac.yml')
    const checks = [
      'codesign --verify --deep --strict',
      "grep -q '^Authority=Developer ID Application:'",
      'xcrun stapler validate',
      'spctl --assess --type execute',
      'hdiutil verify',
      'spctl --assess --type open'
    ]
    for (const check of checks) expect(workflow).toContain(check)

    const upload = workflow.indexOf('gh release upload')
    expect(upload).toBeGreaterThan(-1)
    for (const check of checks) expect(workflow.indexOf(check)).toBeLessThan(upload)
  })

  it('never uploads a workstation-built DMG and skips publishing without CI secrets', () => {
    const release = read('scripts/release.mjs')

    expect(release).toContain("run('gh', ['secret', 'list'")
    expect(release).toContain('REQUIRED_RELEASE_SECRETS')
    expect(release).toContain('skipPublicRelease')
    expect(release).not.toMatch(/release', 'upload|release\/.*\.dmg/)
  })

  it('installs and verifies a local app before checking public-release credentials', () => {
    const release = read('scripts/release.mjs')
    const installer = read('scripts/install-local.mjs')

    expect(release.indexOf("execFileSync(process.execPath, [localInstaller]")).toBeLessThan(
      release.indexOf("run('gh', ['auth', 'status'])")
    )
    expect(installer).toContain("'--config.mac.identity=-'")
    expect(installer).toContain("'--config.mac.notarize=false'")
    expect(installer).toContain("'/Applications/Concourse.app'")
    expect(installer).toContain("'codesign', ['--verify', '--deep', '--strict'")
    expect(installer.indexOf("run('ditto', [builtApp, stagingApp])")).toBeLessThan(
      installer.indexOf('renameSync(installedApp, backup)')
    )
    expect(installer).not.toMatch(/\brm(?:Sync)?\b/)
  })
})
