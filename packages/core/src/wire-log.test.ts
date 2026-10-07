import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WireEntry } from '@kando/protocol'
import { WIRE_LINE_LIMIT_CHARS, WIRE_STAGE_LIMIT_BYTES, WireLog } from './wire-log'

describe('WireLog', () => {
  let root: string
  let added: WireEntry[]
  let wire: WireLog

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-wire-'))
    added = []
    wire = new WireLog(root, (_conversationId, _stageId, entries) => added.push(...entries), () => 1000)
    wire.setEnabled(true)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('pages back from the newest entry, each with its place in the file', () => {
    wire.record('c', 's', [{ dir: 'stdin', text: 'one' }, { dir: 'stdout', text: 'two' }])
    wire.record('c', 's', [{ dir: 'stderr', text: 'three' }])
    const { entries, before } = wire.page('c', 's')
    expect(entries.map((entry) => entry.text)).toEqual(['one', 'two', 'three'])
    expect(before).toBeNull()
    expect(entries).toEqual(added)
    // Paging from an entry gives the ones before it.
    expect(wire.page('c', 's', entries[2]?.pos).entries.map((entry) => entry.text)).toEqual(['one', 'two'])
  })

  it('stops a page at 500 entries and says where the older ones end', () => {
    wire.record('c', 's', Array.from({ length: 501 }, (_, index) => ({ dir: 'stdout' as const, text: String(index) })))
    const newest = wire.page('c', 's')
    expect(newest.entries).toHaveLength(500)
    expect(newest.entries[0]?.text).toBe('1')
    expect(newest.before).toBe(newest.entries[0]?.pos)
    const older = wire.page('c', 's', newest.before ?? undefined)
    expect(older.entries.map((entry) => entry.text)).toEqual(['0'])
    expect(older.before).toBeNull()
  })

  it('cuts a very long line short and says how long it was', () => {
    const long = 'x'.repeat(WIRE_LINE_LIMIT_CHARS + 10)
    wire.record('c', 's', [{ dir: 'stdin', text: long }])
    const [entry] = wire.page('c', 's').entries
    expect(entry?.text).toHaveLength(WIRE_LINE_LIMIT_CHARS)
    expect(entry?.cut).toBe(long.length)
  })

  it('stops a stage at its size limit with a note', () => {
    const file = wire.file('c', 's')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ at: 1, dir: 'stdout', text: 'x'.repeat(WIRE_STAGE_LIMIT_BYTES - 100) })}\n`)
    wire.record('c', 's', [{ dir: 'stdout', text: 'fits' }, { dir: 'stdout', text: 'y'.repeat(200) }, { dir: 'stdout', text: 'after' }])
    expect(added.map((entry) => entry.text.slice(0, 4))).toEqual(['fits', '这一段的'])
    wire.record('c', 's', [{ dir: 'stdout', text: 'later' }])
    expect(added).toHaveLength(2)
    expect(readFileSync(file, 'utf8')).not.toContain('later')
  })

  it('starts a new line after one a crash left torn', () => {
    const file = wire.file('c', 's')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ at: 1, dir: 'stdout', text: 'whole' })}\n{"at":2,"dir":"std`)
    wire.record('c', 's', [{ dir: 'stdout', text: 'next' }])
    expect(wire.page('c', 's').entries.map((entry) => entry.text)).toEqual(['whole', 'next'])
  })

  it('records nothing while off', () => {
    wire.setEnabled(false)
    wire.record('c', 's', [{ dir: 'stdout', text: 'one' }])
    expect(wire.stages('c')).toEqual([])
    expect(added).toEqual([])
  })

  it('adds up, prunes and clears every conversation\'s logs', () => {
    wire.record('a', 's1', [{ dir: 'stdout', text: 'one' }])
    wire.record('b', 's2', [{ dir: 'stdout', text: 'two' }])
    // Another folder under sessions with no wire log is left alone.
    mkdirSync(path.join(root, 'c', 'stages'), { recursive: true })
    expect(wire.usage().files).toBe(2)
    expect(wire.stages('a').map((stage) => stage.stageId)).toEqual(['s1'])

    const old = new Date(0)
    utimesSync(wire.file('a', 's1'), old, old)
    wire.prune(500)
    expect(wire.stages('a')).toEqual([])
    expect(wire.usage().files).toBe(1)

    expect(wire.clear()).toEqual({ files: 0, bytes: 0 })
    // Written again from the start of a new file, not where the deleted one ended.
    wire.record('b', 's2', [{ dir: 'stdout', text: 'three' }])
    expect(wire.page('b', 's2').entries).toEqual([expect.objectContaining({ pos: 0, text: 'three' })])
  })

  it('skips a line it cannot read', () => {
    wire.record('c', 's', [{ dir: 'stdout', text: 'one' }])
    appendFileSync(wire.file('c', 's'), 'not json\n')
    wire.record('c', 's', [{ dir: 'stdout', text: 'two' }])
    expect(wire.page('c', 's').entries.map((entry) => entry.text)).toEqual(['one', 'two'])
  })
})
