import { BROWSER_VIEWPORT, CORE_FEATURES, PROTOCOL_VERSION } from '@kando/protocol'
import packageJson from '../package.json' with { type: 'json' }
import type { AttachmentStore } from './attachment-store'
import type { AttachmentUploads } from './attachment-uploads'
import type { BrowserService } from './browser-service'
import type { SessionHost } from './daemon-client'
import { findFiles } from './file-search'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import type { SourceService } from './source-service'
import type { RpcHandlers } from './rpc-server'
import type { TaskService } from './task-service'
import type { UsageService } from './usage-service'
import type { ConversationService } from './conversation-service'
import type { TerminalService } from './terminal-service'
import type { WorktreeService } from './worktree-service'
import type { ComputerAwakeService } from './computer-awake-service'

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
  awake: ComputerAwakeService
): RpcHandlers {
  return {
    'system.hello': () => ({ protocolVersion: PROTOCOL_VERSION, serverVersion: packageJson.version, features: [...CORE_FEATURES] }),
    'system.awakeStatus': () => awake.status(),
    'system.setAwakeMode': ({ mode }) => awake.setMode(mode),
    'tasks.list': ({ status }) => service.list(status),
    'tasks.get': ({ id }) => service.get(id),
    'tasks.create': (params) => service.createTask(params),
    'tasks.update': (params) => service.update(params),
    'tasks.startOptions': ({ id }) => service.startOptions(id),
    'tasks.move': ({ id, status }) => service.move(id, status),
    'tasks.run': ({ id }) => service.run(id),
    'tasks.continue': ({ id, note }) => service.continue(id, note),
    'tasks.redo': ({ id, reason }) => service.redo(id, reason),
    'tasks.refine': ({ id }) => service.refine(id),
    'tasks.start': ({ id, allowBypass }) => service.start(id, allowBypass),
    'tasks.resumeChat': ({ id, allowBypass }) => service.resumeChat(id, allowBypass),
    'tasks.submit': ({ id }) => service.submit(id),
    'tasks.savePlan': ({ id, stageId, requestId }) => service.savePlan(id, stageId, requestId),
    'tasks.event': ({ id, session, waiting }) => {
      service.agentEvent(id, session, waiting)
      return OK
    },
    'tasks.propose': ({ id, markdown }) => service.propose(id, markdown),
    'tasks.resolveProposal': ({ id, action }) => service.resolveProposal(id, action),
    'tasks.restoreDetails': ({ id }) => service.restoreDetails(id),
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
    'conversations.list': () => conversations.list(),
    'conversations.get': ({ id }) => conversations.get(id),
    'conversations.create': ({ agent, projectPaths, mode, allowBypass, permissionMode, model, effort }) =>
      conversations.create(agent, projectPaths, mode, allowBypass, { permissionMode, model, effort }),
    'conversations.chatCatalog': ({ agent }) => conversations.chatCatalog(agent),
    'conversations.setAdditionalProjects': ({ id, projectPaths }) => conversations.setAdditionalProjects(id, projectPaths),
    'conversations.rename': ({ id, title }) => conversations.rename(id, title),
    'conversations.continue': ({ id, mode, allowBypass }) => conversations.continue(id, mode, allowBypass),
    'conversations.handoff': ({ id, agent, note, stopRunning, mode, allowBypass }) => conversations.handoff(id, agent, note, stopRunning, mode, allowBypass),
    'conversations.setOption': async ({ id, option, value }) => { await conversations.setOption(id, option, value); return OK },
    'conversations.send': async ({ id, text, images, queue, steer }) => { await conversations.send(id, text, images, queue, steer); return OK },
    'conversations.cancelQueued': ({ id, ref }) => { conversations.cancelQueued(id, ref); return OK },
    'conversations.sendQueued': async ({ id, ref, now }) => { await conversations.sendQueued(id, ref, now); return OK },
    'conversations.interrupt': async ({ id }) => { await conversations.interrupt(id); return OK },
    'conversations.respond': async ({ id, requestId, ...answer }) => { await conversations.respond(id, requestId, answer); return OK },
    // Read after subscribing, so an item that changes in between reaches the client either way.
    'conversations.watchChat': ({ id }, connection) => {
      connection.watching.add(id)
      return conversations.chatPage(id)
    },
    'conversations.unwatchChat': ({ id }, connection) => { connection.watching.delete(id); return OK },
    'conversations.chatItems': ({ id, before }) => conversations.chatPage(id, before),
    'conversations.stop': ({ id }) => conversations.stop(id),
    'conversations.delete': async ({ id }) => { await conversations.delete(id); return OK },
    'conversations.history': ({ id, offset, length }) => conversations.history(id, offset, length),
    'conversations.messages': ({ id }) => conversations.messages(id),
    'conversations.stages': ({ id }) => conversations.stages(id),
    'conversations.branches': ({ id }) => conversations.branches(id),
    'conversations.branchOptions': ({ id }) => conversations.branchOptions(id),
    'conversations.switchBranch': ({ id, project, ref }) => conversations.switchBranch(id, project, ref),
    'conversations.createBranch': ({ id, project, name }) => conversations.createBranch(id, project, name),
    'conversations.commitPush': ({ id, project, message }) => conversations.commitPush(id, project, message),
    'conversations.search': ({ query }) => conversations.search(query),
    'conversations.changes': ({ id }) => conversations.changes(id),
    'conversations.diff': ({ id, project, file }) => conversations.diff(id, project, file),
    'conversations.event': (input) => { conversations.recordEvent(input); return OK },
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
    'terminals.list': () => terminals.list(),
    'terminals.open': ({ cwd }) => terminals.open(cwd),
    'terminals.close': async ({ id }) => {
      await terminals.kill(id)
      return OK
    },
    'sessions.attach': async ({ sessionId, fromOffset }, connection) => {
      connection.attached.add(sessionId)
      try {
        const { buffer, bufferStart, endOffset, exited, io } = await sessions.request('attach', { sessionId })
        // A chat agent's output is JSON for core, not a terminal to draw; keystrokes would reach its stdin.
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
    'sessions.write': async ({ sessionId, data }) => {
      if (conversations.isChatSession(sessionId)) throw new Rejection('chat-session', 'this session runs in chat mode')
      await sessions.request('write', { sessionId, data })
      service.noteInput(sessionId)
      conversations.noteInput(sessionId)
      return OK
    },
    'sessions.resize': async ({ sessionId, cols, rows }) => {
      if (conversations.isChatSession(sessionId)) return OK
      await sessions.request('resize', { sessionId, cols, rows })
      return OK
    },
    'projects.recent': () => projects.recent(),
    'worktrees.list': () => worktrees.list(),
    'worktrees.clean': ({ paths }) => worktrees.clean(paths),
    'projects.findFile': ({ roots, path }) => findFiles(roots, path),
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
