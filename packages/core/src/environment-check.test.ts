import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EnvironmentService, findOnPath, parseVersion } from './environment-check'

describe('environment check', () => {
  let root: string
  let bin: string
  const fakeTool = (name: string, says: string) => {
    const file = path.join(bin, name)
    writeFileSync(file, `#!/bin/sh\necho "${says}"\n`)
    chmodSync(file, 0o755)
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-environment-'))
    bin = path.join(root, 'bin')
    mkdirSync(bin)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads the first dotted triple as the version', () => {
    expect(parseVersion('git version 2.39.3 (Apple Git-145)')).toBe('2.39.3')
    expect(parseVersion('2.1.263 (Claude Code)')).toBe('2.1.263')
    expect(parseVersion('codex-cli 0.156.1')).toBe('0.156.1')
    expect(parseVersion('nothing here')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('finds only what the path can run', async () => {
    fakeTool('git', 'git version 9.9.9')
    writeFileSync(path.join(bin, 'claude'), 'not executable')
    expect(await findOnPath('git', `${root}${path.delimiter}${bin}`, process.platform)).toBe(path.join(bin, 'git'))
    expect(await findOnPath('claude', bin, process.platform)).toBeNull()
    expect(await findOnPath('codex', '', process.platform)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('reports each tool, its version and whether it is signed in', async () => {
    fakeTool('git', 'git version 9.9.9')
    fakeTool('claude', '2.1.263 (Claude Code)')
    const service = new EnvironmentService({
      pathEnv: bin,
      platform: process.platform,
      signedIn: { claude: async () => false, codex: async () => true },
      now: () => 1000
    })
    const environment = await service.check()
    expect(environment).toEqual({
      checks: [
        { tool: 'git', status: 'ok', version: '9.9.9', path: path.join(bin, 'git'), signedIn: null },
        { tool: 'claude', status: 'ok', version: '2.1.263', path: path.join(bin, 'claude'), signedIn: false },
        { tool: 'codex', status: 'missing', version: null, path: null, signedIn: null }
      ],
      searchPath: [bin],
      checkedAt: 1000
    })
  })

  it.skipIf(process.platform === 'win32')('keeps the last answer until asked again', async () => {
    let now = 1000
    const service = new EnvironmentService({ pathEnv: bin, platform: process.platform, signedIn: {}, now: () => now })
    const first = await service.check()
    fakeTool('git', 'git version 9.9.9')
    expect(await service.check()).toBe(first)
    expect((await service.check(true)).checks[0]).toMatchObject({ tool: 'git', status: 'ok' })
    now += 10 * 60_000
    fakeTool('codex', 'codex-cli 0.156.1')
    expect((await service.check()).checks[2]).toMatchObject({ tool: 'codex', version: '0.156.1' })
  })

  it.skipIf(process.platform === 'win32')('calls a tool that will not say its version found but unknown', async () => {
    const file = path.join(bin, 'codex')
    writeFileSync(file, '#!/bin/sh\nexit 1\n')
    chmodSync(file, 0o755)
    const service = new EnvironmentService({ pathEnv: bin, platform: process.platform, signedIn: { codex: async () => { throw new Error('no') } } })
    expect((await service.check()).checks[2]).toEqual({ tool: 'codex', status: 'unknown', version: null, path: file, signedIn: null })
  })
})
