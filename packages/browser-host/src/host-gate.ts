import { randomUUID } from 'node:crypto'
import type { BrowserContext, Request } from 'playwright-core'
import { BROWSER_HOST_DECISION_WAIT_MS, isLocalHost, type BrowserNavigationOutcome } from '@kando/protocol'
import type { TabRegistry } from './tabs'

export type HostCheck = { checkId: string; tabId: string; conversationId: string | null; host: string; url: string }

// Whether a request is a page-level navigation the gate has a say in: a top frame going to a
// web host outside local development. Everything a page loads for itself passes.
export function gatedHost(request: Pick<Request, 'url' | 'isNavigationRequest'> & { frame(): { parentFrame(): unknown } }): string | null {
  if (!request.isNavigationRequest() || request.frame().parentFrame() !== null) return null
  let url: URL
  try {
    url = new URL(request.url())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return isLocalHost(url.hostname) ? null : url.hostname
}

// Holds every top-level navigation to a site outside local development until core says whether
// the user allows it. One place for all of them: the agent's goto, a link the user clicks in the
// live view, a redirect. Core keeps the policy; the gate only asks.
export class HostGate {
  private readonly pending = new Map<string, { resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>()
  // Why the tab's last navigation was stopped, for the navigate call to report.
  private readonly blocked = new Map<string, BrowserNavigationOutcome>()

  constructor(
    private readonly tabs: TabRegistry,
    private readonly ask: (check: HostCheck) => void
  ) {}

  async install(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route, request) => {
      const host = gatedHost(request)
      const tab = host ? this.tabs.byPage(request.frame().page()) : null
      if (!host || !tab) {
        await route.fallback()
        return
      }
      const outcome = await this.check({ checkId: randomUUID(), tabId: tab.id, conversationId: tab.conversationId, host, url: request.url() })
      if (outcome === 'done') {
        await route.fallback()
      } else {
        this.blocked.set(tab.id, outcome)
        await route.abort('blockedbyclient')
      }
    })
  }

  private check(check: HostCheck): Promise<BrowserNavigationOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(check.checkId)
        resolve('awaiting-host')
      }, BROWSER_HOST_DECISION_WAIT_MS)
      this.pending.set(check.checkId, {
        resolve: (allow) => {
          clearTimeout(timer)
          this.pending.delete(check.checkId)
          resolve(allow ? 'done' : 'denied')
        },
        timer
      })
      this.ask(check)
    })
  }

  resolve(checkId: string, allow: boolean): void {
    this.pending.get(checkId)?.resolve(allow)
  }

  // The outcome of the tab's last blocked navigation, once; done when nothing was blocked.
  takeOutcome(tabId: string): BrowserNavigationOutcome {
    const outcome = this.blocked.get(tabId) ?? 'done'
    this.blocked.delete(tabId)
    return outcome
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) entry.resolve(false)
  }
}
