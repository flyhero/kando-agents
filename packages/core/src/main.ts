import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { PROTOCOL_VERSION } from '@kando/protocol'
import packageJson from '../package.json' with { type: 'json' }
import { removeCoreEndpoint, kandoPaths, writeCoreEndpoint } from '@kando/protocol/node'
import { readClaudeUsage } from './claude-usage'
import { readCodexUsage } from './codex-usage'
import { AttachmentStore } from './attachment-store'
import { AttachmentUploads } from './attachment-uploads'
import { browserHostCommand } from './browser-host-command'
import { BrowserService, WATCH_ALL } from './browser-service'
import { cliCommand } from './cli-command'
import { CredentialStore } from './credential-store'
import { DaemonClient } from './daemon-client'
import { githubProvider } from './github-provider'
import { jiraProvider } from './jira-provider'
import { createRpcHandlers } from './rpc-handlers'
import { startRpcServer, type RpcServer } from './rpc-server'
import { TaskService } from './task-service'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'
import { UsageService } from './usage-service'
import { kandoChatMcpServer, kandoMcpServer } from './kando-mcp-server'
import { SourceConfigStore } from './source-config'
import { LoginFlows } from './source-login-flow'
import { migrateLegacyJira } from './source-migration'
import { SourceService } from './source-service'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import { TerminalCommandStore } from './terminal-commands'
import { TerminalService } from './terminal-service'
import { WorktreeService } from './worktree-service'
import { AwakeConfigStore } from './awake-config'
import { ComputerAwakeService } from './computer-awake-service'

const paths = kandoPaths()
await mkdir(paths.home, { recursive: true, mode: 0o700 })
await mkdir(paths.worktrees, { recursive: true })
await mkdir(paths.attachments, { recursive: true, mode: 0o700 })
await mkdir(paths.sessions, { recursive: true, mode: 0o700 })
await mkdir(paths.browser, { recursive: true, mode: 0o700 })

// TaskStore first: its migrations create every table the other stores read.
const store = new TaskStore(paths.database)
const projects = new ProjectRegistry(paths.database)
const daemon = new DaemonClient(paths.daemonSocket)
const conversationsStore = new ConversationStore(paths.database)
const attachments = new AttachmentStore(paths.attachments)
let server: RpcServer | null = null
let awake: ComputerAwakeService | null = null
const refreshAwake = () => awake?.refresh(service.workingCount() + conversations.workingCount())

// Built before the task service, which runs its chat tasks in it; each hands the other its events.
const conversations = new ConversationService(
  conversationsStore, daemon, paths.sessions,
  (id, stageId, agent) => cliCommand('conversation-event', paths.home, id, stageId, agent),
  (event) => {
    const watchers = (id: string) => [...(server?.connections ?? [])].filter((c) => c.watching.has(id))
    if (event.type === 'changed') {
      server?.broadcast('conversations.changed', { conversation: event.conversation })
      // A task's conversation says whether its agent waits on the user.
      service.chatChanged(event.conversation)
      refreshAwake()
    } else if (event.type === 'deleted') {
      server?.broadcast('conversations.deleted', { id: event.id })
      void browser.closeForConversation(event.id)
    }
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
  attachments,
  (id) => kandoChatMcpServer(paths.home, id)
)

const browser = new BrowserService(
  daemon,
  paths,
  () => browserHostCommand(paths.home),
  attachments,
  (id, host, url) => conversations.askHost(id, host, url),
  (event) => {
    if (event.type === 'status') server?.broadcast('browser.changed', { status: event.status })
    else {
      const { conversationId, tabs } = event
      ;[...(server?.connections ?? [])]
        .filter((c) => c.browsing.has(WATCH_ALL) || (conversationId !== null && c.browsing.has(conversationId)))
        .forEach((c) => c.notify('browser.tabsChanged', { conversationId, tabs }))
    }
  }
)

const service = new TaskService(
  store,
  projects,
  daemon,
  paths.worktrees,
  (event) => {
    if (event.type === 'changed') {
      server?.broadcast('tasks.changed', { task: event.task })
      refreshAwake()
    } else {
      server?.broadcast('tasks.deleted', { id: event.id })
      sources.tasksChanged()
    }
  },
  (taskId) => kandoMcpServer(taskId, paths.home),
  attachments,
  (taskId, session, agent) => cliCommand('task-event', paths.home, taskId, session, agent),
  conversations
)

const sourceConfig = new SourceConfigStore(paths.sourcesConfig)
const credentials = new CredentialStore(paths.credentials)
await sourceConfig.load()
await credentials.load()
await migrateLegacyJira(paths.legacyJiraConfig, sourceConfig, credentials).catch((error: unknown) =>
  console.error('[kando-core] migrating jira.json failed; it stays in place:', error)
)
const sources = new SourceService([jiraProvider(), githubProvider()], sourceConfig, credentials, new LoginFlows(), service, store, attachments, {
  inboxChanged: (inbox) => server?.broadcast('sources.inboxChanged', { inbox }),
  listChanged: (list) => server?.broadcast('sources.listChanged', { sources: list })
})

const usage = new UsageService({ claude: readClaudeUsage, codex: readCodexUsage }, (entry) =>
  server?.broadcast('usage.changed', { usage: entry })
)

const terminals = new TerminalService(paths.database, daemon, (list) => server?.broadcast('terminals.changed', { terminals: list }))
const terminalCommands = new TerminalCommandStore(paths.database, (commands) => server?.broadcast('terminalCommands.changed', { commands }))
const worktrees = new WorktreeService(paths.worktrees, service, () => server?.broadcast('worktrees.changed', {}))
awake = new ComputerAwakeService(daemon, new AwakeConfigStore(paths.awakeConfig), (status) =>
  server?.broadcast('system.awakeChanged', { status })
)

daemon.onEvent((event) => {
  const { sessionId } = event
  const attached = [...(server?.connections ?? [])].filter((c) => c.attached.has(sessionId))
  if (event.event === 'data') {
    conversations.handleData(event)
    browser.handleData(event)
    attached.forEach((c) => c.notify('sessions.data', { sessionId, data: event.data, offset: event.offset }))
  } else if (event.event === 'exit') {
    attached.forEach((c) => c.notify('sessions.exit', { sessionId, exitCode: event.exitCode }))
    service.handleSessionExit(sessionId, event.exitCode)
    conversations.handleExit(sessionId, event.exitCode)
    terminals.handleExit(sessionId)
    browser.handleExit(sessionId)
    // A finished run is when the numbers most likely moved.
    void usage.refresh()
    refreshAwake()
  } else {
    conversations.handleStderr(sessionId, event.data)
  }
})

daemon.onConnect(() => {
  awake?.reconnect()
  daemon
    .request('list', {})
    .then(async ({ sessions }) => {
      service.reconcile(sessions)
      await conversations.reconcile(sessions)
      terminals.reconcile(sessions)
      await browser.reconcile(sessions)
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
  }, terminals, worktrees, browser, awake, terminalCommands)
})
await writeCoreEndpoint({ port: server.port, token, pid: process.pid, protocolVersion: PROTOCOL_VERSION, version: packageJson.version })
daemon.start()
await awake.start()
refreshAwake()
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
  awake?.stop()
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
