import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kando-paths-'))
  dirs.push(dir)
  return dir
}

describe('home directory', () => {
  it('prefers KANDO_HOME, then the pre-rename RIPEN_HOME', () => {
    expect(kandoHome({ KANDO_HOME: '/a', RIPEN_HOME: '/b' })).toBe(path.resolve('/a'))
    expect(kandoHome({ RIPEN_HOME: '/b' })).toBe(path.resolve('/b'))
  })

  it('defaults to ~/.kando', () => {
    const homedir = tempDir()
    expect(kandoHome({}, homedir)).toBe(path.join(homedir, '.kando'))
  })

  it('keeps using a pre-rename ~/.ripen until ~/.kando exists', () => {
    const homedir = tempDir()
    mkdirSync(path.join(homedir, '.ripen'))
    expect(kandoHome({}, homedir)).toBe(path.join(homedir, '.ripen'))
    mkdirSync(path.join(homedir, '.kando'))
    expect(kandoHome({}, homedir)).toBe(path.join(homedir, '.kando'))
  })
})

describe('database path', () => {
  const tempHome = tempDir

  it('uses kando.db in a fresh home', () => {
    const home = tempHome()
    expect(kandoPaths(home).database).toBe(path.join(home, 'kando.db'))
  })

  it('keeps opening ripen.db in a home created before the rename', () => {
    const home = tempHome()
    writeFileSync(path.join(home, 'ripen.db'), '')
    expect(kandoPaths(home).database).toBe(path.join(home, 'ripen.db'))
  })

  it('prefers kando.db when both exist', () => {
    const home = tempHome()
    writeFileSync(path.join(home, 'ripen.db'), '')
    writeFileSync(path.join(home, 'kando.db'), '')
    expect(kandoPaths(home).database).toBe(path.join(home, 'kando.db'))
  })
})
