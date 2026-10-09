import { createContext, useContext, useEffect, useState } from 'react'
import { terminalToolKind, type ChatDiff, type ChatItem, type ChatToolStatus } from '@kando/protocol'
import { useDisclosure } from '../chat-disclosure'
import { itemKey } from '../chat-state'
import { showTerminal } from '../core-store'
import { commandExitCode, diffCounts, elapsedText, runHeadline, toolDisplayStatus, toolLabel, toolRunStatus } from '../chat-tools'
import { DiffLines } from './DiffLines'
import { ChatToolIcon } from './ChatToolIcon'
import { ChatToolInput } from './ChatToolInput'
import { ChevronRightIcon } from './icons'
import { Spinner } from './Spinner'
import { useJustFinished } from '../chat-motion'
import { ChatCopyRegion } from './ChatCopyRegion'
import { copyTextForItem } from '../message-copy'
import { fileReference } from '../file-links'

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

function CommandExit({ tool }: { tool: ToolItem }) {
  const code = commandExitCode(tool)
  if (code === null || code === 0) return null
  return (
    <div className="chat-tool-actions">
      <span className="chat-tool-status" data-status="failed" aria-label={`退出码 ${code}`}>exit {code}</span>
    </div>
  )
}

export function ChatDiffs({ diffs }: { diffs: readonly ChatDiff[] }) {
  const shorten = useContext(ChatPaths)
  return (
    <div className="chat-diffs">
      {diffs.map((diff, index) => (
        <div key={`${diff.path}:${index}`} className="chat-diff" data-diff-path={diff.path}>
          <div className="chat-diff-path mono" data-file-path={diff.path} title={diff.path}>
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
  const finished = useJustFinished(tools.some((tool) => tool.status === 'running'))
  return (
    <div className="chat-tool" data-diff-path={path} data-finished={finished || undefined}>
      <button type="button" className="chat-tool-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChatToolIcon name="Edit" status={tools.find((tool) => tool.status === 'running')?.status ?? tools.find((tool) => tool.status !== 'done')?.status ?? 'done'} />
        <span className="chat-tool-name">编辑:</span>
        <FileExt path={path} />
        <span className="chat-tool-title" data-file-path={path} title={path}>{shorten(path)}<span className="chat-tool-count"> · {tools.length} 次</span></span>
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
  const code = commandExitCode(tool)
  const details = Boolean(tool.input || tool.output || (code !== null && code !== 0))
  const status = toolDisplayStatus(tool)
  const finished = useJustFinished(status === 'running')
  return (
    <ChatCopyRegion text={copyTextForItem(tool)}>
    <div className="chat-tool-line" data-status={status} data-finished={finished || undefined}>
      <button
        type="button"
        className="chat-tool-row"
        aria-expanded={details ? open : undefined}
        disabled={!details}
        onClick={() => setOpen(!open)}
      >
        <ChatToolIcon name={tool.name} status={status} />
        {tool.description ? (
          // What the agent said the call does; the command itself is a hover, or a click, away.
          <span className="chat-tool-description" title={tool.title}>{tool.description}</span>
        ) : (
          <>
            <span className="chat-tool-name">{toolLabel(tool.name)}</span>
            <span className="chat-tool-title mono" data-file-path={fileReference(tool.title)?.path} title={tool.title}>{shorten(tool.title)}</span>
          </>
        )}
        {details && <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>}
        <ToolStatus status={status} since={tool.at} />
      </button>
      {open && <CommandExit tool={tool} />}
      {open && tool.input && <ChatToolInput name={tool.name} input={tool.input} />}
      {open && tool.output && <ChatCopyRegion text={tool.output}><pre className="chat-tool-io">{clipped(tool.output)}</pre></ChatCopyRegion>}
    </div>
    </ChatCopyRegion>
  )
}

// Only execution exceptions reach the group header; exit results stay in each call's details.
export function ChatToolRun({ tools, summary }: { tools: readonly ToolItem[]; summary?: string }) {
  const [only] = tools
  const [open, setOpen] = useDisclosure(`run:${only ? itemKey(only) : ''}`)
  const shorten = useContext(ChatPaths)
  const running = tools.find((tool) => tool.status === 'running')
  const finished = useJustFinished(Boolean(running))
  if (tools.length === 1 && only && summary === undefined) return <ToolLine tool={only} />
  const outcome = toolRunStatus(tools)
  const headline = summary === undefined ? runHeadline(tools) : { text: summary, described: false }
  // The rail beside the open list fills as the calls finish, top down.
  const settled = tools.filter((tool) => tool.status !== 'running').length
  return (
    <div className="chat-tool-run" data-open={open || undefined} data-live={Boolean(running) || finished || undefined} data-finished={finished || undefined}>
      <button type="button" className="chat-tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChatToolIcon name={running?.name ?? only?.name ?? ''} status={outcome.status} />
        <span className="chat-tool-summary" title={headline.described ? running?.title : undefined}>{headline.text}</span>
        <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        {running && !headline.described && <span className="chat-tool-title mono" title={running.title}>{shorten(running.title)}</span>}
        {running && <ToolStatus status="running" since={running.at} />}
        {outcome.failed > 0 && <span className="chat-tool-status" data-status="failed">{outcome.failed} 项异常</span>}
        {outcome.denied > 0 && <span className="chat-tool-status" data-status="denied">{outcome.denied} 项已拒绝</span>}
        {outcome.interrupted > 0 && <span className="chat-tool-status" data-status="interrupted">{outcome.interrupted} 项已中断</span>}
      </button>
      {open && (
        <div className="chat-tool-run-lines" style={{ '--chat-rail': `${(settled / tools.length) * 100}%` }}>
          {tools.map((tool) => <ToolLine key={itemKey(tool)} tool={tool} />)}
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
  const code = commandExitCode(item)
  const details = Boolean(item.diffs.length || item.input || item.output || (code !== null && code !== 0))
  const status = toolDisplayStatus(item)
  // A command the agent runs in a terminal of its own: the card opens the panel on it.
  const terminal = terminalToolKind(item.name) === 'run' ? TERMINAL_ID.exec(item.output ?? '')?.[1] ?? null : null
  const finished = useJustFinished(status === 'running')
  return (
    <div className="chat-tool" data-status={status} data-finished={finished || undefined}>
      <button
        type="button"
        className="chat-tool-header"
        aria-expanded={details ? open : undefined}
        disabled={!details}
        onClick={() => setOpen(!open)}
      >
        <ChatToolIcon name={item.name} status={status} />
        <span className="chat-tool-name">{toolLabel(item.name)}:</span>
        {item.diffs.length > 0 && <FileExt path={item.diffs[0]?.path ?? item.title} />}
        <span className="chat-tool-title" data-file-path={item.diffs[0]?.path ?? fileReference(item.title)?.path} title={item.title}>{shorten(item.title)}</span>
        <DiffCount diffs={item.diffs} />
        {details && <span className="chat-tool-chevron" aria-hidden="true"><ChevronRightIcon /></span>}
        <ToolStatus status={status} since={item.at} />
      </button>
      {terminal && (
        <div className="chat-tool-actions">
          <button type="button" className="link-button" onClick={() => showTerminal(terminal)}>在终端面板里看</button>
        </div>
      )}
      {open && <CommandExit tool={item} />}
      {open && item.diffs.length > 0 && <ChatDiffs diffs={item.diffs} />}
      {open && item.input && <ChatToolInput name={item.name} input={item.input} />}
      {open && item.output && <ChatCopyRegion text={item.output}><pre className="chat-tool-io">{clipped(item.output)}</pre></ChatCopyRegion>}
    </div>
  )
}
