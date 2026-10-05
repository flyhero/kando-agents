import { beforeEach, describe, expect, it } from 'vitest'
import { createRpcClient, Task, type ListeningPort, type RpcConnection } from '@kando/protocol'
import { portGroups, portKey, portUrl, openPort } from './port-state'
import { setPortsMaximized, showBrowserTab, showTerminal, toggleBrowserPanel, togglePortsPanel, toggleTerminalPanel, useCore } from './core-store'

const port: ListeningPort = { sessionId: 'session', pid: 123, startedAt: 'start', port: 3000, address: '127.0.0.1', command: 'node', canStop: true, terminalId: null, conversationId: null, taskId: null, label: null, cwd: '/project' }
beforeEach(() => useCore.setState(useCore.getInitialState(), true))

describe('port presentation', () => {
  it.each([['*','http://127.0.0.1:3000/'], ['0.0.0.0','http://127.0.0.1:3000/'], ['::','http://[::1]:3000/'], ['::1','http://[::1]:3000/'], ['127.0.0.1','http://127.0.0.1:3000/']])('opens %s on a usable local address', (address, url) => {
    expect(portUrl({ ...port, address })).toBe(url)
  })

  it('distinguishes a port reused by a new process and IPv4/IPv6 listeners', () => {
    expect(portKey(port)).not.toBe(portKey({ ...port, startedAt: 'later' }))
    expect(portKey(port)).not.toBe(portKey({ ...port, address: '::1' }))
  })

  it('groups services by task, while keeping unrelated terminals distinct', () => {
    const task = Task.parse({ id: 'task', title: 'Login page', details: '', status: 'running', agent: 'claude', repos: [], dependsOn: [], createdAt: 0, updatedAt: 0 })
    const groups = portGroups([{ ...port, taskId: task.id }, { ...port, taskId: task.id, port: 8080 }, { ...port, sessionId: 'another' }], { task }, {}, [])
    expect(groups.map((each) => [each.title, each.ports.length])).toEqual([['Login page', 2], ['终端', 1]])
  })
})

describe('port panel navigation', () => {
  it('closes inspectors when the port panel opens', () => {
    useCore.setState({ inspectorOpen: true, conversationInspectorOpen: true })
    togglePortsPanel()
    expect(useCore.getState()).toMatchObject({ portsPanelOpen: true, inspectorOpen: false, conversationInspectorOpen: false })
    useCore.setState({ inspectorOpen: true })
    expect(useCore.getState().portsPanelOpen).toBe(false)
  })

  it('stacks two of the three panels, and a third puts the top one away', async () => {
    useCore.setState({ terminals: [{ id: 'terminal', sessionId: 's', cwd: '/p', title: 'dev', createdAt: 0 }] })
    toggleBrowserPanel()
    togglePortsPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['browser', 'ports'], browserPanelOpen: true, portsPanelOpen: true })
    await toggleTerminalPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['ports', 'terminal'], browserPanelOpen: false, portsPanelOpen: true, terminalPanelOpen: true })
    showBrowserTab('tab')
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['terminal', 'browser'], portsPanelOpen: false, browserPanelOpen: true })
    // Already up: it stays where it is.
    showTerminal('terminal')
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['terminal', 'browser'], activeTerminalId: 'terminal' })
    await toggleTerminalPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['browser'], terminalPanelOpen: false })
  })

  it('lets a panel opened beside a maximized one show, back at its size', () => {
    togglePortsPanel()
    setPortsMaximized(true)
    toggleBrowserPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['ports', 'browser'], portsMaximized: false })
  })

  it('does not leave another utility maximized behind a maximized port panel', () => {
    useCore.setState({ terminalMaximized: true, browserMaximized: true })
    setPortsMaximized(true)
    expect(useCore.getState()).toMatchObject({ portsMaximized: true, terminalMaximized: false, browserMaximized: false })
  })

  it('watches browser ownership before opening a conversation tab and focuses its result', async () => {
    const sent: Array<{ id: number; method: string; params: unknown }> = []
    const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
    const rpc: RpcConnection = { ...client, features: ['ports', 'browser'], close() {}, closed: new Promise(() => {}) }
    useCore.setState({ rpc, connection: 'connected', portsPanelOpen: true, utilityPanelOrder: ['ports'] })
    const operation = openPort({ ...port, conversationId: '11111111-1111-4111-8111-111111111111' })
    const watch = sent[0]
    if (!watch) throw new Error('no watch request')
    expect(watch.method).toBe('browser.watchAll')
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: watch.id, result: [] }))
    await Promise.resolve()
    await Promise.resolve()
    const open = sent[1]
    if (!open) throw new Error('no open request')
    expect(open).toMatchObject({ method: 'browser.newTab', params: { conversationId: '11111111-1111-4111-8111-111111111111', url: 'http://127.0.0.1:3000/' } })
    client.receive(JSON.stringify({ jsonrpc: '2.0', id: open.id, result: { id: '55555555-5555-4555-8555-555555555555', conversationId: '11111111-1111-4111-8111-111111111111', url: 'http://127.0.0.1:3000/', title: 'Page', active: true, loading: false, createdAt: 0 } }))
    await operation
    // The page opens under the ports it came from.
    expect(useCore.getState()).toMatchObject({ browserPanelOpen: true, portsPanelOpen: true, utilityPanelOrder: ['ports', 'browser'] })
    expect(useCore.getState().error).toBeNull()
  })
})
