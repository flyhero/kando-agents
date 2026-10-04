import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { PROTOCOL_VERSION, type ChatItem } from '@kando/protocol'
import packageJson from '../package.json' with { type: 'json' }
import { removeCoreEndpoint, kandoPaths, writeCoreEndpoint } from '@kando/protocol/node'
import { hasClaudeCredentials, readClaudeUsage } from './claude-usage'
import { hasCodexCredentials, readCodexUsage } from './codex-usage'
import { EnvironmentService } from './environment-check'
import { AgentRunStore } from './agent-run-store'
import { ChatTurnStore } from './chat-turn-store'
import { AttachmentStore } from './attachment-store'
import { AttachmentUploads } from './attachment-uploads'
import { browserHostCommand } from './browser-host-command'
import { BrowserService, WATCH_ALL } from './browser-service'
import { CredentialStore } from './credential-store'
import { DaemonClient } from './daemon-client'
import { githubProvider } from './github-provider'
import { jiraProvider } from './jira-provider'
import { createRpcHandlers } from './rpc-handlers'
import { startRpcServer, type RpcServer } from './rpc-server'
import { TaskService } from './task-service'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'
import { UsageLimitResumes } from './usage-limit-resume'
import { ScheduleService } from './schedule-service'
import { RoutineService } from './routine-service'
import { UsageService } from './usage-service'
import { kandoChatMcpServer } from './kando-mcp-server'
import { SourceConfigStore } from './source-config'
import { LoginFlows } from './source-login-flow'
import { migrateLegacyJira } from './source-migration'
import { SourceService } from './source-service'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import { TerminalCommandStore } from './terminal-commands'
import { ChatCommandStore } from './chat-commands'
import { TerminalService } from './terminal-service'
import { WorktreeService } from './worktree-service'
import { AwakeConfigStore } from './awake-config'
import { ComputerAwakeService } from './computer-awake-service'
import { ChatSettingsStore } from './chat-settings'

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
const runs = new AgentRunStore(paths.database)
// Reads its turns from the conversations, which are built below; nothing is read until they run.
const turns = new ChatTurnStore(paths.database, {
  facts: (id, stageId) => conversations.stageFacts(id, stageId),
  stages: () => conversations.chatStageRefs(),
  items: (id, stageId) => conversations.stageChatItems(id, stageId)
})
const attachments = new AttachmentStore(paths.attachments)
let server: RpcServer | null = null
let awake: ComputerAwakeService | null = null
const refreshAwake = () => awake?.refresh(conversations.workingCount(), schedules.openCount())

const notifyChatItems = (conversationId: string, items: ChatItem[]) =>
  [...(server?.connections ?? [])].filter((c) => c.watching.has(conversationId)).forEach((c) => c.notify('conversations.chatItems', { conversationId, items }))

