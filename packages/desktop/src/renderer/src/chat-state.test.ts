import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ConversationStage } from '@kando/protocol'
import {
  appendText,
  chatBlocks,
  finalReplies,
  flushChatDeltas,
  foldRowKeys,
  mergeItems,
  pathShortener,
  prependChatPage,
  previousTodos,
  questionAnswers,
  thoughtDurations,
  todoChange,
  receiveChatDelta,
  receiveChatItems,
  setChatPage,
  timeline,
  useChat
} from './chat-state'

const text = (id: string, value: string, stageId = 'chat-stage', revision = 1): ChatItem =>
  ({ id, stageId, revision, at: 0, kind: 'assistant', text: value, streaming: false }) as const
const stage = (id: string, startedAt: number): ConversationStage => ({
  id, conversationId: 'c', agent: 'claude', providerSessionId: null, sessionId: null, receivedSequence: 0,
  startedAt, endedAt: null, exitCode: null
})

describe('chat items', () => {
  beforeEach(() => useChat.setState({}, true))

  it('replaces a known item where it stands and adds a new one last', () => {
    const merged = mergeItems([text('a', 'one'), text('b', 'two')], [text('a', 'one, revised', 'chat-stage', 2), text('c', 'three')])
    expect(merged.map((item) => item.kind === 'assistant' && item.text)).toEqual(['one, revised', 'two', 'three'])
  })

  it('streams text onto the item it names and ignores one it does not hold', () => {
    expect(appendText([text('a', 'he')], 'chat-stage', 'a', 'llo')).toEqual([text('a', 'hello')])
    expect(appendText([text('a', 'he')], undefined, 'a', 'llo')).toEqual([text('a', 'hello')])
    expect(appendText([text('a', 'he')], 'chat-stage', 'missing', 'x')).toEqual([text('a', 'he')])
    expect(appendText([text('a', 'he')], 'other-stage', 'a', 'x')).toEqual([text('a', 'he')])
  })

  it('keeps apart items two stages gave the same id', () => {
    const merged = mergeItems([text('n:1', 'first stage', 'stage-1')], [text('n:1', 'second stage', 'stage-2')])
    expect(merged.map((item) => item.kind === 'assistant' && item.text)).toEqual(['first stage', 'second stage'])
  })

  it('keeps only conversations a view watches, and puts an older page in front', () => {
    receiveChatItems('c', [text('a', 'ignored')])
    expect(useChat.getState().c).toBeUndefined()
    setChatPage('c', { items: [text('b', 'new')], before: 'stage-0' })
    receiveChatDelta('c', 'chat-stage', 'b', '!')
    prependChatPage('c', { items: [text('a', 'old'), text('b', 'stale')], before: null })
    expect(useChat.getState().c).toEqual({ items: [text('a', 'old'), text('b', 'new!')], before: null })
  })
})

describe('streamed deltas', () => {
  beforeEach(() => {
    flushChatDeltas()
    useChat.setState({ c: { items: [text('a', 'he'), text('b', 'x')], before: null } }, true)
  })

  it('are gathered and applied together, in order, once the flush comes', () => {
    vi.useFakeTimers()
    try {
      const before = useChat.getState().c
      receiveChatDelta('c', 'chat-stage', 'a', 'l')
      receiveChatDelta('c', 'chat-stage', 'a', 'lo')
      receiveChatDelta('c', 'chat-stage', 'b', 'y')
      receiveChatDelta('c', 'chat-stage', 'a', '!')
      expect(useChat.getState().c).toBe(before)
      vi.runAllTimers()
      expect(useChat.getState().c?.items).toEqual([text('a', 'hello!'), text('b', 'xy')])
    } finally {
      vi.useRealTimers()
    }
  })

  it('land before anything else that changes the chat', () => {
    receiveChatDelta('c', 'chat-stage', 'a', 'llo')
    receiveChatItems('c', [text('a', 'hello, revised', 'chat-stage', 2)])
    receiveChatDelta('c', 'chat-stage', 'a', '!')
    flushChatDeltas()
    expect(useChat.getState().c?.items[0]).toEqual(text('a', 'hello, revised!', 'chat-stage', 2))
  })
})

