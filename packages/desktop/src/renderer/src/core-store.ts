import { useMemo } from 'react'
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
  type Routine,
  type RpcParams,
  type SourceDescriptor,
  type SourceInbox,
  type SourceProblem,
  type Task,
  type Terminal,
  type TerminalCommand,
  type SavedChatCommand,
  type Conversation,
  type ComputerAwakeStatus,
  type ChatSettings,
  type Environment,
  type ScheduledRun
} from '@kando/protocol'
import { receiveChatDelta, receiveChatItems } from './chat-state'
import { activeInboxes, inboxKey } from './source-inboxes'
import type { BrowserStatus } from '@kando/protocol'
import { focusBrowserConversation, focusBrowserTab, receiveBrowserTabs } from './browser-state'
import type { InspectorTab } from './components/Inspector'
import { resolveCoreEndpoint } from './core-endpoint'
import { reasonText } from './labels'
import { openUtilityPanel, visibleUtilityPanelOrder, type UtilityPanelKind, type UtilityPanelsOpen } from './utility-panel-order'
import { exclusivePanels } from './side-panels'
import { actionableItems, type ActionableItem } from './attention'
import { attentionSummaryMode, fetchAttentionSummaries, replaySummaryChanges, type AttentionSummaryMode } from './attention-summaries'

export type ConnectionState = 'waiting-for-core' | 'connecting' | 'connected'

// What the right-hand pane shows for the selected task.
// terminal: a task's agent in a terminal · chat: a task started in the chat view, in its chat
export type TaskView = 'detail' | 'chat'
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

export type CoreState = {
  connection: ConnectionState
  rpc: RpcConnection | null
  tasks: Record<string, Task>
  conversations: Record<string, Conversation>
  // Conversations whose turn finished while the user was elsewhere, until they look.
  unseen: Readonly<Record<string, true>>
  section: Section
  selectedConversationId: string | null
  // The page a new conversation starts from while chats are the default (see ConversationDraft).
  conversationDraft: boolean
  selectedId: string | null
  view: TaskView
  // The inspector beside a task's terminal or chat, kept open from one task to the next, on the
  // tab last shown; a chat task's plan tab shows taskInspectorPlan (an item key; null: the newest).
  inspectorOpen: boolean
  taskInspectorTab: InspectorTab
  taskInspectorPlan: string | null
  // A conversation's, which the user opens, or a plan the agent proposes; on the tab last shown.
  conversationInspectorOpen: boolean
  conversationInspectorTab: InspectorTab
  // The plan its plan tab shows, by item key; null for the newest.
  conversationPlan: string | null
  // The hosted browser as core last reported it; null until core says, or on a core without one.
  browser: BrowserStatus | null
  awake: ComputerAwakeStatus | null
  // How chats run, as core keeps them; null until core says, or on a core without them.
  chatSettings: ChatSettings | null
  // What core found of git and the agent CLIs; null until it says, or on a core that does not look.
  environment: Environment | null
  newTaskOpen: boolean
  settingsOpen: boolean
  // Which settings section to show when settings open; null keeps the first.
  settingsSection: string | null
  // The source inbox takes the right-hand pane instead of a task.
  inboxOpen: boolean
  // The inbox tab last shown, as an inboxKey; the tabs appear once two sources are signed in.
  inboxTab: string | null
  // So does the page of worktrees, over whatever else was shown there.
  worktreesOpen: boolean
  // And the page of scheduled runs.
  schedulesOpen: boolean
  // And the page of routines.
  routinesOpen: boolean
  // The routines as core keeps them, each with how many of its runs the user has yet to look at;
  // empty on a core without them.
  routines: Routine[]
  // And the dashboard of stats.
  dashboardOpen: boolean
  attentionOpen: boolean
  attentionSummaryMode: AttentionSummaryMode | null
  attentionSummaryLoading: boolean
  attentionSummaryError: string | null
  // What is scheduled to start later, open ones first in the order they go; empty from a core without.
  schedules: ScheduledRun[]
  error: string | null
  // null until core answers usage.list; an older core without it leaves it null.
  usage: Partial<Record<AgentKind, AgentUsage>> | null
  // null until core answers sources.list.
  sources: SourceDescriptor[] | null
  inboxes: Record<string, SourceInbox>
  // Shells in the app's terminal panel, oldest first. The panel only hides them; they keep running.
  terminals: Terminal[]
  terminalPanelOpen: boolean
  terminalMaximized: boolean
  portsPanelOpen: boolean
  portsMaximized: boolean
  // The browser panel in the shared utility dock: every tab there is, the user's own included.
  browserPanelOpen: boolean
  browserMaximized: boolean
  // Top to bottom among the utility panels that are open; reopening one moves it to the end.
  utilityPanelOrder: UtilityPanelKind[]
  activeTerminalId: string | null
  // Commands kept for the terminal panel, oldest first; empty from a core that keeps none.
  terminalCommands: TerminalCommand[]
  // The user's own chat commands, oldest first; empty from a core that keeps none.
  chatCommands: SavedChatCommand[]
  login: LoginState | null
}

