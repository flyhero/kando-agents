import { z } from 'zod'
import { AgentKind, MAX_DETAILS_LENGTH, MAX_TASK_REPOS, RepoStartOptions, Task, TaskSession, TaskStatus } from './task'
import { ATTACHMENT_CHUNK_BYTES, AttachmentId, AttachmentInfo, Base64Chunk, ImageRef, MAX_ATTACHMENT_BYTES, MAX_CHAT_IMAGES, MAX_TASK_IMAGES } from './attachments'
import { LoginNotice, LoginPrompt, SourceDescriptor, SourceId, SourceInbox, SourceProblem } from './source'
import { AgentUsage } from './usage'
import { CommitPushResult, Conversation, ConversationMessage, ConversationSearchHit, ConversationStage, ProjectBranches, ProjectHead } from './conversation'
import { ChatCatalog, ChatDecision, ChatItemList, ChatOption, ChatPermissionMode, ConversationMode } from './chat'
import { FileDiff, FolderChanges, RepoChanges } from './changes'
import { Terminal } from './terminal'
import { ManagedWorktree, WorktreeCleanResult } from './worktree'
import { browserActions, BrowserAction, BrowserConsole, BrowserFrame, BrowserInputEvent, BrowserNavigateTo, BrowserNavigation, BrowserScreenshot, BrowserScreenshotOptions, BrowserSnapshot, BrowserStatus, BrowserTab, BrowserTabId, BrowserUrl, BrowserViewOptions } from './browser'
import { ComputerAwakeMode, ComputerAwakeStatus } from './awake'

// Bump only for breaking changes; additive optional fields keep the version.
export const PROTOCOL_VERSION = 8

const TaskRef = z.object({ id: z.string().min(1) })
const TaskTitle = z.string().trim().min(1).max(200)
// Everything but the title, shared by create and update.
const TaskFields = z.object({
  details: z.string().max(MAX_DETAILS_LENGTH).optional(),
  // Each list replaces the task's current one.
  // The first repo is primary; reordering preserves each repo's worktree.
  repos: z.array(z.string().trim().min(1)).max(MAX_TASK_REPOS).optional(),
  dependsOn: z.array(z.string().trim().min(1)).max(50).optional(),
  agent: AgentKind.nullable().optional()
})
const SessionRef = z.object({ sessionId: z.string().min(1) })
const InstanceRef = z.object({ provider: SourceId, instance: SourceId })
// Trimmed only: a provider may normalize its own keys (Jira upper-cases them) before core checks them.
const IssueRef = InstanceRef.extend({ key: z.string().trim().min(1).max(160) })
const FlowRef = z.object({ flowId: z.string().min(1).max(64) })
const Ok = z.object({ ok: z.literal(true) })
const ConversationRef = z.object({ id: z.string().uuid() })
// What core can do beyond this protocol version's baseline; an older core sends none.
// chat-options: a chat stage's permission mode, model and effort can be changed (conversations.setOption).
// chat-images: conversations.send takes images; an older core would drop them unnoticed.
// task-chat: a task can start in the chat view (tasks.start and the methods beside it).
// conversation-projects: a conversation's additional projects can change (conversations.setAdditionalProjects).
// browser: core hosts a browser for chat agents (the browser.* methods).
export const CORE_FEATURES = ['chat', 'chat-options', 'chat-images', 'task-chat', 'task-start', 'worktrees', 'conversation-branches', 'conversation-commit-push', 'find-file', 'conversation-projects', 'browser', 'keep-awake'] as const
// Whether a chat-mode start may offer running with nothing asked and nothing sandboxed; the
// conversation keeps what its latest start said.
const AllowBypass = z.boolean().optional()
// One page of a conversation's chat history; `before` fetches the page older than it, null when none is left.
const ChatPage = z.object({ items: ChatItemList, before: z.string().nullable() })
// Browser calls from an agent name the conversation they act for, and a tab of that conversation.
const BrowserConversationRef = z.object({ conversationId: z.string().uuid() })
const BrowserTabRef = BrowserConversationRef.extend({ tabId: BrowserTabId })