describe('pathShortener', () => {
  it('reads paths relative to the project, naming the project when there are several', () => {
    expect(pathShortener(['/work/api'])('Edit /work/api/src/app.ts')).toBe('Edit src/app.ts')
    const both = pathShortener(['/work/api', '/work/api-web'])
    expect(both('/work/api-web/index.ts, /work/api/main.ts')).toBe('api-web/index.ts, api/main.ts')
    expect(both('/elsewhere/file')).toBe('/elsewhere/file')
  })
})

describe('timeline', () => {
  it('lays each stage out as its items, and one that began after the list was read last', () => {
    const entries = timeline([stage('chat-stage', 1)], [text('a', 'reply'), text('late', 'next stage', 'unknown-stage')])
    expect(entries.map((entry) => (entry.kind === 'stage' ? `stage:${entry.stage.id}` : `item:${entry.item.id}`)))
      .toEqual(['stage:chat-stage', 'item:a', 'item:late'])
  })

  it('marks no divider where the same agent started again', () => {
    const restarted = [stage('chat-stage', 1), stage('again', 2), { ...stage('codex', 3), agent: 'codex' as const }]
    expect(timeline(restarted, []).map((entry) => entry.kind === 'stage' && entry.stage.id)).toEqual(['chat-stage', 'codex'])
  })

  it('marks one where a task stops only planning and starts its work', () => {
    const task = [{ ...stage('plan', 1), planOnly: true }, { ...stage('again', 2), planOnly: true }, { ...stage('work', 3), planOnly: false }]
    expect(timeline(task, []).map((entry) => entry.kind === 'stage' && entry.stage.id)).toEqual(['plan', 'work'])
  })
})

describe('questionAnswers', () => {
  const question = {
    id: 'q', header: '语言', question: '用哪些语言？', multiSelect: true,
    options: [{ label: 'Go', description: null }, { label: 'TypeScript', description: null }]
  }

  it('presents Cursor option ids as labels, including options with identical labels', () => {
    const native = { ...question, options: [{ id: 'one', label: 'Same', description: null }, { id: 'two', label: 'Same', description: null }] }
    expect(questionAnswers(native, ['two', 'custom answer'])).toEqual([{ text: 'Same', typed: false }, { text: 'custom answer', typed: true }])
  })

  it('tells the options picked from words of the user\'s own', () => {
    expect(questionAnswers(question, ['Go', 'Rust'])).toEqual([{ text: 'Go', typed: false }, { text: 'Rust', typed: true }])
  })

  it('reads the one string Claude hands back as the options it starts with, then what was typed', () => {
    expect(questionAnswers(question, ['Go, TypeScript, Rust, Zig'])).toEqual([
      { text: 'Go', typed: false },
      { text: 'TypeScript', typed: false },
      { text: 'Rust, Zig', typed: true }
    ])
    expect(questionAnswers(question, ['Go, TypeScript'])).toEqual([{ text: 'Go', typed: false }, { text: 'TypeScript', typed: false }])
  })
})