export const useCore = create<CoreState>()(() => ({
  connection: 'connecting',
  rpc: null,
  tasks: {},
  conversations: {},
  unseen: {},
  section: 'tasks',
  selectedConversationId: null,
  conversationDraft: false,
  selectedId: null,
  view: 'detail',
  inspectorOpen: false,
  taskInspectorTab: 'changes',
  taskInspectorPlan: null,
  conversationInspectorOpen: false,
  conversationInspectorTab: 'changes',
  conversationPlan: null,
  browser: null,
  awake: null,
  chatSettings: null,
  environment: null,
  newTaskOpen: false,
  settingsOpen: false,
  settingsSection: null,
  inboxOpen: false,
  inboxTab: null,
  worktreesOpen: false,
  schedulesOpen: false,
  routinesOpen: false,
  dashboardOpen: false,
  attentionOpen: false,
  attentionSummaryMode: null,
  attentionSummaryLoading: true,
  attentionSummaryError: null,
  schedules: [],
  routines: [],
  error: null,
  usage: null,
  sources: null,
  inboxes: {},
  terminals: [],
  terminalPanelOpen: false,
  terminalMaximized: false,
  portsPanelOpen: false,
  portsMaximized: false,
  browserPanelOpen: false,
  browserMaximized: false,
  utilityPanelOrder: [],
  activeTerminalId: null,
  terminalCommands: [],
  chatCommands: [],
  login: null
}))

// One side of the room beside the content at a time: the terminal panel or an inspector.
useCore.subscribe((next, previous) => {
  const patch = exclusivePanels(next, previous)
  if (patch) useCore.setState(patch)
})

// A started task opens on its chat until it is closed: that is where the work happens. One under
// review opens with the inspector showing what the agent changed.
export function selectTask(id: string | null): void {
  useCore.setState((s) => {
    const task = id ? s.tasks[id] : undefined
    const review = task?.status === 'review'
    const chat = task?.conversationId && task.status !== 'done' && task.status !== 'abandoned'
    return {
      selectedId: id,
      section: 'tasks',
      inboxOpen: false,
      worktreesOpen: false,
      schedulesOpen: false,
      routinesOpen: false,
      dashboardOpen: false,
      attentionOpen: false,
      settingsOpen: false,
      view: chat ? 'chat' : 'detail',
      inspectorOpen: review || s.inspectorOpen
    }
  })
}

export function setTaskInspectorTab(tab: InspectorTab): void {
  useCore.setState({ taskInspectorTab: tab })
}

export function showTaskChanges(): void {
  useCore.setState({ inspectorOpen: true, taskInspectorTab: 'changes' })
}

// One of a chat task's plans by item key, or null for its newest.
export function showTaskPlan(key: string | null): void {
  useCore.setState({ inspectorOpen: true, taskInspectorTab: 'plan', taskInspectorPlan: key })
}

