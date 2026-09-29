import { z } from 'zod'
import { create } from 'zustand'

export const CONVERSATION_GROUPS = ['none', 'project', 'agent', 'status'] as const
export const CONVERSATION_SORTS = ['recent', 'created', 'title'] as const

// This window's UI preferences. They shape how the desktop looks and behaves,
// not what a task is, so they stay on this client instead of going to core.
const Preferences = z.object({
  theme: z.enum(['system', 'light', 'dark']).catch('system'),
  terminalFontSize: z.number().int().min(10).max(20).catch(12),
  // How wide a chat's messages and composer may grow: 800px, 1200px, or the whole chat pane.
  chatWidth: z.enum(['narrow', 'medium', 'full']).catch('narrow'),
  // Off, a finished turn's work stays in view rather than behind how long it worked.
  foldTurns: z.boolean().catch(true),
  showUsage: z.boolean().catch(true),
  usageDisplay: z.enum(['used', 'remaining']).catch('used'),
  // 'recent' reuses whichever agent the newest task picked.
  defaultAgent: z.enum(['recent', 'claude', 'codex', 'none']).catch('recent'),
  openTerminalOnRun: z.boolean().catch(true),
  // How a conversation's agent starts unless the user picks otherwise: its own TUI in a terminal,
  // or Kando's chat view of its structured output.
  agentView: z.enum(['tui', 'chat']).catch('chat'),
  // Off, a chat stage never offers running with nothing asked and nothing sandboxed.
  allowBypass: z.boolean().catch(false),
  // Off, the sidebar lists only pending and running tasks.
  showAllTasks: z.boolean().catch(false),
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
