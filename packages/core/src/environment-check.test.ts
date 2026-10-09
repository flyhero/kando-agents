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
      applicationDirs: [root],
      signedIn: { claude: async () => false, codex: async () => true },
      now: () => 1000
    })
    const environment = await service.check()
    expect(environment).toEqual({
      checks: [
        { tool: 'git', status: 'ok', version: '9.9.9', path: path.join(bin, 'git'), signedIn: null },
        { tool: 'claude', status: 'ok', version: '2.1.263', path: path.join(bin, 'claude'), signedIn: false },
        { tool: 'codex', status: 'missing', version: null, path: null, signedIn: null },
        { tool: 'cursor', status: 'missing', version: null, path: null, signedIn: null }
      ],
      detectedAgents: [{ id: 'claude', name: 'Claude Code', locations: [{ source: 'cli', path: path.join(bin, 'claude') }] }],
      cliInstallations: [],
      searchPath: [bin],
      checkedAt: 1000
    })
  })

  it.skipIf(process.platform === 'win32')('keeps the last answer until asked again', async () => {
    let now = 1000
    const service = new EnvironmentService({ pathEnv: bin, platform: process.platform, applicationDirs: [root], signedIn: {}, now: () => now })
    const first = await service.check()
    fakeTool('git', 'git version 9.9.9')
    expect(await service.check()).toBe(first)
    expect((await service.check(true)).checks[0]).toMatchObject({ tool: 'git', status: 'ok' })
    now += 10 * 60_000
    fakeTool('codex', 'codex-cli 0.156.1')
    expect((await service.check()).checks[2]).toMatchObject({ tool: 'codex', version: '0.156.1' })
  })

  it.skipIf(process.platform === 'win32')('refreshes after a pending look so a completed install is not missed', async () => {
    fakeTool('claude', '2.1.263 (Claude Code)')
    let started = () => {}
    let release = () => {}
    let calls = 0
    const checking = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = new EnvironmentService({ pathEnv: bin, platform: process.platform, applicationDirs: [root], signedIn: {
      claude: async () => { if (++calls === 1) { started(); await gate } return true }
    } })
    const beforeInstall = service.check()
    await checking
    fakeTool('cursor-agent', 'cursor 1.0.0')
    const afterInstall = service.check(true)
    release()
    expect((await beforeInstall).checks.find((each) => each.tool === 'cursor')?.status).toBe('missing')
    expect((await afterInstall).checks.find((each) => each.tool === 'cursor')?.path).toBe(path.join(bin, 'cursor-agent'))
  })

  it.skipIf(process.platform === 'win32')('calls a tool that will not say its version found but unknown', async () => {
    const file = path.join(bin, 'codex')
    writeFileSync(file, '#!/bin/sh\nexit 1\n')
    chmodSync(file, 0o755)
    const service = new EnvironmentService({ pathEnv: bin, platform: process.platform, applicationDirs: [root], signedIn: { codex: async () => { throw new Error('no') } } })
    expect((await service.check()).checks[2]).toEqual({ tool: 'codex', status: 'unknown', version: null, path: file, signedIn: null })
  })

  it.skipIf(process.platform === 'win32')('finds an application without its CLI, then groups both installations', async () => {
    const application = path.join(root, 'Cursor.app')
    mkdirSync(path.join(application, 'Contents'), { recursive: true })
    writeFileSync(path.join(application, 'Contents', 'Info.plist'), 'cursor')
    const service = new EnvironmentService({ pathEnv: bin, platform: 'darwin', applicationDirs: [root], signedIn: {} })
    expect((await service.check()).detectedAgents).toEqual([
      { id: 'cursor', name: 'Cursor', locations: [{ source: 'application', path: application }] }
    ])
    expect((await service.check()).cliInstallations).toEqual([{ agent: 'cursor', shell: 'bash', command: 'curl https://cursor.com/install -fsS | bash' }])

    fakeTool('cursor-agent', 'cursor 1.0.0')
    fakeTool('gemini', 'gemini 1.0.0')
    expect((await service.check(true)).detectedAgents).toEqual([
      { id: 'cursor', name: 'Cursor', locations: [
        { source: 'cli', path: path.join(bin, 'cursor-agent') },
        { source: 'application', path: application }
      ], cliCheck: { status: 'responded', version: '1.0.0', reason: null } },
      { id: 'gemini', name: 'Gemini CLI', locations: [{ source: 'cli', path: path.join(bin, 'gemini') }],
        cliCheck: { status: 'responded', version: '1.0.0', reason: null } }
    ])
    expect((await service.check()).cliInstallations).toEqual([])
  })

  it.each([
    { platform: 'win32', application: 'cursor/Cursor.exe', shell: 'powershell' },
    { platform: 'linux', application: 'cursor/cursor', shell: 'bash' }
  ] as const)('finds an app without its CLI on $platform', async ({ platform, application, shell }) => {
    const file = path.join(root, application)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '', { mode: 0o755 })
    const service = new EnvironmentService({ pathEnv: bin, platform, applicationDirs: [root], signedIn: {} })
    const environment = await service.check()
    expect(environment.detectedAgents).toEqual([{ id: 'cursor', name: 'Cursor', locations: expect.arrayContaining([{ source: 'application', path: file }]) }])
    expect(environment.cliInstallations).toEqual([expect.objectContaining({ agent: 'cursor', shell })])
    if (platform === 'win32') {
      writeFileSync(path.join(bin, 'cursor-agent.cmd'), '@echo off\r\n')
      const installed = await service.check(true)
      expect(installed.checks.find((each) => each.tool === 'cursor')).toMatchObject({ status: 'unknown', path: path.join(bin, 'cursor-agent.cmd') })
      expect(installed.cliInstallations).toEqual([])
    }
  })

  it.skipIf(process.platform === 'win32')('reports a CLI that does not answer --version without claiming it works', async () => {
    const file = path.join(bin, 'gemini')
    writeFileSync(file, '#!/bin/sh\nexit 1\n')
    chmodSync(file, 0o755)
    const service = new EnvironmentService({ pathEnv: bin, platform: process.platform, applicationDirs: [root], signedIn: {} })
    expect((await service.check()).detectedAgents).toEqual([
      { id: 'gemini', name: 'Gemini CLI', locations: [{ source: 'cli', path: file }],
        cliCheck: { status: 'unverified', version: null, reason: 'probe-failed' } }
    ])
  })

  it('keeps a Windows command shim discoverable without trying to execute it directly', async () => {
    const file = path.join(bin, 'gemini.cmd')
    writeFileSync(file, '@echo off\r\n')
    const service = new EnvironmentService({ pathEnv: bin, platform: 'win32', applicationDirs: [], signedIn: {} })
    expect((await service.check()).detectedAgents).toEqual([
      { id: 'gemini', name: 'Gemini CLI', locations: [{ source: 'cli', path: file }],
        cliCheck: { status: 'unverified', version: null, reason: 'windows-shim' } }
    ])
  })

  it.skipIf(process.platform === 'win32')('announces actual discovery changes but not unchanged refreshes', async () => {
    const changes: string[][] = []
    const service = new EnvironmentService({ pathEnv: bin, platform: process.platform, applicationDirs: [root], signedIn: {},
      changed: (environment) => changes.push((environment.detectedAgents ?? []).map((agent) => agent.id)) })
    await service.check()
    await service.check(true)
    expect(changes).toEqual([[]])
    fakeTool('gemini', 'gemini 1.0.0')
    await service.check(true)
    expect(changes).toEqual([[], ['gemini']])
  })
})
