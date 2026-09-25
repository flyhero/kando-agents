import { MAX_ATTACHMENT_BYTES, MAX_TASK_IMAGES } from '@kando/protocol'
import { JiraClient, normalizeSite, type JiraApi, type JiraAttachment, type JiraCredentials, type JiraIssue } from './jira-client'
import { issueSnapshot, isImageAttachment, type ImageOutcome } from './jira-snapshot'
import { SourceError } from './source-error'
import type { SourceCredential, SourceProvider, SourceSettings } from './source-provider'

export const DEFAULT_JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens'
const LOGIN_ATTEMPTS = 3
// Images come along with an issue, within limits that keep an import quick and bounded.
const IMAGE_CONCURRENCY = 3
const IMAGE_TIMEOUT_MS = 30_000
const IMAGE_TOTAL_BYTES = 50 * 1024 * 1024
// Clients remember whether a token needs the api.atlassian.com gateway; keep a few around.
const CLIENT_CACHE_SIZE = 8

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += size) {
    await Promise.all(items.slice(at, at + size).map(run))
  }
}

// Which image attachments to fetch, in the issue's order, and what became of each.
async function downloadImages(api: JiraApi, issue: JiraIssue, signal: AbortSignal) {
  const outcomes = new Map<string, ImageOutcome>()
  const wanted: JiraAttachment[] = []
  let budget = IMAGE_TOTAL_BYTES
  for (const file of issue.attachments.filter(isImageAttachment)) {
    const fits = wanted.length < MAX_TASK_IMAGES && file.size <= MAX_ATTACHMENT_BYTES && file.size <= budget
    outcomes.set(file.id, fits ? 'failed' : 'skipped')
    if (fits) {
      wanted.push(file)
      budget -= file.size
    }
  }
  const fetched = new Map<string, Uint8Array>()
  await inBatches(wanted, IMAGE_CONCURRENCY, async (file) => {
    try {
      const bytes = await api.download(file.id, MAX_ATTACHMENT_BYTES, AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]))
      fetched.set(file.id, bytes)
      outcomes.set(file.id, 'saved')
    } catch (error) {
      // A token without read:attachment:jira gets 403 here; the issue still imports.
      console.error(`[kando-core] image ${file.filename} of ${issue.key} not fetched:`, error instanceof Error ? error.message : error)
    }
  })
  const images = wanted.flatMap((file) => {
    const bytes = fetched.get(file.id)
    return bytes ? [{ name: file.filename, bytes }] : []
  })
  return { images, outcomes }
}

function jiraCredentials(settings: SourceSettings, credential: SourceCredential): JiraCredentials {
  const { email, token } = credential.payload
  if (credential.kind !== 'basic' || !email || !token) {
    throw new SourceError('not-configured', 'the saved Jira credential is incomplete; sign in again')
  }
  return { site: settings.site ?? '', email, token }
}

// Jira Cloud (and Server with an email-style login) through an email + API token.
export function jiraProvider(connect: (credentials: JiraCredentials) => JiraApi = (c) => new JiraClient(c)): SourceProvider {
  const clients = new Map<string, JiraApi>()
  const client = (credentials: JiraCredentials): JiraApi => {
    const id = JSON.stringify(credentials)
    const cached = clients.get(id)
    if (cached) {
      return cached
    }
    if (clients.size >= CLIENT_CACHE_SIZE) {
      clients.clear()
    }
    const created = connect(credentials)
    clients.set(id, created)
    return created
  }

  return {
    id: 'jira',
    name: 'Jira',
    settings: [
      {
        key: 'site',
        type: 'url',
        label: '站点',
        placeholder: 'your-team.atlassian.net',
        required: true,
        bindsCredential: true
      },
      {
        key: 'jql',
        type: 'textarea',
        label: '筛选条件（JQL）',
        required: true,
        default: DEFAULT_JIRA_JQL,
        mono: true,
        hint: '收件箱每 15 分钟按它同步一次。默认是分给你、还没完成的 issue；只看 bug 可以在前面加上 issuetype 条件，例如 issuetype = Bug AND（类型名以你们 Jira 里的为准）。'
      }
    ],
    normalizeSettings: (values) => ({ site: normalizeSite(values.site ?? ''), jql: values.jql?.trim() || DEFAULT_JIRA_JQL }),
    normalizeKey: (key) => key.trim().toUpperCase(),
    envCredential: (env) =>
      env.KANDO_JIRA_EMAIL && env.KANDO_JIRA_TOKEN
        ? { kind: 'basic', payload: { email: env.KANDO_JIRA_EMAIL, token: env.KANDO_JIRA_TOKEN } }
        : null,

    async login(session, settings, signal) {
      let email = ''
      let error: string | undefined
      for (let attempt = 1; ; attempt += 1) {
        email = (
          await session.prompt({
            kind: 'text',
            label: '登录邮箱',
            placeholder: 'you@company.com',
            defaultValue: email || undefined,
            error
          })
        ).trim()
        const token = (
          await session.prompt({
            kind: 'secret',
            label: 'API token',
            hint: '只需要读权限。token 只保存在本机，不会交给 agent。',
            link: { url: TOKEN_PAGE, label: '在 Atlassian 账号设置里创建' }
          })
        ).trim()
        try {
          const { displayName } = await client({ site: settings.site ?? '', email, token }).myself(signal)
          return { credential: { kind: 'basic', payload: { email, token } }, account: displayName }
        } catch (failure) {
          if (!(failure instanceof SourceError) || failure.code !== 'auth-failed' || attempt >= LOGIN_ATTEMPTS) {
            throw failure
          }
          error = '邮箱或 API token 不对，请重新输入'
        }
      }
    },

    list: (settings, credential, signal) => client(jiraCredentials(settings, credential)).search(settings.jql ?? DEFAULT_JIRA_JQL, signal),

    // The raw fields ride along; core keeps only what the issue schema names.
    async fetch(settings, credential, key, signal) {
      const api = client(jiraCredentials(settings, credential))
      const issue = await api.issue(key, signal)
      const { images, outcomes } = await downloadImages(api, issue, signal)
      return { ...issue, markdown: issueSnapshot(issue, outcomes), images }
    }
  }
}
