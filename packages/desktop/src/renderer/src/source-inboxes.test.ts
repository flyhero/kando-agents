import { describe, expect, it } from 'vitest'
import type { SourceDescriptor, SourceInbox, SourceIssue } from '@kando/protocol'
import { activeInboxes, inboxTab } from './source-inboxes'

const issue = (key: string): SourceIssue => ({
  key, title: key, url: `https://demo.test/${key}`, status: 'Open', statusCategory: 'todo', type: 'Bug', priority: null, updatedAt: null
})
const inbox = (provider: string, instance: string, overrides: Partial<SourceInbox> = {}): SourceInbox => ({
  provider, instance, active: true, items: [], dismissed: [], refreshedAt: 1, refreshing: false, problem: null, ...overrides
})
const source = (provider: string, name: string, instances: string[]): SourceDescriptor => ({
  provider,
  name,
  settings: [],
  instances: instances.map((instance) => ({
    instance, enabled: true, settings: {}, credential: { configured: true, source: 'store', account: null }
  }))
})

describe('source inboxes', () => {
  const sources = [source('jira', 'Jira', ['default']), source('github', 'GitHub', ['default', 'reviews']), source('zentao', '禅道', ['default'])]

  it('lists the active inboxes in source order, naming instances past the default', () => {
    const active = activeInboxes(sources, {
      'github/reviews': inbox('github', 'reviews'),
      'github/default': inbox('github', 'default'),
      'jira/default': inbox('jira', 'default'),
      'zentao/default': inbox('zentao', 'default', { active: false })
    })
    expect(active.map(({ key, name }) => [key, name])).toEqual([
      ['jira/default', 'Jira'],
      ['github/default', 'GitHub'],
      ['github/reviews', 'GitHub · reviews']
    ])
    expect(activeInboxes(null, {})).toEqual([])
  })

  it('keeps the tab asked for, else opens the first with work waiting, else the first', () => {
    const active = activeInboxes(sources, {
      'jira/default': inbox('jira', 'default'),
      'github/default': inbox('github', 'default', { items: [issue('acme/widgets#1')] })
    })
    expect(inboxTab(active, 'jira/default')).toBe('jira/default')
    expect(inboxTab(active, null)).toBe('github/default')
    expect(inboxTab(active, 'github/gone')).toBe('github/default')
    expect(inboxTab(active.slice(0, 1), null)).toBe('jira/default')
    expect(inboxTab([], 'jira/default')).toBeNull()
  })
})
