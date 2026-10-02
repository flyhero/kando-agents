import { z } from 'zod'
import type { SourceIssue } from '@kando/protocol'
import { SourceError } from './source-error'

export const GITHUB_KEY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/

export type GitHubCredentials = { token: string }
export type GitHubComment = { author: string; created: number | null; body: string }
export type GitHubIssue = SourceIssue & {
  repository: string
  author: string
  body: string
  labels: string[]
  comments: GitHubComment[]
  commentTotal: number
}

export type GitHubApi = {
  myself(signal: AbortSignal): Promise<{ login: string }>
  search(query: string, signal: AbortSignal): Promise<SourceIssue[]>
  issue(key: string, signal: AbortSignal): Promise<GitHubIssue>
}

const API = 'https://api.github.com'
const TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const SEARCH_LIMIT = 200
const PAGE_SIZE = 100
const COMMENT_LIMIT = 20
const COMMENT_PAGE_SIZE = 100
// GitHub's issue search refuses a query that does not pick issues or pull requests; one that
// picks neither is searched once for each.
const KIND_QUALIFIER = /(?:^|\s)(?:is|type):(?:issue|pr|pull-request)(?=\s|$)/i
const KINDS = ['is:issue', 'is:pull-request'] as const

const User = z.object({ login: z.string() })
const Label = z.union([z.string(), z.object({ name: z.string().nullish() })])
const IssueRow = z.object({
  number: z.number().int().positive(),
  title: z.string().nullish(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullish(),
  updated_at: z.string().nullish(),
  body: z.string().nullish(),
  user: User.nullish(),
  labels: z.array(Label).nullish(),
  comments: z.number().int().nonnegative().nullish(),
  pull_request: z.unknown().optional(),
  repository_url: z.string().optional(),
  repository: z.object({ full_name: z.string() }).optional()
})
const SearchPage = z.object({ items: z.array(IssueRow) })
const Comment = z.object({
  body: z.string().nullish(),
  user: User.nullish(),
  created_at: z.string().nullish()
})
const ErrorBody = z.object({ message: z.string().optional() })

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SourceError('request-failed', 'unexpected reply from GitHub')
  }
  return parsed.data
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new SourceError('response-too-large', `GitHub answered with more than ${limit} bytes`)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new SourceError('response-too-large', `GitHub answered with more than ${limit} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function readText(response: Response, limit: number): Promise<string> {
  return Buffer.from(await readBytes(response, limit)).toString('utf8')
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await readText(response, MAX_RESPONSE_BYTES))
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError('request-failed', 'GitHub did not answer with JSON')
  }
}

function time(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function labels(row: z.infer<typeof IssueRow>): string[] {
  return (row.labels ?? []).flatMap((label) => {
    const name = typeof label === 'string' ? label : label.name
    return name ? [name] : []
  })
}

function repositoryOf(row: z.infer<typeof IssueRow>): string | null {
  if (row.repository?.full_name) return row.repository.full_name
  try {
    const url = new URL(row.repository_url ?? '')
    const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    return match ? `${decodeURIComponent(match[1] ?? '')}/${decodeURIComponent(match[2] ?? '')}` : null
  } catch {
    return null
  }
}

function summarize(repository: string, row: z.infer<typeof IssueRow>): SourceIssue | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null
  const issueLabels = labels(row)
  const priority = issueLabels.find((label) => /^p[0-4]$/i.test(label) || /^priority(?:\s*[:=-]|$)/i.test(label)) ?? null
  return {
    key: `${repository}#${row.number}`,
    title: row.title ?? '',
    url: row.html_url,
    status: row.state_reason ?? row.state,
    statusCategory: row.state === 'open' ? 'todo' : 'done',
    type: row.pull_request === undefined ? 'Issue' : 'Pull Request',
    priority,
    updatedAt: time(row.updated_at)
  }
}