export const rpcMethods = {
  'system.hello': {
    params: z.object({ protocolVersion: z.number().int() }),
    result: z.object({
      protocolVersion: z.number().int(),
      serverVersion: z.string(),
      features: z.array(z.string()).optional()
    })
  },
  'system.awakeStatus': { params: z.object({}), result: ComputerAwakeStatus },
  'system.setAwakeMode': { params: z.object({ mode: ComputerAwakeMode }), result: ComputerAwakeStatus },
  'tasks.list': {
    params: z.object({ status: TaskStatus.optional() }),
    result: z.array(Task)
  },
  'tasks.get': { params: TaskRef, result: Task },
  'tasks.create': {
    params: TaskFields.extend({ title: TaskTitle, images: z.array(ImageRef).max(MAX_TASK_IMAGES).optional() }),
    result: Task
  },
  'tasks.update': {
    params: TaskFields.extend({
      id: TaskRef.shape.id,
      title: TaskTitle.optional(),
      // Where each named repo's branch is to start (see TaskRepo.startRef); others keep theirs.
      starts: z.array(z.object({ path: z.string().trim().min(1), ref: z.string().min(1).max(500).nullable() })).max(MAX_TASK_REPOS).optional()
    }),
    result: Task
  },
  // What each of the task's repos could start from, read from git on every call.
  'tasks.startOptions': { params: TaskRef, result: z.array(RepoStartOptions) },
  'tasks.move': { params: TaskRef.extend({ status: TaskStatus }), result: Task },
  'tasks.run': { params: TaskRef, result: Task },
  // Runs a done task again in its own worktree, starting a fresh agent session.
  // What the user found wrong under review, handed to the continuing agent.
  'tasks.continue': { params: TaskRef.extend({ note: z.string().trim().max(2000).optional() }), result: Task },
  // Abandons a done task and returns the new pending task that takes over from it.
  'tasks.redo': { params: TaskRef.extend({ reason: z.string().trim().max(500).optional() }), result: Task },
  // Opens a read-only session to talk the task through; the agent answers via tasks.propose.
  'tasks.refine': { params: TaskRef, result: Task },
  // A task in the chat view (task-chat). start plans first, then carries the plan out in the task's
  // worktree, or only plans while its dependencies are unfinished. resumeChat readies its agent
  // before a message, reopening a finished task as continuing does. submit hands a running one in
  // for review. savePlan keeps a plan-only stage's plan for when the task can run.
  'tasks.start': { params: TaskRef.extend({ allowBypass: AllowBypass }), result: Task },
  'tasks.resumeChat': { params: TaskRef.extend({ allowBypass: AllowBypass }), result: Task },
  'tasks.submit': { params: TaskRef, result: Task },
  'tasks.savePlan': { params: TaskRef.extend({ stageId: z.string().uuid(), requestId: z.string().min(1).max(200) }), result: Task },
  // From the agent's own hooks via `kando task-event`: its turn ended (waiting) or the user answered.
  'tasks.event': { params: TaskRef.extend({ session: TaskSession, waiting: z.boolean() }), result: Ok },
  'tasks.propose': {
    params: TaskRef.extend({ markdown: z.string().trim().min(1).max(MAX_DETAILS_LENGTH) }),
    result: Task
  },
  'tasks.resolveProposal': {
    params: TaskRef.extend({ action: z.enum(['replace', 'append', 'discard']) }),
    result: Task
  },
  'tasks.restoreDetails': { params: TaskRef, result: Task },
  'tasks.delete': { params: TaskRef, result: Ok },
  // Appended on the server, so uploads that finish together do not overwrite each other.
  'tasks.addImages': { params: TaskRef.extend({ images: z.array(ImageRef).min(1).max(MAX_TASK_IMAGES) }), result: Task },
  'tasks.updateImage': { params: TaskRef.extend({ attachmentId: AttachmentId, name: ImageRef.shape.name }), result: Task },
  'tasks.removeImage': { params: TaskRef.extend({ attachmentId: AttachmentId }), result: Task },
  // Each repo's worktree, read on every call. A repo without one yet has no branch. Older cores lack it.
  'tasks.branches': { params: TaskRef, result: z.array(ProjectHead) },
  // What the agent changed in each worktree since its branch started, read on every call.
  'tasks.changes': { params: TaskRef, result: z.array(RepoChanges) },
  // One file of those changes; `repo` is the path the user picked, `file` a path from the change list.
  'tasks.diff': { params: TaskRef.extend({ repo: z.string().min(1), file: z.string().min(1) }), result: FileDiff },
  'conversations.list': { params: z.object({}), result: z.array(Conversation) },
  'conversations.get': { params: ConversationRef, result: Conversation },
  // mode defaults to tui, which is all an older core knows; check CORE_FEATURES before asking for chat.
  'conversations.create': {
    // permissionMode, model and effort: what a chat-mode start begins with, from what the agent has.
    params: z.object({
      agent: AgentKind,
      // Primary (cwd) first; other directories are available to the agent in place.
      projectPaths: z.array(z.string().trim().min(1)).max(MAX_TASK_REPOS),
      mode: ConversationMode.optional(),
      allowBypass: AllowBypass,
      permissionMode: ChatPermissionMode.optional(),
      model: z.string().trim().min(1).max(200).optional(),
      effort: z.string().trim().min(1).max(200).optional()
    }),
    result: Conversation
  },
  // What the agent offers a new chat: the models its latest chat stage listed, or, when it never
  // ran one, what it lists when asked. null when it cannot be asked.
  'conversations.chatCatalog': { params: z.object({ agent: AgentKind }), result: ChatCatalog.nullable() },
  // Replaces every project but the primary (see checkEditAdditionalProjects); an idle chat agent
  // restarts on its session to be given them.
  'conversations.setAdditionalProjects': {
    params: ConversationRef.extend({ projectPaths: z.array(z.string().trim().min(1)).max(MAX_TASK_REPOS - 1) }),
    result: Conversation
  },
  'conversations.rename': { params: ConversationRef.extend({ title: z.string().trim().min(1).max(200) }), result: Conversation },
  'conversations.continue': { params: ConversationRef.extend({ mode: ConversationMode.optional(), allowBypass: AllowBypass }), result: Conversation },
  'conversations.handoff': {
    params: ConversationRef.extend({ agent: AgentKind, note: z.string().max(10000), stopRunning: z.boolean(), mode: ConversationMode.optional(), allowBypass: AllowBypass }),
    result: Conversation
  },
  // Chat mode only: a message for the agent, text and/or images already uploaded (attachments.commit),
  // in the order they show. With queue, one sent while a turn runs waits its turn behind any
  // already waiting; with steer, it goes into the running turn (state.steerable says whether the
  // agent takes that); with neither, the agent must be idle.
  'conversations.send': {
    params: ConversationRef.extend({
      text: z.string().trim().max(100000),
      images: z.array(AttachmentId).max(MAX_CHAT_IMAGES).optional(),
      queue: z.boolean().optional(),
      steer: z.boolean().optional()
    }).refine((params) => params.text !== '' || (params.images?.length ?? 0) > 0, { message: 'a message needs text or an image' }),
    result: Ok
  },
  // Drops a waiting message (the ref from state.queue), or every one without a ref.
  'conversations.cancelQueued': { params: ConversationRef.extend({ ref: z.string().optional() }), result: Ok },
  // Releases a message a failed turn held (the first without a ref) to go out when the agent is
  // idle; with now, takes it out of the queue and sends it at once, into the running turn if need be.
  'conversations.sendQueued': { params: ConversationRef.extend({ ref: z.string().optional(), now: z.boolean().optional() }), result: Ok },
  // Chat mode only: switches one of the stage's options to a value its state item offers. The
  // conversation remembers it for its next start.
  'conversations.setOption': { params: ConversationRef.extend({ option: ChatOption, value: z.string().trim().min(1).max(200) }), result: Ok },
  // Ends the running turn; the agent stays up for the next message.
  'conversations.interrupt': { params: ConversationRef, result: Ok },
  // Answers an approval or question item. answers maps a question id to the chosen labels.
  'conversations.respond': {
    params: ConversationRef.extend({
      requestId: z.string().min(1).max(200),
      decision: ChatDecision,
      message: z.string().trim().max(2000).optional(),
      answers: z.record(z.string().max(500), z.array(z.string().max(2000)).max(20)).optional()
    }),
    result: Ok
  },
  // The latest page of chat items; this connection then receives conversations.chatItems and
  // conversations.chatDelta for the conversation until it unwatches.
  'conversations.watchChat': { params: ConversationRef, result: ChatPage },
  'conversations.unwatchChat': { params: ConversationRef, result: Ok },
  'conversations.chatItems': { params: ConversationRef.extend({ before: z.string().uuid() }), result: ChatPage },
  'conversations.stop': { params: ConversationRef, result: Conversation },
  'conversations.delete': { params: ConversationRef, result: Ok },
  'conversations.history': {
    params: ConversationRef.extend({ offset: z.number().int().nonnegative(), length: z.number().int().min(1).max(65536) }),
    result: z.object({ data: z.string(), nextOffset: z.number().int(), totalBytes: z.number().int(), sessionOffset: z.number().int() })
  },
  'conversations.messages': { params: ConversationRef, result: z.array(ConversationMessage) },
  'conversations.stages': { params: ConversationRef, result: z.array(ConversationStage) },
  // Messages only: clients match titles and projects themselves. Older cores lack it.
  // Read on every call: the agent works in the project folders themselves, so either it or
  // the user can switch branches at any time. Older cores lack it.
  'conversations.branches': { params: ConversationRef, result: z.array(ProjectHead) },
  // What each project could switch to (see checkSwitchBranch); read from git on every call.
  'conversations.branchOptions': { params: ConversationRef, result: z.array(ProjectBranches) },
  // Checks out a branch by its full name in one project; a remote one gets a local branch tracking it.
  'conversations.switchBranch': { params: ConversationRef.extend({ project: z.string().min(1), ref: z.string().min(1).max(500) }), result: Conversation },
  // Makes a branch at the project's HEAD and checks it out, uncommitted changes and all.
  'conversations.createBranch': { params: ConversationRef.extend({ project: z.string().min(1), name: z.string().trim().min(1).max(200) }), result: Conversation },
  // Stages every change in one project, commits it, then pushes its current branch.
  'conversations.commitPush': {
    params: ConversationRef.extend({ project: z.string().min(1), message: z.string().trim().min(1).max(10_000) }),
    result: CommitPushResult
  },
  // Each project's uncommitted changes and the commits since the conversation started.
  'conversations.changes': { params: ConversationRef, result: z.array(FolderChanges) },
  'conversations.diff': { params: ConversationRef.extend({ project: z.string().min(1), file: z.string().min(1) }), result: FileDiff },
  'conversations.search': { params: z.object({ query: z.string().trim().min(1).max(200) }), result: z.array(ConversationSearchHit) },
  'conversations.event': {
    params: ConversationRef.extend({
      stageId: z.string().uuid(), agent: AgentKind, providerSessionId: z.string().nullable(),
      role: z.enum(['user', 'assistant']), text: z.string().max(200000), eventKey: z.string().min(1).max(300), complete: z.boolean()
    }), result: Ok
  },
  // The browser core hosts (feature `browser`). The agent's side, from its MCP tools: every call
  // names the conversation it acts for, and sees only that conversation's tabs. A screenshot is
  // stored as an attachment; snapshots are AI-mode aria snapshots whose refs the actions take.
  'browser.tabs': { params: BrowserConversationRef, result: z.array(BrowserTab) },
  // A new tab for the conversation, at the URL when one is given.
  'browser.open': { params: BrowserConversationRef.extend({ url: BrowserUrl.optional() }), result: BrowserNavigation },
  // The first visit to a site outside local development hosts asks the user in the chat; the
  // outcome says whether the page loaded, the user refused, or they have not answered yet.
  'browser.navigate': { params: BrowserTabRef.extend({ to: BrowserNavigateTo }), result: BrowserNavigation },
  'browser.snapshot': { params: BrowserTabRef, result: BrowserSnapshot },
  'browser.screenshot': { params: BrowserTabRef.extend(BrowserScreenshotOptions.shape), result: BrowserScreenshot },
  'browser.click': { params: BrowserTabRef.extend(browserActions.click.shape), result: BrowserAction },
  'browser.type': { params: BrowserTabRef.extend(browserActions.type.shape), result: BrowserAction },
  'browser.press': { params: BrowserTabRef.extend(browserActions.press.shape), result: BrowserAction },
  'browser.hover': { params: BrowserTabRef.extend(browserActions.hover.shape), result: BrowserAction },
  'browser.scroll': { params: BrowserTabRef.extend(browserActions.scroll.shape), result: BrowserAction },
  'browser.select': { params: BrowserTabRef.extend(browserActions.select.shape), result: BrowserAction },
  'browser.wait': { params: BrowserTabRef.extend(browserActions.wait.shape), result: BrowserAction },
  // The page's console, errors and failed requests, since the tab opened or its last navigation.
  'browser.console': { params: BrowserTabRef.extend({ sinceNavigation: z.boolean().optional() }), result: BrowserConsole },
  'browser.close': { params: BrowserTabRef, result: Ok },
  // The user's side, from the app. status answers from the host, starting it when it is not up.
  'browser.status': { params: z.object({}), result: BrowserStatus },
  'browser.install': { params: z.object({}), result: BrowserStatus },
  // The conversation's tabs; this connection then receives browser.tabsChanged for it until it
  // unwatches, and may view and drive its tabs meanwhile.
  'browser.watch': { params: BrowserConversationRef, result: z.array(BrowserTab) },
  'browser.unwatch': { params: BrowserConversationRef, result: Ok },
  // Every tab there is, the user's own included, for the browser panel; then browser.tabsChanged
  // for all of them until unwatchAll.
  'browser.watchAll': { params: z.object({}), result: z.array(BrowserTab) },
  'browser.unwatchAll': { params: z.object({}), result: Ok },
  // Streams a tab's frames to this connection as browser.frame (one view per tab per connection;
  // starting again resizes it); the connection acks each frame it drew, and no more than two go
  // unacked. stop ends one tab's view, or every one of the connection's.
  'browser.view.start': { params: z.object({ tabId: BrowserTabId }).extend(BrowserViewOptions.shape), result: z.object({ viewport: z.object({ width: z.number().int(), height: z.number().int() }) }) },
  'browser.view.stop': { params: z.object({ tabId: BrowserTabId.optional() }), result: Ok },
  'browser.view.ack': { params: z.object({ tabId: BrowserTabId, seq: z.number().int().nonnegative() }), result: Ok },
  // Input from the live view. Driving a tab this way, or navigating it below, holds the agent's
  // calls on it off for a few seconds; handBack ends that at once.
  'browser.input': { params: z.object({ tabId: BrowserTabId, event: BrowserInputEvent }), result: Ok },
  'browser.userNavigate': { params: z.object({ tabId: BrowserTabId, to: BrowserNavigateTo }), result: BrowserTab },
  // For a conversation the connection watches, or, with none, a tab of the user's own.
  'browser.newTab': { params: z.object({ conversationId: z.string().uuid().optional(), url: BrowserUrl.optional() }), result: BrowserTab },
  'browser.closeTab': { params: z.object({ tabId: BrowserTabId }), result: Ok },
  'browser.handBack': { params: z.object({ tabId: BrowserTabId }), result: Ok },
  'browser.userScreenshot': { params: z.object({ tabId: BrowserTabId }), result: AttachmentInfo },
  // An upload in chunks; core checks and stores the image on commit.
  'attachments.begin': {
    params: z.object({ size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES) }),
    result: z.object({ uploadId: z.string() })
  },
  'attachments.append': {
    params: z.object({ uploadId: z.string().min(1).max(64), offset: z.number().int().nonnegative(), data: Base64Chunk }),
    result: Ok
  },
  'attachments.commit': { params: z.object({ uploadId: z.string().min(1).max(64) }), result: AttachmentInfo },
  'attachments.stat': { params: z.object({ id: AttachmentId }), result: AttachmentInfo },
  'attachments.read': {
    params: z.object({
      id: AttachmentId,
      offset: z.number().int().nonnegative(),
      length: z.number().int().min(1).max(ATTACHMENT_CHUNK_BYTES)
    }),
    result: z.object({ data: z.string() })
  },
  // Shells in the app's own terminal panel; their output flows through sessions.* like an agent's.
  'terminals.list': { params: z.object({}), result: z.array(Terminal) },
  'terminals.open': { params: z.object({ cwd: z.string().optional() }), result: Terminal },
  'terminals.close': { params: z.object({ id: z.string().uuid() }), result: Ok },
  'sessions.attach': {
    params: SessionRef.extend({ fromOffset: z.number().int().nonnegative().optional() }),
    result: z.object({ buffer: z.string(), bufferStart: z.number().int(), endOffset: z.number().int(), exited: z.boolean() })
  },
  'sessions.detach': { params: SessionRef, result: Ok },
  'sessions.write': { params: SessionRef.extend({ data: z.string() }), result: Ok },
  'sessions.resize': {
    params: SessionRef.extend({
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000)
    }),
    result: Ok
  },
  // Project paths any task or conversation has used, most recent first; kept after they are gone.
  'projects.recent': { params: z.object({}), result: z.array(z.string()) },
  // Every worktree Kando laid out, with what git says of each; sizes come as they are counted.
  'worktrees.list': { params: z.object({}), result: z.array(ManagedWorktree) },
  // Removes each worktree checkCleanWorktree allows, as it stands now; branches stay.
  'worktrees.clean': { params: z.object({ paths: z.array(z.string().min(1)).min(1).max(500) }), result: z.array(WorktreeCleanResult) },
  'projects.forget': { params: z.object({ path: z.string().min(1) }), result: Ok },
  // Files in these project folders whose path ends in `path` (a bare name, or a tail of one),
  // tracked or untracked but not ignored: absolute, the shallowest first, at most 20.
  'projects.findFile': {
    params: z.object({ roots: z.array(z.string().min(1)).min(1).max(20), path: z.string().min(1).max(1000) }),
    result: z.array(z.string())
  },
  // What older clients call projects.recent / projects.forget.
  'repos.recent': { params: z.object({}), result: z.array(z.string()) },
  'repos.forget': { params: z.object({ path: z.string().min(1) }), result: Ok },
  'usage.list': { params: z.object({}), result: z.array(AgentUsage) },
  // Refetches now instead of waiting for the next poll; core rate-limits repeats.
  'usage.refresh': { params: z.object({}), result: z.array(AgentUsage) },
  'sources.list': { params: z.object({}), result: z.array(SourceDescriptor) },
  // Non-secret settings only; changing one marked bindsCredential signs the instance out.
  'sources.saveSettings': {
    params: InstanceRef.extend({
      settings: z.record(z.string().max(32), z.string().max(4000)),
      enabled: z.boolean().optional()
    }),
    result: SourceDescriptor
  },
  // Starts a sign-in flow owned by this connection; prompts arrive as sources.loginPrompt. The
  // client picks the flow id, so it knows it before the first prompt can arrive.
  'sources.login': { params: InstanceRef.extend({ flowId: z.string().uuid() }), result: FlowRef },
  'sources.answer': { params: FlowRef.extend({ promptId: z.string().min(1).max(64), value: z.string().max(4000) }), result: Ok },
  'sources.cancelLogin': { params: FlowRef, result: Ok },
  // Forgets the stored credential; settings stay.
  'sources.disconnect': { params: InstanceRef, result: Ok },
  'sources.inbox': { params: z.object({}), result: z.array(SourceInbox) },
  'sources.refresh': { params: InstanceRef, result: SourceInbox },
  // Turns an issue into a pending task that carries the issue's text as a snapshot.
  'sources.import': { params: IssueRef.extend({ agent: AgentKind.nullable().optional() }), result: Task },
  'sources.dismiss': { params: IssueRef, result: SourceInbox },
  'sources.restore': { params: IssueRef, result: SourceInbox },
  // Fetches the task's issue again and replaces its snapshot.
  'sources.resync': { params: z.object({ taskId: z.string().min(1) }), result: Task }
} as const