// Older cores list only free conversations, so a task's view may still need its summary.
export async function loadConversation(id: string): Promise<void> {
  const conversation = await perform((rpc) => rpc.call('conversations.get', { id }))
  if (conversation) useCore.setState((s) => ({ conversations: { ...s.conversations, [conversation.id]: conversation } }))
}

export function setInspectorOpen(open: boolean): void {
  useCore.setState({ inspectorOpen: open })
}

export function setConversationInspectorOpen(open: boolean): void {
  useCore.setState({ conversationInspectorOpen: open })
}

export function setConversationInspectorTab(tab: InspectorTab): void {
  useCore.setState({ conversationInspectorTab: tab })
}

export function showConversationChanges(): void {
  useCore.setState({ conversationInspectorOpen: true, conversationInspectorTab: 'changes' })
}

// One of the conversation's plans by item key, or null for its newest.
export function showConversationPlan(key: string | null): void {
  useCore.setState({ conversationInspectorOpen: true, conversationInspectorTab: 'plan', conversationPlan: key })
}

type UtilityPanelState = Pick<CoreState, 'utilityPanelOrder' | 'browserPanelOpen' | 'terminalPanelOpen' | 'portsPanelOpen' | 'browserMaximized' | 'terminalMaximized' | 'portsMaximized'>

// The browser, terminal and ports panels as the dock's order says, which is what decides: those in
// it are open, and a maximized one stays so only while it is, and only if asked to.
function utilityPanels(s: CoreState, order: UtilityPanelKind[], keepMaximized: boolean): UtilityPanelState {
  const open = (panel: UtilityPanelKind) => order.includes(panel)
  return {
    utilityPanelOrder: order,
    browserPanelOpen: open('browser'),
    terminalPanelOpen: open('terminal'),
    portsPanelOpen: open('ports'),
    browserMaximized: keepMaximized && s.browserMaximized && open('browser'),
    terminalMaximized: keepMaximized && s.terminalMaximized && open('terminal'),
    portsMaximized: keepMaximized && s.portsMaximized && open('ports')
  }
}

function openPanels(s: CoreState): UtilityPanelsOpen {
  return { browser: s.browserPanelOpen, terminal: s.terminalPanelOpen, ports: s.portsPanelOpen }
}

// One panel brought up: below what is open, the top one going past two, and no other left
// maximized over it. Nothing changes for one already up.
function shownUtilityPanel(s: CoreState, panel: UtilityPanelKind): Partial<UtilityPanelState> {
  if (openPanels(s)[panel]) return {}
  return utilityPanels(s, openUtilityPanel(s.utilityPanelOrder, openPanels(s), panel), false)
}

function hiddenUtilityPanel(s: CoreState, panel: UtilityPanelKind): UtilityPanelState {
  return utilityPanels(s, visibleUtilityPanelOrder(s.utilityPanelOrder, openPanels(s)).filter((each) => each !== panel), true)
}

// Opens the browser panel on a conversation's tab: the one it has, or the one about to appear.
export function showBrowserPanel(conversationId: string | null): void {
  useCore.setState((s) => shownUtilityPanel(s, 'browser'))
  if (conversationId) focusBrowserConversation(conversationId)
}

// Opens the browser panel on one tab, from the page's card in the chat.
export function showBrowserTab(tabId: string): void {
  useCore.setState((s) => shownUtilityPanel(s, 'browser'))
  focusBrowserTab(tabId)
}

// A new terminal starts in the folder of whatever the user is looking at: a task's worktree, a
// conversation's project. Core falls back to home.
function contextFolder(s: CoreState): string | undefined {
  if (s.section === 'conversations') {
    const conversation = s.selectedConversationId ? s.conversations[s.selectedConversationId] : undefined
    return conversation && !conversation.managedWorkspace ? conversation.workspacePath : undefined
  }
  const repo = (s.selectedId ? s.tasks[s.selectedId] : undefined)?.repos[0]
  return repo ? repo.worktreePath ?? repo.path : undefined
}

