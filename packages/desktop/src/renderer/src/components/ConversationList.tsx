import { useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_KINDS, type Conversation } from '@kando/protocol'
import { selectConversation, useCore, setSchedulesOpen, useRoutinesSupported } from '../core-store'
import { conversationState, timeAgo } from '../conversation-state'
import { AGENT_LABEL } from '../labels'
import { CONVERSATION_GROUPS, CONVERSATION_SORTS, setPreference, usePreferences, type Preferences } from '../preferences'
import { ConversationContextMenu, newConversation, renameConversation } from './ConversationActions'
import { ConversationHandoffDialog } from './ConversationHandoffDialog'
import { ConversationStatus } from './ConversationStatus'
import { ContextMenu, menuPoint, MenuRadioItem, MenuSubmenu, type MenuPoint } from './ContextMenu'
import { ChatIcon, SlidersIcon, ClockIcon } from './icons'
import { projectName, projectNames } from './ProjectPicker'
import { SidebarCollapseButton } from './SidebarCollapseButton'
import { SidebarSearchField, SidebarSearchToggle } from './SidebarSearch'
import { TitleEditor } from './TitleEditor'

type GroupBy = Preferences['conversationGroup']
type SortBy = Preferences['conversationSort']

const GROUP_LABEL: Record<GroupBy, string> = { none: '不分组', project: '项目', agent: '智能体', status: '运行状态' }
const SORT_LABEL: Record<SortBy, string> = { recent: '最近活动', created: '创建时间', title: '标题' }

const COMPARE: Record<SortBy, (a: Conversation, b: Conversation) => number> = {
  recent: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  title: (a, b) => a.title.localeCompare(b.title, 'zh-CN')
}

// Groups keep a fixed order where there is one (running first, agents as listed);
// projects go by name, with conversations that have no project last.
function groupOf(conversation: Conversation, by: Exclude<GroupBy, 'none'>): { label: string; rank: number } {
  switch (by) {
    case 'project':
      return { label: projectNames(conversation.projectPaths), rank: conversation.projectPaths.length > 0 ? 0 : 1 }
    case 'agent':
      return { label: AGENT_LABEL[conversation.agent], rank: AGENT_KINDS.indexOf(conversation.agent) }
    case 'status':
      return conversation.sessionId ? { label: '运行中', rank: 0 } : { label: '已停止', rank: 1 }
  }
}

type Group = { key: string; label: string | null; rank: number; items: Conversation[] }

// Pinned conversations come first, in a group of their own, whatever the grouping.
function arrange(conversations: Conversation[], by: GroupBy, sort: SortBy): Group[] {
  const sorted = [...conversations].sort(COMPARE[sort])
  const pinned = sorted.filter((conversation) => conversation.pinnedAt != null)
  const rest = sorted.filter((conversation) => conversation.pinnedAt == null)
  const top: Group[] = pinned.length > 0 ? [{ key: 'pinned', label: '已置顶', rank: -1, items: pinned }] : []
  if (by === 'none') return rest.length > 0 ? [...top, { key: 'all', label: null, rank: 0, items: rest }] : top
  const groups = new Map<string, Group>()
  for (const conversation of rest) {
    const { label, rank } = groupOf(conversation, by)
    const group = groups.get(label) ?? { key: `group:${label}`, label, rank, items: [] }
    group.items.push(conversation)
    groups.set(label, group)
  }
  return [...top, ...[...groups.values()].sort((a, b) => a.rank - b.rank || (a.label ?? '').localeCompare(b.label ?? '', 'zh-CN'))]
}

// By title or project name, ignoring case. Message text is searched by core.
function matches(conversation: Conversation, query: string): boolean {
  const needle = query.toLowerCase()
  return [conversation.title, ...conversation.projectPaths.map(projectName)].some((text) => text.toLowerCase().includes(needle))
}

const SEARCH_DELAY_MS = 200

// Snippets by conversation id, kept with the query they answer so a slow reply for an older
// query cannot label rows for a newer one.
type MessageHits = { query: string; snippets: Map<string, string> }