describe('chatBlocks', () => {
  const base = { stageId: 'chat-stage', revision: 1, at: 0 }
  const user = (id: string): ChatItem => ({ ...base, id, kind: 'user', text: 'go', images: [] })
  const reply = (id: string): ChatItem => ({ ...base, id, kind: 'assistant', text: id, streaming: false })
  const tool = (id: string, name = 'Read', diffs: { path: string; change: 'update'; patch: string }[] = []): Extract<ChatItem, { kind: 'tool' }> =>
    ({ ...base, id, kind: 'tool', name, title: id, input: null, status: 'done', output: null, diffs })
  const thought = (id: string, value: string): ChatItem => ({ ...base, id, kind: 'reasoning', text: value, streaming: false })
  const turn = (id: string): ChatItem => ({ ...base, id, kind: 'turn', state: 'completed', error: null, durationMs: 70_800 })
  const blocksOf = (items: ChatItem[]) => chatBlocks(items.map((item) => ({ kind: 'item' as const, item })))
  const shape = (blocks: ReturnType<typeof chatBlocks>): unknown[] => blocks.map((block) =>
    block.kind === 'tools' || block.kind === 'browser' ? `${block.kind}:${block.tools.map((each) => each.id).join('+')}`
      : block.kind === 'edits' ? `edits:${block.path}:${block.tools.map((each) => each.id).join('+')}`
      : block.kind === 'agents' ? `agents:${block.tools.map((each) => each.id).join('+')}`
      : block.kind === 'fold' ? { fold: shape(block.blocks) }
      : block.kind === 'changes' ? { changes: block.files }
      : block.entry.kind === 'item' ? block.entry.item.id : block.key)

  it('runs calls made one after another together, a change to files on its own card', () => {
    const edit = tool('e', 'Edit', [{ path: 'a.ts', change: 'update', patch: '+x' }])
    expect(shape(blocksOf([user('u'), tool('a'), tool('b', 'Bash'), edit, tool('c'), reply('r')])))
      .toEqual(['u', 'tools:a+b', 'e', 'tools:c', 'r'])
  })

  it('collects browser history across commands and narration, leaving screenshots separate', () => {
    const shot = { ...tool('shot', 'mcp__kando__browser_screenshot'), images: [{ id: `${'a'.repeat(64)}.png`, width: 2, height: 1 }] }
    const items = [user('u'), tool('open', 'mcp__kando__browser_navigate'), tool('cmd', 'Bash'), reply('checking'),
      tool('click', 'kando.browser_click'), shot, tool('refresh', 'kando.browser_navigate'), reply('answer')]
    expect(shape(blocksOf(items))).toEqual(['u', 'tools:cmd', 'checking', 'shot', 'browser:open+click+refresh', 'answer'])
    const browser = blocksOf(items).find((block) => block.kind === 'browser')
    expect(browser?.key).toBe('browser:item:chat-stage/open')
    expect(foldRowKeys(browser ? [browser] : [])).toEqual([
      'run:chat-stage/open', 'call:chat-stage/open', 'call:chat-stage/click', 'call:chat-stage/refresh'
    ])
    expect(items).toHaveLength(8)
  })

  it('keeps browser entry points visible after completion without counting them twice in the work fold', () => {
    const items = [user('u'), { ...tool('open', 'kando.browser_navigate'), at: 100 },
      { ...tool('cmd'), at: 200 }, { ...tool('click', 'kando.browser_click'), at: 300 },
      { ...reply('answer'), at: 400 }, { ...turn('end'), at: 500 }]
    expect(shape(blocksOf(items))).toEqual(['u', { fold: ['tools:cmd'] }, 'browser:open+click', 'answer', 'end'])
    expect(blocksOf(items).find((block) => block.kind === 'fold')).toMatchObject({ steps: 1, workMs: 200 })
    expect(shape(chatBlocks(items.map((item) => ({ kind: 'item' as const, item })), { foldTurns: false })))
      .toEqual(['u', 'tools:cmd', 'browser:open+click', 'answer', 'end'])
  })

  it('does not promote narration before the last browser operation to the final answer', () => {
    expect(shape(blocksOf([user('u'), tool('open', 'kando.browser_navigate'), reply('checking'),
      tool('click', 'kando.browser_click'), turn('end')])))
      .toEqual(['u', { fold: ['checking'] }, 'browser:open+click', 'end'])
  })

  it('does not merge browser histories across users, turn endings or stages', () => {
    const open = (id: string) => tool(id, 'kando.browser_navigate')
    expect(shape(blocksOf([user('u'), open('a'), turn('t'), open('b'), user('u2'), open('c'),
      { ...open('d'), stageId: 'next' }])))
      .toEqual(['u', 'browser:a', 't', 'browser:b', 'u2', 'browser:c', 'browser:d'])
    expect(shape(chatBlocks([
      { kind: 'item', item: open('a') }, { kind: 'stage', stage: stage('next', 1) },
      { kind: 'item', item: { ...open('b'), stageId: 'next' } }
    ]))).toEqual(['browser:a', 'stage:next', 'browser:b'])
  })

  it('retains running, failed and denied browser calls in inspectable history', () => {
    const navigate = tool('open', 'kando.browser_navigate')
    const calls = [navigate, { ...navigate, id: 'running', status: 'running' as const },
      { ...navigate, id: 'failed', status: 'failed' as const }, { ...navigate, id: 'denied', status: 'denied' as const }]
    expect(blocksOf(calls)).toEqual([{ kind: 'browser', key: 'browser:item:chat-stage/open', tools: calls }])
  })

  it('gives a call that looked at a picture, or brought one back, a card of its own', () => {
    const read = { ...tool('/tmp/shot.png'), id: 'p' }
    const shot = { ...tool('s', 'mcp__playwright__screenshot'), images: [{ id: `${'a'.repeat(64)}.png`, width: 2, height: 1 }] }
    expect(shape(blocksOf([user('u'), tool('a'), read, tool('b'), shot, tool('c'), reply('r')])))
      .toEqual(['u', 'tools:a', 'p', 'tools:b', 's', 'tools:c', 'r'])
  })

  // The turn's own line follows the answer: how it ended reads there, the fold only how it worked.
  it('folds a finished turn\'s work behind one line and leaves its answer and ending in view', () => {
    expect(shape(blocksOf([user('u'), reply('looking'), thought('t', 'hm'), tool('a'), tool('b'), reply('answer'), turn('end')])))
      .toEqual(['u', { fold: ['looking', 't', 'tools:a+b'] }, 'answer', 'end'])
  })

  it('measures the fold\'s work from its first call to the answer', () => {
    const at = (item: ChatItem, ms: number): ChatItem => ({ ...item, at: ms })
    const blocks = blocksOf([at(user('u'), 0), at(tool('a'), 1_000), at(tool('b'), 5_000), at(reply('answer'), 99_000), at(turn('end'), 100_000)])
    expect(blocks.find((block) => block.kind === 'fold')).toMatchObject({ steps: 2, workMs: 98_000 })
  })

  it('leaves a finished turn open when folding is off, still listing the files it changed', () => {
    const edit = tool('e', 'Edit', [{ path: 'a.ts', change: 'update', patch: '+x' }])
    const items = [user('u'), reply('looking'), tool('a'), edit, reply('answer'), turn('end')]
    expect(shape(chatBlocks(items.map((item) => ({ kind: 'item' as const, item })), { foldTurns: false })))
      .toEqual(['u', 'looking', 'tools:a', 'e', 'answer', { changes: [expect.objectContaining({ path: 'a.ts' })] }])
  })

  it('keeps a turn that did nothing but answer as it was, and one still running unfolded', () => {
    expect(shape(blocksOf([user('u'), reply('answer'), turn('end')]))).toEqual(['u', 'answer', 'end'])
    expect(shape(blocksOf([user('u'), tool('a'), reply('so far')]))).toEqual(['u', 'tools:a', 'so far'])
  })

  it('puts edits to one file made one after another on one card, and lists a turn\'s files under it', () => {
    const patch = (lines: string) => [{ path: 'a.ts', change: 'update' as const, patch: lines }]
    const items = [user('u'), tool('r'), tool('e1', 'Edit', patch('+x\n-y')), tool('e2', 'Edit', patch('+z')),
      tool('w', 'Write', [{ path: 'b.ts', change: 'update', patch: '+b' }]), reply('answer'), turn('end')]
    expect(shape(blocksOf(items))).toEqual([
      'u',
      { fold: ['tools:r', 'edits:a.ts:e1+e2', 'w'] },
      'answer',
      { changes: [{ path: 'a.ts', added: 2, removed: 1, change: 'update' }, { path: 'b.ts', added: 1, removed: 0, change: 'update' }] }
    ])
    const blocks = blocksOf(items)
    expect(blocks.find((block) => block.kind === 'changes')).toMatchObject({
      collapsible: true,
      turn: { id: 'end' },
      reply: { key: 'item:chat-stage/answer', text: 'answer' }
    })
  })

  it('groups subagents sent off together apart from the calls around them', () => {
    expect(shape(blocksOf([user('u'), tool('a'), tool('t1', 'Task'), tool('t2', 'Agent'), tool('b'), reply('r')])))
      .toEqual(['u', 'tools:a', 'agents:t1+t2', 'tools:b', 'r'])
    expect(shape(blocksOf([user('u'), tool('s1', 'spawnAgent'), tool('s2', 'spawnAgent'), reply('r')]))).toEqual(['u', 'agents:s1+s2', 'r'])
  })

  it('leaves where the context was compacted in view, and folds other info', () => {
    const notice = (id: string, text: string): ChatItem => ({ ...base, id, kind: 'notice', level: 'info', text })
    expect(shape(blocksOf([user('u'), notice('c', '对话上下文已压缩'), tool('a'), notice('i', '切换了模型'), reply('answer'), turn('end')])))
      .toEqual(['u', { fold: ['tools:a', 'i'] }, 'c', 'answer', 'end'])
  })

  it('leaves what the user was asked, and empty thinking, out of the fold', () => {
    const question: ChatItem = { ...base, id: 'q', kind: 'question', requestId: 'r', questions: [], answers: {}, resolution: 'answered' }
    expect(shape(blocksOf([user('u'), thought('empty', ' '), tool('a'), question, tool('b'), reply('answer'), turn('end')])))
      .toEqual(['u', { fold: ['tools:a', 'tools:b'] }, 'q', 'answer', 'end'])
  })
})

