import { create } from 'zustand'
import {
  RpcError,
  connectRpc,
  coreUrl,
  type AgentKind,
  type AgentUsage,
  type LoginNotice,
  type LoginPrompt,
  type RpcConnection,
  type RpcParams,
  type SourceDescriptor,
  type SourceInbox,
  type SourceProblem,
  type Task,
  type Conversation
} from '@kando/protocol'
import { resolveCoreEndpoint } from './core-endpoint'
import { reasonText } from './labels'

export type ConnectionState = 'waiting-for-core' | 'connecting' | 'connected'

// What the right-hand pane shows for the selected task.
export type TaskView = 'detail' | 'terminal'
export type Section = 'tasks' | 'conversations'

// A sign-in this window started. The flow lives in core and ends if the connection drops.
export type LoginState = {
  provider: string
  instance: string
  name: string
  flowId: string
  prompt: { promptId: string; prompt: LoginPrompt } | null
  notices: LoginNotice[]
  // Set once core reports the flow finished.
  result: { account: string | null; problem: SourceProblem | null } | null
}

export const inboxKey = (inbox: Pick<SourceInbox, 'provider' | 'instance'>) => `${inbox.provider}/${inbox.instance}`

type CoreState = {
  connection: ConnectionState
  rpc: RpcConnection | null
  tasks: Record<string, Task>
  conversations: Record<string, Conversation>
  section: Section
  selectedConversationId: string | null
  newConversationOpen: boolean
  selectedId: string | null
  view: TaskView
  newTaskOpen: boolean
  settingsOpen: boolean
  // Which settings section to show when settings open; null keeps the first.
  settingsSection: string | null
  // The source inbox takes the right-hand pane instead of a task.
  inboxOpen: boolean
  error: string | null
  // null until core answers usage.list; an older core without it leaves it null.
  usage: Partial<Record<AgentKind, AgentUsage>> | null
  // null until core answers sources.list.
  sources: SourceDescriptor[] | null
  inboxes: Record<string, SourceInbox>
  login: LoginState | null
}

export const useCore = create<CoreState>()(() => ({
  connection: 'connecting',
  rpc: null,
  tasks: {},
  conversations: {},
  section: 'tasks',
  selectedConversationId: null,
  newConversationOpen: false,
  selectedId: null,
  view: 'detail',
  newTaskOpen: false,
  settingsOpen: false,
  settingsSection: null,
  inboxOpen: false,
  error: null,
  usage: null,
  sources: null,
  inboxes: {},
  login: null
}))

// A task with a live agent opens on its terminal: that is where the work is happening.
export function selectTask(id: string | null): void {
  useCore.setState((s) => {
    const task = id ? s.tasks[id] : undefined
    return {
      selectedId: id,
      section: 'tasks',
      inboxOpen: false,
      view: task && (task.status === 'running' || task.refineSessionId) ? 'terminal' : 'detail'
    }
  })
}

export function selectConversation(id: string | null): void {
  useCore.setState({ selectedConversationId: id, section: 'conversations', settingsOpen: false })
}

export function setNewConversationOpen(open: boolean): void {
  useCore.setState({ newConversationOpen: open })
}

export function openInbox(): void {
  useCore.setState({ section: 'tasks', inboxOpen: true, selectedId: null, settingsOpen: false })
}

export function showView(view: TaskView): void {
  useCore.setState({ view })
}

export function setNewTaskOpen(open: boolean): void {
  useCore.setState({ newTaskOpen: open })
}

export function setSettingsOpen(open: boolean, section: string | null = null): void {
  useCore.setState({ settingsOpen: open, settingsSection: section })
}

function byAgent(usage: AgentUsage[]): Partial<Record<AgentKind, AgentUsage>> {
  return Object.fromEntries(usage.map((entry) => [entry.agent, entry]))
}

export async function refreshUsage(): Promise<void> {
  const usage = await perform((rpc) => rpc.call('usage.refresh', {}))
  if (usage) {
    useCore.setState({ usage: byAgent(usage) })
  }
}

function patchLogin(flowId: string, patch: (login: LoginState) => Partial<LoginState>): void {
  useCore.setState((s) => (s.login && s.login.flowId === flowId ? { login: { ...s.login, ...patch(s.login) } } : {}))
}

// The flow id is chosen here: its first prompt can arrive before the reply to sources.login.
export async function startLogin(provider: string, instance: string, name: string): Promise<void> {
  const flowId = crypto.randomUUID()
  useCore.setState({ login: { provider, instance, name, flowId, prompt: null, notices: [], result: null } })
  const started = await perform((rpc) => rpc.call('sources.login', { provider, instance, flowId }))
  if (!started) {
    useCore.setState((s) => (s.login?.flowId === flowId ? { login: null } : {}))
  }
}

