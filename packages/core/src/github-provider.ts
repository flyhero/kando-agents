import { GitHubClient, GITHUB_KEY_PATTERN, type GitHubApi, type GitHubCredentials } from './github-client'
import { githubIssueSnapshot } from './github-snapshot'
import { SourceError } from './source-error'
import type { SourceCredential, SourceProvider } from './source-provider'

export const DEFAULT_GITHUB_QUERY = 'assignee:@me is:open'

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens'
const LOGIN_ATTEMPTS = 3

function githubCredentials(credential: SourceCredential): GitHubCredentials {
  const { token } = credential.payload
  if (credential.kind !== 'token' || !token) {
    throw new SourceError('not-configured', 'the saved GitHub credential is incomplete; sign in again')
  }
  return { token }
}

export function githubProvider(connect: (credentials: GitHubCredentials) => GitHubApi = (c) => new GitHubClient(c)): SourceProvider {
  const clients = new Map<string, GitHubApi>()
  const client = (credentials: GitHubCredentials): GitHubApi => {
    const cached = clients.get(credentials.token)
    if (cached) return cached
    if (clients.size >= 8) clients.clear()
    const created = connect(credentials)
    clients.set(credentials.token, created)
    return created
  }

  return {
    id: 'github',
    name: 'GitHub',
    settings: [
      {
        key: 'query',
        type: 'text',
        label: '筛选条件',
        required: true,
        default: DEFAULT_GITHUB_QUERY,
        mono: true,
        hint: '收件箱每 15 分钟按它同步一次，写法和 GitHub 网页上的搜索一样。默认是分给你、还开着的 issue 和 PR；没写 is:issue 或 is:pr 时两种都同步。只看某个组织可以加 org:组织名，只看 bug 可以加 label:bug，同步等你 review 的 PR 可以写 review-requested:@me is:pr is:open。结果固定按更新时间排序，不用写 sort:。'
      }
    ],
    normalizeSettings: (values) => ({ query: values.query?.trim().split(/\s+/).join(' ') || DEFAULT_GITHUB_QUERY }),
    normalizeKey: (key) => key.trim(),
    envCredential: (env) => (env.KANDO_GITHUB_TOKEN ? { kind: 'token', payload: { token: env.KANDO_GITHUB_TOKEN } } : null),

    async login(session, _settings, signal) {
      let error: string | undefined
      for (let attempt = 1; ; attempt += 1) {
        const token = (
          await session.prompt({
            kind: 'secret',
            label: 'Personal access token',
            hint: '需要读取账号和可访问仓库的 issue。token 只保存在本机，不会交给 Agent。',
            link: { url: TOKEN_PAGE, label: '在 GitHub 设置里创建' },
            error
          })
        ).trim()
        try {
          const { login } = await client({ token }).myself(signal)
          return { credential: { kind: 'token', payload: { token } }, account: login }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt >= LOGIN_ATTEMPTS) throw failure
          error = 'Personal access token 不对，请重新输入'
        }
      }
    },

    list: (settings, credential, signal) => client(githubCredentials(credential)).search(settings.query ?? DEFAULT_GITHUB_QUERY, signal),

    async fetch(_settings, credential, key, signal) {
      if (!GITHUB_KEY_PATTERN.test(key)) throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
      const issue = await client(githubCredentials(credential)).issue(key, signal)
      return { ...issue, markdown: githubIssueSnapshot(issue) }
    }
  }
}
