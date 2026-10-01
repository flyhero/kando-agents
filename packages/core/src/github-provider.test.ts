import { describe, expect, it } from 'vitest'
import type { LoginPrompt, SourceIssue } from '@kando/protocol'
import type { GitHubApi, GitHubCredentials, GitHubIssue } from './github-client'
import { githubProvider } from './github-provider'
import { SourceError } from './source-error'

const signal = new AbortController().signal
const summary: SourceIssue = {
  key: 'acme/widgets#7',
  title: 'Fix login',
  url: 'https://github.com/acme/widgets/issues/7',
  status: 'open',
  statusCategory: 'todo',
  type: 'Issue',
  priority: 'P1',
  updatedAt: 1
}
const issue: GitHubIssue = {
  ...summary,
  repository: 'acme/widgets',
  author: 'ann',
  body: 'The login form fails.',
  labels: ['P1', 'bug'],
  comments: [{ author: 'bob', created: Date.parse('2026-09-21T08:00:00Z'), body: 'Reproduced.' }],
  commentTotal: 3
}

function fakeApi(validToken: string, seen: GitHubCredentials[]): (credentials: GitHubCredentials) => GitHubApi {
  return (credentials) => ({
    myself: async () => {
      seen.push(credentials)
      if (credentials.token !== validToken) throw new SourceError('auth-failed', 'GitHub answered 401')
      return { login: 'qingfei' }
    },
    search: async () => [summary],
    issue: async () => issue
  })
}

describe('githubProvider', () => {
  it('asks only for a token and retries authentication failures', async () => {
    const seen: GitHubCredentials[] = []
    const prompts: LoginPrompt[] = []
    const answers = ['bad', 'good']
    const provider = githubProvider(fakeApi('good', seen))
    const result = await provider.login(
      { prompt: async (prompt) => (prompts.push(prompt), answers.shift() ?? ''), notify: () => {} },
      {},
      signal
    )
    expect(result).toEqual({ credential: { kind: 'token', payload: { token: 'good' } }, account: 'qingfei' })
    expect(prompts.map((prompt) => prompt.kind)).toEqual(['secret', 'secret'])
    expect(prompts[1]?.error).toBe('Personal access token 不对，请重新输入')
    expect(seen).toEqual([{ token: 'bad' }, { token: 'good' }])
  })

  it('has no settings and reads its environment credential', () => {
    const provider = githubProvider(fakeApi('good', []))
    expect(provider.settings).toEqual([])
    expect(provider.normalizeSettings({ ignored: 'value' })).toEqual({})
    expect(provider.envCredential?.({ KANDO_GITHUB_TOKEN: 'token' })).toEqual({ kind: 'token', payload: { token: 'token' } })
    expect(provider.envCredential?.({})).toBeNull()
  })

  it('lists work and builds an untrusted markdown snapshot on fetch', async () => {
    const provider = githubProvider(fakeApi('good', []))
    const credential = { kind: 'token', payload: { token: 'good' } }
    expect(await provider.list({}, credential, signal)).toEqual([summary])
    const detail = await provider.fetch({}, credential, 'acme/widgets#7', signal)
    expect(detail).toMatchObject(summary)
    expect(detail.markdown).toContain('仓库：acme/widgets')
    expect(detail.markdown).toContain('作者：ann')
    expect(detail.markdown).toContain('The login form fails.')
    expect(detail.markdown).toContain('这里是最近 1 条，更早的 2 条在 GitHub 上')
    expect(detail.markdown).toContain('**bob**')
  })
})