// Keeps the tab the user was on while it exists, else the newest one.
function activeAmong(id: string | null, terminals: readonly Terminal[]): string | null {
  return terminals.some((terminal) => terminal.id === id) ? id : terminals.at(-1)?.id ?? null
}

export async function openTerminal(cwd = contextFolder(useCore.getState())): Promise<Terminal | null> {
  const terminal = await perform((rpc) => rpc.call('terminals.open', { cwd }))
  if (terminal) {
    useCore.setState((s) => ({
      terminals: s.terminals.some((each) => each.id === terminal.id) ? s.terminals : [...s.terminals, terminal],
      activeTerminalId: terminal.id,
      ...shownUtilityPanel(s, 'terminal')
    }))
  }
  return terminal
}

// The list updates when core says so, through terminals.changed.
export function closeTerminal(id: string): void {
  void perform((rpc) => rpc.call('terminals.close', { id }))
}

export function selectTerminal(id: string): void {
  useCore.setState({ activeTerminalId: id })
}

// Brings up the panel on one terminal, as an agent's tool card does for the command it started.
export function showTerminal(id: string): void {
  useCore.setState((s) => ({ activeTerminalId: id, ...shownUtilityPanel(s, 'terminal') }))
}

// Opening the panel with nothing in it starts a shell right away.
export async function toggleTerminalPanel(): Promise<void> {
  const { terminalPanelOpen, terminals } = useCore.getState()
  const open = !terminalPanelOpen
  useCore.setState((s) => (open ? shownUtilityPanel(s, 'terminal') : hiddenUtilityPanel(s, 'terminal')))
  if (open && terminals.length === 0) await openTerminal()
}

export function togglePortsPanel(): void {
  useCore.setState((s) => (s.portsPanelOpen ? hiddenUtilityPanel(s, 'ports') : shownUtilityPanel(s, 'ports')))
}

export function setPortsMaximized(maximized: boolean): void {
  useCore.setState({ portsMaximized: maximized, ...(maximized ? { terminalMaximized: false, browserMaximized: false } : {}) })
}

// The list updates when core says so, through terminalCommands.changed.
export function saveTerminalCommand(params: RpcParams<'terminalCommands.save'>): Promise<TerminalCommand | null> {
  return perform((rpc) => rpc.call('terminalCommands.save', params))
}

export function deleteTerminalCommand(id: string): void {
  void perform((rpc) => rpc.call('terminalCommands.delete', { id }))
}

// The list updates when core says so, through chatCommands.changed.
export function saveChatCommand(params: RpcParams<'chatCommands.save'>): Promise<SavedChatCommand | null> {
  return perform((rpc) => rpc.call('chatCommands.save', params))
}

export function deleteChatCommand(id: string): void {
  void perform((rpc) => rpc.call('chatCommands.delete', { id }))
}

export function setTerminalMaximized(maximized: boolean): void {
  useCore.setState({ terminalMaximized: maximized, ...(maximized ? { browserMaximized: false, portsMaximized: false } : {}) })
}

export function toggleBrowserPanel(): void {
  useCore.setState((s) => (s.browserPanelOpen ? hiddenUtilityPanel(s, 'browser') : shownUtilityPanel(s, 'browser')))
}

export function setBrowserMaximized(maximized: boolean): void {
  useCore.setState({ browserMaximized: maximized, ...(maximized ? { terminalMaximized: false, portsMaximized: false } : {}) })
}

export function selectConversation(id: string | null): void {
  useCore.setState((s) => {
    const { [id ?? '']: _seen, ...unseen } = s.unseen
    return { selectedConversationId: id, section: 'conversations', settingsOpen: false, worktreesOpen: false, schedulesOpen: false, routinesOpen: false, dashboardOpen: false, attentionOpen: false, conversationDraft: false, unseen }
  })
  if (id) markRoutineRunSeen(id)
}