export async function answerLogin(value: string): Promise<void> {
  const { login } = useCore.getState()
  if (!login?.prompt) {
    return
  }
  const { flowId } = login
  const { promptId } = login.prompt
  patchLogin(flowId, () => ({ prompt: null }))
  await perform((rpc) => rpc.call('sources.answer', { flowId, promptId, value }))
}

// Cancels a flow still running; after it finished this only closes the dialog.
export function closeLogin(): void {
  const { login } = useCore.getState()
  useCore.setState({ login: null })
  if (login && !login.result) {
    const { flowId } = login
    void perform((rpc) => rpc.call('sources.cancelLogin', { flowId }))
  }
}

export function dismissError(): void {
  useCore.setState({ error: null })
}

// Runs an RPC action and turns a rejection into a visible, localized message.
export async function perform<T>(action: (rpc: RpcConnection) => Promise<T>): Promise<T | null> {
  const { rpc } = useCore.getState()
  if (!rpc) {
    useCore.setState({ error: '尚未连接到 Kando core' })
    return null
  }
  try {
    return await action(rpc)
  } catch (error) {
    const message =
      error instanceof RpcError && error.reason
        ? reasonText(error.reason, error.message)
        : error instanceof Error
          ? error.message
          : String(error)
    useCore.setState({ error: message })
    return null
  }
}

export function updateTask(id: string, patch: Omit<RpcParams<'tasks.update'>, 'id'>): Promise<Task | null> {
  return perform((rpc) => rpc.call('tasks.update', { id, ...patch }))
}

const RETRY_MS = 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// One loop for the app's lifetime; survives core restarts (new port and token).
export function startCoreConnection(): void {
  void (async () => {
    for (;;) {
      const endpoint = await resolveCoreEndpoint()
      if (!endpoint) {
        useCore.setState({ connection: 'waiting-for-core', rpc: null })
        await sleep(RETRY_MS)
        continue
      }
      try {
        useCore.setState({ connection: 'connecting' })
        const rpc = await connectRpc(coreUrl(endpoint))
        rpc.on('tasks.changed', ({ task }) =>
          useCore.setState((s) => ({ tasks: { ...s.tasks, [task.id]: task } }))
        )
        rpc.on('tasks.deleted', ({ id }) =>
          useCore.setState((s) => {
            const { [id]: _removed, ...tasks } = s.tasks
            return { tasks, selectedId: s.selectedId === id ? null : s.selectedId }
          })
        )
        rpc.on('conversations.changed', ({ conversation }) =>
          useCore.setState((s) => ({ conversations: { ...s.conversations, [conversation.id]: conversation } }))
        )
        rpc.on('conversations.deleted', ({ id }) =>
          useCore.setState((s) => {
            const { [id]: _removed, ...conversations } = s.conversations
            return { conversations, selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId }
          })
        )
        rpc.on('usage.changed', ({ usage }) =>
          useCore.setState((s) => ({ usage: { ...s.usage, [usage.agent]: usage } }))
        )
        rpc.on('sources.listChanged', ({ sources }) => useCore.setState({ sources }))
        rpc.on('sources.inboxChanged', ({ inbox }) =>
          useCore.setState((s) => ({ inboxes: { ...s.inboxes, [inboxKey(inbox)]: inbox } }))
        )
        rpc.on('sources.loginPrompt', ({ flowId, promptId, prompt }) => patchLogin(flowId, () => ({ prompt: { promptId, prompt } })))
        rpc.on('sources.loginNotice', ({ flowId, notice }) => patchLogin(flowId, (login) => ({ notices: [...login.notices, notice] })))
        rpc.on('sources.loginFinished', ({ flowId, account, problem }) =>
          patchLogin(flowId, () => ({ prompt: null, result: { account, problem } }))
        )
        const tasks = await rpc.call('tasks.list', {})
        const conversations = await rpc.call('conversations.list', {}).catch(() => [])
        const usage = await rpc.call('usage.list', {}).catch(() => null)
        const sources = await rpc.call('sources.list', {})
        const inboxes = await rpc.call('sources.inbox', {})
        useCore.setState((s) => ({
          rpc,
          connection: 'connected',
          tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
          conversations: Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation])),
          usage: usage && byAgent(usage),
          sources,
          inboxes: Object.fromEntries(inboxes.map((inbox) => [inboxKey(inbox), inbox])),
          inboxOpen: s.inboxOpen && inboxes.some((inbox) => inbox.active)
        }))
        await rpc.closed
      } catch {
        // Fall through to retry; the badge already shows we're not connected.
      }
      // A sign-in belongs to the connection that started it; core has dropped it.
      useCore.setState({ rpc: null, connection: 'connecting', login: null })
      await sleep(RETRY_MS)
    }
  })()
}
