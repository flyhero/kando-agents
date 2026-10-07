import { describe, expect, it } from 'vitest'
import type { WireEntry } from '@kando/protocol'
import { formatBytes, groupWireEntries, isWireStream, mergeWireEntries, streamLabel, streamText, wireDetail, wireJsonl, wireLabel, wireMatches } from './wire-entries'

let next = 0
const entry = (dir: WireEntry['dir'], value: unknown, cut?: number): WireEntry => ({
  pos: next++,
  at: 0,
  dir,
  text: typeof value === 'string' ? value : JSON.stringify(value),
  ...(cut !== undefined ? { cut } : {})
})

describe('wireLabel', () => {
  it('names Claude frames by type and what they carry', () => {
    expect(wireLabel(entry('stdin', { type: 'control_request', request_id: 'x', request: { subtype: 'initialize' } }))).toBe('control_request · initialize')
    expect(wireLabel(entry('stdout', { type: 'stream_event', event: { type: 'content_block_delta' } }))).toBe('stream_event · content_block_delta')
    expect(wireLabel(entry('stdout', { type: 'result', subtype: 'success' }))).toBe('result · success')
    expect(wireLabel(entry('stdout', { type: 'assistant', message: {} }))).toBe('assistant')
  })

  it('names Codex frames by method and id', () => {
    expect(wireLabel(entry('stdin', { jsonrpc: '2.0', id: 3, method: 'turn/start', params: {} }))).toBe('turn/start #3')
    expect(wireLabel(entry('stdout', { method: 'item/started', params: {} }))).toBe('item/started')
    expect(wireLabel(entry('stdout', { id: 3, result: {} }))).toBe('result #3')
    expect(wireLabel(entry('stdout', { id: 4, error: { message: 'no' } }))).toBe('error #4')
  })

  it('names the start, the end and lines that are no frame', () => {
    expect(wireLabel(entry('spawn', { command: '/usr/local/bin/claude', args: [], cwd: '/w' }))).toBe('启动 claude')
    expect(wireLabel(entry('exit', { code: 1 }))).toBe('退出，代码 1')
    expect(wireLabel(entry('stdout', 'Warning: odd\nmore'))).toBe('Warning: odd')
    expect(wireLabel(entry('stderr', '{"looks":"like json"}'))).toBe('{"looks":"like json"}')
  })
})

describe('isWireStream', () => {
  it('picks out streamed pieces and keep-alives from the agent only', () => {
    expect(isWireStream(entry('stdout', { type: 'stream_event', event: {} }))).toBe(true)
    expect(isWireStream(entry('stdout', { type: 'keep_alive' }))).toBe(true)
    expect(isWireStream(entry('stdout', { method: 'item/agentMessage/delta', params: {} }))).toBe(true)
    expect(isWireStream(entry('stdout', { method: 'item/reasoning/textDelta', params: {} }))).toBe(true)
    expect(isWireStream(entry('stdout', { type: 'assistant' }))).toBe(false)
    expect(isWireStream(entry('stdin', { type: 'stream_event' }))).toBe(false)
  })
})

describe('wire entries', () => {
  it('searches the text and the label', () => {
    const frame = entry('stdout', { type: 'result', subtype: 'success', result: 'Done' })
    expect(wireMatches(frame, 'done')).toBe(true)
    expect(wireMatches(frame, 'result · success')).toBe(true)
    expect(wireMatches(frame, 'nothing')).toBe(false)
    expect(wireMatches(frame, '')).toBe(true)
  })

  it('lays JSON out and says when a line was cut short', () => {
    expect(wireDetail(entry('stdin', { a: 1 }))).toBe('{\n  "a": 1\n}')
    expect(wireDetail(entry('stdin', '{"a":', 2_000_000))).toBe('{"a":\n…（原本 2,000,000 个字符，只记了前面这些）')
  })

  it('adds entries that arrive once each, in order', () => {
    const a = entry('stdout', 'a')
    const b = entry('stdout', 'b')
    const c = entry('stdout', 'c')
    expect(mergeWireEntries([a, b], [b, c]).map((each) => each.text)).toEqual(['a', 'b', 'c'])
  })

  it('writes the entries back as the log keeps them', () => {
    expect(wireJsonl([{ pos: 9, at: 1, dir: 'stdout', text: 'x' }])).toBe('{"at":1,"dir":"stdout","text":"x"}')
  })

  it('sizes in bytes, kilobytes and megabytes', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('groupWireEntries', () => {
  const text = (value: string) => entry('stdout', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: value } } })

  it('folds a run of streamed pieces into one row, and leaves one on its own alone', () => {
    const rows = groupWireEntries([
      entry('stdin', { type: 'user' }),
      text('Hel'),
      entry('stdout', { type: 'keep_alive' }),
      text('lo'),
      entry('stdout', { type: 'assistant' }),
      text('again'),
      entry('stdout', { type: 'result' })
    ])
    expect(rows.map((row) => (row.kind === 'stream' ? `stream ${row.entries.length}` : wireLabel(row.entry)))).toEqual(['user', 'stream 3', 'assistant', 'stream_event · content_block_delta', 'result'])
  })

  it('joins the text the pieces carry, Claude\'s and Codex\'s', () => {
    const pieces = [
      text('Hel'),
      entry('stdout', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'lo' } } }),
      entry('stdout', { type: 'keep_alive' }),
      entry('stdout', { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: ' world' } })
    ]
    expect(streamText(pieces)).toBe('Hello world')
    expect(streamLabel(pieces)).toBe('流式增量 × 4 · Hello world')
    expect(streamLabel([entry('stdout', { type: 'keep_alive' }), entry('stdout', { type: 'keep_alive' })])).toBe('流式增量 × 2')
  })
})
