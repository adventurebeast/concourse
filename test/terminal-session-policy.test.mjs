import { describe, expect, it } from 'vitest'
import { sanitizeSessionBlob } from '../src/main/terminal-session-policy.js'

describe('persisted terminal session privacy policy', () => {
  it('keeps only explicit labels, cwd, and normalized agent identity', () => {
    const clean = sanitizeSessionBlob({
      version: 3,
      terminals: {
        layout: 'grid',
        tabs: [
          {
            customLabel: ' API server ',
            cwd: '/workspace',
            resumeCommand: 'claude --continue',
            label: 'login --password secret',
            lastCommand: 'login --password secret',
            typedInput: 'secret',
            summaryText: 'secret'
          }
        ]
      }
    })

    expect(clean).toEqual({
      version: 3,
      terminals: {
        layout: 'grid',
        tabs: [{ customLabel: 'API server', cwd: '/workspace', resumeCommand: 'claude --continue' }]
      }
    })
  })

  it('rejects arbitrary resume commands and their arguments', () => {
    const clean = sanitizeSessionBlob({
      terminals: {
        tabs: [{ resumeCommand: 'claude --api-key secret' }, { resumeCommand: 'deploy --prod' }]
      }
    })
    expect(clean.terminals.tabs).toEqual([{}, {}])
  })
})
