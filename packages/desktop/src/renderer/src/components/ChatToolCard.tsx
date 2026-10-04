import { createContext, useContext, useEffect, useState } from 'react'
import { terminalToolKind, type ChatDiff, type ChatItem, type ChatToolStatus } from '@kando/protocol'
import { useDisclosure } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { showTerminal } from '../core-store'
import { diffCounts, elapsedText, runHeadline, toolLabel } from '../chat-tools'
import { DiffLines } from './DiffLines'
import { ChatToolIcon } from './ChatToolIcon'
import { ChevronRightIcon } from './icons'
import { Spinner } from './Spinner'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Turns the conversation's project paths in a title or diff header into short, relative ones.
export const ChatPaths = createContext<(text: string) => string>((text) => text)

// A file's type as a small badge: its extension, coloured by the stylesheet for the common ones.
export function FileExt({ path }: { path: string }) {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (!ext || ext.length > 4) return null
  return <span className="chat-file-ext" data-ext={ext} aria-hidden="true">{ext.slice(0, 3)}</span>
}


// Only what did not simply work is said; a finished call needs no word.
const STATUS_TEXT: Partial<Record<ChatToolStatus, string>> = { failed: '失败', denied: '已拒绝', interrupted: '已中断' }

// A long output is cut here: the call's own card is not where to read a whole log.
const OUTPUT_LIMIT = 4000

