import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore } from './credential-store'
import { SourceConfigStore } from './source-config'
import { migrateLegacyJira } from './source-migration'

describe('migrateLegacyJira', () => {
  let dir: string
  let legacy: string
  let sources: SourceConfigStore
  let credentials: CredentialStore

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-migrate-'))
    legacy = path.join(dir, 'jira.json')
    sources = new SourceConfigStore(path.join(dir, 'sources.json'))
    credentials = new CredentialStore(path.join(dir, 'credentials.json'))
    await sources.load()
    await credentials.load()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeLegacy = () =>
    writeFileSync(legacy, JSON.stringify({ site: 'https://acme.atlassian.net', email: 'me@acme.com', token: 'secret', jql: 'project = X' }))

  it('splits jira.json into settings and a credential record, then removes it', async () => {
    writeLegacy()
    await migrateLegacyJira(legacy, sources, credentials, () => 7)
    expect(sources.get('jira', 'default')).toEqual({
      provider: 'jira',
      instance: 'default',
      enabled: true,
      settings: { site: 'https://acme.atlassian.net', jql: 'project = X' }
    })
    expect(credentials.get('jira', 'default')).toEqual({ kind: 'basic', payload: { email: 'me@acme.com', token: 'secret' }, account: null, updatedAt: 7 })
    expect(existsSync(legacy)).toBe(false)
    // A second run finds nothing to do.
    await migrateLegacyJira(legacy, sources, credentials)
    expect(credentials.get('jira', 'default')?.updatedAt).toBe(7)
  })

  it('finishes a migration that stopped halfway, without overwriting what already moved', async () => {
    writeLegacy()
    await sources.save({ provider: 'jira', instance: 'default', enabled: false, settings: { site: 'https://acme.atlassian.net', jql: 'kept' } })
    await migrateLegacyJira(legacy, sources, credentials)
    expect(sources.get('jira', 'default')?.settings.jql).toBe('kept')
    expect(credentials.get('jira', 'default')?.payload.token).toBe('secret')
    expect(existsSync(legacy)).toBe(false)
  })

  it('leaves a file it cannot understand where it is', async () => {
    writeFileSync(legacy, '{ not json')
    await migrateLegacyJira(legacy, sources, credentials)
    expect(existsSync(legacy)).toBe(true)
    expect(sources.list()).toEqual([])
  })
})
