import { z } from 'zod'
import { ChatImage } from './chat'

// The browser Kando hosts for its chat agents: one Chromium, tabs tagged by the conversation
// they belong to. Every page is laid out at this size, so what the agent screenshots is what the
// user sees in the live view, and a point in one maps straight onto the other.
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const

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
  createdAt: z.number()
})
export type BrowserTab = z.infer<typeof BrowserTab>

// not-installed: Chromium has not been downloaded · installing: the download runs (percent when
// known) · starting: the host or the browser is coming up · ready: tabs can be opened · error:
// the last attempt failed (message says how). running: the host process is up.
export const BrowserStatus = z.object({
  state: z.enum(['not-installed', 'installing', 'starting', 'ready', 'error']),
  percent: z.number().int().min(0).max(100).optional(),
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

// Input the live view forwards to a tab, in the tab's CSS pixels; the host hands each to CDP as it
// is. Modifiers are CDP's bitmask: Alt 1, Control 2, Meta 4, Shift 8.
const Coordinate = z.number().finite()
const Modifiers = z.number().int().min(0).max(15)
export const BrowserInputEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('mouse'),
    action: z.enum(['pressed', 'released', 'moved']),
    x: Coordinate,
    y: Coordinate,
    button: z.enum(['none', 'left', 'middle', 'right', 'back', 'forward']),
    buttons: z.number().int().min(0).max(31),
    clickCount: z.number().int().min(0).max(3),
    modifiers: Modifiers
  }),
  z.object({ type: z.literal('wheel'), x: Coordinate, y: Coordinate, deltaX: Coordinate, deltaY: Coordinate, modifiers: Modifiers }),
  z.object({
    type: z.literal('key'),
    action: z.enum(['down', 'up']),
    key: z.string().max(32),
    code: z.string().max(64),
    windowsVirtualKeyCode: z.number().int().min(0).max(255),
    // The character a printable key types; left out for keys that type nothing.
    text: z.string().max(8).optional(),
    modifiers: Modifiers
  }),
  // What an input method composed, or pasted text.
  z.object({ type: z.literal('text'), text: z.string().max(10_000) })
])
export type BrowserInputEvent = z.infer<typeof BrowserInputEvent>

// Frames the live view asks for: never larger than the viewport, JPEG at this quality.
export const BrowserViewOptions = z.object({
  maxWidth: z.number().int().min(160).max(BROWSER_VIEWPORT.width).optional(),
  maxHeight: z.number().int().min(100).max(BROWSER_VIEWPORT.height).optional(),
  quality: z.number().int().min(10).max(90).optional()
})
export type BrowserViewOptions = z.infer<typeof BrowserViewOptions>
export const BROWSER_FRAME_QUALITY = 60

// How long a navigation to a site the user has not cleared waits for their answer before the
// agent is told to try again later. Under the agents' own tool timeouts.
export const BROWSER_HOST_DECISION_WAIT_MS = 25_000

// One screencast frame of a tab, a JPEG in base64; seq counts up per tab.
export const BrowserFrame = z.object({ tabId: BrowserTabId, seq: z.number().int().nonnegative(), width: z.number().int(), height: z.number().int(), data: z.string() })
export type BrowserFrame = z.infer<typeof BrowserFrame>

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
