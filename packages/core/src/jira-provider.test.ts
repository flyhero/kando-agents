import { describe, expect, it } from 'vitest'
import type { LoginPrompt } from '@kando/protocol'
import type { JiraApi, JiraCredentials } from './jira-client'
import { DEFAULT_JIRA_JQL, jiraProvider } from './jira-provider'
import { SourceError } from './source-error'

function fakeApi(validToken: string, seen: JiraCredentials[]): (credentials: JiraCredentials) => JiraApi {
  return (credentials) => ({
    myself: async () => {
      seen.push(credentials)
      if (credentials.token !== validToken) {
        throw new SourceError('auth-failed', 'Jira answered 401')
      }
      return { displayName: 'Qingfei' }
    },
    search: async () => [],
    issue: async () => {
      throw new Error('not used')
    },
    download: async () => {
      throw new Error('not used')
    }
  })
}

const settings = { site: 'https://acme.atlassian.net', jql: DEFAULT_JIRA_JQL }
const signal = new AbortController().signal

describe('jiraProvider', () => {
  it('asks for an email and a token, and asks again when Jira turns them down', async () => {
    const seen: JiraCredentials[] = []
    const provider = jiraProvider(fakeApi('good', seen))
    const prompts: LoginPrompt[] = []
    const answers = ['me@acme.com', 'bad', 'me@acme.com', 'good']
    const result = await provider.login(
      { prompt: async (prompt) => (prompts.push(prompt), answers.shift() ?? ''), notify: () => {} },
      settings,
      signal
    )
    expect(result).toEqual({ credential: { kind: 'basic', payload: { email: 'me@acme.com', token: 'good' } }, account: 'Qingfei' })
    expect(prompts.map((prompt) => prompt.kind)).toEqual(['text', 'secret', 'text', 'secret'])
    expect(prompts[2]).toMatchObject({ defaultValue: 'me@acme.com', error: '邮箱或 API token 不对，请重新输入' })
    expect(seen.map((credentials) => credentials.site)).toEqual([settings.site, settings.site])
  })

  it('gives up after three refusals instead of asking forever', async () => {
    const provider = jiraProvider(fakeApi('good', []))
    await expect(
      provider.login({ prompt: async () => 'nope', notify: () => {} }, settings, signal)
    ).rejects.toMatchObject({ code: 'auth-failed' })
  })

  it('normalizes settings and keys, and reads a credential from the environment', () => {
    const provider = jiraProvider(fakeApi('good', []))
    expect(provider.normalizeSettings({ site: 'acme.atlassian.net/', jql: '  ' })).toEqual({ site: 'https://acme.atlassian.net', jql: DEFAULT_JIRA_JQL })
    expect(() => provider.normalizeSettings({ site: 'http://acme.atlassian.net' })).toThrow(SourceError)
    expect(provider.normalizeKey?.(' proj-7 ')).toBe('PROJ-7')
    expect(provider.envCredential?.({ KANDO_JIRA_EMAIL: 'ci@acme.com', KANDO_JIRA_TOKEN: 't' })).toEqual({
      kind: 'basic',
      payload: { email: 'ci@acme.com', token: 't' }
    })
    expect(provider.envCredential?.({ KANDO_JIRA_TOKEN: 't' })).toBeNull()
  })
})

describe('jiraProvider images', () => {
  const issue = {
    key: 'PROJ-9',
    title: 'Bug',
    url: 'https://acme.atlassian.net/browse/PROJ-9',
    status: '待办',
    statusCategory: 'todo' as const,
    type: '缺陷',
    priority: null,
    updatedAt: null,
    description: {
      type: 'doc',
      content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'media-1', alt: 'shot.png' } }] }]
    },
    comments: [],
    commentTotal: 0,
    attachments: [
      { id: '1', filename: 'shot.png', mimeType: 'image/png', size: 100 },
      { id: '2', filename: 'huge.png', mimeType: 'image/png', size: 11 * 1024 * 1024 },
      { id: '3', filename: 'denied.jpg', mimeType: 'image/jpeg', size: 100 },
      { id: '4', filename: 'spec.pdf', mimeType: 'application/pdf', size: 100 }
    ]
  }

  it('fetches the image attachments it may, and says in the text what became of each', async () => {
    const downloaded: string[] = []
    const provider = jiraProvider(() => ({
      myself: async () => ({ displayName: 'x' }),
      search: async () => [],
      issue: async () => issue,
      download: async (id) => {
        downloaded.push(id)
        if (id === '3') {
          throw new SourceError('forbidden', 'scope')
        }
        return new Uint8Array([id.charCodeAt(0)])
      }
    }))
    const detail = await provider.fetch(settings, { kind: 'basic', payload: { email: 'e', token: 't' } }, 'PROJ-9', signal)
    expect(downloaded.sort()).toEqual(['1', '3'])
    expect(detail.images).toEqual([{ name: 'shot.png', bytes: new Uint8Array([49]) }])
    expect(detail.markdown).toContain('（图片：shot.png）')
    expect(detail.markdown).toContain('- shot.png（1 KB，图片见下方）')
    expect(detail.markdown).toContain('- huge.png（11.0 MB，图片太大或太多，没有下载）')
    expect(detail.markdown).toContain('- denied.jpg（1 KB，图片没能下载）')
    expect(detail.markdown).toContain('- spec.pdf（1 KB）')
  })
})
