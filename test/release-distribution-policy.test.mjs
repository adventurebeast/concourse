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

  it('never uploads a workstation-built DMG and blocks absent CI secrets', () => {
    const release = read('scripts/release.mjs')

    expect(release).toContain("run('gh', ['secret', 'list'")
    expect(release).toContain('REQUIRED_RELEASE_SECRETS')
    expect(release).not.toMatch(/release', 'upload|release\/.*\.dmg/)
  })
})