// Opening a routine's conversation is looking at its run, whose id the conversation shares; core
// keeps that, so every window and the dock count agree. Harmless on any other conversation.
export function markRoutineRunSeen(conversationId: string): void {
  const { conversations, rpc } = useCore.getState()
  if (!conversations[conversationId]?.routineId || !rpc?.features.includes('routines')) return
  void rpc.call('routines.markSeen', { runId: conversationId }).catch(() => {})
}

// A turn that was going and is now over, in a conversation the user is not looking at. A
// routine's conversation is left out: core keeps whether its run was looked at.
function finishedUnseen(s: CoreState, previous: Conversation | undefined, next: Conversation): boolean {
  if (next.routineId) return false
  const working = previous?.chat?.turn === 'running' || previous?.chat?.turn === 'awaiting'
  const looking = s.section === 'conversations' && s.selectedConversationId === next.id
  return working && next.chat?.turn !== 'running' && next.chat?.turn !== 'awaiting' && !looking
}

export function openConversationDraft(): void {
  useCore.setState({ selectedConversationId: null, section: 'conversations', settingsOpen: false, worktreesOpen: false, schedulesOpen: false, routinesOpen: false, dashboardOpen: false, attentionOpen: false, conversationDraft: true })
}

export function closeConversationDraft(): void {
  useCore.setState({ conversationDraft: false })
}

// The sidebar entry shows a failure in place of the count, so opening it then shows that failure.
export function openInbox(): void {
  useCore.setState((s) => ({
    section: 'tasks',
    inboxOpen: true,
    inboxTab: activeInboxes(s.sources, s.inboxes).find((entry) => entry.inbox.problem)?.key ?? s.inboxTab,
    selectedId: null,
    settingsOpen: false,
    worktreesOpen: false,
    schedulesOpen: false,
    routinesOpen: false,
    dashboardOpen: false,
    attentionOpen: false
  }))
}

export function setInboxTab(key: string): void {
  useCore.setState({ inboxTab: key })
}

export function showView(view: TaskView): void {
  useCore.setState({ view })
}

export function setNewTaskOpen(open: boolean): void {
  useCore.setState({ newTaskOpen: open })
}

export function setSettingsOpen(open: boolean, section: string | null = null): void {
  useCore.setState({ settingsOpen: open, settingsSection: section, ...(open ? { attentionOpen: false } : {}) })
}

export function setWorktreesOpen(open: boolean): void {
  useCore.setState({ worktreesOpen: open, schedulesOpen: false, routinesOpen: false, dashboardOpen: false, attentionOpen: false, settingsOpen: false })
}

export function setSchedulesOpen(open: boolean): void {
  useCore.setState({ schedulesOpen: open, routinesOpen: false, worktreesOpen: false, dashboardOpen: false, attentionOpen: false, settingsOpen: false })
}

export function setRoutinesOpen(open: boolean): void {
  useCore.setState({ routinesOpen: open, schedulesOpen: false, worktreesOpen: false, dashboardOpen: false, attentionOpen: false, settingsOpen: false })
}

// Opened from the task list, so it takes the place of the selected task as the inbox does.
export function setDashboardOpen(open: boolean): void {
  useCore.setState(open
    ? { dashboardOpen: true, attentionOpen: false, section: 'tasks', selectedId: null, inboxOpen: false, worktreesOpen: false, schedulesOpen: false, routinesOpen: false, settingsOpen: false }
    : { dashboardOpen: false })
}

export function setAttentionOpen(open: boolean): void {
  useCore.setState(open
    ? { attentionOpen: true, section: 'tasks', selectedId: null, selectedConversationId: null, conversationDraft: false, inboxOpen: false, worktreesOpen: false, schedulesOpen: false, routinesOpen: false, dashboardOpen: false, settingsOpen: false }
    : { attentionOpen: false })
}

