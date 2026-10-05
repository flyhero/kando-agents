import type { ApprovalChoice, ApprovalGrant, ApprovalScope, ChatItem } from '@kando/protocol'
import { modeLabel } from './components/ChatOptionsBar'

type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

// How long, and where, what an answer remembers holds: said before what it is.
const SCOPE_LEAD: Record<ApprovalScope, string> = {
  run: '这次运行内',
  local: '本项目以后',
  project: '本项目以后',
  user: '所有项目以后',
  agent: '以后'
}
// Where it is kept, so the user knows what else it reaches and where to take it back.
const SCOPE_NOTE: Record<ApprovalScope, string> = {
  run: 'Agent 停下或重启后就失效',
  local: '写进本项目的 .claude/settings.local.json（Git 忽略），之后的会话也生效',
  project: '写进本项目的 .claude/settings.json，会随仓库提交',
  user: '写进 ~/.claude/settings.json，所有项目都生效',
  agent: '记进 Agent 自己的规则，之后的会话也生效'
}
const SHOWN = 3

function listed(values: readonly string[]): string {
  const shown = values.slice(0, SHOWN).join('、')
  return values.length > SHOWN ? `${shown} 等 ${values.length} 项` : shown
}

function grantAction(grant: ApprovalGrant): string {
  const what = listed(grant.values)
  switch (grant.kind) {
    case 'rules':
      return grant.behavior === 'deny' ? `都不许用 ${what}` : grant.behavior === 'ask' ? `${what} 每次都先问` : `${what} 不再问`
    case 'mode':
      return `改用「${modeLabel('claude', grant.values[0] ?? '')}」模式`
    case 'directories':
      return `访问 ${what} 不再问`
    case 'command':
      return '这条命令不再问'
    case 'files':
      return what ? `改 ${what} 不再问` : '改这些文件不再问'
    case 'prefix':
      return `以 ${grant.values.join(' ')} 开头的命令不再问`
    case 'host':
      return grant.behavior === 'deny' ? `都不许访问 ${what}` : `访问 ${what} 不再问`
    case 'other':
      return '还有 Agent 建议的其他规则'
  }
}

// What a choice remembers, scope by scope in the order the agent gave them.
function grantsText(grants: readonly ApprovalGrant[]): string {
  const scopes = [...new Set(grants.map((grant) => grant.scope))]
  return scopes.map((scope) => {
    const actions = grants.filter((grant) => grant.scope === scope).map(grantAction).join('，')
    // A space between Chinese and a rule or path that follows it.
    return `${SCOPE_LEAD[scope]}${/^[!-~]/.test(actions) ? ' ' : ''}${actions}`
  }).join('；')
}

// A choice's row: what it does, and where what it remembers is kept. A plain deny has its own row.
export function choiceText(choice: ApprovalChoice): { label: string; note: string | null } {
  if (choice.grants.length === 0) return { label: choice.decision === 'deny' ? '拒绝' : '允许这一次', note: null }
  const notes = [...new Set(choice.grants.map((grant) => SCOPE_NOTE[grant.scope]))]
  return { label: `${choice.decision === 'deny' ? '拒绝' : '允许'}，${grantsText(choice.grants)}`, note: notes.join('；') }
}

// The submit button's words for a choice: short, the row above says the rest.
export function choiceAction(choice: ApprovalChoice): string {
  if (choice.grants.length === 0) return choice.decision === 'deny' ? '拒绝' : '允许'
  return choice.decision === 'deny' ? '拒绝并记住' : '允许并记住'
}

// Whether a choice is the plain no, whose row takes the reason for it.
export function isPlainDeny(choice: ApprovalChoice): boolean {
  return choice.decision === 'deny' && choice.grants.length === 0
}

// How an answered approval went, when it was answered with a choice that remembered something.
export function chosenText(item: ApprovalItem): string | null {
  const choice = item.chosen ? item.choices?.find((each) => each.id === item.chosen) : undefined
  if (!choice || choice.grants.length === 0) return null
  return `${choice.decision === 'deny' ? '已拒绝' : '已允许'}，${grantsText(choice.grants)}`
}
