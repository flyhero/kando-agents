import { z } from 'zod'
import { browserActions, BrowserConsole, BrowserFrame, BrowserInputEvent, BrowserNavigateTo, BrowserNavigationOutcome, BrowserScreenshotOptions, BrowserStatus, BrowserTab, BrowserTabId, BrowserUrl, BrowserViewOptions } from '../browser'

// JSON-RPC-shaped lines over a loopback WebSocket between core and the browser host. The host runs
// as a daemon pipe session; it prints one line on stdout saying where to connect, and nothing
// else, so the daemon's buffer never carries a frame or a screenshot.
export const BROWSER_HOST_PROTOCOL_VERSION = 1

export const BrowserHostListening = z.object({
  event: z.literal('listening'),
  port: z.number().int(),
  token: z.string().min(1),
  pid: z.number().int(),
  protocolVersion: z.number().int()
})
export type BrowserHostListening = z.infer<typeof BrowserHostListening>

export function browserHostUrl(endpoint: Pick<BrowserHostListening, 'port' | 'token'>): string {
  return `ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`
}

const TabRef = z.object({ tabId: BrowserTabId })
const Ok = z.object({ ok: z.literal(true) })
// The host's own view of a tab: what the user does with it is core's to know.
export const HostTab = BrowserTab.omit({ userDriving: true, agentActing: true })
export type HostTab = z.infer<typeof HostTab>
// An action's result: the tab and a fresh AI-mode aria snapshot of the page.
const ActionResult = z.object({ tab: HostTab, snapshot: z.string() })
// A host the gate has not cleared holds the navigation until core answers (host.resolve).
const NavigationResult = z.object({ tab: HostTab, outcome: BrowserNavigationOutcome, snapshot: z.string().nullable() })

export const browserHostMethods = {
  status: { params: z.object({}), result: BrowserStatus },
  // Starts the Chromium download when it is missing; progress comes as status events.
  install: { params: z.object({}), result: BrowserStatus },
  'tabs.list': { params: z.object({}), result: z.object({ tabs: z.array(HostTab) }) },
  // Without a conversation, the tab is the user's own.
  'tabs.open': { params: z.object({ conversationId: z.string().uuid().optional(), url: BrowserUrl.optional() }), result: NavigationResult },
  'tabs.close': { params: TabRef, result: Ok },
  'tabs.closeAll': { params: z.object({ conversationId: z.string().uuid() }), result: Ok },
  navigate: { params: TabRef.extend({ to: BrowserNavigateTo }), result: NavigationResult },
  snapshot: { params: TabRef, result: ActionResult },
  // A JPEG of the viewport (or the page, or one element), base64; core reads its size as it stores it.
  screenshot: { params: TabRef.extend(BrowserScreenshotOptions.shape), result: z.object({ tab: HostTab, jpeg: z.string() }) },
  click: { params: TabRef.extend(browserActions.click.shape), result: ActionResult },
  type: { params: TabRef.extend(browserActions.type.shape), result: ActionResult },
  press: { params: TabRef.extend(browserActions.press.shape), result: ActionResult },
  hover: { params: TabRef.extend(browserActions.hover.shape), result: ActionResult },
  scroll: { params: TabRef.extend(browserActions.scroll.shape), result: ActionResult },
  select: { params: TabRef.extend(browserActions.select.shape), result: ActionResult },
  wait: { params: TabRef.extend(browserActions.wait.shape), result: ActionResult },
  console: { params: TabRef.extend({ sinceNavigation: z.boolean().optional() }), result: BrowserConsole },
  // Core's answer to a hostCheck event.
  'host.resolve': { params: z.object({ checkId: z.string(), allow: z.boolean() }), result: Ok },
  'screencast.start': { params: TabRef.extend(BrowserViewOptions.shape), result: Ok },
  'screencast.stop': { params: TabRef, result: Ok },
  input: { params: TabRef.extend({ event: BrowserInputEvent }), result: Ok },
  shutdown: { params: z.object({}), result: Ok }
} as const

export type BrowserHostMethod = keyof typeof browserHostMethods
export type BrowserHostParams<M extends BrowserHostMethod> = z.input<(typeof browserHostMethods)[M]['params']>
export type BrowserHostParsedParams<M extends BrowserHostMethod> = z.output<(typeof browserHostMethods)[M]['params']>
export type BrowserHostResult<M extends BrowserHostMethod> = z.output<(typeof browserHostMethods)[M]['result']>

// Same generic-index narrowing as rpcSchemas.
export const browserHostSchemas: {
  [M in BrowserHostMethod]: {
    params: z.ZodType<BrowserHostParsedParams<M>>
    result: z.ZodType<BrowserHostResult<M>>
  }
} = browserHostMethods

export function isBrowserHostMethod(name: string): name is BrowserHostMethod {
  return Object.hasOwn(browserHostMethods, name)
}

export const BrowserHostRequest = z.object({ id: z.number(), method: z.string(), params: z.unknown() })

export const BrowserHostEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('status'), status: BrowserStatus }),
  // Every tab the host has, after any change to one of them.
  z.object({ event: z.literal('tabs'), tabs: z.array(HostTab) }),
  // A top-level navigation to a host outside local development ones; held until host.resolve.
  z.object({ event: z.literal('hostCheck'), checkId: z.string(), tabId: BrowserTabId, conversationId: z.string().nullable(), host: z.string(), url: z.string() }),
  z.object({ event: z.literal('frame') }).extend(BrowserFrame.shape)
])
export type BrowserHostEvent = z.infer<typeof BrowserHostEvent>

// Error before result, for the same missing-key reason as RpcFrame.
export const BrowserHostInbound = z.union([
  BrowserHostEvent,
  z.object({ id: z.number(), error: z.object({ reason: z.string(), message: z.string() }) }),
  z.object({ id: z.number(), result: z.unknown() })
])
export type BrowserHostInbound = z.infer<typeof BrowserHostInbound>
