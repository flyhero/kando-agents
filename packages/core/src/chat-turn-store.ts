import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AGENT_KINDS, AgentKind, type ChatItem, type ConversationStats } from '@kando/protocol'
import type { ChatStageRef } from './conversation-service'
import { median } from './median'

// What a turn is counted under: the conversation's task (none for a free one), and the stage's agent
// and model as its state item last said.
export type TurnFacts = { taskId: string | null; agent: AgentKind; model: string | null }

export type TurnSource = {
  facts(conversationId: string, stageId: string): TurnFacts | null
  // For counting the turns of stages that ended before core kept them.
  stages(): ChatStageRef[]
  items(conversationId: string, stageId: string): ChatItem[]
}

const Row = z.object({
  conversationId: z.string(),
  agent: AgentKind,
  model: z.string().nullable(),
  state: z.string(),
  durationMs: z.number().nullable(),
  totalTokens: z.number().nullable(),
  usageLimit: z.number()
})
type Row = z.infer<typeof Row>

export const TurnRow = Row.extend({ endedAt: z.number() })
export type TurnRow = z.infer<typeof TurnRow>

// Rows live in chat_turns and chat_turn_stages, which TaskStore's migrations create. A turn is taken
// as its item comes out of a live stage; a replayed stage puts the same items out again, which
// changes nothing.
export class ChatTurnStore {
  private readonly db: DatabaseSync

  constructor(
    file: string,
    private readonly source: TurnSource,
    private readonly now: () => number = Date.now
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
  }

  close(): void {
    this.db.close()
  }

  observe(conversationId: string, items: readonly ChatItem[]): void {
    const counted = items.filter((item) => item.kind === 'turn' || item.kind === 'usageLimit')
    if (counted.length === 0) return
    const facts = new Map<string, TurnFacts | null>()
    const factsOf = (stageId: string) => {
      if (!facts.has(stageId)) facts.set(stageId, this.source.facts(conversationId, stageId))
      return facts.get(stageId) ?? null
    }
    for (const item of counted) {
      const known = factsOf(item.stageId)
      if (known) this.count(conversationId, item, known)
    }
  }

  // Counts the turns of every chat stage that ended without core counting it, once each. Yields
  // between stages: rebuilding one from its log can take a moment, and agents are being served.
  async catchUp(): Promise<void> {
    const done = new Set(this.db.prepare('SELECT stage_id AS stageId FROM chat_turn_stages').all().map((row) => String(row.stageId)))
    for (const stage of this.source.stages()) {
      if (!stage.ended || done.has(stage.stageId)) continue
      const facts = this.source.facts(stage.conversationId, stage.stageId)
      if (facts) {
        for (const item of this.source.items(stage.conversationId, stage.stageId)) {
          if (item.kind === 'turn' || item.kind === 'usageLimit') this.count(stage.conversationId, item, facts)
        }
      }
      this.db.prepare('INSERT OR IGNORE INTO chat_turn_stages (stage_id, counted_at) VALUES (?, ?)').run(stage.stageId, this.now())
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  // Free conversations only: a task chat's turns are its task's runs, which agent_runs judges.
  stats(): ConversationStats[] {
    const rows = this.db
      .prepare(`SELECT conversation_id AS conversationId, agent, model, state, duration_ms AS durationMs,
        total_tokens AS totalTokens, usage_limit AS usageLimit FROM chat_turns WHERE task_id IS NULL`)
      .all()
      .map((row) => Row.parse(row))
    return summarizeTurns(rows)
  }

  // Free conversations' turns that ended at `since` or later.
  endedSince(since: number): TurnRow[] {
    return this.db
      .prepare(`SELECT conversation_id AS conversationId, agent, model, state, duration_ms AS durationMs,
        total_tokens AS totalTokens, usage_limit AS usageLimit, ended_at AS endedAt FROM chat_turns
        WHERE task_id IS NULL AND ended_at >= ?`)
      .all(since)
      .map((row) => TurnRow.parse(row))
  }

  private count(conversationId: string, item: ChatItem, facts: TurnFacts): void {
    if (item.kind === 'usageLimit') {
      this.db.prepare('UPDATE chat_turns SET usage_limit = 1 WHERE stage_id = ? AND item_id = ?').run(item.stageId, item.id.replace(/^limit:/, 'turn:'))
      return
    }
    if (item.kind !== 'turn') return
    const usage = item.usage ?? null
    const split = usage && 'input' in usage ? usage : null
    const total = usage ? ('total' in usage ? usage.total : usage.input + usage.output) : null
    this.db
      .prepare(`INSERT INTO chat_turns (stage_id, item_id, conversation_id, task_id, agent, model, state, duration_ms,
          input_tokens, output_tokens, total_tokens, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (stage_id, item_id) DO UPDATE SET state = excluded.state, duration_ms = excluded.duration_ms,
          input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, total_tokens = excluded.total_tokens,
          model = coalesce(excluded.model, chat_turns.model)`)
      .run(item.stageId, item.id, conversationId, facts.taskId, facts.agent, facts.model, item.state, item.durationMs,
        split?.input ?? null, split?.output ?? null, total, item.at)
  }
}

// One row per agent and model; agents in their usual order, a known model before the unknown one,
// busier models first.
export function summarizeTurns(rows: readonly Row[]): ConversationStats[] {
  const groups = new Map<string, { agent: AgentKind; model: string | null; rows: Row[] }>()
  for (const row of rows) {
    const key = JSON.stringify([row.agent, row.model])
    const group = groups.get(key) ?? { agent: row.agent, model: row.model, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  const stats = [...groups.values()].map(({ agent, model, rows: group }): ConversationStats => ({
    agent,
    model,
    conversations: new Set(group.map((row) => row.conversationId)).size,
    turns: group.length,
    failed: group.filter((row) => row.state === 'failed').length,
    interrupted: group.filter((row) => row.state === 'interrupted').length,
    usageLimits: group.filter((row) => row.usageLimit === 1).length,
    medianTurnMs: median(group.flatMap((row) => (row.durationMs === null ? [] : [row.durationMs]))),
    medianTurnTokens: median(group.flatMap((row) => (row.totalTokens === null ? [] : [row.totalTokens]))),
    totalTokens: group.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0)
  }))
  return stats.sort(
    (a, b) =>
      AGENT_KINDS.indexOf(a.agent) - AGENT_KINDS.indexOf(b.agent) ||
      Number(a.model === null) - Number(b.model === null) ||
      b.turns - a.turns
  )
}
