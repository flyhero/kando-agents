import { AgentKind } from '@kando/protocol'
import { z } from 'zod'
import { create } from 'zustand'
import { PALETTES } from './palettes'
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from './sidebar-width'

export const CONVERSATION_GROUPS = ['none', 'project', 'agent', 'status'] as const
export const CONVERSATION_SORTS = ['recent', 'created', 'title'] as const
export const TASK_GROUPS = ['none', 'project', 'agent', 'status'] as const
export const TASK_SORTS = ['recent', 'created', 'title'] as const

// This window's UI preferences. They shape how the desktop looks and behaves,
// not what a task is, so they stay on this client instead of going to core.
const Preferences = z.object({
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  // The set of colours the interface is drawn in; each has a light and a dark side.
  palette: z.enum(PALETTES).catch('terracotta'),
  terminalFontSize: z.number().int().min(10).max(20).catch(12),
  chatFontSize: z.number().int().min(10).max(20).catch(14),
  // What the chat is set in: the system's font, a serif for the prose, or a family the user
  // picked from those installed (chatFontFamily). A preset since dropped reads as the system's.
  chatFont: z.enum(['system', 'serif', 'custom']).catch('system'),
  chatFontFamily: z.string().max(200).catch(''),
  // How wide a chat's messages and composer may grow: 800px, 1200px, or the whole chat pane.
  chatWidth: z.enum(['narrow', 'medium', 'full']).catch('narrow'),
  // Off, a finished turn's work stays in view rather than behind how long it worked.
  foldTurns: z.boolean().catch(true),
  showUsage: z.boolean().catch(true),
  // Off, nothing is said when the window is not in front; the dock count stays.
  notifications: z.boolean().catch(true),
  usageDisplay: z.enum(['used', 'remaining']).catch('used'),
  // 'recent' reuses whichever agent the newest task picked.
  defaultAgent: z.enum(['recent', 'claude', 'codex', 'cursor', 'none']).catch('recent'),
  // The permission mode a plan is carried out in, as last picked; where the stage lacks it, auto,
  // then accepting edits.
  planRunMode: z.enum(['auto', 'acceptEdits', 'ask', 'bypass']).catch('auto'),
  // Agents the user turned off: found here, but not offered for new tasks and conversations.
  // Every agent found is on until turned off.
  disabledAgents: z.array(AgentKind).catch([]),
  // On, the browser panel appears with the agent's first tab; off, the page's card in the chat
  // offers to open it and the browser works in the background.
  openBrowserOnTab: z.boolean().catch(false),
  // Off, a chat stage never offers running with nothing asked and nothing sandboxed.
  allowBypass: z.boolean().catch(false),
  // On, the sidebar is put away and the panes take the whole window.
  sidebarHidden: z.boolean().catch(false),
  // As the user dragged it, before the cap a small window puts on it.
  sidebarWidth: z.number().int().min(MIN_SIDEBAR_WIDTH).max(MAX_SIDEBAR_WIDTH).catch(DEFAULT_SIDEBAR_WIDTH),
  // Off, the sidebar lists only pending and running tasks.
  showAllTasks: z.boolean().catch(false),
  taskGroup: z.enum(TASK_GROUPS).catch('none'),
  // Creation order preserves the task list's original behavior.
  taskSort: z.enum(TASK_SORTS).catch('created'),
  conversationGroup: z.enum(CONVERSATION_GROUPS).catch('none'),
  conversationSort: z.enum(CONVERSATION_SORTS).catch('recent')
})
export type Preferences = z.infer<typeof Preferences>

const STORAGE_KEY = 'kando.preferences'

// Each field falls back on its own, so one bad or outdated value never resets the rest.
function load(): Preferences {
  let saved: unknown = {}
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    // Unreadable storage: start from defaults.
  }
  const parsed = Preferences.safeParse(saved)
  return parsed.success ? parsed.data : Preferences.parse({})
}

export const usePreferences = create<Preferences>()(() => load())

usePreferences.subscribe((preferences) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Storage full or blocked: the change still applies for this session.
  }
})

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  usePreferences.setState({ [key]: value })
}
