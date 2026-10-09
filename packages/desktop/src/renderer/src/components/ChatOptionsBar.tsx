import type { AgentKind, ChatContextUse, ChatItem, ChatModel, ChatOption, ChatPermissionMode, Conversation } from '@kando/protocol'
import { perform } from '../core-store'
import { usePreferences } from '../preferences'
import { ChatModelPicker, ChatPicker, type PickerOption } from './ChatPicker'

type StateItem = Extract<ChatItem, { kind: 'state' }>

// Kando's permission modes as each agent's users know them; the Codex default reads "auto".
const MODE_LABEL: Record<AgentKind, Record<string, string>> = {
  claude: { ask: '逐项确认', acceptEdits: '自动接受编辑', plan: '规划', auto: '自动判断', bypass: '全部放行' },
  codex: { ask: '逐项确认', acceptEdits: '自动', plan: '规划', readOnly: '只读', bypass: '全部放行' },
  cursor: { ask: 'Agent', plan: 'Plan', readOnly: 'Ask' }
}

export function modeLabel(agent: AgentKind, mode: string): string {
  return MODE_LABEL[agent][mode] ?? mode
}

// What each mode lets the agent do without asking, under its name in the menu.
const MODE_DESCRIPTION: Record<AgentKind, Record<string, string>> = {
  claude: {
    ask: '改文件、运行命令前都先问你',
    acceptEdits: '改文件不再问，运行命令仍会问',
    plan: '只读代码、给出计划，你确认后才动手',
    auto: '由模型判断哪些操作要先问你',
    bypass: '什么都不问，也不受限制'
  },
  codex: {
    ask: '每一步都先问你',
    acceptEdits: '在项目里自由修改，越界时才问',
    plan: '只读代码、给出计划，你确认后才动手',
    readOnly: '只能读，不能修改文件',
    bypass: '什么都不问，也不受沙箱限制'
  },
  cursor: {
    ask: 'Cursor 原生 Agent 模式，审批按 CLI 提供的选项处理',
    plan: '先探索代码并制定计划，确认后执行',
    readOnly: 'Cursor 原生 Ask 模式，用于提问和理解代码'
  }
}

// The modes as the picker lists them; one the agent offers but cannot be picked now stays greyed.
export function modeOptions(agent: AgentKind, modes: readonly string[], offered: readonly string[] = modes): PickerOption[] {
  return modes.map((mode) => ({
    value: mode,
    label: modeLabel(agent, mode),
    description: MODE_DESCRIPTION[agent][mode] ?? null,
    disabled: !offered.includes(mode)
  }))
}

// Only the modes worth a second look stand out: planning, and running with nothing asked.
export function modeTone(mode: string | null): string | undefined {
  return mode === 'plan' || mode === 'bypass' ? mode : undefined
}

// What a new conversation can start in, before its agent lists model-specific auto and optional
// bypass. The first is the fallback when its preferred default is unavailable.
export const START_MODES: Record<AgentKind, readonly ChatPermissionMode[]> = {
  claude: ['ask', 'acceptEdits', 'plan'],
  codex: ['acceptEdits', 'ask', 'plan', 'readOnly'],
  cursor: ['ask', 'plan', 'readOnly']
}

export const DEFAULT_START_MODES: Record<AgentKind, ChatPermissionMode> = {
  claude: 'auto',
  codex: 'acceptEdits',
  cursor: 'ask'
}

export function defaultStartMode(agent: AgentKind, offered: readonly ChatPermissionMode[]): ChatPermissionMode {
  const preferred = DEFAULT_START_MODES[agent]
  return offered.includes(preferred) ? preferred : START_MODES[agent][0]!
}

// Those, with auto where the model takes it (as the agent's catalog says) and bypass where the
// settings allow it, in the order a running chat lists them.
export function startModes(agent: AgentKind, model: ChatModel | undefined, allowBypass: boolean): ChatPermissionMode[] {
  return [...START_MODES[agent], ...(model?.autoMode && agent === 'claude' ? ['auto' as const] : []), ...(allowBypass && agent !== 'cursor' ? ['bypass' as const] : [])]
}

const EFFORT_LABEL: Record<string, string> = {
  none: '无',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  ultra: '超高'
}

