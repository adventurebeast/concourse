import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// update-check.js imports `app` from electron at module load, so stub it before
// importing. getVersion() is the running build we compare GitHub's latest against.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.28' } }))

const { isNewer, checkForUpdate } = await import('../src/main/update-check.js')

describe('isNewer', () => {
  it('orders by major/minor/patch', () => {
    expect(isNewer('0.0.29', '0.0.28')).toBe(true)
    expect(isNewer('0.1.0', '0.0.99')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
  })
  it('is strict — equal is not newer', () => {
    expect(isNewer('0.0.28', '0.0.28')).toBe(false)
  })
  it('treats older as not newer', () => {
    expect(isNewer('0.0.27', '0.0.28')).toBe(false)
  })
  it('ignores non-numeric / pre-release suffixes (no false "newer")', () => {
    expect(isNewer('0.0.28-beta', '0.0.28')).toBe(false)
  })
})

describe('checkForUpdate', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const ok = (body) => ({ ok: true, json: async () => body })

  it('returns {version,url} when the latest release is newer', async () => {
    global.fetch.mockResolvedValue(
      ok({ tag_name: 'v0.0.30', html_url: 'https://example.com/r/0.0.30' })
    )
    expect(await checkForUpdate()).toEqual({
      version: '0.0.30',
      url: 'https://example.com/r/0.0.30'
    })
  })

  it('returns null when the latest is the running version', async () => {
    global.fetch.mockResolvedValue(ok({ tag_name: 'v0.0.28' }))
    expect(await checkForUpdate()).toBeNull()
  })

  it('ignores drafts and pre-releases', async () => {
    global.fetch.mockResolvedValue(ok({ tag_name: 'v0.0.30', prerelease: true }))
    expect(await checkForUpdate()).toBeNull()
  })

  it('stays silent on a non-OK response', async () => {
    global.fetch.mockResolvedValue({ ok: false })
    expect(await checkForUpdate()).toBeNull()
  })

  it('stays silent when the network throws (offline)', async () => {
    global.fetch.mockRejectedValue(new Error('offline'))
    expect(await checkForUpdate()).toBeNull()
  })
})
