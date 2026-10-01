import { GitHubClient, GITHUB_KEY_PATTERN, type GitHubApi, type GitHubCredentials } from './github-client'
import { githubIssueSnapshot } from './github-snapshot'
import { SourceError } from './source-error'
import type { SourceCredential, SourceProvider } from './source-provider'

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
    settings: [],
    normalizeSettings: () => ({}),
    normalizeKey: (key) => key.trim(),
    envCredential: (env) => (env.KANDO_GITHUB_TOKEN ? { kind: 'token', payload: { token: env.KANDO_GITHUB_TOKEN } } : null),

    async login(session, _settings, signal) {
      let error: string | undefined
      for (let attempt = 1; ; attempt += 1) {
        const token = (
          await session.prompt({
            kind: 'secret',
            label: 'Personal access token',
            hint: '需要读取账号和可访问仓库的 issue。token 只保存在本机，不会交给 agent。',
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

    list: (_settings, credential, signal) => client(githubCredentials(credential)).search(signal),

    async fetch(_settings, credential, key, signal) {
      if (!GITHUB_KEY_PATTERN.test(key)) throw new SourceError('not-found', `not a GitHub issue key: ${key}`)
      const issue = await client(githubCredentials(credential)).issue(key, signal)
      return { ...issue, markdown: githubIssueSnapshot(issue) }
    }
  }
}