export const rpcNotifications = {
  'system.awakeChanged': z.object({ status: ComputerAwakeStatus }),
  'conversations.changed': z.object({ conversation: Conversation }),
  'conversations.deleted': ConversationRef,
  // Items added or changed, newest revision each; only to connections watching the conversation.
  'conversations.chatItems': z.object({ conversationId: z.string(), items: ChatItemList }),
  // Text streamed onto an assistant or reasoning item the client already holds. Item ids are
  // unique within a stage only; an older core leaves the stage out.
  'conversations.chatDelta': z.object({ conversationId: z.string(), stageId: z.string().optional(), itemId: z.string(), append: z.string() }),
  'tasks.changed': z.object({ task: Task }),
  'tasks.deleted': z.object({ id: z.string() }),
  'sessions.data': z.object({ sessionId: z.string(), data: z.string(), offset: z.number().int() }),
  'sessions.exit': z.object({ sessionId: z.string(), exitCode: z.number() }),
  'usage.changed': z.object({ usage: AgentUsage }),
  'terminals.changed': z.object({ terminals: z.array(Terminal) }),
  // The hosted browser: its status to every connection; a conversation's tabs to the connections
  // watching them (browser.watch); frames to the one connection viewing the tab.
  'browser.changed': z.object({ status: BrowserStatus }),
  'browser.tabsChanged': z.object({ conversationId: z.string().nullable(), tabs: z.array(BrowserTab) }),
  'browser.frame': BrowserFrame,
  // Worktrees were cleaned, or their sizes counted: list them again.
  'worktrees.changed': z.object({}),
  'sources.listChanged': z.object({ sources: z.array(SourceDescriptor) }),
  'sources.inboxChanged': z.object({ inbox: SourceInbox }),
  // Sent only to the connection that started the flow.
  'sources.loginPrompt': z.object({ flowId: z.string(), promptId: z.string(), prompt: LoginPrompt }),
  'sources.loginNotice': z.object({ flowId: z.string(), notice: LoginNotice }),
  'sources.loginFinished': z.object({
    flowId: z.string(),
    provider: SourceId,
    instance: SourceId,
    account: z.string().nullable(),
    problem: SourceProblem.nullable()
  })
} as const

