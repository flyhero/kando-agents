import { PROTOCOL_VERSION } from '@kando/protocol'
import packageJson from '../package.json' with { type: 'json' }
import type { AttachmentStore } from './attachment-store'
import type { AttachmentUploads } from './attachment-uploads'
import type { SessionHost } from './daemon-client'
import type { ProjectRegistry } from './project-registry'
import { Rejection } from './rejection'
import type { SourceService } from './source-service'
import type { RpcHandlers } from './rpc-server'
import type { TaskService } from './task-service'
import type { UsageService } from './usage-service'
import type { ConversationService } from './conversation-service'

const OK = { ok: true } as const

export function createRpcHandlers(
  service: TaskService,
  conversations: ConversationService,
  projects: ProjectRegistry,
  sessions: SessionHost,
  usage: UsageService,
  sources: SourceService,
  attachments: { store: AttachmentStore; uploads: AttachmentUploads }
): RpcHandlers {
  return {
    'system.hello': () => ({ protocolVersion: PROTOCOL_VERSION, serverVersion: packageJson.version }),
    'tasks.list': ({ status }) => service.list(status),
    'tasks.get': ({ id }) => service.get(id),
    'tasks.create': (params) => service.createTask(params),
    'tasks.update': (params) => service.update(params),
    'tasks.move': ({ id, status }) => service.move(id, status),
    'tasks.run': ({ id }) => service.run(id),
    'tasks.continue': ({ id, note }) => service.continue(id, note),
    'tasks.redo': ({ id, reason }) => service.redo(id, reason),
    'tasks.refine': ({ id }) => service.refine(id),
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
    'conversations.list': () => conversations.list(),
    'conversations.get': ({ id }) => conversations.get(id),
    'conversations.create': ({ agent, projectPaths }) => conversations.create(agent, projectPaths),
    'conversations.rename': ({ id, title }) => conversations.rename(id, title),
    'conversations.continue': ({ id }) => conversations.continue(id),
    'conversations.handoff': ({ id, agent, note, stopRunning }) => conversations.handoff(id, agent, note, stopRunning),
    'conversations.stop': ({ id }) => conversations.stop(id),
    'conversations.delete': async ({ id }) => { await conversations.delete(id); return OK },
    'conversations.history': ({ id, offset, length }) => conversations.history(id, offset, length),
    'conversations.messages': ({ id }) => conversations.messages(id),
    'conversations.stages': ({ id }) => conversations.stages(id),
    'conversations.branches': ({ id }) => conversations.branches(id),
    'conversations.search': ({ query }) => conversations.search(query),
    'conversations.event': (input) => { conversations.recordEvent(input); return OK },
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
    'sessions.attach': async ({ sessionId, fromOffset }, connection) => {
      connection.attached.add(sessionId)
      try {
        const { buffer, bufferStart, endOffset, exited } = await sessions.request('attach', { sessionId })
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
      await sessions.request('write', { sessionId, data })
      service.noteInput(sessionId)
      return OK
    },
    'sessions.resize': async ({ sessionId, cols, rows }) => {
      await sessions.request('resize', { sessionId, cols, rows })
      return OK
    },
    'projects.recent': () => projects.recent(),
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
