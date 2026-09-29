import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@kando/protocol'
import { removeCoreEndpoint, kandoPaths, writeCoreEndpoint } from '@kando/protocol/node'
import { readClaudeUsage } from './claude-usage'
import { readCodexUsage } from './codex-usage'
import { AttachmentStore } from './attachment-store'
import { AttachmentUploads } from './attachment-uploads'
import { CredentialStore } from './credential-store'
import { DaemonClient } from './daemon-client'
import { jiraProvider } from './jira-provider'
import { createRpcHandlers } from './rpc-handlers'
import { startRpcServer, type RpcServer } from './rpc-server'
import { TaskService } from './task-service'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'
import { UsageService } from './usage-service'
import { kandoMcpServer } from './kando-mcp-server'
import { SourceConfigStore } from './source-config'
import { LoginFlows } from './source-login-flow'
import { migrateLegacyJira } from './source-migration'
import { SourceService } from './source-service'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import { TerminalService } from './terminal-service'
import { WorktreeService } from './worktree-service'

const paths = kandoPaths()
await mkdir(paths.home, { recursive: true, mode: 0o700 })
await mkdir(paths.worktrees, { recursive: true })
await mkdir(paths.attachments, { recursive: true, mode: 0o700 })
await mkdir(paths.sessions, { recursive: true, mode: 0o700 })

// TaskStore first: its migrations create every table the other stores read.
const store = new TaskStore(paths.database)
const projects = new ProjectRegistry(paths.database)
const daemon = new DaemonClient(paths.daemonSocket)
const conversationsStore = new ConversationStore(paths.database)
const attachments = new AttachmentStore(paths.attachments)
let server: RpcServer | null = null

const tsxLoader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
const cli = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
// Built before the task service, which runs its chat tasks in it; each hands the other its events.
const conversations = new ConversationService(
  conversationsStore, daemon, paths.sessions,
  (id, stageId, agent) => [process.execPath, '--import', tsxLoader, cli, 'conversation-event', paths.home, id, stageId, agent],
  (event) => {
    const watchers = (id: string) => [...(server?.connections ?? [])].filter((c) => c.watching.has(id))
    if (event.type === 'changed') {
      server?.broadcast('conversations.changed', { conversation: event.conversation })
      // A task's conversation says whether its agent waits on the user.
      service.chatChanged(event.conversation)
    } else if (event.type === 'deleted') server?.broadcast('conversations.deleted', { id: event.id })
    else if (event.type === 'chatItems') {
      watchers(event.conversationId).forEach((c) => c.notify('conversations.chatItems', { conversationId: event.conversationId, items: event.items }))
    } else if (event.type === 'planApproved') {
      service.recordPlan(event.taskId, event.plan)
    } else {
      const { conversationId, stageId, itemId, append } = event
      watchers(conversationId).forEach((c) => c.notify('conversations.chatDelta', { conversationId, stageId, itemId, append }))
    }
  },
  projects,
  attachments
)

const service = new TaskService(
  store,
  projects,
  daemon,
  paths.worktrees,
  (event) => {
    if (event.type === 'changed') {
      server?.broadcast('tasks.changed', { task: event.task })
    } else {
      server?.broadcast('tasks.deleted', { id: event.id })
      sources.tasksChanged()
    }
  },
  (taskId) => kandoMcpServer(taskId, paths.home),
  attachments,
  (taskId, session, agent) => [process.execPath, '--import', tsxLoader, cli, 'task-event', paths.home, taskId, session, agent],
  conversations
)

const sourceConfig = new SourceConfigStore(paths.sourcesConfig)
const credentials = new CredentialStore(paths.credentials)
await sourceConfig.load()
await credentials.load()
await migrateLegacyJira(paths.legacyJiraConfig, sourceConfig, credentials).catch((error: unknown) =>
  console.error('[kando-core] migrating jira.json failed; it stays in place:', error)
)
const sources = new SourceService([jiraProvider()], sourceConfig, credentials, new LoginFlows(), service, store, attachments, {
  inboxChanged: (inbox) => server?.broadcast('sources.inboxChanged', { inbox }),
  listChanged: (list) => server?.broadcast('sources.listChanged', { sources: list })
})

const usage = new UsageService({ claude: readClaudeUsage, codex: readCodexUsage }, (entry) =>
  server?.broadcast('usage.changed', { usage: entry })
)

const terminals = new TerminalService(paths.database, daemon, (list) => server?.broadcast('terminals.changed', { terminals: list }))
const worktrees = new WorktreeService(paths.worktrees, service, () => server?.broadcast('worktrees.changed', {}))

daemon.onEvent((event) => {
  const { sessionId } = event
  const attached = [...(server?.connections ?? [])].filter((c) => c.attached.has(sessionId))
  if (event.event === 'data') {
    conversations.handleData(event)
    attached.forEach((c) => c.notify('sessions.data', { sessionId, data: event.data, offset: event.offset }))
  } else if (event.event === 'exit') {
    attached.forEach((c) => c.notify('sessions.exit', { sessionId, exitCode: event.exitCode }))
    service.handleSessionExit(sessionId, event.exitCode)
    conversations.handleExit(sessionId, event.exitCode)
    terminals.handleExit(sessionId)
    // A finished run is when the numbers most likely moved.
    void usage.refresh()
  } else {
    conversations.handleStderr(sessionId, event.data)
  }
})

daemon.onConnect(() => {
  daemon
    .request('list', {})
    .then(async ({ sessions }) => {
      service.reconcile(sessions)
      await conversations.reconcile(sessions)
      terminals.reconcile(sessions)
    })
    .catch((error) => console.error('[kando-core] reconcile failed', error))
})

const token = randomBytes(32).toString('hex')
server = await startRpcServer({
  port: Number(process.env.KANDO_PORT ?? 0),
  token,
  handlers: createRpcHandlers(service, conversations, projects, daemon, usage, sources, {
    store: attachments,
    uploads: new AttachmentUploads(attachments)
  }, terminals, worktrees)
})
await writeCoreEndpoint({ port: server.port, token, pid: process.pid, protocolVersion: PROTOCOL_VERSION })
daemon.start()
usage.start()
sources.start()
// Idle chat agents are checked for once a minute, so one goes within a minute of its limit.
setInterval(() => void conversations.releaseIdle(), 60_000).unref()
console.log(`[kando-core] listening on 127.0.0.1:${server.port} (home ${paths.home})`)

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  usage.stop()
  sources.stop()
  daemon.stop()
  await server?.close()
  await removeCoreEndpoint(process.pid)
  store.close()
  conversationsStore.close()
  projects.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
