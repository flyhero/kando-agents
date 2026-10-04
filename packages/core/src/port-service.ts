import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { PortLabels, type Conversation, type HostedPort, type ListeningPort, type PortList, type PortRef, type Task, type Terminal } from '@kando/protocol'
import type { SessionHost } from './daemon-client'
import { Rejection } from './rejection'

type PortContext = { terminals: Terminal[]; conversations: Conversation[]; tasks: Task[] }

function inside(folder: string, root: string): boolean {
  const relative = path.relative(root, folder)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function ownedPorts(ports: readonly HostedPort[], context: PortContext): ListeningPort[] {
  return ports.flatMap((port) => {
    const terminal = context.terminals.find((each) => each.sessionId === port.sessionId)
    const direct = context.conversations.find((each) => each.sessionId === port.sessionId)
    if (!terminal && !direct) return []
    // A pipe root is the agent, not a dev server it started.
    if (!terminal && !port.canStop) return []
    const cwd = port.cwd ?? terminal?.cwd ?? direct?.workspacePath ?? ''
    let conversation = terminal?.conversationId ? context.conversations.find((each) => each.id === terminal.conversationId) : direct
    const directTaskId = conversation?.taskId
    let task = directTaskId ? context.tasks.find((each) => each.id === directTaskId) : undefined
    if (!conversation && !terminal?.conversationId && port.cwd) {
      const worktrees = context.tasks.filter((each) => each.repos.some((repo) => repo.worktreePath && inside(cwd, repo.worktreePath)))
      if (worktrees.length === 1) {
        task = worktrees[0]
        conversation = context.conversations.find((each) => each.id === task?.conversationId)
      } else {
        const shared = context.conversations.filter((each) => !each.taskId && inside(cwd, each.workspacePath))
        if (shared.length === 1) conversation = shared[0]
      }
    }
    return [{ ...port, terminalId: terminal?.id ?? null, conversationId: conversation?.id ?? terminal?.conversationId ?? null, taskId: task?.id ?? conversation?.taskId ?? null, cwd, label: null }]
  })
}

async function labels(folder: string): Promise<Map<number, string>> {
  try {
    const file = path.join(folder, '.kando', 'ports.json')
    if ((await stat(file)).size > 64 * 1024) return new Map()
    const parsed = PortLabels.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return new Map(parsed.success ? parsed.data.ports.map((each) => [each.port, each.label]) : [])
  } catch {
    return new Map()
  }
}

export class PortService {
  private pending: Promise<PortList> | null = null

  constructor(private readonly daemon: SessionHost, private readonly context: () => PortContext) {}

  list(): Promise<PortList> {
    if (this.pending) return this.pending
    this.pending = this.discover().finally(() => { this.pending = null })
    return this.pending
  }

  private async discover(): Promise<PortList> {
    try {
      const context = this.context()
      const ports = ownedPorts(await this.daemon.request('portsList', {}), context)
      const folderOf = (port: ListeningPort) => {
        const task = context.tasks.find((each) => each.id === port.taskId)
        const conversation = context.conversations.find((each) => each.id === port.conversationId)
        const roots = [...(task?.repos.flatMap((repo) => repo.worktreePath ? [repo.worktreePath] : []) ?? []), ...(conversation?.projectPaths ?? [])]
          .filter((root) => inside(port.cwd, root)).sort((a, b) => b.length - a.length)
        return roots[0] ?? port.cwd
      }
      const folders = [...new Set(ports.map(folderOf))]
      const byFolder = new Map(await Promise.all(folders.map(async (folder) => [folder, await labels(folder)] as const)))
      return { ports: ports.map((port) => ({ ...port, label: byFolder.get(folderOf(port))?.get(port.port) ?? null })), problem: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ports: [], problem: message === 'unknown-method' ? '当前 daemon 不支持端口管理，请重启 Kando daemon。' : `无法读取监听端口：${message}` }
    }
  }

  async stop(ref: PortRef): Promise<void> {
    const port = ownedPorts(await this.daemon.request('portsList', {}), this.context()).find((each) => each.sessionId === ref.sessionId && each.pid === ref.pid && each.startedAt === ref.startedAt && each.port === ref.port && each.address === ref.address)
    if (!port) throw new Rejection('port-process-changed', '服务已经结束或端口归属发生变化，请刷新后重试。')
    await this.daemon.request('portsStop', ref)
  }
}
