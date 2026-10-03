import { describe, expect, it } from 'vitest'
import { fileTarget, insertMention, matchProjects, mentionQuery, mentionText } from './chat-mentions'

describe('mentionQuery', () => {
  it('reads the @word the caret is in, at the start or after a space', () => {
    expect(mentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(mentionQuery('look at @src/co', 15)).toEqual({ start: 8, end: 15, query: 'src/co' })
    expect(mentionQuery('fix\n@comp please', 6)).toEqual({ start: 4, end: 9, query: 'c' })
  })

  it('reads one straight after Chinese text or punctuation', () => {
    expect(mentionQuery('看看@rea', 6)).toEqual({ start: 2, end: 6, query: 'rea' })
    expect(mentionQuery('回答：@rea', 7)).toEqual({ start: 3, end: 7, query: 'rea' })
  })

  it('ignores an @ inside a word, or a caret past the word', () => {
    expect(mentionQuery('mail me@host', 12)).toBeNull()
    expect(mentionQuery('v1.2@x', 6)).toBeNull()
    expect(mentionQuery('@src done', 9)).toBeNull()
    expect(mentionQuery('', 0)).toBeNull()
  })
})

describe('mentionText', () => {
  const inCwd = fileTarget({ path: '/repo/src/a.ts', root: '/repo', relative: 'src/a.ts', kind: 'file' }, '/repo')
  const elsewhere = fileTarget({ path: '/other/lib/b.ts', root: '/other', relative: 'lib/b.ts', kind: 'file' }, '/repo')
  const folder = fileTarget({ path: '/repo/src/lib', root: '/repo', relative: 'src/lib', kind: 'directory' }, '/repo')

  it('gives Claude its own @ mentions, relative inside its working folder', () => {
    expect(mentionText(inCwd, 'claude')).toBe('@src/a.ts')
    expect(mentionText(elsewhere, 'claude')).toBe('@/other/lib/b.ts')
    expect(mentionText(folder, 'claude')).toBe('@src/lib/')
    expect(mentionText({ kind: 'file', path: '/repo/my notes.md', relative: 'my notes.md' }, 'claude')).toBe('@"my notes.md"')
  })

  it('gives Codex the bare path, and either agent a project as a path only', () => {
    expect(mentionText(inCwd, 'codex')).toBe('src/a.ts')
    expect(mentionText(folder, 'codex')).toBe('src/lib/')
    expect(mentionText({ kind: 'file', path: '/repo/my notes.md', relative: 'my notes.md' }, 'codex')).toBe('`my notes.md`')
    expect(mentionText({ kind: 'project', path: '/work/api', relative: null }, 'claude')).toBe('/work/api')
  })
})

describe('insertMention', () => {
  it('replaces the whole word and puts the caret past a space', () => {
    const text = 'see @sr/x and'
    expect(insertMention(text, { start: 4, end: 9, query: 'sr' }, '@src/a.ts', true)).toEqual({ text: 'see @src/a.ts and', caret: 14 })
    expect(insertMention('@co', { start: 0, end: 3, query: 'co' }, '@config.ts', true)).toEqual({ text: '@config.ts ', caret: 11 })
  })

  it('puts a space between it and the text it follows', () => {
    expect(insertMention('看看@rea', { start: 2, end: 6, query: 'rea' }, '@README.md', true)).toEqual({ text: '看看 @README.md ', caret: 14 })
    expect(insertMention('看看@s', { start: 2, end: 4, query: 's' }, '@src/', false)).toEqual({ text: '看看 @src/', caret: 8 })
  })

  it('leaves a folder being opened without a space, the caret at its end', () => {
    expect(insertMention('@sr', { start: 0, end: 3, query: 'sr' }, '@src/', false)).toEqual({ text: '@src/', caret: 5 })
  })
})

describe('matchProjects', () => {
  it('puts folder names starting with the query first, then paths holding it', () => {
    const paths = ['/work/web-app', '/work/api', '/apps/legacy']
    expect(matchProjects(paths, 'ap')).toEqual(['/work/api', '/work/web-app', '/apps/legacy'])
    expect(matchProjects(paths, '')).toEqual(paths)
    expect(matchProjects(paths, 'zzz')).toEqual([])
  })
})
