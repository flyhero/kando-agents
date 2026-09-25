import { describe, expect, it } from 'vitest'
import { ADF_TOO_COMPLEX, adfToMarkdown } from './jira-adf'

const text = (value: string, ...marks: string[]) => ({ type: 'text', text: value, marks: marks.map((type) => ({ type })) })
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content })
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })

describe('adfToMarkdown', () => {
  it('renders paragraphs, headings and inline marks', () => {
    const markdown = adfToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [text('问题描述')] },
        paragraph(text('传入的 '), text('sequence ', 'strong'), text('值过大，见 '), {
          type: 'text',
          text: '文档',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/doc' } }]
        }),
        paragraph(text('调用 '), text('nextSequence()', 'code'), { type: 'hardBreak' }, text('第二行'))
      )
    )
    expect(markdown).toBe(
      '## 问题描述\n\n传入的 **sequence** 值过大，见 [文档](https://example.com/doc)\n\n调用 `nextSequence()`\n第二行'
    )
  })

  it('keeps edge punctuation outside emphasis so CJK text still renders bold', () => {
    const markdown = adfToMarkdown(doc(paragraph(text('问题描述：', 'strong'), text('批量改价'), text('「重要」', 'em'), text('。'))))
    expect(markdown).toBe('**问题描述**：批量改价「*重要*」。')
  })

  it('renders nested lists, task lists and code blocks', () => {
    const markdown = adfToMarkdown(
      doc(
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                paragraph(text('平台：pos-dashboard')),
                {
                  type: 'orderedList',
                  attrs: { order: 3 },
                  content: [{ type: 'listItem', content: [paragraph(text('staging01'))] }]
                }
              ]
            }
          ]
        },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('复现')] },
            { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('修复')] }
          ]
        },
        { type: 'codeBlock', attrs: { language: 'sql' }, content: [text('SELECT 1;')] }
      )
    )
    expect(markdown).toBe('- 平台：pos-dashboard\n  3. staging01\n\n- [x] 复现\n- [ ] 修复\n\n```sql\nSELECT 1;\n```')
  })

  it('keeps mentions, quotes, tables and attachments readable', () => {
    const markdown = adfToMarkdown(
      doc(
        paragraph({ type: 'mention', attrs: { id: 'x', text: '@Siyu Pan' } }, text(' 请确认')),
        { type: 'blockquote', content: [paragraph(text('一定要排在最后？'))] },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph(text('字段'))] }, { type: 'tableHeader', content: [paragraph(text('值'))] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text('a|b'))] }, { type: 'tableCell', content: [paragraph(text('1'))] }] }
          ]
        },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'abc', alt: '截屏.png' } }] }
      )
    )
    expect(markdown).toBe(
      '@Siyu Pan 请确认\n\n> 一定要排在最后？\n\n| 字段 | 值 |\n| --- | --- |\n| a\\|b | 1 |\n\n（附件：截屏.png）'
    )
  })

  it('lets the caller describe embedded files, inline ones too, and keeps names from breaking out', () => {
    const markdown = adfToMarkdown(
      doc(
        paragraph(text('见 '), { type: 'mediaInline', attrs: { alt: 'a].png' } }),
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'external', url: 'https://x.test/a b.png', alt: 'x\n](evil)' } }] }
      ),
      { describeMedia: (name) => `<${name}>` }
    )
    expect(markdown).toBe('见 <a].png>\n\n[图片：x \\](evil)](<https://x.test/a%20b.png>)')
  })

  it('refuses to walk a document nested deeper than a real one would be', () => {
    let nested: unknown = text('bottom')
    for (let depth = 0; depth < 5_000; depth += 1) {
      nested = { type: 'blockquote', content: [nested] }
    }
    expect(adfToMarkdown(doc(nested))).toBe(ADF_TOO_COMPLEX)
  })

  it('treats a plain string as text and anything else as empty', () => {
    expect(adfToMarkdown('  plain  ')).toBe('plain')
    expect(adfToMarkdown(null)).toBe('')
    expect(adfToMarkdown({ nope: true })).toBe('')
  })
})
