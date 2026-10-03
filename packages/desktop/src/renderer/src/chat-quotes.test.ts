import { describe, expect, it } from 'vitest'
import { composeFeedback, composeMessage, FEEDBACK_LIMIT, parseQuotes } from './chat-quotes'

describe('composeMessage', () => {
  it('puts each quote before the message: its marker, the passage, then the note', () => {
    expect(composeMessage([
      { source: 'item:s/r1', text: 'first line\n\nsecond line', note: 'why this?' },
      { source: null, text: 'another', note: '' }
    ], 'the message')).toBe([
      '<!-- quote 1 from item:s/r1 -->',
      '> first line',
      '>',
      '> second line',
      '',
      'why this?',
      '',
      '',
      '<!-- quote 2 -->',
      '> another',
      '',
      '',
      'the message'
    ].join('\n'))
  })

  it('keeps a note to one line, and leaves a message without quotes as it is', () => {
    expect(composeMessage([{ source: null, text: 'x', note: 'a\nb ' }], '')).toBe('<!-- quote 1 -->\n> x\n\na b')
    expect(composeMessage([], ' hello ')).toBe('hello')
  })
})

describe('parseQuotes', () => {
  it('reads back what composeMessage wrote', () => {
    const quotes = [
      { source: 'item:s/r1', text: 'first line\n\nsecond line', note: 'why this?' },
      { source: null, text: 'another', note: '' },
      { source: 'item:s/r2', text: 'last', note: 'and this' }
    ]
    expect(parseQuotes(composeMessage(quotes, 'the message\n\n> my own quote'))).toEqual({ quotes, body: 'the message\n\n> my own quote' })
    expect(parseQuotes(composeMessage(quotes.slice(0, 1), ''))).toEqual({ quotes: quotes.slice(0, 1), body: '' })
  })

  it('leaves a message that does not open with a quote marker alone', () => {
    expect(parseQuotes('> just Markdown\n\ntext')).toEqual({ quotes: [], body: '> just Markdown\n\ntext' })
    expect(parseQuotes('text\n<!-- quote 1 -->\n> x')).toEqual({ quotes: [], body: 'text\n<!-- quote 1 -->\n> x' })
  })
})

describe('composeFeedback', () => {
  it('quotes each passage with its note, then the rest, without markers', () => {
    expect(composeFeedback([{ text: 'step 2', note: 'skip it' }, { text: 'step 3', note: '' }], 'and add tests'))
      .toBe('> step 2\n\nskip it\n\n> step 3\n\nand add tests')
  })

  it('cuts a long passage short, and the whole to what the answer takes', () => {
    const long = 'x'.repeat(1000)
    expect(composeFeedback([{ text: long, note: '' }], '')).toBe(`> ${'x'.repeat(400)}…`)
    const many = Array.from({ length: 10 }, () => ({ text: long, note: 'n' }))
    expect(composeFeedback(many, '').length).toBe(FEEDBACK_LIMIT)
  })
})
