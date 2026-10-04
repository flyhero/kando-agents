import { describe, expect, it, vi } from 'vitest'
import { parseLsof, parseProcessFolders, parseProcesses, parseSs, type ProcessSnapshot } from './listening-processes'
import { SessionPorts, sessionPorts } from './session-ports'

const snapshot: ProcessSnapshot = {
  processes: [
    { pid: 100, parentPid: 1, startedAt: 'root', command: 'agent' },
    { pid: 110, parentPid: 100, startedAt: 'shell', command: 'shell' },
    { pid: 120, parentPid: 110, startedAt: 'server', command: 'node' },
    { pid: 200, parentPid: 1, startedAt: 'foreign', command: 'node' }
  ],
  listeners: [{ pid: 120, port: 3000, address: '127.0.0.1' }, { pid: 200, port: 8080, address: '*' }]
}
const roots = [{ sessionId: 'agent', pid: 100, canStopRoot: false }, { sessionId: 'terminal', pid: 110, canStopRoot: true }]

describe('listening process parsers', () => {
  it('reads process identity separately from command paths containing spaces', () => {
    expect(parseProcesses(' 120 110 Mon Oct  5 10:15:30 2026 /Program Files/node\nmalformed')).toEqual([{ pid: 120, parentPid: 110, startedAt: 'Mon Oct  5 10:15:30 2026', command: '/Program Files/node' }])
  })

  it('reads macOS IPv4, IPv6 and wildcard listeners, and ignores non-endpoints', () => {
    expect(parseLsof('p120\nf20\nn127.0.0.1:3000\nn[::1]:3000\np200\nn*:8080\nninvalid')).toEqual([
      { pid: 120, address: '127.0.0.1', port: 3000 }, { pid: 120, address: '::1', port: 3000 }, { pid: 200, address: '*', port: 8080 }
    ])
    expect(parseLsof('p120\nn127.0.0.1:99999')).toEqual([])
    expect(parseLsof('p120\ntIPv6\nn*:3000')).toEqual([{ pid: 120, address: '::', port: 3000 }])
  })

  it('reads Linux ss ownership, including multiple processes sharing a socket', () => {
    expect(parseSs('LISTEN 0 511 [::1]:3000 [::]:* users:(("node",pid=120,fd=20),("node",pid=121,fd=20))\nLISTEN 0 511 0.0.0.0:8080 0.0.0.0:*')).toEqual([{ pid: 120, address: '::1', port: 3000 }, { pid: 121, address: '::1', port: 3000 }])
    expect(parseSs('LISTEN 0 511 *:3000 *:* users:(("node",pid=120,fd=20))', 6)).toEqual([{ pid: 120, address: '::', port: 3000 }])
  })

  it('preserves spaces in process working directories', () => {
    expect([...parseProcessFolders('p120\nfcwd\nn/project with spaces\np200\nn/another')]).toEqual([[120, '/project with spaces'], [200, '/another']])
  })
})

describe('session port ownership', () => {
  it('uses the closest managed ancestor and excludes unrelated processes', () => {
    expect(sessionPorts(snapshot, roots)).toEqual([{ sessionId: 'terminal', pid: 120, port: 3000, address: '127.0.0.1', command: 'node', startedAt: 'server', canStop: true }])
  })

  it('deduplicates sockets and handles dead processes and ancestry cycles', () => {
    const first = snapshot.listeners[0]
    if (!first) throw new Error('missing fixture')
    const data = { processes: [...snapshot.processes, { pid: 300, parentPid: 300, startedAt: 'cycle', command: 'node' }], listeners: [...snapshot.listeners, first, { pid: 300, port: 9090, address: '*' }, { pid: 400, port: 4000, address: '*' }] }
    expect(sessionPorts(data, roots)).toHaveLength(1)
  })

  it('protects the agent root while allowing a command terminal root to stop', async () => {
    const data = { ...snapshot, listeners: [{ pid: 100, port: 3000, address: '*' }] }
    const stop = vi.fn(async () => {})
    const service = new SessionPorts(() => roots, async () => data, stop, async () => new Map())
    const [port] = await service.list()
    if (!port) throw new Error('missing port')
    expect(port.canStop).toBe(false)
    await expect(service.stop(port)).rejects.toThrow('port-process-protected')
    expect(stop).not.toHaveBeenCalled()
    expect(sessionPorts(data, [{ sessionId: 'command', pid: 100, canStopRoot: true }])[0]?.canStop).toBe(true)
  })

  it.each(['identity', 'owner', 'listener'] as const)('refuses a stop after the %s changes', async (change) => {
    let current = structuredClone(snapshot)
    const stop = vi.fn(async () => {})
    let sessions = roots
    const service = new SessionPorts(() => sessions, async () => current, stop, async () => new Map())
    const [port] = await service.list()
    if (!port) throw new Error('missing port')
    if (change === 'identity') current = { ...current, processes: current.processes.map((each) => each.pid === port.pid ? { ...each, startedAt: 'reused-pid' } : each) }
    if (change === 'owner') sessions = []
    if (change === 'listener') current = { ...current, listeners: [] }
    await expect(service.stop(port)).rejects.toThrow('port-process-changed')
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops only the verified listening process and includes its actual cwd', async () => {
    const stop = vi.fn(async () => {})
    const service = new SessionPorts(() => roots, async () => snapshot, stop, async () => new Map([[120, '/worktree/frontend']]))
    const [port] = await service.list()
    if (!port) throw new Error('missing port')
    expect(port.cwd).toBe('/worktree/frontend')
    await service.stop(port)
    expect(stop).toHaveBeenCalledExactlyOnceWith(snapshot.processes[2])
  })
})
