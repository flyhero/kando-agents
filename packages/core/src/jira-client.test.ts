import { describe, expect, it } from 'vitest'
import { JiraClient, normalizeSite } from './jira-client'
import { SourceError } from './source-error'

type Route = (url: URL) => Response | undefined

function fakeFetch(route: Route): { fetch: typeof fetch; calls: { url: URL; auth: string | null }[] } {
  const calls: { url: URL; auth: string | null }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return route(url) ?? new Response('{"errorMessages":["no route"]}', { status: 404 })
  }
  return { fetch: fetchImpl, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const issue = (key: string) => ({
  key,
  fields: {
    summary: `Bug ${key}`,
    status: { name: '待办', statusCategory: { key: 'new' } },
    priority: { name: 'P1' },
    issuetype: { name: '缺陷' },
    updated: '2026-08-21T14:55:53.403+0800'
  }
})

const site = 'https://acme.atlassian.net'
const credentials = { site, email: 'me@acme.com', token: 'secret' }
const signal = new AbortController().signal

describe('normalizeSite', () => {
  it('keeps the origin and insists on https away from loopback', () => {
    expect(normalizeSite('acme.atlassian.net')).toBe(site)
    expect(normalizeSite(' https://acme.atlassian.net/browse/PROJ-1 ')).toBe(site)
    expect(normalizeSite('http://127.0.0.1:4010')).toBe('http://127.0.0.1:4010')
    expect(() => normalizeSite('http://acme.atlassian.net')).toThrow(SourceError)
  })
})

describe('JiraClient', () => {
  it('pages through search results with basic auth, dropping keys that are not Jira keys', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname !== '/rest/api/3/search/jql') {
        return undefined
      }
      return url.searchParams.get('nextPageToken') === 'p2'
        ? json({ issues: [issue('PROJ-2'), issue('../../admin')], isLast: true })
        : json({ issues: [issue('PROJ-1')], nextPageToken: 'p2', isLast: false })
    })
    const found = await new JiraClient(credentials, fetch).search('assignee = currentUser()', signal)
    expect(found.map((entry) => entry.key)).toEqual(['PROJ-1', 'PROJ-2'])
    expect(found[0]).toEqual({
      key: 'PROJ-1',
      title: 'Bug PROJ-1',
      url: `${site}/browse/PROJ-1`,
      status: '待办',
      statusCategory: 'todo',
      type: '缺陷',
      priority: 'P1',
      updatedAt: Date.parse('2026-08-21T14:55:53.403+0800')
    })
    expect(calls[0]?.url.searchParams.get('jql')).toBe('assignee = currentUser()')
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('me@acme.com:secret').toString('base64')}`)
  })

  it('maps Jira errors to stable codes, keeping its message', async () => {
    const { fetch } = fakeFetch((url) =>
      url.pathname === '/rest/api/3/search/jql' ? json({ errorMessages: ["Field 'sprint' does not exist"] }, 400) : undefined
    )
    await expect(new JiraClient(credentials, fetch).search('sprint = 1', signal)).rejects.toMatchObject({
      code: 'bad-query',
      message: "Field 'sprint' does not exist"
    })
  })

  it('retries a scoped token through the api.atlassian.com gateway and stays there', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.host === 'acme.atlassian.net' && url.pathname === '/_edge/tenant_info') {
        return json({ cloudId: 'cloud-1' })
      }
      if (url.host === 'acme.atlassian.net') {
        return json({ errorMessages: ['unauthorized'] }, 401)
      }
      return url.pathname === '/ex/jira/cloud-1/rest/api/3/myself' ? json({ displayName: 'Me' }) : undefined
    })
    const client = new JiraClient(credentials, fetch)
    expect(await client.myself(signal)).toEqual({ displayName: 'Me' })
    await client.myself(signal)
    expect(calls.map((call) => `${call.url.host}${call.url.pathname}`)).toEqual([
      'acme.atlassian.net/rest/api/3/myself',
      'acme.atlassian.net/_edge/tenant_info',
      'api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself',
      'api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself'
    ])
    // The tenant lookup is public and must not carry the token.
    expect(calls[1]?.auth).toBeNull()
  })

  it('reports a sign-in page as a failed request rather than crashing', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>log in</html>', { status: 200 }))
    await expect(new JiraClient(credentials, fetch).myself(signal)).rejects.toMatchObject({ code: 'request-failed' })
  })

  it('refuses a reply larger than it is willing to buffer', async () => {
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32))
      }
    })
    const { fetch } = fakeFetch(() => new Response(huge, { status: 200 }))
    await expect(new JiraClient(credentials, fetch).search('x', signal)).rejects.toMatchObject({ code: 'response-too-large' })
  })

  it('reads an issue with its newest comments, oldest first, and its attachments', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/rest/api/3/issue/PROJ-9') {
        return json({
          ...issue('PROJ-9'),
          fields: { ...issue('PROJ-9').fields, description: { type: 'doc', content: [] }, attachment: [{ id: 10001, filename: 'shot.png', mimeType: 'image/png', size: 2048 }] }
        })
      }
      if (url.pathname === '/rest/api/3/issue/PROJ-9/comment') {
        return json({
          total: 25,
          comments: [
            { author: { displayName: 'Bob' }, created: '2026-08-22T09:00:00.000+0800', body: 'newer' },
            { author: { displayName: 'Ann' }, created: '2026-08-21T18:22:37.250+0800', body: 'older' }
          ]
        })
      }
      return undefined
    })
    const detail = await new JiraClient(credentials, fetch).issue('PROJ-9', signal)
    expect(detail.comments.map((comment) => comment.body)).toEqual(['older', 'newer'])
    expect(detail.commentTotal).toBe(25)
    expect(detail.attachments).toEqual([{ id: '10001', filename: 'shot.png', mimeType: 'image/png', size: 2048 }])
    const commentCall = calls.find((call) => call.url.pathname.endsWith('/comment'))
    expect(commentCall?.url.searchParams.get('orderBy')).toBe('-created')
    expect(commentCall?.url.searchParams.get('maxResults')).toBe('20')
  })

  it('downloads an attachment straight from the site, within a byte limit it counts itself', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/rest/api/3/attachment/content/10001') {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
      }
      if (url.pathname === '/rest/api/3/attachment/content/10002') {
        // Claims to be small, is not.
        return new Response(new Uint8Array(64), { status: 200, headers: { 'content-length': '4' } })
      }
      return undefined
    })
    const client = new JiraClient(credentials, fetch)
    expect([...(await client.download('10001', 16, signal))]).toEqual([1, 2, 3, 4])
    expect(calls[0]?.url.searchParams.get('redirect')).toBe('false')
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('me@acme.com:secret').toString('base64')}`)
    await expect(client.download('10002', 16, signal)).rejects.toMatchObject({ code: 'response-too-large' })
    await expect(client.download('../../myself', 16, signal)).rejects.toMatchObject({ code: 'request-failed' })
    expect(calls).toHaveLength(2)
  })

  it('downloads through the gateway when the token is scoped, and reports a refusal', async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.host === 'acme.atlassian.net' && url.pathname === '/_edge/tenant_info') {
        return json({ cloudId: 'cloud-1' })
      }
      if (url.host === 'acme.atlassian.net') {
        return json({ errorMessages: ['unauthorized'] }, 401)
      }
      if (url.pathname === '/ex/jira/cloud-1/rest/api/3/attachment/content/7') {
        return new Response(new Uint8Array([9]), { status: 200 })
      }
      return json({ errorMessages: ['scope does not match'] }, 403)
    })
    const client = new JiraClient(credentials, fetch)
    expect([...(await client.download('7', 16, signal))]).toEqual([9])
    await expect(client.download('8', 16, signal)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
