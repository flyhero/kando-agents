import { describe, expect, it } from 'vitest'
import { caretOutside, fileTarget, insertMention, markedRuns, matchProjects, mentionBeside, mentionLabel, mentionQuery, mentionText, placeMention, shiftMentions, writeMentions, type Mention, type MentionTarget } from './chat-mentions'

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

const fontFile: MentionTarget = { kind: 'file', path: '/repo/src/font.ts', relative: 'src/font.ts' }
const orca: MentionTarget = { kind: 'project', path: '/work/orca', relative: null }
const at = (start: number, end: number, target: MentionTarget = fontFile): Mention => ({ start, end, target })

describe('mentionLabel', () => {
  it('names a file, folder or project by its last part, a folder with a slash', () => {
    expect(mentionLabel(fontFile)).toBe('font.ts')
    expect(mentionLabel(orca)).toBe('orca')
    expect(mentionLabel({ kind: 'directory', path: '/repo/src/lib', relative: 'src/lib' })).toBe('lib/')
  })
})

describe('placeMention', () => {
  it('puts the name in for the @word, spaced, and marks it', () => {
    expect(placeMention({ text: '看看@fo', mentions: [] }, { start: 2, end: 5, query: 'fo' }, fontFile)).toEqual({
      value: { text: '看看 font.ts ', mentions: [at(3, 10)] },
      caret: 11
    })
  })

  it('moves the mentions after it, and keeps them in order', () => {
    const value = { text: '@or then font.ts', mentions: [at(9, 16)] }
    expect(placeMention(value, { start: 0, end: 3, query: 'or' }, orca)).toEqual({
      value: { text: 'orca then font.ts', mentions: [at(0, 4, orca), at(10, 17)] },
      caret: 5
    })
  })
})

describe('shiftMentions', () => {
  const mentions = [at(3, 10)]
  const text = '看看 font.ts 的'

  it('keeps a mention the change is before or after, moving it with the text', () => {
    expect(shiftMentions(mentions, text, `${text}内容`, 15)).toEqual(mentions)
    expect(shiftMentions(mentions, text, `改${text}`, 1)).toEqual([at(4, 11)])
    expect(shiftMentions(mentions, text, `新

${text}`, null)).toEqual([at(6, 13)])
  })

  it('drops a mention the change reaches into', () => {
    expect(shiftMentions(mentions, text, '看看 font.s 的', 8)).toEqual([])
    expect(shiftMentions(mentions, text, '', 0)).toEqual([])
  })

  it('takes typing beside a mention as outside it, where equal letters leave it unclear', () => {
    // An s typed straight after font.ts, or straight before a mention named s.ts.
    expect(shiftMentions(mentions, text, '看看 font.tss 的', 11)).toEqual(mentions)
    expect(shiftMentions([at(0, 4)], 's.ts', 'ss.ts', 1)).toEqual([at(1, 5)])
  })
})

describe('writeMentions', () => {
  it('writes each mention out as the agent reads it', () => {
    const value = { text: '看看 font.ts 和 orca', mentions: [at(3, 10), at(13, 17, orca)] }
    expect(writeMentions(value, 'claude')).toBe('看看 @src/font.ts 和 /work/orca')
    expect(writeMentions(value, 'codex')).toBe('看看 src/font.ts 和 /work/orca')
  })

  it('sets a mention apart from text running into it', () => {
    expect(writeMentions({ text: '看看font.ts的', mentions: [at(2, 9)] }, 'claude')).toBe('看看 @src/font.ts 的')
    expect(writeMentions({ text: 'font.tsfont.ts', mentions: [at(0, 7), at(7, 14)] }, 'claude')).toBe('@src/font.ts @src/font.ts')
  })
})

describe('caretOutside', () => {
  it('sends a caret inside a mention to its nearer end, and leaves one outside alone', () => {
    const mentions = [at(3, 10)]
    expect(caretOutside(mentions, 5)).toBe(3)
    expect(caretOutside(mentions, 8)).toBe(10)
    expect(caretOutside(mentions, 10)).toBe(10)
    expect(caretOutside(mentions, 1)).toBe(1)
  })
})

describe('mentionBeside', () => {
  it('finds the mention a step to either side would go into', () => {
    const mentions = [at(3, 10)]
    expect(mentionBeside(mentions, 10, false)).toEqual(at(3, 10))
    expect(mentionBeside(mentions, 3, true)).toEqual(at(3, 10))
    expect(mentionBeside(mentions, 3, false)).toBeNull()
  })
})

describe('markedRuns', () => {
  it('splits the text at mentions and what an input method composes', () => {
    expect(markedRuns('看看 font.ts 的', [at(3, 10)], { start: 11, end: 12 })).toEqual([
      { text: '看看 ', mention: false, composing: false },
      { text: 'font.ts', mention: true, composing: false },
      { text: ' ', mention: false, composing: false },
      { text: '的', mention: false, composing: true }
    ])
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