// Built before the task service, which runs its chat tasks in it; each hands the other its events.
const conversations = new ConversationService(
  conversationsStore, daemon, paths.sessions,
  (event) => {
    const watchers = (id: string) => [...(server?.connections ?? [])].filter((c) => c.watching.has(id))
    if (event.type === 'changed') {
      server?.broadcast('conversations.changed', { conversation: event.conversation })
      // A task's conversation says whether its agent waits on the user.
      service.chatChanged(event.conversation)
      schedules.conversationChanged(event.conversation)
      routines.conversationChanged(event.conversation)
      refreshAwake()
    } else if (event.type === 'deleted') {
      server?.broadcast('conversations.deleted', { id: event.id })
      schedules.conversationDeleted(event.id)
      void browser.closeForConversation(event.id)
    }
    else if (event.type === 'chatItems') {
      limits.observe(event.conversationId, event.items)
      turns.observe(event.conversationId, event.items)
      routines.observe(event.conversationId, event.items)
      notifyChatItems(event.conversationId, limits.decorate(event.items))
    } else if (event.type === 'planApproved') {
      service.recordPlan(event.taskId, event.plan)
    } else if (event.type === 'usage') {
      usage.report(event.agent, event.report)
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
  paths.worktrees,
  (event) => {
    if (event.type === 'changed') {
      server?.broadcast('tasks.changed', { task: event.task })
      schedules.taskChanged(event.task)
      refreshAwake()
    } else {
      server?.broadcast('tasks.deleted', { id: event.id })
      schedules.taskDeleted(event.id)
      sources.tasksChanged()
    }
  },
  attachments,
  conversations,
  runs
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

const schedules = new ScheduleService(paths.database, {
  tasks: {
    get: (id) => store.get(id),
    scheduleBlocker: (id) => service.scheduleBlocker(id),
    start: (id, allowBypass, unattended) => service.start(id, allowBypass, unattended),
    resumeChat: (id, allowBypass) => service.resumeChat(id, allowBypass)
  },
  conversations,
  usage,
  mode: () => chatSettings.current().unattendedMode,
  emit: (runs) => {
    server?.broadcast('schedules.changed', { runs })
    refreshAwake()
  },
  limitChanged: (conversationId, limit) => limits.announce(conversationId, limit),
  routines: {
    pass: () => routines.pass(),
    get: (id) => routines.get(id),
    pickAgent: (routine) => routines.pickAgent(routine),
    runChanged: (run) => routines.runChanged(run)
  }
})
// Speaks for the scheduler on the usage-limit cards; built after it, called only once runs change.
const limits = new UsageLimitResumes(schedules, conversations, usage, notifyChatItems)
// Makes the scheduler's runs for what comes due; built after it, called only from its passes.
const routines = new RoutineService(paths.database, {
  schedules,
  conversations,
  usage,
  emit: (list) => server?.broadcast('routines.changed', { routines: list })
})

const terminals = new TerminalService(paths.database, daemon, (list) => server?.broadcast('terminals.changed', { terminals: list }))
const terminalCommands = new TerminalCommandStore(paths.database, (commands) => server?.broadcast('terminalCommands.changed', { commands }))
const chatCommands = new ChatCommandStore(paths.database, (commands) => server?.broadcast('chatCommands.changed', { commands }))
const worktrees = new WorktreeService(paths.worktrees, service, () => server?.broadcast('worktrees.changed', {}))
awake = new ComputerAwakeService(daemon, new AwakeConfigStore(paths.awakeConfig), (status) =>
  server?.broadcast('system.awakeChanged', { status })
)
const chatSettings = new ChatSettingsStore(paths.chatSettings, (settings) => {
  conversations.setPromptSuggestions(settings.promptSuggestions)
  server?.broadcast('system.chatSettingsChanged', { settings })
})
// Before the daemon connects: a chat stage it still runs is taken back with these settings.
conversations.setPromptSuggestions((await chatSettings.load()).promptSuggestions)

daemon.onEvent((event) => {
  const { sessionId } = event
  const attached = [...(server?.connections ?? [])].filter((c) => c.attached.has(sessionId))
  if (event.event === 'data') {
    conversations.handleData(event)
    browser.handleData(event)
    attached.forEach((c) => c.notify('sessions.data', { sessionId, data: event.data, offset: event.offset }))
  } else if (event.event === 'exit') {
    attached.forEach((c) => c.notify('sessions.exit', { sessionId, exitCode: event.exitCode }))
    conversations.handleExit(sessionId, event.exitCode)
    terminals.handleExit(sessionId, event.exitCode)
    browser.handleExit(sessionId)
    // An agent that ended is when the numbers most likely moved.
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
      await conversations.reconcile(sessions)
      terminals.reconcile(sessions)
      await browser.reconcile(sessions)
      // What came due while core or the daemon was away goes now, not at the next tick.
      await schedules.tick()
    })
    .catch((error) => console.error('[kando-core] reconcile failed', error))
})

// Looked for where the daemon looks: it was started with the same PATH as core.
const environment = new EnvironmentService({
  pathEnv: process.env.PATH ?? '',
  platform: process.platform,
  signedIn: { claude: hasClaudeCredentials, codex: hasCodexCredentials }
})

const token = randomBytes(32).toString('hex')
server = await startRpcServer({
  port: Number(process.env.KANDO_PORT ?? 0),
  token,
  handlers: createRpcHandlers(service, conversations, projects, daemon, usage, sources, {
    store: attachments,
    uploads: new AttachmentUploads(attachments)
  }, terminals, worktrees, browser, awake, terminalCommands, limits, runs, turns, chatSettings, environment, schedules, chatCommands, routines)
})
await writeCoreEndpoint({ port: server.port, token, pid: process.pid, protocolVersion: PROTOCOL_VERSION, version: packageJson.version })
daemon.start()
await awake.start()
refreshAwake()
usage.start()
routines.start()
schedules.start()
refreshAwake()
// Stages that ended before turns were kept, counted once in the background.
void turns.catchUp().catch((error: unknown) => console.error('[kando-core] counting earlier chat turns failed:', error))
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
  schedules.stop()
  routines.stop()
  sources.stop()
  awake?.stop()
  daemon.stop()
  await server?.close()
  await removeCoreEndpoint(process.pid)
  store.close()
  conversationsStore.close()
  runs.close()
  turns.close()
  projects.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
