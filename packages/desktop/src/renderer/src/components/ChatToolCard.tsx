import { createContext, useContext, useState } from 'react'
import type { ChatDiff, ChatItem, ChatToolStatus } from '@kando/protocol'
import { DiffLines } from './DiffLines'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// Both agents' tool names, in words; an unknown one shows as the agent named it.
const TOOL_LABEL: Record<string, string> = {
  Bash: '命令',
  commandExecution: '命令',
  Read: '读取',
  Write: '写入',
  Edit: '编辑',
  MultiEdit: '编辑',
  NotebookEdit: '编辑笔记本',
  fileChange: '修改文件',
  Grep: '搜索',
  Glob: '查找文件',
  WebFetch: '读取网页',
  WebSearch: '搜索网页',
  webSearch: '搜索网页',
  Task: '子任务',
  Agent: '子任务',
  TodoWrite: '待办',
  ExitPlanMode: '计划'
}

// Turns the conversation's project paths in a title or diff header into short, relative ones.
export const ChatPaths = createContext<(text: string) => string>((text) => text)

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name
}

const STATUS_TEXT: Record<ChatToolStatus, string> = { running: '进行中', done: '完成', failed: '失败', denied: '已拒绝' }

export function ChatDiffs({ diffs }: { diffs: readonly ChatDiff[] }) {
  const shorten = useContext(ChatPaths)
  return (
    <div className="chat-diffs">
      {diffs.map((diff, index) => (
        <div key={`${diff.path}:${index}`} className="chat-diff">
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

// A call's title and outcome; its input and output open on request, a file change's diff shows at once.
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
        <span className="chat-tool-status">{STATUS_TEXT[item.status]}</span>
      </button>
      {item.diffs.length > 0 && <ChatDiffs diffs={item.diffs} />}
      {open && item.input && <pre className="chat-tool-io">{item.input}</pre>}
      {open && item.output && <pre className="chat-tool-io">{item.output}</pre>}
    </div>
  )
}
