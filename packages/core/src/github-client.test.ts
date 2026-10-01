import { describe, expect, it } from 'vitest'
import { GitHubClient, GITHUB_ASSIGNED_QUERY } from './github-client'

type Route = (url: URL) => Response | undefined

function fakeFetch(route: Route): { fetch: typeof fetch; calls: { url: URL; headers: Headers }[] } {
  const calls: { url: URL; headers: Headers }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    calls.push({ url, headers })
    return route(url) ?? new Response('{"message":"no route"}', { status: 404 })
  }
  return { fetch: fetchImpl, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const row = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Work ${number}`,
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  state: 'open',
  state_reason: null,
  updated_at: '2026-09-21T08:10:00Z',
  body: `Body ${number}`,
  user: { login: 'ann' },
  labels: [{ name: 'P1' }, { name: 'backend' }],
  comments: 0,
  repository_url: 'https://api.github.com/repos/acme/widgets',
  ...overrides
})

const signal = new AbortController().signal
const credentials = { token: 'secret' }
const base = 'https://api.github.test'

describe('GitHubClient', () => {
  it('authenticates with a bearer token and returns the current login', async () => {
    const { fetch, calls } = fakeFetch((url) => (url.pathname === '/user' ? json({ login: 'qingfei' }) : undefined))
    expect(await new GitHubClient(credentials, fetch, base).myself(signal)).toEqual({ login: 'qingfei' })
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret')
    expect(calls[0]?.headers.get('x-github-api-version')).toBe('2022-11-28')
  })

  it('pages through assigned open issues and pull requests', async () => {
    const first = Array.from({ length: 100 }, (_, index) => row(index + 1))
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname !== '/search/issues') return undefined
      return url.searchParams.get('page') === '2'
        ? json({ items: [row(101, { pull_request: { url: 'api' }, labels: [{ name: 'frontend' }] })] })
        : json({ items: first })
    })
    const found = await new GitHubClient(credentials, fetch, base).search(signal)
    expect(found).toHaveLength(101)
    expect(found[0]).toEqual({
      key: 'acme/widgets#1',
      title: 'Work 1',
      url: 'https://github.com/acme/widgets/issues/1',
      status: 'open',
      statusCategory: 'todo',
      type: 'Issue',
      priority: 'P1',
      updatedAt: Date.parse('2026-09-21T08:10:00Z')
    })
    expect(found[100]).toMatchObject({ key: 'acme/widgets#101', type: 'Pull Request', priority: null })
    expect(calls[0]?.url.searchParams.get('q')).toBe(GITHUB_ASSIGNED_QUERY)
    expect(calls.map((call) => call.url.searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('fetches detail and the latest comments in chronological order', async () => {
    const comments = Array.from({ length: 105 }, (_, index) => ({
      body: `Comment ${index + 1}`,
      user: { login: `user-${index + 1}` },
      created_at: '2026-09-21T08:00:00Z'
    }))
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/repos/acme/widgets/issues/7/comments') {
        return json(url.searchParams.get('page') === '2' ? comments.slice(100) : comments.slice(0, 100))
      }
      if (url.pathname === '/repos/acme/widgets/issues/7') return json(row(7, { comments: 105 }))
      return undefined
    })
    const issue = await new GitHubClient(credentials, fetch, base).issue('acme/widgets#7', signal)
    expect(issue).toMatchObject({ key: 'acme/widgets#7', repository: 'acme/widgets', author: 'ann', commentTotal: 105 })
    expect(issue.labels).toEqual(['P1', 'backend'])
    expect(issue.comments.map((comment) => comment.body)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Comment ${index + 86}`)
    )
    const commentCalls = calls.filter((call) => call.url.pathname.endsWith('/comments'))
    expect(commentCalls[0]?.url.searchParams.get('per_page')).toBe('100')
    expect(commentCalls.map((call) => call.url.searchParams.get('page'))).toEqual(['2', '1'])
  })

  it('maps GitHub failures and rejects malformed replies', async () => {
    const denied = fakeFetch(() => json({ message: 'Bad credentials' }, 401))
    await expect(new GitHubClient(credentials, denied.fetch, base).myself(signal)).rejects.toMatchObject({
      code: 'auth-failed',
      message: 'Bad credentials'
    })
    const malformed = fakeFetch(() => json({ name: 'missing login' }))
    await expect(new GitHubClient(credentials, malformed.fetch, base).myself(signal)).rejects.toMatchObject({ code: 'request-failed' })
    await expect(new GitHubClient(credentials, malformed.fetch, base).issue('../admin#1', signal)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses a reply larger than its buffer limit', async () => {
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32))
      }
    })
    const { fetch } = fakeFetch(() => new Response(huge, { status: 200 }))
    await expect(new GitHubClient(credentials, fetch, base).search(signal)).rejects.toMatchObject({ code: 'response-too-large' })
  })
})
