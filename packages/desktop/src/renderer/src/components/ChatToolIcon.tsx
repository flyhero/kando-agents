import type { ChatToolStatus } from '@kando/protocol'
import { toolIconKind, type ToolIconKind } from '../chat-tools'
import { BookIcon, BranchIcon, GearIcon, GlobeIcon, ImageIcon, ListIcon, PencilIcon, SearchIcon, TerminalIcon } from './icons'

const ICONS = {
  read: BookIcon,
  edit: PencilIcon,
  terminal: TerminalIcon,
  search: SearchIcon,
  browser: GlobeIcon,
  image: ImageIcon,
  agent: BranchIcon,
  list: ListIcon,
  tool: GearIcon
} satisfies Record<ToolIconKind, () => React.JSX.Element>

export function ChatToolIcon({ name, status }: { name: string; status: ChatToolStatus }) {
  const kind = toolIconKind(name)
  const Icon = ICONS[kind]
  return <span className="chat-tool-icon" data-kind={kind} data-status={status} aria-hidden="true"><Icon /></span>
}
