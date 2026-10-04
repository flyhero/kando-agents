import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Task, type Conversation, type HostedPort, type Terminal } from '@kando/protocol'
import { daemonSchemas } from '@kando/protocol/node'
import { fakeChatDaemon } from './fake-chat-agent'
import { ownedPorts, PortService } from './port-service'
import type { SessionHost } from './daemon-client'

const chatId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const terminalId = '33333333-3333-4333-8333-333333333333'
const taskId = '44444444-4444-4444-8444-444444444444'
function conversation(id = chatId, folder = '/project'): Conversation {
  return { id, title: id, titleLocked: false, agent: 'claude', workspacePath: folder, projectPaths: [folder], managedWorkspace: false, sessionId: 'agent-session', createdAt: 0, updatedAt: 0 }
}
const terminal: Terminal = { id: terminalId, sessionId: 'terminal-session', cwd: '/project', title: 'pnpm dev', createdAt: 0, conversationId: chatId }
const port: HostedPort = { sessionId: terminal.sessionId, pid: 120, startedAt: 'server-start', address: '127.0.0.1', port: 3000, command: '/usr/bin/node', canStop: true, cwd: '/project/frontend' }
const base = { terminals: [terminal], conversations: [conversation()], tasks: [] }
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })))

function daemonWith(initial: HostedPort[]) {
  const agent = fakeChatDaemon()
  let ports = initial
  let failure: Error | null = null
  const stopped: unknown[] = []
  const daemon: SessionHost = {
    onEvent: agent.onEvent,
    request: async (method, params) => {
      if (failure) throw failure
      if (method === 'portsStop') stopped.push(params)
      return daemonSchemas[method].result.parse(method === 'portsList' ? ports : method === 'portsStop' ? { ok: true } : await agent.request(method, params))
    }
  }
  return { daemon, stopped, set: (next: HostedPort[]) => { ports = next }, fail: (error: Error) => { failure = error } }
}

describe('port ownership in core', () => {
  it('uses the terminal conversation even when another conversation shares the directory', () => {
    const task = Task.parse({ id: taskId, title: 'Task', details: '', status: 'running', conversationId: chatId, agent: 'claude', repos: [], dependsOn: [], createdAt: 0, updatedAt: 0 })
    const context = { ...base, conversations: [{ ...conversation(), taskId }, conversation(otherId)], tasks: [task] }
    expect(ownedPorts([port], context)[0]).toMatchObject({ conversationId: chatId, taskId, terminalId, cwd: '/project/frontend' })
  })

  it('does not assign a user shell to an arbitrary conversation sharing its directory', () => {
    const user = { ...terminal, conversationId: null }
    expect(ownedPorts([port], { ...base, terminals: [user], conversations: [conversation(), conversation(otherId)] })[0]).toMatchObject({ terminalId, conversationId: null, taskId: null })
  })

  it('uses the current server cwd after the user changes directory, with path boundaries', () => {
    const user = { ...terminal, conversationId: null }
    const moved = { ...port, cwd: '/other/frontend' }
    const context = { ...base, terminals: [user], conversations: [conversation(), conversation(otherId, '/other')] }
    expect(ownedPorts([moved], context)[0]?.conversationId).toBe(otherId)
    expect(ownedPorts([{ ...moved, cwd: '/other-project' }], context)[0]?.conversationId).toBeNull()
    expect(ownedPorts([{ ...port, cwd: undefined }], context)[0]?.conversationId).toBeNull()
  })

  it('associates a user terminal in a task worktree with that task', () => {
    const task = Task.parse({ id: taskId, title: 'Task', details: '', status: 'running', conversationId: chatId, agent: 'claude', repos: [{ path: '/repo', worktreePath: '/worktree', branch: 'kando/task' }], dependsOn: [], createdAt: 0, updatedAt: 0 })
    expect(ownedPorts([{ ...port, cwd: '/worktree/frontend' }], { ...base, terminals: [{ ...terminal, conversationId: null }], tasks: [task] })[0]).toMatchObject({ taskId, conversationId: chatId })
  })

  it('includes agent descendants but excludes agent roots and browser infrastructure', () => {
    const agentPort = { ...port, sessionId: 'agent-session' }
    expect(ownedPorts([agentPort], base)[0]).toMatchObject({ terminalId: null, conversationId: chatId })
    expect(ownedPorts([{ ...agentPort, canStop: false }, { ...port, sessionId: 'browser-host' }], base)).toEqual([])
  })
})

describe('PortService', () => {
  it('reads labels from each worktree, detects edits, and keeps discovery working with malformed labels', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'kando-ports-'))
    roots.push(root)
    mkdirSync(path.join(root, '.kando'))
    const file = path.join(root, '.kando', 'ports.json')
    const context = { ...base, terminals: [{ ...terminal, cwd: root }], conversations: [conversation(chatId, root)] }
    const fake = daemonWith([{ ...port, cwd: path.join(root, 'frontend') }])
    const service = new PortService(fake.daemon, () => context)
    writeFileSync(file, JSON.stringify({ ports: [{ port: 3000, label: 'Frontend' }] }))
    expect((await service.list()).ports[0]?.label).toBe('Frontend')
    writeFileSync(file, JSON.stringify({ ports: [{ port: 3000, label: 'Web' }] }))
    expect((await service.list()).ports[0]?.label).toBe('Web')
    writeFileSync(file, '{invalid')
    expect(await service.list()).toMatchObject({ problem: null, ports: [{ label: null, port: 3000 }] })
  })

  it('reports an old daemon without pretending its empty result means there are no ports', async () => {
    const fake = daemonWith([])
    fake.fail(new Error('unknown-method'))
    expect(await new PortService(fake.daemon, () => base).list()).toEqual({ ports: [], problem: '当前 daemon 不支持端口管理，请重启 Kando daemon。' })
  })

  it('rechecks ownership before stopping and refuses a stale or unknown service', async () => {
    const fake = daemonWith([port])
    const service = new PortService(fake.daemon, () => base)
    await service.stop(port)
    expect(fake.stopped).toEqual([port])
    fake.set([{ ...port, startedAt: 'reused-pid' }])
    await expect(service.stop(port)).rejects.toMatchObject({ reason: 'port-process-changed' })
    expect(fake.stopped).toHaveLength(1)
    fake.set([{ ...port, sessionId: 'unowned-session' }])
    await expect(service.stop({ ...port, sessionId: 'unowned-session' })).rejects.toMatchObject({ reason: 'port-process-changed' })
    expect(fake.stopped).toHaveLength(1)
  })
})
