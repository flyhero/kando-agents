import { z } from 'zod'
import { ISSUE_STATUS_CATEGORIES, type SourceIssue } from '@kando/protocol'
import { SourceError } from './source-error'

export type JiraCredentials = { site: string; email: string; token: string }

export type JiraComment = { author: string; created: number | null; body: unknown }
export type JiraAttachment = { id: string; filename: string; mimeType: string; size: number }
export type JiraIssue = SourceIssue & {
  description: unknown
  // The latest comments, oldest first; `commentTotal` says how many the issue has in all.
  comments: JiraComment[]
  commentTotal: number
  attachments: JiraAttachment[]
}

export type JiraApi = {
  myself(signal: AbortSignal): Promise<{ displayName: string }>
  search(jql: string, signal: AbortSignal): Promise<SourceIssue[]>
  issue(key: string, signal: AbortSignal): Promise<JiraIssue>
  // An attachment's bytes, at most `limit` of them; what they are is for the caller to check.
  download(attachmentId: string, limit: number, signal: AbortSignal): Promise<Uint8Array>
}

// Jira's own key format; anything else in a reply is dropped before it can reach a URL.
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/

const TIMEOUT_MS = 15_000
// A hostile or broken server must not make core buffer or parse without bound.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
// An inbox is for reading, not for paging through a whole project.
const SEARCH_LIMIT = 200
const PAGE_SIZE = 100
const COMMENT_LIMIT = 20
const SUMMARY_FIELDS = 'summary,status,priority,issuetype,updated'
const ISSUE_FIELDS = `${SUMMARY_FIELDS},description,attachment`

// Origin only; plain http is refused except on loopback, since the token rides in every request.
export function normalizeSite(input: string): string {
  const text = input.trim()
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    throw new SourceError('invalid-settings', `not a site address: ${input}`)
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SourceError('invalid-settings', 'the Jira site must use https')
  }
  return url.origin
}

const Named = z.object({ name: z.string() })
const SummaryFields = z.object({
  summary: z.string().nullish(),
  status: Named.extend({ statusCategory: z.object({ key: z.string() }).nullish() }).nullish(),
  priority: Named.nullish(),
  issuetype: Named.nullish(),
  updated: z.string().nullish()
})
const IssueRow = z.object({ key: z.string(), fields: SummaryFields })
const SearchPage = z.object({
  issues: z.array(IssueRow),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish()
})
const IssueDetail = IssueRow.extend({
  fields: SummaryFields.extend({
    description: z.unknown(),
    attachment: z
      .array(
        z.object({
          id: z.union([z.string(), z.number()]).transform(String),
          filename: z.string(),
          mimeType: z.string().catch(''),
          size: z.number().catch(0)
        })
      )
      .nullish()
  })
})
const CommentPage = z.object({
  comments: z.array(
    z.object({
      author: z.object({ displayName: z.string() }).nullish(),
      created: z.string().nullish(),
      body: z.unknown()
    })
  ),
  total: z.number().nullish()
})
const TenantInfo = z.object({ cloudId: z.string() })
const ErrorBody = z.object({ errorMessages: z.array(z.string()).optional() })

// A reply of the wrong shape means the address is not a Jira REST API.
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SourceError('request-failed', 'unexpected reply from Jira')
  }
  return parsed.data
}

