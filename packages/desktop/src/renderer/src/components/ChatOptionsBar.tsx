import type { AgentKind, ChatContextUse, ChatItem, ChatOption, Conversation } from '@kando/protocol'
import { perform } from '../core-store'

type StateItem = Extract<ChatItem, { kind: 'state' }>

// Kando's permission modes as each agent's users know them; the Codex default reads "auto".
const MODE_LABEL: Record<AgentKind, Record<string, string>> = {
  claude: { ask: '逐项确认', acceptEdits: '自动接受编辑', plan: '规划', auto: '自动判断', bypass: '全部放行' },
  codex: { ask: '逐项确认', acceptEdits: '自动', readOnly: '只读', bypass: '全部放行' }
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

// Below the composer: how freely the agent may act, and the model and effort it runs, all of
// which a click switches. The model and effort change between turns; the mode at any time.
export function ChatOptionsBar({ conversation, state }: { conversation: Conversation; state: StateItem }) {
  const { id, agent } = conversation
  const idle = conversation.chat?.turn === 'idle'
  const set = (option: ChatOption, value: string) => void perform((rpc) => rpc.call('conversations.setOption', { id, option, value }))
  const model = state.models.find((each) => each.id === state.model)
  const efforts = model?.efforts ?? []
  const modes = withCurrent(state.permissionModes, state.permissionMode)
  const models = state.models.some((each) => each.id === state.model) || !state.model
    ? state.models
    : [{ id: state.model, label: state.model, description: null, efforts: [], isDefault: false }, ...state.models]
  return (
    <div className="chat-options">
      {modes.length > 0 && (
        <select
          className="chat-select"
          aria-label="权限模式"
          data-mode={state.permissionMode ?? undefined}
          value={state.permissionMode ?? ''}
          onChange={(event) => set('permissionMode', event.target.value)}
        >
          {!state.permissionMode && <option value="" disabled>权限模式</option>}
          {modes.map((mode) => (
            <option key={mode} value={mode} disabled={!state.permissionModes.includes(mode)}>
              {MODE_LABEL[agent][mode] ?? mode}
            </option>
          ))}
        </select>
      )}
      {models.length > 0 && (
        <select
          className="chat-select"
          aria-label="模型"
          title={idle ? model?.description ?? undefined : '回合结束后才能换模型'}
          disabled={!idle}
          value={state.model ?? ''}
          onChange={(event) => set('model', event.target.value)}
        >
          {!state.model && <option value="" disabled>模型</option>}
          {models.map((each) => <option key={each.id} value={each.id}>{each.label}</option>)}
        </select>
      )}
      {efforts.length > 0 && (
        <select
          className="chat-select"
          aria-label="推理强度"
          title={idle ? undefined : '回合结束后才能换推理强度'}
          disabled={!idle}
          value={state.effort ?? ''}
          onChange={(event) => set('effort', event.target.value)}
        >
          {!state.effort && <option value="" disabled>默认强度</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}
        </select>
      )}
      <span className="chat-dock-spacer" />
      {state.context && <ContextRing context={state.context} />}
    </div>
  )
}
