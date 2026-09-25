import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { kandoHome, kandoPaths } from './paths'

describe.skipIf(process.platform === 'win32')('daemon socket path', () => {
  it('lives in KANDO_HOME when short enough', () => {
    expect(kandoPaths('/home/me/.kando').daemonSocket).toBe('/home/me/.kando/daemon-v2.sock')
  })

  it('falls back to a hashed temp path when KANDO_HOME is too deep for sun_path', () => {
    const deep = `/${'nested/'.repeat(20)}kando`
    const socket = kandoPaths(deep).daemonSocket
    expect(path.dirname(socket)).toBe(os.tmpdir())
    expect(socket).not.toBe(kandoPaths(`${deep}-other`).daemonSocket)
  })
})

describe('home directory', () => {
  it('prefers KANDO_HOME', () => {
    expect(kandoHome({ KANDO_HOME: '/a' }, '/home/me')).toBe(path.resolve('/a'))
  })

  it('defaults to ~/.kando', () => {
    expect(kandoHome({}, '/home/me')).toBe(path.join('/home/me', '.kando'))
  })
})