export function effortLabel(effort: string): string {
  return EFFORT_LABEL[effort] ?? effort
}

function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}

// How full the context window is; before the window is known, only the tokens.
function ContextRing({ context }: { context: ChatContextUse }) {
  const ratio = context.window ? Math.min(1, context.used / context.window) : null
  const title = ratio === null
    ? `上下文 ${tokens(context.used)} tokens`
    : `上下文 ${Math.round(ratio * 100)}%（${tokens(context.used)} / ${tokens(context.window ?? 0)}）`
  const radius = 7
  const length = 2 * Math.PI * radius
  const level = ratio === null ? 'normal' : ratio >= 0.85 ? 'critical' : ratio >= 0.6 ? 'warning' : 'normal'
  return (
    <span className="chat-context" role="img" aria-label={title} data-tooltip={title} data-tooltip-side="top-end" data-level={level}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r={radius} className="chat-context-track" />
        {ratio !== null && (
          <circle cx="10" cy="10" r={radius} className="chat-context-fill" strokeDasharray={`${ratio * length} ${length}`} transform="rotate(-90 10 10)" />
        )}
      </svg>
      {ratio !== null && <span>{Math.round(ratio * 100)}%</span>}
    </span>
  )
}

// A choice the stage reports but does not list (a mode Kando has no name for) still shows.
function withCurrent(values: readonly string[], current: string | null): string[] {
  return current && !values.includes(current) ? [current, ...values] : [...values]
}

// The composer's toolbar, inside its box after the ＋: how freely the agent may act on the left; on
// the right, the model and effort it runs beside how full its context is. A click switches each;
// the model and effort change between turns, the mode at any time. With no agent running, the
// choices are for the next start, from what the last stage offered: as chosen since, or as that
// stage left them.
export function ChatOptionsBar({ conversation, state }: { conversation: Conversation; state: StateItem }) {
  const { id, agent, chatOptions: next } = conversation
  const running = conversation.sessionId !== null
  const allowBypass = usePreferences((s) => s.allowBypass)
  // An older core takes options only from a running agent.
  if (!running && !next) return null
  const idle = !running || conversation.chat?.turn === 'idle'
  const set = (option: ChatOption, value: string) => void perform((rpc) => rpc.call('conversations.setOption', { id, option, value }))
  const permissionMode = running ? state.permissionMode : (next?.permissionMode ?? state.permissionMode)
  const modelId = running ? state.model : (next?.model ?? state.model)
  // A model picked since takes its own default effort unless one was picked for it too.
  const effort = running ? state.effort : (next?.effort ?? (next?.model && next.model !== state.model ? null : state.effort))
  // The next start offers bypass by the setting as it is then; a task that only plans never.
  const offered = running || conversation.planOnly
    ? state.permissionModes
    : [...state.permissionModes.filter((mode) => mode !== 'bypass'), ...(allowBypass && agent !== 'cursor' ? ['bypass'] : [])]
  const model = state.models.find((each) => each.id === modelId)
  const modes = withCurrent(offered, permissionMode)
  const models = model || !modelId
    ? state.models
    : [{ id: modelId, label: modelId, description: null, efforts: [], isDefault: false }, ...state.models]
  const later = running ? null : '发下一条消息时按这个启动'
  return (
    <>
      {modes.length > 0 && (
        <ChatPicker
          label="权限模式"
          value={permissionMode}
          placeholder="权限模式"
          options={modeOptions(agent, modes, offered)}
          tone={modeTone(permissionMode)}
          disabled={agent === 'cursor' && !idle}
          title={later ?? undefined}
          onChange={(mode) => set('permissionMode', mode)}
        />
      )}
      <span className="chat-dock-spacer" />
      {models.length > 0 && (
        <ChatModelPicker
          models={models.map((each) => ({ value: each.id, label: each.label, description: each.description, efforts: each.efforts.map((one) => ({ value: one, label: effortLabel(one) })) }))}
          model={modelId}
          effort={effort}
          disabled={!idle}
          title={later ?? (idle ? undefined : '回合结束后才能换模型和推理强度')}
          onModel={(value) => set('model', value)}
          onEffort={(value) => set('effort', value)}
        />
      )}
      {state.context && <ContextRing context={state.context} />}
    </>
  )
}