export function useActionableItems(): ActionableItem[] {
  const tasks = useCore((s) => s.tasks)
  const conversations = useCore((s) => s.conversations)
  const mode = useCore((s) => s.attentionSummaryMode)
  const schedules = useCore((s) => s.schedules)
  return useMemo(() => actionableItems({ tasks, conversations, schedules }, mode === 'complete'), [tasks, conversations, schedules, mode])
}

export function openAttentionItem(item: ActionableItem): void {
  if (item.target.kind === 'conversation') {
    if (useCore.getState().conversations[item.target.id]) selectConversation(item.target.id)
  } else {
    const task = useCore.getState().tasks[item.target.id]
    if (!task || task.status === 'done' || task.status === 'abandoned') return
    selectTask(task.id)
    if (task.status === 'review' && task.conversationId) showTaskChanges()
  }
}

export async function refreshAttentionSummaries(): Promise<void> {
  const { rpc, attentionSummaryLoading } = useCore.getState()
  if (!rpc || attentionSummaryLoading) return
  useCore.setState({ attentionSummaryLoading: true, attentionSummaryError: null })
  try {
    const conversations = await fetchAttentionSummaries(rpc)
    if (useCore.getState().rpc !== rpc) return
    useCore.setState((s) => ({
      conversations: attentionSummaryMode(rpc) === 'complete' ? conversations : {
        ...Object.fromEntries(Object.values(s.conversations).filter((c) => c.taskId).map((c) => [c.id, c])),
        ...conversations
      },
      attentionSummaryMode: attentionSummaryMode(rpc), attentionSummaryLoading: false, attentionSummaryError: null
    }))
  } catch (error) {
    if (useCore.getState().rpc === rpc) useCore.setState({ attentionSummaryLoading: false, attentionSummaryError: error instanceof Error ? error.message : String(error) })
  }
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

// Whether the core this window talks to can switch a chat stage's permission mode, model and effort.
export function useChatOptionsSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('chat-options') ?? false)
}

// Whether a chat message can carry images.
export function useChatImagesSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('chat-images') ?? false)
}

// Whether core can look a file up by name in the projects (projects.findFile).
export function useFindFileSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('find-file') ?? false)
}

// Whether core can search the projects for the composer's @ menu (projects.searchFiles).
// A core that sends a scheduled message's pictures with it.
export function useScheduleImagesSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('schedule-images') ?? false)
}

// A core that carries a plan out in any permission mode the stage offers, not only ask or edits.
export function usePlanModesSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('plan-modes') ?? false)
}

export function useFileMentionsSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('file-mentions') ?? false)
}

// Whether a new conversation can work in worktrees of its projects rather than in them.
export function useConversationWorktreesSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('conversation-worktrees') ?? false)
}

export function useStartBranchSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('conversation-start-branch') ?? false)
}

// Whether core keeps conversations pinned to the top of the list.
export function useConversationPinSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('conversation-pin') ?? false)
}

export function useWorktreesSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('worktrees') ?? false)
}

// An older core keeps no starts, and would drop a picked one without a word.
// Whether core hosts a browser for chat agents.
export function useBrowserSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('browser') ?? false)
}

export function useUsageLimitSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('usage-limit') ?? false)
}

export function useAgentStatsSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('agent-stats') ?? false)
}

export function useConversationStatsSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('conversation-stats') ?? false)
}

export function useDashboardSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('dashboard') ?? false)
}

export async function setChatSettings(patch: Partial<ChatSettings>): Promise<void> {
  const settings = await perform((rpc) => rpc.call('system.setChatSettings', patch))
  if (settings) useCore.setState({ chatSettings: settings })
}

export function useEnvironmentSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('environment') ?? false)
}

// Looks at the machine again, for the user who has just installed something.
export async function refreshEnvironment(): Promise<void> {
  const environment = await perform((rpc) => rpc.call('system.environment', { refresh: true }))
  if (environment) useCore.setState({ environment })
}