export function clipped(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…（还有 ${text.length - OUTPUT_LIMIT} 字）` : text
}

// How long a call has run so far, ticking beside its spinner; gone once it finishes.
function ToolTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])
  return <span className="chat-tool-time" aria-hidden="true">{elapsedText(Math.max(0, now - since))}</span>
}

export function ToolStatus({ status, since }: { status: ChatToolStatus; since?: number }) {
  if (status === 'running') return <><Spinner label="进行中" />{since !== undefined && <ToolTimer since={since} />}</>
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

// Edits to one file made one after another: one collapsed card, each edit's diff in turn.
export function ChatEditsCard({ path, tools }: { path: string; tools: readonly ToolItem[] }) {
  const [first] = tools
  const [open, setOpen] = useDisclosure(`edits:${first ? itemKey(first) : path}`)
  const shorten = useContext(ChatPaths)
  return (
    <div className="chat-tool" data-diff-path={path}>
      <button type="button" className="chat-tool-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChatToolIcon name="Edit" status={tools.find((tool) => tool.status === 'running')?.status ?? tools.find((tool) => tool.status !== 'done')?.status ?? 'done'} />
        <span className="chat-tool-name">编辑:</span>
        <FileExt path={path} />
        <span className="chat-tool-title" title={path}>{shorten(path)}<span className="chat-tool-count"> · {tools.length} 次</span></span>
        <DiffCount diffs={tools.flatMap((tool) => tool.diffs)} />
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
      </button>
      {open && <div className="chat-diffs">
        {tools.map((tool, index) => (
          <div key={tool.id} className="chat-diff">
            <div className="chat-diff-path chat-edit-step">
              第 {index + 1} 次
              <DiffCount diffs={tool.diffs} />
              <ToolStatus status={tool.status} since={tool.at} />
            </div>
            {tool.diffs.map((diff, at) => diff.patch && <DiffLines key={at} patch={diff.patch} />)}
          </div>
        ))}
      </div>}
    </div>
  )
}

// One call as a flat line: what it is and what it was given, opening onto its input and output.
function ToolLine({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useDisclosure(`call:${itemKey(tool)}`)
  const shorten = useContext(ChatPaths)
  const details = Boolean(tool.input || tool.output)
  return (
    <div className="chat-tool-line" data-status={tool.status}>
      <button
        type="button"
        className="chat-tool-row"
        aria-expanded={details ? open : undefined}
        disabled={!details}
        onClick={() => setOpen(!open)}
      >
        <ChatToolIcon name={tool.name} status={tool.status} />
        {tool.description ? (
          // What the agent said the call does; the command itself is a hover, or a click, away.
          <span className="chat-tool-description" title={tool.title}>{tool.description}</span>
        ) : (
          <>
            <span className="chat-tool-name">{toolLabel(tool.name)}</span>
            <span className="chat-tool-title mono" title={tool.title}>{shorten(tool.title)}</span>
          </>
        )}
        {details && <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>}
        <ToolStatus status={tool.status} since={tool.at} />
      </button>
      {open && tool.input && <pre className="chat-tool-io">{tool.input}</pre>}
      {open && tool.output && <pre className="chat-tool-io">{clipped(tool.output)}</pre>}
    </div>
  )
}

// Calls made one after another, as one sentence of what they did: the one still going named beside
// it, any that failed counted. A lone call is just its line.
export function ChatToolRun({ tools }: { tools: readonly ToolItem[] }) {
  const [only] = tools
  const [open, setOpen] = useDisclosure(`run:${only ? itemKey(only) : ''}`)
  const shorten = useContext(ChatPaths)
  if (tools.length === 1 && only) return <ToolLine tool={only} />
  const running = tools.find((tool) => tool.status === 'running')
  const failed = tools.filter((tool) => tool.status === 'failed' || tool.status === 'denied').length
  const headline = runHeadline(tools)
  return (
    <div className="chat-tool-run" data-open={open || undefined}>
      <button type="button" className="chat-tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChatToolIcon name={running?.name ?? only?.name ?? ''} status={running ? 'running' : failed > 0 ? 'failed' : 'done'} />
        <span className="chat-tool-summary" title={headline.described ? running?.title : undefined}>{headline.text}</span>
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        {running && !headline.described && <span className="chat-tool-title mono" title={running.title}>{shorten(running.title)}</span>}
        {running ? <ToolStatus status="running" since={running.at} /> : failed > 0 && <span className="chat-tool-status" data-status="failed">{failed} 个失败</span>}
      </button>
      {open && (
        <div className="chat-tool-run-lines">
          {tools.map((tool) => <ToolLine key={tool.id} tool={tool} />)}
        </div>
      )}
    </div>
  )
}

// A call that changed files: its collapsed card opens onto the diff, input and output.
// The terminal a run started, as the tool's result names it.
const TERMINAL_ID = /标签 id：([0-9a-f-]{36})/

export function ChatToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useDisclosure(`card:${itemKey(item)}`)
  const shorten = useContext(ChatPaths)
  const details = Boolean(item.diffs.length || item.input || item.output)
  // A command the agent runs in a terminal of its own: the card opens the panel on it.
  const terminal = terminalToolKind(item.name) === 'run' ? TERMINAL_ID.exec(item.output ?? '')?.[1] ?? null : null
  return (
    <div className="chat-tool" data-status={item.status}>
      <button
        type="button"
        className="chat-tool-header"
        aria-expanded={details ? open : undefined}
        disabled={!details}
        onClick={() => setOpen(!open)}
      >
        <ChatToolIcon name={item.name} status={item.status} />
        <span className="chat-tool-name">{toolLabel(item.name)}:</span>
        {item.diffs.length > 0 && <FileExt path={item.diffs[0]?.path ?? item.title} />}
        <span className="chat-tool-title" title={item.title}>{shorten(item.title)}</span>
        <DiffCount diffs={item.diffs} />
        {details && <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>}
        <ToolStatus status={item.status} since={item.at} />
      </button>
      {terminal && (
        <div className="chat-tool-actions">
          <button type="button" className="link-button" onClick={() => showTerminal(terminal)}>在终端面板里看</button>
        </div>
      )}
      {open && item.diffs.length > 0 && <ChatDiffs diffs={item.diffs} />}
      {open && item.input && <pre className="chat-tool-io">{item.input}</pre>}
      {open && item.output && <pre className="chat-tool-io">{clipped(item.output)}</pre>}
    </div>
  )
}