describe('finalReplies', () => {
  const base = { stageId: 'chat-stage', revision: 1, at: 0 }
  const assistant = (id: string): ChatItem => ({ ...base, id, kind: 'assistant', text: id, streaming: false })
  const tool = (id: string): ChatItem => ({ ...base, id, kind: 'tool', name: 'Read', title: id, input: null, status: 'done', output: null, diffs: [] })
  const turn = (id: string, state: 'completed' | 'interrupted'): ChatItem => ({ ...base, id, kind: 'turn', state, error: null, durationMs: 1 })
  const entries = (items: ChatItem[]) => items.map((item) => ({ kind: 'item' as const, item }))

  it('keeps copy for the final answer, not progress updates', () => {
    const replies = finalReplies(entries([assistant('progress'), tool('read'), assistant('answer'), { ...turn('end', 'completed'), at: 42 }]))
    expect([...replies]).toEqual([['item:chat-stage/answer', 42]])
  })

  it('does not call an interrupted or unfinished reply final', () => {
    expect([...finalReplies(entries([assistant('interrupted'), turn('end', 'interrupted')]))]).toEqual([])
    expect([...finalReplies(entries([assistant('still-running')]))]).toEqual([])
  })
})

describe('thoughtDurations', () => {
  it('times a finished thought until the next thing in its stage, and not one still going', () => {
    const at = (id: string, kind: 'reasoning' | 'assistant', when: number, streaming = false, stageId = 's'): ChatItem =>
      ({ id, stageId, revision: 1, at: when, kind, text: 'x', streaming })
    const items = [at('t1', 'reasoning', 1_000), at('a1', 'assistant', 9_000), at('t2', 'reasoning', 10_000, true), at('t3', 'reasoning', 12_000)]
    expect([...thoughtDurations(items)]).toEqual([['s/t1', 8_000]])
  })
})

describe('todoChange', () => {
  const todo = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({ content, status, activeForm: null })

  it('says what an update finished, started or added, and lists the first', () => {
    const first = [todo('读代码', 'in_progress'), todo('改代码', 'pending')]
    expect(todoChange(null, first)).toBe('列出 2 项待办')
    expect(todoChange(first, [todo('读代码', 'completed'), todo('改代码', 'in_progress')])).toBe('完成「读代码」，开始「改代码」')
    expect(todoChange(first, [...first, todo('测试', 'pending')])).toBe('新增 1 项')
    expect(todoChange(first, first)).toBeNull()
  })

  it('pairs each update with the list before it', () => {
    const item = (id: string): ChatItem => ({ id, stageId: 's', revision: 1, at: 0, kind: 'todos', todos: [todo(id, 'pending')] })
    expect([...previousTodos([item('a'), item('b')])]).toEqual([['s/a', null], ['s/b', [todo('a', 'pending')]]])
  })
})
