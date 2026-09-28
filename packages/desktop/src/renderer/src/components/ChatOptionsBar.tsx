import type { AgentKind, ChatContextUse, ChatItem, ChatOption, ChatPermissionMode, Conversation } from '@kando/protocol'
import { perform } from '../core-store'
import { usePreferences } from '../preferences'

type StateItem = Extract<ChatItem, { kind: 'state' }>

// Kando's permission modes as each agent's users know them; the Codex default reads "auto".
const MODE_LABEL: Record<AgentKind, Record<string, string>> = {
  claude: { ask: '逐项确认', acceptEdits: '自动接受编辑', plan: '规划', auto: '自动判断', bypass: '全部放行' },
  codex: { ask: '逐项确认', acceptEdits: '自动', plan: '规划', readOnly: '只读', bypass: '全部放行' }
}

export function modeLabel(agent: AgentKind, mode: string): string {
  return MODE_LABEL[agent][mode] ?? mode
}

// What a new conversation can start in, before its agent lists what it offers (bypass aside):
// auto hangs on the model, so it waits for the agent. The first is where each starts by default.
export const START_MODES: Record<AgentKind, readonly ChatPermissionMode[]> = {
  claude: ['ask', 'acceptEdits', 'plan'],
  codex: ['acceptEdits', 'ask', 'plan', 'readOnly']
}

const EFFORT_LABEL: Record<string, string> = {
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

// Below the composer: how freely the agent may act on the left; on the right, the model and effort
// it runs beside how full its context is. A click switches each; the model and effort change
// between turns, the mode at any time. With no agent running, the choices are for the next start,
// from what the last stage offered: as chosen since, or as that stage left them.
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
  // The next start offers bypass by the setting as it is then.
  const offered = running ? state.permissionModes : [...state.permissionModes.filter((mode) => mode !== 'bypass'), ...(allowBypass ? ['bypass'] : [])]
  const model = state.models.find((each) => each.id === modelId)
  const efforts = model?.efforts ?? []
  const modes = withCurrent(offered, permissionMode)
  const models = model || !modelId
    ? state.models
    : [{ id: modelId, label: modelId, description: null, efforts: [], isDefault: false }, ...state.models]
  const later = running ? null : '发下一条消息时按这个启动'
  return (
    <div className="chat-options">
      {modes.length > 0 && (
        <select
          className="chat-select"
          aria-label="权限模式"
          data-mode={permissionMode ?? undefined}
          title={later ?? undefined}
          value={permissionMode ?? ''}
          onChange={(event) => set('permissionMode', event.target.value)}
        >
          {!permissionMode && <option value="" disabled>权限模式</option>}
          {modes.map((mode) => (
            <option key={mode} value={mode} disabled={!offered.includes(mode)}>
              {modeLabel(agent, mode)}
            </option>
          ))}
        </select>
      )}
      <span className="chat-dock-spacer" />
      {models.length > 0 && (
        <select
          className="chat-select"
          aria-label="模型"
          title={later ?? (idle ? model?.description ?? undefined : '回合结束后才能换模型')}
          disabled={!idle}
          value={modelId ?? ''}
          onChange={(event) => set('model', event.target.value)}
        >
          {!modelId && <option value="" disabled>模型</option>}
          {models.map((each) => <option key={each.id} value={each.id}>{each.label}</option>)}
        </select>
      )}
      {efforts.length > 0 && (
        <select
          className="chat-select"
          aria-label="推理强度"
          title={later ?? (idle ? undefined : '回合结束后才能换推理强度')}
          disabled={!idle}
          value={effort ?? ''}
          onChange={(event) => set('effort', event.target.value)}
        >
          {!effort && <option value="" disabled>默认强度</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
        </select>
      )}
      {state.context && <ContextRing context={state.context} />}
    </div>
  )
}