export function useAwakeSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('keep-awake') ?? false)
}

export async function setAwakeMode(mode: ComputerAwakeStatus['mode']): Promise<void> {
  const status = await perform((rpc) => rpc.call('system.setAwakeMode', { mode }))
  if (status) useCore.setState({ awake: status })
}

export function useTerminalCommandsSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('terminal-commands') ?? false)
}

export function useChatCommandsSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('chat-commands') ?? false)
}

// Whether core starts tasks and conversations later on their own (schedules.*).
export function useSchedulesSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('schedules') ?? false)
}

// Whether core runs routines, rules that open a conversation on a schedule (routines.*).
export function useRoutinesSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('routines') ?? false)
}

export function useTaskStartSupported(): boolean {
  return useCore((s) => s.rpc?.features.includes('task-start') ?? false)
}

export function showError(message: string): void {
  useCore.setState({ error: message })
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
        let initialized = false
        const taskChanges = new Map<string, Task | null>()
        const conversationChanges = new Map<string, Conversation | null>()
        let changedSchedules: ScheduledRun[] | null = null
        let changedRoutines: Routine[] | null = null
        useCore.setState({ attentionSummaryLoading: true, attentionSummaryError: null })
        rpc.on('tasks.changed', ({ task }) => {
          if (!initialized) taskChanges.set(task.id, task)
          useCore.setState((s) => ({ tasks: { ...s.tasks, [task.id]: task } }))
        })
        rpc.on('tasks.deleted', ({ id }) => {
          if (!initialized) taskChanges.set(id, null)
          useCore.setState((s) => {
            const { [id]: _removed, ...tasks } = s.tasks
            return { tasks, selectedId: s.selectedId === id ? null : s.selectedId }
          })
        })
        rpc.on('conversations.changed', ({ conversation }) => {
          if (!initialized) conversationChanges.set(conversation.id, conversation)
          useCore.setState((s) => ({
            conversations: { ...s.conversations, [conversation.id]: conversation },
            ...(finishedUnseen(s, s.conversations[conversation.id], conversation) ? { unseen: { ...s.unseen, [conversation.id]: true } } : {})
          }))
        })
        rpc.on('conversations.deleted', ({ id }) => {
          if (!initialized) conversationChanges.set(id, null)
          useCore.setState((s) => {
            const { [id]: _removed, ...conversations } = s.conversations
            return { conversations, selectedConversationId: s.selectedConversationId === id ? null : s.selectedConversationId }
          })
        })
        rpc.on('conversations.chatItems', ({ conversationId, items }) => receiveChatItems(conversationId, items))
        rpc.on('conversations.chatDelta', ({ conversationId, stageId, itemId, append }) => receiveChatDelta(conversationId, stageId, itemId, append))
        rpc.on('browser.changed', ({ status }) => useCore.setState({ browser: status }))
        rpc.on('system.awakeChanged', ({ status }) => useCore.setState({ awake: status }))
        rpc.on('system.chatSettingsChanged', ({ settings }) => useCore.setState({ chatSettings: settings }))
        rpc.on('browser.tabsChanged', ({ conversationId, tabs }) => receiveBrowserTabs(conversationId, tabs))
        rpc.on('usage.changed', ({ usage }) =>
          useCore.setState((s) => ({ usage: { ...s.usage, [usage.agent]: usage } }))
        )
        rpc.on('sources.listChanged', ({ sources }) => useCore.setState({ sources }))
        // The last shell exiting puts the panel away, as closing the last tab would.
        rpc.on('terminals.changed', ({ terminals }) =>
          useCore.setState((s) => ({
            terminals,
            activeTerminalId: activeAmong(s.activeTerminalId, terminals),
            ...(terminals.length === 0 && s.terminalPanelOpen ? hiddenUtilityPanel(s, 'terminal') : {})
          }))
        )
        rpc.on('terminalCommands.changed', ({ commands }) => useCore.setState({ terminalCommands: commands }))
        rpc.on('chatCommands.changed', ({ commands }) => useCore.setState({ chatCommands: commands }))
        rpc.on('schedules.changed', ({ runs }) => {
          if (!initialized) changedSchedules = runs
          useCore.setState({ schedules: runs })
        })
        rpc.on('routines.changed', ({ routines }) => {
          if (!initialized) changedRoutines = routines
          useCore.setState({ routines })
        })
        rpc.on('sources.inboxChanged', ({ inbox }) =>
          useCore.setState((s) => ({ inboxes: { ...s.inboxes, [inboxKey(inbox)]: inbox } }))
        )
        rpc.on('sources.loginPrompt', ({ flowId, promptId, prompt }) => patchLogin(flowId, () => ({ prompt: { promptId, prompt } })))
        rpc.on('sources.loginNotice', ({ flowId, notice }) => patchLogin(flowId, (login) => ({ notices: [...login.notices, notice] })))
        rpc.on('sources.loginFinished', ({ flowId, account, problem }) =>
          patchLogin(flowId, () => ({ prompt: null, result: { account, problem } }))
        )
        const tasks = await rpc.call('tasks.list', {})
        let conversations: Record<string, Conversation> | null = null
        let summaryError: string | null = null
        try {
          conversations = await fetchAttentionSummaries(rpc)
        } catch (error) {
          summaryError = error instanceof Error ? error.message : String(error)
        }
        const usage = await rpc.call('usage.list', {}).catch(() => null)
        const sources = await rpc.call('sources.list', {})
        const inboxes = await rpc.call('sources.inbox', {})
        const terminals = await rpc.call('terminals.list', {}).catch(() => [])
        const terminalCommands = rpc.features.includes('terminal-commands') ? await rpc.call('terminalCommands.list', {}).catch(() => []) : []
        // Asked only of a core that has one, and never waited for: it starts the host when it is down.
        if (rpc.features.includes('browser')) void rpc.call('browser.status', {}).then((status) => useCore.setState({ browser: status })).catch(() => {})
        if (rpc.features.includes('keep-awake')) void rpc.call('system.awakeStatus', {}).then((awake) => useCore.setState({ awake })).catch(() => {})
        if (rpc.features.includes('prompt-suggestions')) void rpc.call('system.chatSettings', {}).then((chatSettings) => useCore.setState({ chatSettings })).catch(() => {})
        const schedules = rpc.features.includes('schedules') ? await rpc.call('schedules.list', {}).catch(() => []) : []
        const routines = rpc.features.includes('routines') ? await rpc.call('routines.list', {}).catch(() => []) : []
        if (rpc.features.includes('chat-commands')) void rpc.call('chatCommands.list', {}).then((chatCommands) => useCore.setState({ chatCommands })).catch(() => {})
        if (rpc.features.includes('environment')) void rpc.call('system.environment', {}).then((environment) => useCore.setState({ environment })).catch(() => {})
        useCore.setState((s) => ({
          rpc,
          connection: 'connected',
          tasks: replaySummaryChanges(tasks, taskChanges),
          conversations: replaySummaryChanges(Object.values(conversations ?? s.conversations), conversationChanges),
          schedules: changedSchedules ?? schedules,
          routines: changedRoutines ?? routines,
          attentionSummaryMode: attentionSummaryMode(rpc),
          attentionSummaryLoading: false,
          attentionSummaryError: summaryError,
          usage: usage && byAgent(usage),
          sources,
          inboxes: Object.fromEntries(inboxes.map((inbox) => [inboxKey(inbox), inbox])),
          terminals,
          activeTerminalId: activeAmong(s.activeTerminalId, terminals),
          terminalCommands,
          inboxOpen: s.inboxOpen && inboxes.some((inbox) => inbox.active)
        }))
        initialized = true
        taskChanges.clear()
        conversationChanges.clear()
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
