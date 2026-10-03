import type { ChatCommand } from '@kando/protocol'
import { commandOf, offeredCommand } from './agent-commands'

// The app server expands no slash command: Kando offers the TUI's /compact and /review as the
// methods behind them, and each skill as a message that carries it.

export type CodexSkill = { name: string; description: string; path: string }

const BUILT_IN: readonly ChatCommand[] = [
  offeredCommand('compact', '总结目前的对话，腾出上下文', null),
  offeredCommand('review', '审查未提交的改动，或与给定分支之间的改动', '[分支]')
]

export function codexCommands(skills: readonly CodexSkill[]): ChatCommand[] {
  const taken = new Set(BUILT_IN.map((command) => command.name))
  return [...BUILT_IN, ...skills.filter((skill) => !taken.has(skill.name)).map((skill) => offeredCommand(skill.name, skill.description, null))]
}

export type CodexCommand =
  | { kind: 'compact' }
  | { kind: 'review'; branch: string | null }
  | { kind: 'skill'; skill: CodexSkill }

// What a message asks of the app server, when it names one of the commands offered; null for a
// message to send as it is.
export function codexCommand(text: string, skills: readonly CodexSkill[]): CodexCommand | null {
  const command = commandOf(text)
  if (!command) return null
  if (command.name === 'compact' && !command.args) return { kind: 'compact' }
  if (command.name === 'review' && !/\s/.test(command.args)) return { kind: 'review', branch: command.args || null }
  const skill = skills.find((each) => each.name === command.name)
  return skill ? { kind: 'skill', skill } : null
}

// The request a command makes, as the frame `thread/compact/start` or `review/start` would be.
export function commandRequest(command: Exclude<CodexCommand, { kind: 'skill' }>, id: string, threadId: string): { id: string; method: string; params: Record<string, unknown> } {
  if (command.kind === 'compact') return { id, method: 'thread/compact/start', params: { threadId } }
  const target = command.branch ? { type: 'baseBranch', branch: command.branch } : { type: 'uncommittedChanges' }
  return { id, method: 'review/start', params: { threadId, target, delivery: 'inline' } }
}

// The message a command request stands for, as the chat shows it: read off the frame, so a stage
// rebuilt from its log shows the same.
export function requestText(method: string, params: unknown): string | null {
  if (method === 'thread/compact/start') return '/compact'
  if (method !== 'review/start' || typeof params !== 'object' || params === null || !('target' in params)) return null
  const target = params.target
  const branch = typeof target === 'object' && target !== null && 'branch' in target && typeof target.branch === 'string' ? target.branch : null
  return branch ? `/review ${branch}` : '/review'
}
