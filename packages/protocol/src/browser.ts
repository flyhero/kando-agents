import { z } from 'zod'
import { ChatImage } from './chat'

// The browser Kando hosts for its chat agents: the app's own Chromium, tabs tagged by the
// conversation they belong to. A tab is laid out at the browser panel's size, so what the agent
// screenshots is what the user sees; this is the size of one no panel has shown yet.
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const

// A page size asked for over the panel's: the agent's for a narrow layout, the user's from the
// panel's presets. null returns the tab to the panel's size.
export const BrowserViewport = z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) })
export type BrowserViewport = z.infer<typeof BrowserViewport>

export const BrowserTabId = z.string().uuid()

export const BrowserTab = z.object({
  id: BrowserTabId,
  // Whose tab it is: a conversation's, for its agent to drive, or null for one the user opened
  // themselves in the browser panel, which no agent sees.
  conversationId: z.string().uuid().nullable(),
  url: z.string().max(4096),
  title: z.string().max(500),
  loading: z.boolean(),
  // The conversation's tab its tools act on when they name none: the one last used.
  active: z.boolean(),
  // The user is acting in the live view; the agent's calls on the tab are refused meanwhile.
  userDriving: z.boolean().default(false),
  // One of the agent's calls is under way on the tab.
  agentActing: z.boolean().default(false),
  // The size the tab is held at, or null while it follows the panel.
  viewport: BrowserViewport.nullable().default(null),
  createdAt: z.number()
})
export type BrowserTab = z.infer<typeof BrowserTab>

// app-closed: the desktop app, which runs the browser, is not up · starting: core is connecting
// to it · ready: tabs can be opened · error: the last attempt failed (message says how).
// running: core is connected to the app's browser host.
export const BrowserStatus = z.object({
  state: z.enum(['app-closed', 'starting', 'ready', 'error']),
  message: z.string().max(2000).optional(),
  running: z.boolean()
})
export type BrowserStatus = z.infer<typeof BrowserStatus>

// An element reference from an AI-mode aria snapshot ([ref=e12]); stale once the page changes.
export const SnapshotRef = z.string().regex(/^e\d+$/)

export const BrowserUrl = z.string().trim().min(1).max(4096)
// Where a navigation goes: a URL, or a step through the tab's own history.
export const BrowserNavigateTo = z.union([
  z.object({ url: BrowserUrl }),
  z.object({ history: z.enum(['back', 'forward', 'reload']) })
])
export type BrowserNavigateTo = z.infer<typeof BrowserNavigateTo>

// Parameters of the actions an agent takes on a tab, shared by core's RPC and the host's wire.
export const browserActions = {
  click: z.object({
    ref: SnapshotRef,
    button: z.enum(['left', 'right', 'middle']).optional(),
    double: z.boolean().optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).max(4).optional()
  }),
  // submit presses Enter after the text; replace clears the field first.
  type: z.object({ ref: SnapshotRef, text: z.string().max(10_000), submit: z.boolean().optional(), replace: z.boolean().optional() }),
  press: z.object({ key: z.string().min(1).max(40) }),
  hover: z.object({ ref: SnapshotRef }),
  // Scrolls the element under ref, or the page; amount in wheel ticks of roughly a hundred pixels.
  scroll: z.object({ ref: SnapshotRef.optional(), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(20).optional() }),
  select: z.object({ ref: SnapshotRef, values: z.array(z.string().max(500)).min(1).max(50) }),
  // Waits for text to appear, for text to go, or for a number of seconds.
  wait: z.object({ text: z.string().max(500).optional(), textGone: z.string().max(500).optional(), seconds: z.number().min(0).max(30).optional() })
} as const
export type BrowserActionName = keyof typeof browserActions

export const BrowserScreenshotOptions = z.object({ fullPage: z.boolean().optional(), ref: SnapshotRef.optional() })

// What a navigation came to: done · awaiting-host: the user has been asked about the site and
// has not answered yet, so the agent should try again once they have · denied: they refused.
export const BrowserNavigationOutcome = z.enum(['done', 'awaiting-host', 'denied'])
export type BrowserNavigationOutcome = z.infer<typeof BrowserNavigationOutcome>
export const BrowserNavigation = z.object({ tab: BrowserTab, outcome: BrowserNavigationOutcome, snapshot: z.string().nullable() })
export type BrowserNavigation = z.infer<typeof BrowserNavigation>

// An action's result: the tab as it stands and a fresh snapshot of the page.
export const BrowserAction = z.object({ tab: BrowserTab, snapshot: z.string() })
export type BrowserAction = z.infer<typeof BrowserAction>

export const BrowserSnapshot = z.object({ tab: BrowserTab, snapshot: z.string() })
export const BrowserScreenshot = z.object({ tab: BrowserTab, image: ChatImage })
export type BrowserScreenshot = z.infer<typeof BrowserScreenshot>

export const BrowserConsole = z.object({
  messages: z.array(z.object({ level: z.string().max(20), text: z.string().max(4000), at: z.number() })),
  errors: z.array(z.string().max(4000)),
  failedRequests: z.array(z.object({ method: z.string().max(10), url: z.string().max(4096), failure: z.string().max(500) }))
})
export type BrowserConsole = z.infer<typeof BrowserConsole>

// How long a navigation to a site the user has not cleared waits for their answer before the
// agent is told to try again later. Under the agents' own tool timeouts.
export const BROWSER_HOST_DECISION_WAIT_MS = 25_000

// A bare host name goes to https, except what is plainly a local server. localhost:5173 reads as
// a scheme to a URL parser, so only the schemes a page can have count as one.
export function normalizeBrowserUrl(input: string): string {
  const text = input.trim()
  if (/^(https?|file|about|data|blob):/i.test(text)) return text
  return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(text) ? `http://${text}` : `https://${text}`
}

// The web host a URL goes to, or null for anything that is not a web page (about:blank, data:).
export function browserHostOf(url: string): string | null {
  try {
    const parsed = new URL(normalizeBrowserUrl(url))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null
  } catch {
    return null
  }
}

// The model's view of a page, as the browser tools word it: where it is, which tab it is, and
// the snapshot. A client reads the head back with parseBrowserPage for the page's card.
export function describeBrowserPage(tab: Pick<BrowserTab, 'id' | 'url' | 'title'>, snapshot: string | null): string {
  const head = `${tab.title ? `${tab.title} — ` : ''}${tab.url}\n标签页 ${tab.id}`
  return snapshot ? `${head}\n\n${snapshot}` : head
}

const PAGE_HEAD = /^(?:(.*) — )?(\S+)\n标签页 ([0-9a-f-]{36})(?:\n|$)/
export function parseBrowserPage(text: string): Pick<BrowserTab, 'id' | 'url' | 'title'> | null {
  const match = PAGE_HEAD.exec(text)
  return match ? { title: match[1] ?? '', url: match[2] ?? '', id: match[3] ?? '' } : null
}

// Hosts the browser opens without asking: where a developer's own servers live. A rule on the
// name alone; a name that resolves to loopback is not local by it.
export function isLocalHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0') return true
  return name.endsWith('.localhost') || name.endsWith('.test')
}