// Asks core once typing pauses. An older core without the method answers with no hits,
// which leaves title and project matches.
function useMessageHits(query: string): MessageHits {
  const rpc = useCore((s) => s.rpc)
  const [hits, setHits] = useState<MessageHits>({ query: '', snippets: new Map() })
  useEffect(() => {
    if (!query) return
    if (!rpc) {
      setHits({ query, snippets: new Map() })
      return
    }
    let current = true
    const timer = setTimeout(() => {
      void rpc.call('conversations.search', { query: query.slice(0, 200) })
        .catch(() => [])
        .then((found) => {
          if (current) setHits({ query, snippets: new Map(found.map((hit) => [hit.conversationId, hit.snippet])) })
        })
    }, SEARCH_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [rpc, query])
  return hits
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>
}

function conversationMeta(conversation: Conversation): string {
  return `${AGENT_LABEL[conversation.agent]} · ${projectNames(conversation.projectPaths)} · ${conversationState(conversation).label}`
}

// The time, a minute at a time, for how long ago each row last changed.
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function ViewMenu({ at, trigger, onClose }: { at: MenuPoint; trigger: HTMLElement | null; onClose: () => void }) {
  const groupBy = usePreferences((p) => p.conversationGroup)
  const sortBy = usePreferences((p) => p.conversationSort)
  const [open, setOpen] = useState<'group' | 'sort' | null>(null)
  const closeSubmenu = () => setOpen(null)
  return (
    <ContextMenu at={at} align="end" trigger={trigger} label="会话的分组和排序" onClose={onClose}>
      <MenuSubmenu label="分组方式" value={GROUP_LABEL[groupBy]} open={open === 'group'} onOpen={() => setOpen('group')} onClose={closeSubmenu}>
        {CONVERSATION_GROUPS.map((value) => (
          <MenuRadioItem
            key={value}
            label={GROUP_LABEL[value]}
            checked={value === groupBy}
            onSelect={() => {
              setPreference('conversationGroup', value)
              onClose()
            }}
          />
        ))}
      </MenuSubmenu>
      <MenuSubmenu label="排序方式" value={SORT_LABEL[sortBy]} open={open === 'sort'} onOpen={() => setOpen('sort')} onClose={closeSubmenu}>
        {CONVERSATION_SORTS.map((value) => (
          <MenuRadioItem
            key={value}
            label={SORT_LABEL[value]}
            checked={value === sortBy}
            onSelect={() => {
              setPreference('conversationSort', value)
              onClose()
            }}
          />
        ))}
      </MenuSubmenu>
    </ContextMenu>
  )
}

export function ConversationList() {
  const now = useMinute()
  const [collapsed, setCollapsed] = useState(false)
  const conversations = useCore((s) => s.conversations)
  const selected = useCore((s) => s.selectedConversationId)
  const section = useCore((s) => s.section)
  const groupBy = usePreferences((p) => p.conversationGroup)
  const sortBy = usePreferences((p) => p.conversationSort)
  // A task's conversation is reached from its task; a routine's from the routine's history.
  const all = Object.values(conversations).filter((conversation) => !conversation.taskId && !conversation.routineId)
  const routines = useCore((s) => s.routines)
  const routinesSupported = useRoutinesSupported()
  const schedulesOpen = useCore((s) => s.schedulesOpen)
  const unreadRuns = routines.reduce((sum, routine) => sum + routine.unread, 0)
  // Null while the search box is closed. Groups left empty by a search drop out.
  const [query, setQuery] = useState<string | null>(null)
  const needle = query?.trim() ?? ''
  const searching = needle !== ''
  const messageHits = useMessageHits(needle)
  // Null until core has answered this query.
  const snippets = messageHits.query === needle ? messageHits.snippets : null
  const visible = searching
    ? all.filter((conversation) => matches(conversation, needle) || snippets?.has(conversation.id))
    : all
  const groups = arrange(visible, groupBy, sortBy)
  const [menu, setMenu] = useState<{ id: string; at: MenuPoint } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [viewAt, setViewAt] = useState<MenuPoint | null>(null)
  const closeView = useCallback(() => setViewAt(null), [])
  const viewButton = useRef<HTMLButtonElement>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [handoffId, setHandoffId] = useState<string | null>(null)
  const menuConversation = menu ? conversations[menu.id] : undefined
  const handoffConversation = handoffId ? conversations[handoffId] : undefined

  const row = (conversation: Conversation) => {
    const snippet = searching ? snippets?.get(conversation.id) : undefined
    return <li key={conversation.id}>
      {renamingId === conversation.id
        ? <div className="task-row conversation-row" data-renaming>
          <ConversationStatus conversation={conversation} />
          <TitleEditor title={conversation.title} label="会话标题" onSave={(title) => void renameConversation(conversation.id, title)} onDone={() => setRenamingId(null)} />
          <span className="task-row-meta">{conversationMeta(conversation)}</span>
        </div>
        : <button
          type="button"
          className="task-row conversation-row"
          data-menu-open={menu?.id === conversation.id || undefined}
          aria-current={section === 'conversations' && selected === conversation.id}
          onClick={() => selectConversation(conversation.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ id: conversation.id, at: menuPoint(event) })
          }}
        >
          <ConversationStatus conversation={conversation} />
          <span className="task-row-title">{conversation.title}</span>
          <span className="conversation-age">{timeAgo(conversation.updatedAt, now)}</span>
          <span className="task-row-meta" title={conversation.projectPaths.join('\n')}>{conversationMeta(conversation)}</span>
          {snippet && <span className="conversation-snippet"><Highlighted text={snippet} query={needle} /></span>}
        </button>}
    </li>
  }

  return (
    <nav className="conversation-list" data-collapsed={collapsed} aria-label="会话列表">
      <header className="task-list-header">
        <SidebarCollapseButton icon={<ChatIcon />} label="会话" count={visible.length} collapsed={collapsed} controls="sidebar-conversations" onToggle={() => setCollapsed((value) => !value)} />
        <SidebarSearchToggle
          label="搜索会话"
          query={query}
          onToggle={() => {
            setQuery((current) => (current === null ? '' : null))
            setCollapsed(false)
          }}
        />
        <button
          ref={viewButton}
          type="button"
          className="icon-button sidebar-tool"
          aria-label="分组和排序"
          aria-haspopup="menu"
          aria-expanded={viewAt !== null}
          data-tooltip="分组和排序"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setViewAt((current) => (current ? null : { x: box.right, y: box.bottom + 4 }))
          }}
        >
          <SlidersIcon />
        </button>
        <button type="button" className="icon-button task-list-add" aria-label="新建会话" onClick={newConversation}>＋</button>
      </header>
      {query !== null && !collapsed && (
        <SidebarSearchField label="搜索会话" placeholder="标题、项目名或聊天内容" query={query} onChange={setQuery} />
      )}
      <div id="sidebar-conversations" className="sidebar-section-content" hidden={collapsed}>
      {routinesSupported && routines.length > 0 && (
        <button type="button" className="inbox-entry" aria-current={schedulesOpen} onClick={() => setSchedulesOpen(true)}>
          <ClockIcon />
          <span>定时任务</span>
          {unreadRuns > 0 && <span className="inbox-entry-count" aria-label={`${unreadRuns} 次运行未看`}>{unreadRuns}</span>}
        </button>
      )}
      {all.length === 0 ? <p className="task-list-empty">还没有会话，点右上角的 ＋ 新建。</p> :
        visible.length === 0 ? snippets && <p className="task-list-empty">没有找到匹配「{needle}」的会话。</p> :
        groups.map((group) => group.label === null
          ? <ul key={group.key}>{group.items.map(row)}</ul>
          : <section key={group.key} className="conversation-group" aria-label={group.label}>
            <h3 className="conversation-group-title">{group.label}<span className="count">{group.items.length}</span></h3>
            <ul>{group.items.map(row)}</ul>
          </section>)}
      </div>
      {viewAt && <ViewMenu at={viewAt} trigger={viewButton.current} onClose={closeView} />}
      {menu && menuConversation && (
        <ConversationContextMenu
          conversation={menuConversation}
          at={menu.at}
          onClose={closeMenu}
          onRename={() => setRenamingId(menuConversation.id)}
          onHandoff={() => setHandoffId(menuConversation.id)}
        />
      )}
      {handoffConversation && <ConversationHandoffDialog conversation={handoffConversation} onClose={() => setHandoffId(null)} />}
    </nav>
  )
}
