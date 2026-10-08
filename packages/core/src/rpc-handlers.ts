import { BROWSER_VIEWPORT, CORE_FEATURES, PROTOCOL_VERSION, type ChatItem } from '@kando/protocol'
import packageJson from '../package.json' with { type: 'json' }
import type { AgentRunStore } from './agent-run-store'
import type { ChatTurnStore } from './chat-turn-store'
import type { AttachmentStore } from './attachment-store'
import type { AttachmentUploads } from './attachment-uploads'
import type { BrowserService } from './browser-service'
import type { SessionHost } from './daemon-client'
import { findFiles, searchFiles } from './file-search'
import { ConversationFiles } from './conversation-files'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import type { SourceService } from './source-service'
import type { RpcHandlers } from './rpc-server'
import type { TaskService } from './task-service'
import type { UsageLimitResumes } from './usage-limit-resume'
import type { UsageService } from './usage-service'
import type { ConversationService } from './conversation-service'
import type { TerminalCommandStore } from './terminal-commands'
import type { ChatCommandStore } from './chat-commands'
import type { TerminalService } from './terminal-service'
import type { WorktreeService } from './worktree-service'
import type { ComputerAwakeService } from './computer-awake-service'
import type { ChatSettingsStore } from './chat-settings'
import type { EnvironmentService } from './environment-check'
import type { ScheduleService } from './schedule-service'
import type { RoutineService } from './routine-service'
import { AgentTerminals } from './agent-terminals'
import { dashboardSince, summarizeDashboard } from './dashboard-stats'
import { PortService } from './port-service'
import type { WireLog } from './wire-log'

const OK = { ok: true } as const