async function failure(response: Response): Promise<SourceError> {
  let detail = ''
  try {
    detail = ErrorBody.parse(JSON.parse(await readText(response, MAX_ERROR_BYTES))).message ?? ''
  } catch {
    detail = ''
  }
  const message = detail || `GitHub answered ${response.status}`
  switch (response.status) {
    case 401:
      return new SourceError('auth-failed', message)
    case 403:
      return new SourceError('forbidden', message)
    case 404:
      return new SourceError('not-found', message)
    case 422:
      return new SourceError('bad-query', message)
    default:
      return new SourceError('request-failed', message)
  }
}

export class GitHubClient implements GitHubApi {
  constructor(
    private readonly credentials: GitHubCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = API
  ) {}

  async myself(signal: AbortSignal): Promise<{ login: string }> {
    return parse(User, await this.get('/user', signal))
  }

  async search(query: string, signal: AbortSignal): Promise<SourceIssue[]> {
    const queries = KIND_QUALIFIER.test(query) ? [query] : KINDS.map((kind) => `${query} ${kind}`)
    const issues: SourceIssue[] = []
    for (const q of queries) issues.push(...(await this.searchPages(q, signal)))
    return issues.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, SEARCH_LIMIT)
  }

  private async searchPages(q: string, signal: AbortSignal): Promise<SourceIssue[]> {
    const issues: SourceIssue[] = []
    for (let page = 1; issues.length < SEARCH_LIMIT; page += 1) {
      const query = new URLSearchParams({
        q,
        sort: 'updated',
        order: 'desc',
        per_page: String(PAGE_SIZE),
        page: String(page)
      })
      const found = parse(SearchPage, await this.get(`/search/issues?${query}`, signal))
      issues.push(
        ...found.items.flatMap((row) => {
          const repository = repositoryOf(row)
          const summary = repository ? summarize(repository, row) : null
          return summary ? [summary] : []
        })
      )
      if (found.items.length < PAGE_SIZE) break
    }
    return issues.slice(0, SEARCH_LIMIT)
  }

  async issue(key: string, signal: AbortSignal): Promise<GitHubIssue> {
    const match = GITHUB_KEY_PATTERN.exec(key)
    if (!match) throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
    const [, owner = '', repo = '', number = ''] = match
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
      throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
    }
    const repository = `${owner}/${repo}`
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
    const row = parse(IssueRow, await this.get(path, signal))
    const summary = summarize(repository, row)
    if (!summary || summary.key !== key) {
      throw new SourceError('request-failed', 'GitHub answered with a mismatched issue')
    }
    const comments = (await this.comments(path, row.comments ?? 0, signal))
      .map((comment) => ({ author: comment.user?.login ?? '', created: time(comment.created_at), body: comment.body ?? '' }))
    return {
      ...summary,
      repository,
      author: row.user?.login ?? '',
      body: row.body ?? '',
      labels: labels(row),
      comments,
      commentTotal: row.comments ?? comments.length
    }
  }

  private async get(pathAndQuery: string, signal: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}${pathAndQuery}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.credentials.token}`,
          'User-Agent': 'Kando',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        redirect: 'error'
      })
    } catch (error) {
      throw new SourceError('request-failed', error instanceof Error ? error.message : String(error))
    }
    if (!response.ok) throw await failure(response)
    return readJson(response)
  }

  private async comments(path: string, total: number, signal: AbortSignal): Promise<z.infer<typeof Comment>[]> {
    if (total === 0) return []
    const page = Math.ceil(total / COMMENT_PAGE_SIZE)
    const fetchPage = (number: number) => {
      const query = new URLSearchParams({ per_page: String(COMMENT_PAGE_SIZE), page: String(number) })
      return this.get(`${path}/comments?${query}`, signal).then((value) => parse(z.array(Comment), value))
    }
    const latest = await fetchPage(page)
    const previous = latest.length < COMMENT_LIMIT && page > 1 ? await fetchPage(page - 1) : []
    return [...previous, ...latest].slice(-COMMENT_LIMIT)
  }
}
