import { beforeEach, describe, expect, it } from 'vitest'
import { Task, createRpcClient, type Conversation, type RpcConnection } from '@kando/protocol'
import { actionableItems } from './attention'
import {
  openAttentionItem, openConversationDraft, openInbox, selectConversation, selectTask, setAttentionOpen,
  refreshAttentionSummaries, setDashboardOpen, setSchedulesOpen, setSettingsOpen, setWorktreesOpen, useCore,
  clearInspectorFile, showConversationChanges, showInspectorFile, showTaskChanges
} from './core-store'
import { conversationSurface } from './components/chat-surface'

const task = Task.parse({ id: 'task', title: 'Review me', details: '', status: 'review', conversationId: 'chat', repos: [], dependsOn: [], agent: 'claude', createdAt: 0, updatedAt: 0 })
const chat: Conversation = {
  id: 'chat', title: 'Chat', titleLocked: false, agent: 'claude', workspacePath: '/project',
  projectPaths: [], managedWorkspace: false, sessionId: 'session', createdAt: 0, updatedAt: 0,
  taskId: task.id, chat: { turn: 'awaiting' }
}

beforeEach(() => useCore.setState(useCore.getInitialState(), true))

describe('inspector file navigation', () => {
  it('opens a conversation file from its chat surface and leaves review on the full list', () => {
    const conversation = { ...chat, taskId: null, workspacePath: '/project/api', projectPaths: ['/project/api', '/project/web'] }
    selectConversation(conversation.id)
    useCore.setState({ conversationInspectorTab: 'branch' })
    const surface = conversationSurface(conversation)
    surface.showFileChange('../web/src/app.ts')
    expect(useCore.getState()).toMatchObject({
      conversationInspectorOpen: true, conversationInspectorTab: 'changes',
      inspectorFile: { kind: 'conversation', id: chat.id, project: '/project/web', file: '/project/web/src/app.ts' }
    })
    const previous = useCore.getState().inspectorFile?.revision
    surface.showFileChange('../web/src/app.ts')
    expect(useCore.getState().inspectorFile?.revision).not.toBe(previous)
    surface.showChanges()
    expect(useCore.getState()).toMatchObject({ conversationInspectorOpen: true, conversationInspectorTab: 'changes', inspectorFile: null })
  })

  it('opens task diffs and clears the selection when returning to the list', () => {
    useCore.setState({ taskInspectorTab: 'plan', terminalPanelOpen: true })
    showInspectorFile('task', task.id, '/project', '/wt/a.ts')
    expect(useCore.getState()).toMatchObject({
      inspectorOpen: true, taskInspectorTab: 'changes', terminalPanelOpen: false,
      inspectorFile: { kind: 'task', id: task.id, project: '/project', file: '/wt/a.ts' }
    })
    clearInspectorFile()
    expect(useCore.getState()).toMatchObject({ inspectorOpen: true, inspectorFile: null })
    showInspectorFile('task', task.id, '/project', 'b.ts')
    showTaskChanges()
    expect(useCore.getState().inspectorFile).toBeNull()
  })

  it('does not carry file selection to a different owner or chat surface', () => {
    selectTask(task.id)
    showInspectorFile('task', task.id, '/project', 'a.ts')
    selectTask(task.id)
    expect(useCore.getState().inspectorFile?.file).toBe('a.ts')
    selectTask('another')
    expect(useCore.getState().inspectorFile).toBeNull()
    selectConversation(chat.id)
    showInspectorFile('conversation', chat.id, '/project', 'b.ts')
    selectConversation('another')
    expect(useCore.getState().inspectorFile).toBeNull()
    showInspectorFile('conversation', 'another', '/project', 'b.ts')
    selectTask(task.id)
    expect(useCore.getState().inspectorFile).toBeNull()
    showInspectorFile('conversation', chat.id, '/project', 'b.ts')
    showConversationChanges()
    expect(useCore.getState().inspectorFile).toBeNull()
  })
})

