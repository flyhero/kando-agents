import { describe, expect, it, vi } from 'vitest'
import type { Environment, Terminal } from '@kando/protocol'
import { AgentCliInstaller, agentCliInstallations, cursorInstallation } from './agent-cli-installation'

const missing: Environment = {
  checks: [{ tool: 'cursor', status: 'missing', version: null, path: null, signedIn: null }],
  detectedAgents: [{ id: 'cursor', name: 'Cursor', locations: [{ source: 'application', path: '/Applications/Cursor.app' }] }],
  searchPath: [], checkedAt: 0
}
const installation = cursorInstallation('darwin')
if (!installation) throw new Error('missing installer')
const offered = { ...missing, cliInstallations: [installation] }
const terminal: Terminal = {
  id: '00000001-0000-4000-8000-000000000000', sessionId: 'installation', cwd: '/home', title: '安装 Cursor CLI',
  command: installation.command, createdAt: 0, exited: false, exitCode: null
}

describe('agent CLI installation eligibility', () => {
  it('offers only an app with its supported CLI positively missing', () => {
    expect(agentCliInstallations(missing, 'darwin')).toEqual([installation])
    expect(agentCliInstallations({ ...missing, detectedAgents: [] }, 'darwin')).toEqual([])
    expect(agentCliInstallations({ ...missing, detectedAgents: undefined }, 'darwin')).toEqual([])
    expect(agentCliInstallations({ ...missing, checks: [] }, 'darwin')).toEqual([])
    expect(agentCliInstallations({ ...missing, detectedAgents: [{ id: 'windsurf', name: 'Windsurf', locations: [{ source: 'application', path: '/Applications/Windsurf.app' }] }] }, 'darwin')).toEqual([])
  })

  it.each(['ok', 'unknown'] as const)('does not reinstall a %s CLI even when signed out or incompatible', (status) => {
    const environment = { ...missing, checks: [{ tool: 'cursor' as const, status, version: null, path: '/bin/cursor-agent', signedIn: false }] }
    expect(agentCliInstallations(environment, 'darwin')).toEqual([])
  })

  it('rejects a contradictory missing result when the inventory or check still has a CLI path', () => {
    expect(agentCliInstallations({ ...missing, checks: missing.checks.map((check) => ({ ...check, path: '/bin/cursor-agent' })) }, 'darwin')).toEqual([])
    expect(agentCliInstallations({ ...missing, detectedAgents: [{ id: 'cursor', name: 'Cursor', locations: [
      { source: 'application', path: '/Applications/Cursor.app' }, { source: 'cli', path: '/bin/cursor-agent.cmd' }
    ], cliCheck: { status: 'unverified', version: null, reason: 'windows-shim' } }] }, 'win32')).toEqual([])
  })

  it('selects the host shell and official command and offers nothing on other systems', () => {
    expect(agentCliInstallations(missing, 'linux')).toEqual([installation])
    expect(agentCliInstallations(missing, 'win32')).toEqual([{ agent: 'cursor', shell: 'powershell', command: "irm 'https://cursor.com/install?win32=true' | iex" }])
    expect(agentCliInstallations(missing, 'freebsd')).toEqual([])
  })
})

describe('AgentCliInstaller', () => {
  it('checks eligibility again and refuses a stale or unsupported entry without spawning', async () => {
    const environment = { check: vi.fn(async () => ({ ...missing, cliInstallations: [] })) }
    const terminals = { list: () => [], installCli: vi.fn(async () => terminal) }
    const installer = new AgentCliInstaller(environment, terminals)
    await expect(installer.install('cursor')).rejects.toMatchObject({ reason: 'agent-cli-install-unavailable' })
    await expect(installer.install('codex')).rejects.toMatchObject({ reason: 'agent-cli-install-unavailable' })
    expect(environment.check).toHaveBeenCalledWith(true)
    expect(terminals.installCli).not.toHaveBeenCalled()
  })

  it('coalesces clicks across clients and reuses a running installation after a core restart', async () => {
    const rows: Terminal[] = []
    const environment = { check: vi.fn(async () => offered) }
    const terminals = { list: () => rows, installCli: vi.fn(async () => { rows.push(terminal); return terminal }) }
    const installer = new AgentCliInstaller(environment, terminals)
    expect(await Promise.all([installer.install('cursor'), installer.install('cursor')])).toEqual([terminal, terminal])
    const restarted = new AgentCliInstaller(environment, terminals)
    expect(await restarted.install('cursor')).toBe(terminal)
    expect(terminals.installCli).toHaveBeenCalledTimes(1)
  })

  it('retries a failed spawn or finished command, and checks even a command that already exited', async () => {
    const environment = { check: vi.fn(async () => offered) }
    const exited = { ...terminal, exited: true, exitCode: 1 }
    const terminals = { list: () => [exited], installCli: vi.fn(async () => exited).mockRejectedValueOnce(new Error('no shell')) }
    const installer = new AgentCliInstaller(environment, terminals)
    await expect(installer.install('cursor')).rejects.toThrow('no shell')
    expect(await installer.install('cursor')).toEqual(exited)
    expect(terminals.installCli).toHaveBeenCalledTimes(2)
    expect(environment.check).toHaveBeenCalledTimes(3)
  })
})