export type RpcMethod = keyof typeof rpcMethods
export type RpcParams<M extends RpcMethod> = z.input<(typeof rpcMethods)[M]['params']>
export type RpcParsedParams<M extends RpcMethod> = z.output<(typeof rpcMethods)[M]['params']>
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcMethods)[M]['result']>

export type RpcNotificationName = keyof typeof rpcNotifications
export type RpcNotificationParams<N extends RpcNotificationName> = z.output<
  (typeof rpcNotifications)[N]
>

// Typed views: indexing these with a generic M yields M's own schema, where
// indexing the raw literals widens to the union of every method's schema.
export const rpcSchemas: {
  [M in RpcMethod]: { params: z.ZodType<RpcParsedParams<M>>; result: z.ZodType<RpcResult<M>> }
} = rpcMethods
export const rpcNotificationSchemas: {
  [N in RpcNotificationName]: z.ZodType<RpcNotificationParams<N>>
} = rpcNotifications

export function isRpcMethod(name: string): name is RpcMethod {
  return Object.hasOwn(rpcMethods, name)
}

export function isRpcNotificationName(name: string): name is RpcNotificationName {
  return Object.hasOwn(rpcNotifications, name)
}

export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  // Domain failures; `data.reason` carries a stable code the UI can localize.
  rejected: -32000
} as const

export const RpcRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  method: z.string(),
  params: z.unknown().optional()
})

// Order matters: z.unknown() accepts a missing key, so the error shape must be
// tried before the result shape or every error would parse as a result.
export const RpcFrame = z.union([
  RpcRequest,
  z.object({
    jsonrpc: z.literal('2.0'),
    id: z.number().nullable(),
    error: z.object({
      code: z.number(),
      message: z.string(),
      data: z.object({ reason: z.string() }).optional()
    })
  }),
  z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.unknown() }),
  z.object({ jsonrpc: z.literal('2.0'), method: z.string(), params: z.unknown() })
])
export type RpcFrame = z.infer<typeof RpcFrame>

// Written by core on startup; clients discover port and token from it.
export const CoreEndpoint = z.object({
  port: z.number().int(),
  token: z.string(),
  pid: z.number().int(),
  protocolVersion: z.number().int(),
  // The core's package version, so an app newer than the core serving its home can replace it.
  // Older cores leave it out, which reads as outdated.
  version: z.string().optional()
})
export type CoreEndpoint = z.infer<typeof CoreEndpoint>

export function coreUrl(endpoint: Pick<CoreEndpoint, 'port' | 'token'>): string {
  return `ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`
}
