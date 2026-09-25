import { z } from 'zod'

// Atlassian Document Format: the JSON tree Jira's v3 API uses for descriptions and comments.
type AdfMark = { type: string; attrs?: Record<string, unknown> }
type AdfNode = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: AdfMark[]; content?: AdfNode[] }

const AdfMarkSchema = z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })
const AdfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(AdfMarkSchema).optional(),
    content: z.array(AdfNodeSchema).optional()
  })
)

function attr(node: { attrs?: Record<string, unknown> }, name: string): string | null {
  const value = node.attrs?.[name]
  if (typeof value === 'string') {
    return value
  }
  return typeof value === 'number' ? String(value) : null
}

// Keeps surrounding spaces outside the delimiters: `** bold**` is not bold in markdown.
function wrap(text: string, open: string, close: string = open): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
  if (!match || !match[2]) {
    return text
  }
  return `${match[1]}${open}${match[2]}${close}${match[3]}`
}

// CommonMark will not close `**问题：**批` (punctuation inside, a letter right after), which
// Chinese text hits all the time, so edge punctuation moves outside the delimiters.
function emphasize(text: string, delimiter: string): string {
  const match = /^(\s*)(\p{P}*)([\s\S]*?)(\p{P}*)(\s*)$/u.exec(text)
  if (!match || !match[3]) {
    return wrap(text, delimiter)
  }
  const [, before = '', lead = '', inner = '', trail = '', after = ''] = match
  return `${before}${lead}${wrap(inner, delimiter)}${trail}${after}`
}

function markText(node: AdfNode): string {
  let text = node.text ?? ''
  const marks = node.marks ?? []
  const has = (type: string) => marks.some((mark) => mark.type === type)
  if (has('code')) {
    text = wrap(text, '`')
  } else {
    if (has('strong')) {
      text = emphasize(text, '**')
    }
    if (has('em')) {
      text = emphasize(text, '*')
    }
    if (has('strike')) {
      text = emphasize(text, '~~')
    }
  }
  const link = marks.find((mark) => mark.type === 'link')
  const href = link ? attr(link, 'href') : null
  return href ? `[${text}](${href})` : text
}

function formatDate(timestamp: string | null): string {
  const ms = Number(timestamp)
  return Number.isFinite(ms) && timestamp ? new Date(ms).toISOString().slice(0, 10) : ''
}

function prefixLines(text: string, first: string, rest: string = first): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? first : line ? rest : rest.trimEnd()) + line)
    .join('\n')
}

// Link text from the tracker must not break out of `[...]`; line breaks would end the link.
export function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (char) => `\\${char}`).replace(/\s+/g, ' ')
}

// What an embedded file becomes in the text. The caller knows which files are images, and
// shows those itself; the default names the file.
export type MediaDescriber = (name: string | null) => string
const describeFile: MediaDescriber = (name) => `（附件：${escapeLinkText(name ?? '文件')}）`

class AdfRenderer {
  constructor(private readonly describeMedia: MediaDescriber) {}

  inline(nodes: readonly AdfNode[] = []): string {
    return nodes
      .map((node) => {
        switch (node.type) {
          case 'text':
            return markText(node)
          case 'hardBreak':
            return '\n'
          case 'mention':
            return attr(node, 'text') ?? '@someone'
          case 'emoji':
            return attr(node, 'text') ?? attr(node, 'shortName') ?? ''
          case 'inlineCard':
            return attr(node, 'url') ?? ''
          case 'date':
            return formatDate(attr(node, 'timestamp'))
          case 'status':
            return `[${attr(node, 'text') ?? ''}]`
          case 'mediaInline':
            return this.describeMedia(attr(node, 'alt'))
          default:
            return node.content ? this.inline(node.content) : (node.text ?? '')
        }
      })
      .join('')
  }

  blocks(nodes: readonly AdfNode[], separator: string = '\n\n'): string {
    return nodes
      .map((node) => this.block(node))
      .filter((text) => text.trim() !== '')
      .join(separator)
  }

