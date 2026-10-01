import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import { TabRegistry } from './tabs'

// Only what the registry reads of a page.
class FakePage extends EventEmitter {
  closed = false
  constructor(private href = 'about:blank', private name = '') {
    super()
  }
  url() {
    return this.href
  }
  async title() {
    return this.name
  }
  isClosed() {
    return this.closed
  }
  mainFrame() {
    return this
  }
  go(href: string, name: string) {
    this.href = href
    this.name = name
    this.emit('request', { isNavigationRequest: () => true, frame: () => this })
    this.emit('framenavigated', this)
    this.emit('load')
  }
  close() {
    this.closed = true
    this.emit('close')
  }
  asPage(): Page {
    return this as unknown as Page
  }
}

describe('TabRegistry', () => {
  it('keeps a conversation\'s tabs apart from another\'s and marks the one last used', () => {
    const registry = new TabRegistry(() => {})
    const a = registry.add('conv-a', new FakePage().asPage())
    const b = registry.add('conv-a', new FakePage().asPage())
    registry.add('conv-b', new FakePage().asPage())
    expect(registry.ofConversation('conv-a').map((tab) => tab.id)).toEqual([a.id, b.id])
    expect(registry.describe(a).active).toBe(false)
    expect(registry.describe(b).active).toBe(true)
    registry.touch(a)
    expect(registry.describe(a).active).toBe(true)
    expect(registry.size).toBe(3)
  })

  it('follows the page through a navigation and forgets it when it closes', async () => {
    const changes: number[] = []
    const registry = new TabRegistry(() => changes.push(registry.size))
    const page = new FakePage()
    const tab = registry.add('conv', page.asPage())
    page.go('https://example.com/', 'Example')
    expect(tab.loading).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(registry.describe(tab)).toMatchObject({ url: 'https://example.com/', title: 'Example' })
    page.close()
    expect(() => registry.get(tab.id)).toThrow('标签页不存在')
    expect(registry.ofConversation('conv')).toEqual([])
  })

  it('reads the console since the last navigation when asked', () => {
    const registry = new TabRegistry(() => {})
    const page = new FakePage()
    const tab = registry.add('conv', page.asPage())
    page.emit('console', { type: () => 'log', text: () => 'before' })
    page.go('https://example.com/', '')
    page.emit('console', { type: () => 'error', text: () => 'after' })
    page.emit('pageerror', new Error('boom'))
    expect(registry.console(tab, true).messages.map((entry) => entry.text)).toEqual(['after'])
    expect(registry.console(tab, false).messages.map((entry) => entry.text)).toEqual(['before', 'after'])
    expect(registry.console(tab, true).errors).toEqual(['boom'])
  })
})
