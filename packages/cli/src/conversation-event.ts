import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { AgentKind, connectRpc, coreUrl } from '@kando/protocol'
import { readCoreEndpoint } from '@kando/protocol/node'
import { isCodexTitleTurn } from './codex-title-turn'

type Forwarded = {
  providerSessionId: string | null
  messages: Array<{ role: 'user' | 'assistant'; text: string; eventKey: string; complete: boolean }>
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined
}
function string(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }
function key(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32) }

function claudeEventKey(input: unknown): string {
  const transcript = string(field(input, 'transcript_path'))
  let position: number | null = null
  if (transcript) {
    try { position = statSync(transcript, { throwIfNoEntry: false })?.size ?? null } catch { /* Hook payload may name an inaccessible file. */ }
  }
  return key({ input, position })
}

export function parseConversationEvent(agent: AgentKind, input: unknown): Forwarded {
  if (agent === 'codex') {
    if (field(input, 'type') !== 'agent-turn-complete') return { providerSessionId: null, messages: [] }
    // Drop its thread id too: adopting it would bind the stage to a thread `codex resume` cannot find
    // and reject every real turn after it as another thread's.
    if (isCodexTitleTurn(input)) return { providerSessionId: null, messages: [] }
    const providerSessionId = string(field(input, 'thread-id'))
    const turn = string(field(input, 'turn-id')) ?? key(input)
    const inputs = field(input, 'input-messages')
    const texts = Array.isArray(inputs) ? inputs.filter((value): value is string => typeof value === 'string' && value.trim() !== '') : []
    const reply = string(field(input, 'last-assistant-message'))
    return {
      providerSessionId,
      messages: [
        ...texts.map((text, index) => ({ role: 'user' as const, text, eventKey: `${turn}:user:${index}`, complete: true })),
        ...(reply ? [{ role: 'assistant' as const, text: reply, eventKey: `${turn}:assistant`, complete: true }] : [])
      ]
    }
  }
  const event = string(field(input, 'hook_event_name'))
  const session = string(field(input, 'session_id'))
  const turn = string(field(input, 'turn_id')) ?? claudeEventKey(input)
  const role = event === 'UserPromptSubmit' ? 'user' : event === 'Stop' ? 'assistant' : null
  const text = role === 'user' ? string(field(input, 'prompt')) : role === 'assistant' ? string(field(input, 'last_assistant_message')) : null
  return { providerSessionId: session, messages: role && text ? [{ role, text, eventKey: `${turn}:${role}`, complete: role === 'assistant' }] : [] }
}

export async function forwardConversationEvent(
  home: string,
  id: string,
  stageId: string,
  agent: AgentKind,
  input: unknown
): Promise<void> {
  const endpoint = await readCoreEndpoint(home)
  if (!endpoint) return
  const { providerSessionId, messages } = parseConversationEvent(agent, input)
  const rpc = await connectRpc(coreUrl(endpoint))
  try {
    if (providerSessionId && messages.length === 0) {
      await rpc.call('conversations.event', { id, stageId, agent, providerSessionId,
        role: 'assistant', text: '', eventKey: `identity:${providerSessionId}`, complete: true })
    }
    for (const item of messages) {
      await rpc.call('conversations.event', { id, stageId, agent, providerSessionId, ...item })
    }
  } finally {
    rpc.close()
  }
}