export function createRpcHandlers(
  service: TaskService,
  conversations: ConversationService,
  projects: ProjectRegistry,
  sessions: SessionHost,
  usage: UsageService,
  sources: SourceService,
  attachments: { store: AttachmentStore; uploads: AttachmentUploads },
  terminals: TerminalService,
  worktrees: WorktreeService,
  browser: BrowserService,
  awake: ComputerAwakeService,
  terminalCommands: TerminalCommandStore,
  limits: UsageLimitResumes,
  runs: AgentRunStore,
  turns: ChatTurnStore,
  chatSettings: ChatSettingsStore,
  environment: EnvironmentService,
  schedules: ScheduleService,
  chatCommands: ChatCommandStore,
  routines: RoutineService,
  wire: WireLog
): RpcHandlers {
  const files = new ConversationFiles((id) => conversations.get(id))
  const ports = new PortService(sessions, () => ({ terminals: terminals.list(), conversations: conversations.list(true), tasks: service.list() }))
  // An agent's own terminals: run in the conversation's folder unless it names another, and
  // asked about in the chat where the agent asks nothing for MCP tools.
  const agentTerminals = new AgentTerminals(
    (id) => {
      const conversation = conversations.get(id)
      return { agent: conversation.agent, cwd: conversation.workspacePath }
    },
    (id, cwd, command) => terminals.run(id, cwd, command),
    (id, command, cwd) => conversations.askTerminal(id, command, cwd)
  )
  // A page of chat items as clients see them: a usage limit with what core means to do about it.
  const page = (result: { items: ChatItem[]; before: string | null }) => ({ ...result, items: limits.decorate(result.items) })
  // The user going on with a conversation themselves: core no longer continues it after a limit.
  const userActed = async <T>(id: string, act: () => Promise<T>): Promise<T> => {
    const since = limits.mark()
    const result = await act()
    limits.cancelFor(id, since)
    return result
  }
  return {
    'system.hello': () => ({ protocolVersion: PROTOCOL_VERSION, serverVersion: packageJson.version, features: [...CORE_FEATURES] }),
    'files.resolve': ({ conversationId, path }) => files.resolve(conversationId, path),
    'files.read': ({ conversationId, path }) => files.read(conversationId, path),
    'system.awakeStatus': () => awake.status(),
    'system.setAwakeMode': ({ mode }) => awake.setMode(mode),
    'system.chatSettings': () => chatSettings.current(),
    'system.setChatSettings': (patch) => chatSettings.update(patch),
    'debug.wire': ({ id, stageId, before }) => {
      const known = new Map(conversations.stages(id).map((stage) => [stage.id, stage]))
      const stages = wire.stages(id)
        .map((found) => {
          const stage = known.get(found.stageId)
          return {
            stageId: found.stageId,
            agent: stage?.agent ?? null,
            startedAt: stage?.startedAt ?? found.createdAt,
            endedAt: stage ? stage.endedAt : null,
            bytes: found.bytes,
            file: wire.file(id, found.stageId)
          }
        })
        .sort((a, b) => b.startedAt - a.startedAt)
      const shown = stages.find((stage) => stage.stageId === stageId) ?? stages[0]
      if (!shown) return { stages, stageId: null, entries: [], before: null }
      return { stages, stageId: shown.stageId, ...wire.page(id, shown.stageId, before) }
    },
    'debug.watchWire': ({ id }, connection) => {
      conversations.get(id)
      connection.wiring.add(id)
      return OK
    },
    'debug.unwatchWire': ({ id }, connection) => { connection.wiring.delete(id); return OK },
    'debug.wireUsage': () => wire.usage(),
    'debug.clearWire': () => wire.clear(),
    'system.environment': ({ refresh }) => environment.check(refresh ?? false),
    'tasks.list': ({ status }) => service.list(status),
    'tasks.get': ({ id }) => service.get(id),
    'tasks.create': (params) => service.createTask(params),
    'tasks.update': (params) => service.update(params),
    'tasks.startOptions': ({ id }) => service.startOptions(id),
    'tasks.move': ({ id, status }) => service.move(id, status),
    'tasks.redo': ({ id, reason }) => service.redo(id, reason),
    'tasks.start': ({ id, allowBypass }) => service.start(id, allowBypass),
    // Going on by hand in a task's chat is the user acting there, as in a free conversation.
    'tasks.resumeChat': ({ id, allowBypass }) => {
      const { conversationId } = service.get(id)
      return conversationId ? userActed(conversationId, () => service.resumeChat(id, allowBypass)) : service.resumeChat(id, allowBypass)
    },
    'tasks.submit': ({ id }) => service.submit(id),
    'tasks.savePlan': ({ id, stageId, requestId }) => service.savePlan(id, stageId, requestId),
    'tasks.delete': async ({ id }) => {
      await service.delete(id)
      return OK
    },
    'tasks.addImages': ({ id, images }) => service.addImages(id, images),
    'tasks.updateImage': ({ id, attachmentId, name }) => service.updateImage(id, attachmentId, name),
    'tasks.removeImage': ({ id, attachmentId }) => service.removeImage(id, attachmentId),
    'tasks.branches': ({ id }) => service.branches(id),
    'tasks.changes': ({ id }) => service.changes(id),
    'tasks.diff': ({ id, repo, file }) => service.diff(id, repo, file),
    'conversations.list': ({ includeTasks }) => conversations.list(includeTasks),
    'conversations.get': ({ id }) => conversations.get(id),
    'conversations.create': ({ agent, projectPaths, worktree, branch, allowBypass, permissionMode, model, effort }) =>
      conversations.create(agent, projectPaths, allowBypass, { permissionMode, model, effort, worktree, branch }),
    'conversations.chatCatalog': ({ agent }) => conversations.chatCatalog(agent),
    'conversations.setAdditionalProjects': ({ id, projectPaths }) => conversations.setAdditionalProjects(id, projectPaths),
    'conversations.rename': ({ id, title }) => conversations.rename(id, title),
    'conversations.setPinned': ({ id, pinned }) => conversations.setPinned(id, pinned),
    'conversations.continue': ({ id, allowBypass }) => userActed(id, () => conversations.continue(id, allowBypass)),
    'conversations.handoff': ({ id, agent, note, stopRunning, allowBypass }) => conversations.handoff(id, agent, note, stopRunning, allowBypass),
    'conversations.fork': ({ id, stageId, itemId }) => conversations.fork(id, stageId, itemId),
    'conversations.setOption': async ({ id, option, value }) => { await conversations.setOption(id, option, value); return OK },
    'conversations.send': ({ id, text, images, queue, steer }) => userActed(id, async () => { await conversations.send(id, text, images, queue, steer); return OK }),
    'conversations.cancelQueued': ({ id, ref }) => { conversations.cancelQueued(id, ref); return OK },
    'conversations.sendQueued': ({ id, ref, now }) => userActed(id, async () => { await conversations.sendQueued(id, ref, now); return OK }),
    'conversations.setUsageLimitAutoContinue': ({ id, stageId, itemId, autoContinue }) => {
      limits.setAutoContinue(id, stageId, itemId, autoContinue)
      return OK
    },
    'conversations.retryUsageLimit': async ({ id, stageId, itemId }) => { await limits.retry(id, stageId, itemId); return OK },
    'conversations.interrupt': async ({ id }) => { await conversations.interrupt(id); return OK },
    'conversations.respond': async ({ id, requestId, ...answer }) => { await conversations.respond(id, requestId, answer); return OK },
    // Read after subscribing, so an item that changes in between reaches the client either way.
    'conversations.watchChat': ({ id }, connection) => {
      connection.watching.add(id)
      return page(conversations.chatPage(id))
    },
    'conversations.unwatchChat': ({ id }, connection) => { connection.watching.delete(id); return OK },
    'conversations.chatItems': ({ id, before }) => page(conversations.chatPage(id, before)),
    'conversations.stop': ({ id }) => userActed(id, () => conversations.stop(id)),
    'conversations.delete': async ({ id }) => { await conversations.delete(id); return OK },
    'conversations.messages': ({ id }) => conversations.messages(id),
    'conversations.stages': ({ id }) => conversations.stages(id),
    'conversations.branches': ({ id }) => conversations.branches(id),
    'conversations.branchOptions': ({ id }) => conversations.branchOptions(id),
    'projects.branches': ({ path }) => conversations.projectBranchOptions(path),
    'conversations.switchBranch': ({ id, project, ref }) => conversations.switchBranch(id, project, ref),
    'conversations.createBranch': ({ id, project, name }) => conversations.createBranch(id, project, name),
    'conversations.commitPush': ({ id, project, message }) => conversations.commitPush(id, project, message),
    'conversations.commit': ({ id, project, message }) => conversations.commit(id, project, message),
    'conversations.push': ({ id, project }) => conversations.push(id, project),
    'conversations.search': ({ query }) => conversations.search(query),
    'conversations.changes': ({ id }) => conversations.changes(id),
    'conversations.diff': ({ id, project, file }) => conversations.diff(id, project, file),
    // The agent's side: its MCP server is launched for one conversation and names it here. The
    // token in core.json already grants everything, so this scopes correctness, not trust.
    'browser.tabs': ({ conversationId }) => browser.tabsOf(conversationId),
    'browser.open': ({ conversationId, url }) => browser.open(conversationId, url),
    'browser.navigate': ({ conversationId, tabId, to }) => browser.navigate(conversationId, tabId, to),
    'browser.snapshot': ({ conversationId, tabId }) => browser.snapshot(conversationId, tabId),
    'browser.screenshot': ({ conversationId, tabId, ...options }) => browser.screenshot(conversationId, tabId, options),
    'browser.click': ({ conversationId, tabId, ...params }) => browser.click(conversationId, tabId, params),
    'browser.type': ({ conversationId, tabId, ...params }) => browser.type(conversationId, tabId, params),
    'browser.press': ({ conversationId, tabId, ...params }) => browser.press(conversationId, tabId, params),
    'browser.hover': ({ conversationId, tabId, ...params }) => browser.hover(conversationId, tabId, params),
    'browser.scroll': ({ conversationId, tabId, ...params }) => browser.scroll(conversationId, tabId, params),
    'browser.select': ({ conversationId, tabId, ...params }) => browser.select(conversationId, tabId, params),
    'browser.wait': ({ conversationId, tabId, ...params }) => browser.wait(conversationId, tabId, params),
    'browser.console': ({ conversationId, tabId, sinceNavigation }) => browser.console(conversationId, tabId, sinceNavigation ?? false),
    'browser.close': async ({ conversationId, tabId }) => {
      await browser.close(conversationId, tabId)
      return OK
    },
    // The user's side.
    'browser.status': () => browser.status(),
    'browser.install': () => browser.install(),
    'browser.watch': ({ conversationId }, connection) => browser.watch(connection, conversationId),
    'browser.unwatch': async ({ conversationId }, connection) => {
      await browser.unwatch(connection, conversationId)
      return OK
    },
    'browser.watchAll': (_params, connection) => browser.watchAll(connection),
    'browser.unwatchAll': async (_params, connection) => {
      await browser.unwatchAll(connection)
      return OK
    },
    'browser.view.start': async ({ tabId, ...options }, connection) => {
      await browser.startView(connection, tabId, options)
      return { viewport: { ...BROWSER_VIEWPORT } }
    },
    'browser.view.stop': async ({ tabId }, connection) => {
      await browser.views.stop(connection, tabId)
      return OK
    },
    'browser.view.ack': ({ tabId, seq }, connection) => {
      browser.views.ack(connection, tabId, seq)
      return OK
    },
    'browser.input': async ({ tabId, event }, connection) => {
      await browser.input(connection, tabId, event)
      return OK
    },
    'browser.userNavigate': ({ tabId, to }, connection) => browser.userNavigate(connection, tabId, to),
    'browser.newTab': ({ conversationId, url }, connection) => browser.newTab(connection, conversationId ?? null, url),
    'browser.closeTab': async ({ tabId }, connection) => {
      await browser.closeTab(connection, tabId)
      return OK
    },
    'browser.handBack': ({ tabId }, connection) => {
      browser.handBack(connection, tabId)
      return OK
    },
    'browser.userScreenshot': ({ tabId }, connection) => browser.userScreenshot(connection, tabId),
    'attachments.begin': ({ size }, connection) => ({ uploadId: attachments.uploads.begin(connection, size) }),
    'attachments.append': ({ uploadId, offset, data }, connection) => {
      attachments.uploads.append(connection, uploadId, offset, data)
      return OK
    },
    'attachments.commit': ({ uploadId }, connection) => attachments.uploads.commit(connection, uploadId),
    'attachments.stat': async ({ id }) => {
      const info = await attachments.store.info(id)
      if (!info) {
        throw new Rejection('attachment-not-found', `no image ${id}`)
      }
      return info
    },
    'attachments.read': async ({ id, offset, length }) => ({
      data: Buffer.from(await attachments.store.read(id, offset, length)).toString('base64')
    }),
    'ports.list': () => ports.list(),
    'ports.stop': async (ref) => { await ports.stop(ref); return OK },
    'terminals.list': () => terminals.list(),
    'terminals.open': ({ cwd }) => terminals.open(cwd),
    'terminals.run': ({ conversationId, command, cwd }) => agentTerminals.run(conversationId, command, cwd),
    'terminals.read': ({ conversationId, id, tail }) => terminals.read(conversationId, id, tail),
    'terminals.stop': async ({ conversationId, id }) => {
      await terminals.stop(conversationId, id)
      return OK
    },
    'terminals.close': async ({ id }) => {
      await terminals.kill(id)
      return OK
    },
    'terminalCommands.list': () => terminalCommands.list(),
    'terminalCommands.save': (params) => terminalCommands.save(params),
    'terminalCommands.delete': ({ id }) => {
      terminalCommands.delete(id)
      return OK
    },
    'chatCommands.list': () => chatCommands.list(),
    'chatCommands.save': (params) => chatCommands.save(params),
    'chatCommands.delete': ({ id }) => {
      chatCommands.delete(id)
      return OK
    },
    'sessions.attach': async ({ sessionId, fromOffset }, connection) => {
      connection.attached.add(sessionId)
      try {
        const { buffer, bufferStart, endOffset, exited, io } = await sessions.request('attach', { sessionId })
        // An agent's output is JSON for core, not a terminal to draw; keystrokes would reach its stdin.
        if (io === 'pipe') throw new Rejection('chat-session', 'this session runs in chat mode')
        const start = Math.max(bufferStart, Math.min(fromOffset ?? bufferStart, endOffset))
        return { buffer: buffer.slice(start - bufferStart), bufferStart: start, endOffset, exited }
      } catch (error) {
        connection.attached.delete(sessionId)
        throw error
      }
    },
    'sessions.detach': ({ sessionId }, connection) => {
      connection.attached.delete(sessionId)
      return OK
    },
    // Keystrokes go to the terminal panel's shells only: anything else the daemon runs is an agent
    // or the browser, reading JSON on its stdin.
    'sessions.write': async ({ sessionId, data }) => {
      if (!terminals.owns(sessionId)) throw new Rejection('chat-session', 'this session runs in chat mode')
      await sessions.request('write', { sessionId, data })
      return OK
    },
    'sessions.resize': async ({ sessionId, cols, rows }) => {
      if (!terminals.owns(sessionId)) return OK
      await sessions.request('resize', { sessionId, cols, rows })
      return OK
    },
    'projects.recent': () => projects.recent(),
    'worktrees.list': () => worktrees.list(),
    'worktrees.clean': ({ paths }) => worktrees.clean(paths),
    'projects.findFile': ({ roots, path }) => findFiles(roots, path),
    'projects.searchFiles': ({ roots, query }) => searchFiles(roots, query),
    'projects.forget': ({ path }) => {
      projects.forget(path)
      return OK
    },
    'repos.recent': () => projects.recent(),
    'repos.forget': ({ path }) => {
      projects.forget(path)
      return OK
    },
    'usage.list': () => usage.list(),
    'usage.refresh': () => usage.refresh(),
    'agents.stats': () => runs.stats(),
    'agents.conversationStats': () => turns.stats(),
    'dashboard.stats': (params) => {
      const options = { ...params, now: Date.now() }
      const since = dashboardSince(options)
      return summarizeDashboard(runs.endedSince(since), turns.endedSince(since), options)
    },
    'schedules.list': () => schedules.list(),
    'schedules.create': ({ target, notBefore }) => schedules.create(target, notBefore),
    'schedules.update': ({ id, notBefore, text }) => schedules.update(id, { notBefore, text }),
    'schedules.reorder': ({ ids }) => { schedules.reorder(ids); return OK },
    'schedules.cancel': ({ id }) => schedules.cancel(id),
    'schedules.runNow': ({ id }) => schedules.runNow(id),
    'schedules.clear': () => { schedules.clear(); return OK },
    'routines.list': () => routines.list(),
    'routines.create': (fields) => routines.create(fields),
    'routines.update': ({ id, ...patch }) => routines.update(id, patch),
    'routines.delete': ({ id }) => { routines.delete(id); return OK },
    'routines.runNow': ({ id }) => routines.runNow(id),
    'routines.runs': ({ routineId, before, limit }) => routines.runs(routineId, before ?? null, limit),
    'routines.markSeen': ({ runId }) => { routines.markSeen(runId); return OK },
    'routines.markAllSeen': ({ routineId }) => { routines.markAllSeen(routineId); return OK },
    'sources.list': () => sources.list(),
    'sources.saveSettings': (params) => sources.saveSettings(params),
    'sources.login': ({ provider, instance, flowId }, connection) => ({
      flowId: sources.login(connection, provider, instance, flowId)
    }),
    'sources.answer': ({ flowId, promptId, value }, connection) => {
      sources.answer(connection, flowId, promptId, value)
      return OK
    },
    'sources.cancelLogin': ({ flowId }, connection) => {
      sources.cancelLogin(connection, flowId)
      return OK
    },
    'sources.disconnect': async ({ provider, instance }) => {
      await sources.disconnect(provider, instance)
      return OK
    },
    'sources.inbox': () => sources.inboxes(),
    'sources.refresh': ({ provider, instance }) => sources.refresh(provider, instance),
    'sources.import': ({ provider, instance, key, agent }) => sources.import(provider, instance, key, agent ?? null),
    'sources.dismiss': ({ provider, instance, key }) => sources.dismiss(provider, instance, key),
    'sources.restore': ({ provider, instance, key }) => sources.restore(provider, instance, key),
    'sources.resync': ({ taskId }) => sources.resync(taskId)
  }
}