  private listItems(node: AdfNode, marker: (index: number, item: AdfNode) => string): string {
    return (node.content ?? [])
      .map((item, index) => {
        const bullet = marker(index, item)
        // taskItem holds inline nodes directly; listItem holds blocks.
        const body = item.type === 'taskItem' ? this.inline(item.content) : this.blocks(item.content ?? [], '\n')
        return prefixLines(body, bullet, ' '.repeat(bullet.length))
      })
      .join('\n')
  }

  private tableCell(cell: AdfNode): string {
    return this.blocks(cell.content ?? [], ' ')
      .replace(/\n+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim()
  }

  // GFM needs a header row, so the first row is one whether or not Jira marked it.
  private table(node: AdfNode): string {
    const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => this.tableCell(cell)))
    const [head, ...body] = rows
    if (!head) {
      return ''
    }
    const width = Math.max(...rows.map((row) => row.length))
    const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill('')]
    const line = (row: string[]) => `| ${pad(row).join(' | ')} |`
    return [line(head), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n')
  }

  // A file is a Jira attachment, described by the caller; an external image stays a link.
  private media(node: AdfNode): string {
    return (node.content ?? [])
      .filter((child) => child.type === 'media')
      .map((child) => {
        const name = attr(child, 'alt')
        const url = attr(child, 'url')
        if (attr(child, 'type') === 'external' && url) {
          return `[图片：${escapeLinkText(name ?? '外部图片')}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)`
        }
        return this.describeMedia(name)
      })
      .join('\n')
  }

  private block(node: AdfNode): string {
    switch (node.type) {
      case 'paragraph':
        return this.inline(node.content)
      case 'heading': {
        const level = Math.min(Math.max(Number(attr(node, 'level') ?? 1), 1), 6)
        return `${'#'.repeat(level)} ${this.inline(node.content)}`
      }
      case 'bulletList':
        return this.listItems(node, () => '- ')
      case 'orderedList': {
        const start = Number(attr(node, 'order') ?? 1)
        return this.listItems(node, (index) => `${start + index}. `)
      }
      case 'taskList':
        return this.listItems(node, (_index, item) => (attr(item, 'state') === 'DONE' ? '- [x] ' : '- [ ] '))
      case 'decisionList':
        return this.listItems(node, () => '- ')
      case 'codeBlock': {
        const code = (node.content ?? []).map((child) => child.text ?? '').join('')
        const fence = code.includes('```') ? '~~~' : '```'
        return `${fence}${attr(node, 'language') ?? ''}\n${code}\n${fence}`
      }
      case 'blockquote':
      case 'panel':
        return prefixLines(this.blocks(node.content ?? []), '> ')
      case 'rule':
        return '---'
      case 'table':
        return this.table(node)
      case 'mediaSingle':
      case 'mediaGroup':
        return this.media(node)
      case 'expand':
      case 'nestedExpand': {
        const title = attr(node, 'title')
        const body = this.blocks(node.content ?? [])
        return title ? `**${title}**\n\n${body}` : body
      }
      default:
        return node.content ? this.blocks(node.content) : this.inline([node])
    }
  }
}

// Checked before parsing, iteratively: the schema and the renderer recurse, so a hostile document
// must not get to decide how deep they go.
const MAX_DEPTH = 50
const MAX_NODES = 20_000
export const ADF_TOO_COMPLEX = '（内容结构过于复杂，没有转换，请在原系统里查看）'

function withinLimits(value: unknown): boolean {
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }]
  let count = 0
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    count += 1
    if (count > MAX_NODES || entry.depth > MAX_DEPTH) {
      return false
    }
    const { node, depth } = entry
    if (typeof node === 'object' && node !== null && 'content' in node && Array.isArray(node.content)) {
      node.content.forEach((child: unknown) => stack.push({ node: child, depth: depth + 1 }))
    }
  }
  return true
}

// Anything that is not an ADF document (an older plain-text field, null) is kept as text.
export function adfToMarkdown(value: unknown, options: { describeMedia?: MediaDescriber } = {}): string {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (!withinLimits(value)) {
    return ADF_TOO_COMPLEX
  }
  const parsed = AdfNodeSchema.safeParse(value)
  if (!parsed.success) {
    return ''
  }
  return new AdfRenderer(options.describeMedia ?? describeFile).blocks(parsed.data.content ?? [parsed.data]).trim()
}