describe('attention navigation', () => {
  it('closes every other main page when the aggregate opens', () => {
    useCore.setState({
      selectedId: 'task', selectedConversationId: 'chat', section: 'conversations', conversationDraft: true,
      settingsOpen: true, dashboardOpen: true, schedulesOpen: true, worktreesOpen: true, inboxOpen: true
    })
    setAttentionOpen(true)
    expect(useCore.getState()).toMatchObject({
      attentionOpen: true, selectedId: null, selectedConversationId: null, section: 'tasks', conversationDraft: false,
      settingsOpen: false, dashboardOpen: false, schedulesOpen: false, worktreesOpen: false, inboxOpen: false
    })
  })

  it.each([
    ['task', () => selectTask('task')], ['conversation', () => selectConversation('chat')],
    ['draft', openConversationDraft], ['inbox', openInbox], ['settings', () => setSettingsOpen(true)],
    ['dashboard', () => setDashboardOpen(true)], ['schedules', () => setSchedulesOpen(true)],
    ['worktrees', () => setWorktreesOpen(true)]
  ])('closes the aggregate when opening %s', (_label, open) => {
    setAttentionOpen(true)
    open()
    expect(useCore.getState().attentionOpen).toBe(false)
  })

  it('opens the task chat and changes inspector for review, without resolving any reason', () => {
    useCore.setState({ tasks: { task }, conversations: { chat }, taskInspectorTab: 'plan' })
    const items = actionableItems(useCore.getState())
    const item = items[0]
    if (!item) throw new Error('expected a review item')
    setAttentionOpen(true)
    openAttentionItem(item)
    expect(useCore.getState()).toMatchObject({ attentionOpen: false, selectedId: task.id, view: 'chat', inspectorOpen: true, taskInspectorTab: 'changes' })
    expect(actionableItems(useCore.getState())).toEqual(items)
  })

  it('opens a review without chat on its details and an approval in its existing chat', () => {
    const withoutChat = { ...task, conversationId: null }
    useCore.setState({ tasks: { task: withoutChat } })
    const review = actionableItems(useCore.getState())[0]
    if (!review) throw new Error('expected a review item')
    openAttentionItem(review)
    expect(useCore.getState().view).toBe('detail')
    const free = { ...chat, taskId: null }
    useCore.setState({ tasks: {}, conversations: { chat: free }, unseen: { chat: true } })
    const item = actionableItems(useCore.getState())[0]
    if (!item) throw new Error('expected an approval item')
    setAttentionOpen(true)
    openAttentionItem(item)
    expect(useCore.getState()).toMatchObject({ section: 'conversations', selectedConversationId: 'chat', attentionOpen: false, unseen: {} })
    expect(actionableItems(useCore.getState())).toEqual([item])
  })

  it('does not navigate to a task deleted or finished since its row rendered', () => {
    const item = actionableItems({ tasks: { task }, conversations: {} })[0]
    if (!item) throw new Error('expected a review item')
    setAttentionOpen(true)
    openAttentionItem(item)
    expect(useCore.getState().attentionOpen).toBe(true)
    useCore.setState({ tasks: { task: { ...task, status: 'done' } } })
    openAttentionItem(item)
    expect(useCore.getState().attentionOpen).toBe(true)
  })
})

describe('attention snapshot retry', () => {
  function connect(features = ['task-conversation-summaries']) {
    const sent: Array<{ id: number; params: unknown }> = []
    const client = createRpcClient((frame) => sent.push(JSON.parse(frame)))
    const rpc: RpcConnection = { ...client, features, close: () => {}, closed: new Promise(() => {}) }
    useCore.setState({ rpc, connection: 'connected', conversations: { chat }, attentionSummaryLoading: false, attentionSummaryError: 'previous failure' })
    return { rpc, sent }
  }

  it('keeps the previous data on failure and replaces it after a successful retry', async () => {
    const { rpc, sent } = connect()
    const loading = refreshAttentionSummaries()
    expect(useCore.getState().attentionSummaryLoading).toBe(true)
    await refreshAttentionSummaries()
    expect(sent).toHaveLength(1)
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, error: { code: -32000, message: 'snapshot failed' } }))
    await loading
    expect(useCore.getState()).toMatchObject({ conversations: { chat }, attentionSummaryError: 'snapshot failed', attentionSummaryLoading: false })
    const retry = refreshAttentionSummaries()
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[1]?.id, result: [] }))
    await retry
    expect(useCore.getState()).toMatchObject({ conversations: {}, attentionSummaryError: null, attentionSummaryLoading: false, attentionSummaryMode: 'complete' })
  })

  it('does not apply a reply from a connection that has since been replaced', async () => {
    const { rpc, sent } = connect()
    const loading = refreshAttentionSummaries()
    useCore.setState({ rpc: null, connection: 'connecting' })
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: [] }))
    await loading
    expect(useCore.getState().conversations).toEqual({ chat })
  })

  it('keeps loaded task chats on a limited core while refreshing independent summaries', async () => {
    const { rpc, sent } = connect([])
    const loading = refreshAttentionSummaries()
    expect(sent[0]?.params).toEqual({})
    rpc.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: [] }))
    await loading
    expect(useCore.getState()).toMatchObject({ conversations: { chat }, attentionSummaryMode: 'limited', attentionSummaryLoading: false })
  })
})
