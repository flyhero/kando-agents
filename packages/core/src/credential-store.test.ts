import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialStore } from './credential-store'

const record = (token: string) => ({ kind: 'basic', payload: { email: 'me@acme.com', token }, account: 'Me', updatedAt: 1 })

describe('CredentialStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-credentials-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps records per provider instance in an owner-only file', async () => {
    const file = path.join(dir, 'credentials.json')
    const store = new CredentialStore(file)
    await store.load()
    await store.set('jira', 'default', record('a'))
    await store.set('jira', 'second', record('b'))
    expect(store.get('jira', 'default')?.payload.token).toBe('a')
    expect(store.get('zentao', 'default')).toBeNull()
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
    const reloaded = new CredentialStore(file)
    await reloaded.load()
    expect(reloaded.get('jira', 'second')?.payload.token).toBe('b')
    await reloaded.delete('jira', 'default')
    expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual({ 'jira/second': record('b') })
  })

  it('keeps the credential that worked when writing a new one fails', async () => {
    const store = new CredentialStore(path.join(dir, 'missing-dir', 'credentials.json'))
    await store.load()
    await expect(store.set('jira', 'default', record('a'))).rejects.toThrow()
    expect(store.get('jira', 'default')).toBeNull()
  })
})
