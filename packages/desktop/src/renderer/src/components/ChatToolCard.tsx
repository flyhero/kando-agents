import { createContext, useContext, useState } from 'react'
import type { ChatDiff, ChatItem, ChatToolStatus } from '@kando/protocol'
import { diffCounts, runSummary, toolLabel } from '../chat-tools'
import { DiffLines } from './DiffLines'
import { ChevronRightIcon } from './icons'
import { Spinner } from './Spinner'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Turns the conversation's project paths in a title or diff header into short, relative ones.
export const ChatPaths = createContext<(text: string) => string>((text) => text)


// Only what did not simply work is said; a finished call needs no word.
const STATUS_TEXT: Partial<Record<ChatToolStatus, string>> = { failed: '失败', denied: '已拒绝', interrupted: '已中断' }

// A long output is cut here: the call's own card is not where to read a whole log.
const OUTPUT_LIMIT = 4000

function clipped(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…（还有 ${text.length - OUTPUT_LIMIT} 字）` : text
}

function ToolStatus({ status }: { status: ChatToolStatus }) {
  if (status === 'running') return <Spinner label="进行中" />
  const text = STATUS_TEXT[status]
  return text ? <span className="chat-tool-status" data-status={status}>{text}</span> : null
}

export function ChatDiffs({ diffs }: { diffs: readonly ChatDiff[] }) {
  const shorten = useContext(ChatPaths)
  return (
    <div className="chat-diffs">
      {diffs.map((diff, index) => (
        <div key={`${diff.path}:${index}`} className="chat-diff" data-diff-path={diff.path}>
          <div className="chat-diff-path mono" title={diff.path}>
            {diff.change === 'add' ? '新建 ' : diff.change === 'delete' ? '删除 ' : ''}
            {shorten(diff.path)}
          </div>
          {diff.patch && <DiffLines patch={diff.patch} />}
        </div>
      ))}
    </div>
  )
}

function DiffCount({ diffs }: { diffs: readonly ChatDiff[] }) {
  const { added, removed } = diffCounts(diffs)
  return (
    <span className="chat-diff-count mono">
      {added > 0 && <span className="chat-diff-added">+{added}</span>}
      {removed > 0 && <span className="chat-diff-removed">−{removed}</span>}
    </span>
  )
}

// Edits to one file made one after another: one card, each edit's diff in turn with its own count.
export function ChatEditsCard({ path, tools }: { path: string; tools: readonly ToolItem[] }) {
  const shorten = useContext(ChatPaths)
  return (
    <div className="chat-tool" data-diff-path={path}>
      <div className="chat-tool-header">
        <span className="chat-tool-name">编辑</span>
        <span className="chat-tool-title mono" title={path}>{shorten(path)} · {tools.length} 次修改</span>
        <DiffCount diffs={tools.flatMap((tool) => tool.diffs)} />
      </div>
      <div className="chat-diffs">
        {tools.map((tool, index) => (
          <div key={tool.id} className="chat-diff">
            <div className="chat-diff-path chat-edit-step">
              第 {index + 1} 次
              <DiffCount diffs={tool.diffs} />
              <ToolStatus status={tool.status} />
            </div>
            {tool.diffs.map((diff, at) => diff.patch && <DiffLines key={at} patch={diff.patch} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

// One call as a flat line: what it is and what it was given, opening onto its input and output.
function ToolLine({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false)
  const shorten = useContext(ChatPaths)
  const details = Boolean(tool.input || tool.output)
  return (
    <div className="chat-tool-line" data-status={tool.status}>
      <button
        type="button"
        className="chat-tool-row"
        aria-expanded={details ? open : undefined}
        disabled={!details}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="chat-tool-chevron" aria-hidden="true">{details && <ChevronRightIcon />}</span>
        <span className="chat-tool-name">{toolLabel(tool.name)}</span>
        <span className="chat-tool-title mono" title={tool.title}>{shorten(tool.title)}</span>
        <ToolStatus status={tool.status} />
      </button>
      {open && tool.input && <pre className="chat-tool-io">{tool.input}</pre>}
      {open && tool.output && <pre className="chat-tool-io">{clipped(tool.output)}</pre>}
    </div>
  )
}

// Calls made one after another, as one sentence of what they did: the one still going named beside
// it, any that failed counted. A lone call is just its line.
export function ChatToolRun({ tools }: { tools: readonly ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const shorten = useContext(ChatPaths)
  const [only] = tools
  if (tools.length === 1 && only) return <ToolLine tool={only} />
  const running = tools.find((tool) => tool.status === 'running')
  const failed = tools.filter((tool) => tool.status === 'failed' || tool.status === 'denied').length
  return (
    <div className="chat-tool-run" data-open={open || undefined}>
      <button type="button" className="chat-tool-row" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        <span className="chat-tool-summary">{runSummary(tools)}</span>
        {running && <span className="chat-tool-title mono" title={running.title}>{shorten(running.title)}</span>}
        {running ? <ToolStatus status="running" /> : failed > 0 && <span className="chat-tool-status" data-status="failed">{failed} 个失败</span>}
      </button>
      {open && (
        <div className="chat-tool-run-lines">
          {tools.map((tool) => <ToolLine key={tool.id} tool={tool} />)}
        </div>
      )}
    </div>
  )
}

// A call that changed files: its card shows the diff at once, with the lines it added and removed.
export function ChatToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const shorten = useContext(ChatPaths)
  const details = Boolean(item.input || item.output)
  return (
    <div className="chat-tool" data-status={item.status}>
      <button
        type="button"
        className="chat-tool-header"
        aria-expanded={details ? open : undefined}
        disabled={!details}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="chat-tool-name">{toolLabel(item.name)}</span>
        <span className="chat-tool-title mono" title={item.title}>{shorten(item.title)}</span>
        <DiffCount diffs={item.diffs} />
        <ToolStatus status={item.status} />
      </button>
      {item.diffs.length > 0 && <ChatDiffs diffs={item.diffs} />}
      {open && item.input && <pre className="chat-tool-io">{item.input}</pre>}
      {open && item.output && <pre className="chat-tool-io">{clipped(item.output)}</pre>}
    </div>
  )
}