// Counted as they arrive: a Content-Length that lies does not get past the limit either.
async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new SourceError('response-too-large', `Jira answered with more than ${limit} bytes`)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    return new Uint8Array()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new SourceError('response-too-large', `Jira answered with more than ${limit} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function readText(response: Response, limit: number): Promise<string> {
  return Buffer.from(await readBytes(response, limit)).toString('utf8')
}

// A sign-in page instead of JSON is the usual sign of a wrong site address.
async function readJson(response: Response): Promise<unknown> {
  const text = await readText(response, MAX_RESPONSE_BYTES)
  try {
    return JSON.parse(text)
  } catch {
    throw new SourceError('request-failed', 'Jira did not answer with JSON')
  }
}

function time(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

const CATEGORY: Record<string, (typeof ISSUE_STATUS_CATEGORIES)[number]> = {
  new: 'todo',
  indeterminate: 'doing',
  done: 'done'
}

function summarize(site: string, row: z.infer<typeof IssueRow>): SourceIssue | null {
  if (!JIRA_KEY_PATTERN.test(row.key)) {
    return null
  }
  const { fields } = row
  return {
    key: row.key,
    title: fields.summary ?? '',
    url: `${site}/browse/${row.key}`,
    status: fields.status?.name ?? '',
    statusCategory: CATEGORY[fields.status?.statusCategory?.key ?? ''] ?? 'unknown',
    type: fields.issuetype?.name ?? '',
    priority: fields.priority?.name ?? null,
    updatedAt: time(fields.updated)
  }
}

async function failure(response: Response): Promise<SourceError> {
  let detail = ''
  try {
    detail = ErrorBody.parse(JSON.parse(await readText(response, MAX_ERROR_BYTES))).errorMessages?.join('; ') ?? ''
  } catch {
    // An error page that is not Jira's JSON: the status code alone has to do.
    detail = ''
  }
  const message = detail || `Jira answered ${response.status}`
  switch (response.status) {
    case 400:
      return new SourceError('bad-query', message)
    case 401:
      return new SourceError('auth-failed', message)
    case 403:
      return new SourceError('forbidden', message)
    case 404:
      return new SourceError('not-found', message)
    default:
      return new SourceError('request-failed', message)
  }
}

// Jira Cloud's REST API with an email + API token. A scoped token only works through the
// api.atlassian.com gateway, so a 401 on the site itself is retried there once.
export class JiraClient implements JiraApi {
  private base: string

  constructor(
    private readonly credentials: JiraCredentials,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.base = credentials.site
  }

  async myself(signal: AbortSignal): Promise<{ displayName: string }> {
    return parse(z.object({ displayName: z.string() }), await this.get('/rest/api/3/myself', signal))
  }

  async search(jql: string, signal: AbortSignal): Promise<SourceIssue[]> {
    const issues: SourceIssue[] = []
    let pageToken: string | null = null
    do {
      const query = new URLSearchParams({ jql, fields: SUMMARY_FIELDS, maxResults: String(PAGE_SIZE) })
      if (pageToken) {
        query.set('nextPageToken', pageToken)
      }
      const page = parse(SearchPage, await this.get(`/rest/api/3/search/jql?${query}`, signal))
      issues.push(...page.issues.flatMap((row) => summarize(this.credentials.site, row) ?? []))
      pageToken = page.isLast ? null : (page.nextPageToken ?? null)
    } while (pageToken && issues.length < SEARCH_LIMIT)
    return issues.slice(0, SEARCH_LIMIT)
  }

  async issue(key: string, signal: AbortSignal): Promise<JiraIssue> {
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}`
    const row = parse(IssueDetail, await this.get(`${path}?${new URLSearchParams({ fields: ISSUE_FIELDS })}`, signal))
    const summary = summarize(this.credentials.site, row)
    if (!summary) {
      throw new SourceError('request-failed', 'Jira answered with a malformed issue key')
    }
    // The issue's own comment field is not guaranteed to hold the newest ones; this endpoint is.
    const query = new URLSearchParams({ orderBy: '-created', maxResults: String(COMMENT_LIMIT) })
    const page = parse(CommentPage, await this.get(`${path}/comment?${query}`, signal))
    return {
      ...summary,
      description: row.fields.description,
      comments: page.comments
        .map((comment) => ({ author: comment.author?.displayName ?? '', created: time(comment.created), body: comment.body }))
        .reverse(),
      commentTotal: page.total ?? page.comments.length,
      attachments: row.fields.attachment ?? []
    }
  }

  // Straight from the site, never through a redirect: the token must not follow one elsewhere.
  async download(attachmentId: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    if (!/^\d+$/.test(attachmentId)) {
      throw new SourceError('request-failed', `not an attachment id: ${attachmentId}`)
    }
    const response = await this.send(`/rest/api/3/attachment/content/${attachmentId}?redirect=false`, signal, '*/*')
    return readBytes(response, limit)
  }

  private async get(pathAndQuery: string, signal: AbortSignal): Promise<unknown> {
    return readJson(await this.send(pathAndQuery, signal, 'application/json'))
  }

  // One successful response, trying the gateway once if the site turns the token down.
  private async send(pathAndQuery: string, signal: AbortSignal, accept: string): Promise<Response> {
    const response = await this.request(`${this.base}${pathAndQuery}`, signal, accept)
    const gateway = response.status === 401 && this.base === this.credentials.site ? await this.gateway(signal) : null
    if (gateway) {
      await response.body?.cancel()
      const retried = await this.request(`${gateway}${pathAndQuery}`, signal, accept)
      if (!retried.ok) {
        throw await failure(retried)
      }
      this.base = gateway
      return retried
    }
    if (!response.ok) {
      throw await failure(response)
    }
    return response
  }

  // Loopback sites are test doubles, which have no gateway.
  private async gateway(signal: AbortSignal): Promise<string | null> {
    if (new URL(this.credentials.site).protocol !== 'https:') {
      return null
    }
    try {
      const response = await this.request(`${this.credentials.site}/_edge/tenant_info`, signal, 'application/json', false)
      if (!response.ok) {
        await response.body?.cancel()
        return null
      }
      const { cloudId } = parse(TenantInfo, await readJson(response))
      return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}`
    } catch {
      // No tenant info (a server install, a proxy in between): the original 401 stands.
      return null
    }
  }

  private async request(url: string, signal: AbortSignal, accept: string, authorized: boolean = true): Promise<Response> {
    const { email, token } = this.credentials
    const headers: Record<string, string> = { Accept: accept }
    if (authorized) {
      headers.Authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    }
    try {
      return await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: 'error'
      })
    } catch (error) {
      throw new SourceError('request-failed', error instanceof Error ? error.message : String(error))
    }
  }
}
