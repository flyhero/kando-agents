import { MAX_SNAPSHOT_LENGTH } from '@kando/protocol'
import type { GitHubIssue } from './github-client'

const pad = (value: number) => String(value).padStart(2, '0')

function formatTime(ms: number | null): string {
  if (ms === null) return ''
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function commentSection(issue: GitHubIssue): string | null {
  const comments = issue.comments.flatMap((comment) => {
    const byline = [`**${comment.author || '匿名'}**`, formatTime(comment.created)].filter(Boolean).join(' · ')
    return comment.body ? [`${byline}\n\n${comment.body}`] : []
  })
  if (comments.length === 0) return null
  const earlier = issue.commentTotal - issue.comments.length
  const note = earlier > 0 ? [`（这里是最近 ${issue.comments.length} 条，更早的 ${earlier} 条在 GitHub 上）`] : []
  return ['## 评论', ...note, ...comments].join('\n\n')
}

export function githubIssueSnapshot(issue: GitHubIssue): string {
  const metadata = [
    `仓库：${issue.repository}`,
    `作者：${issue.author || '未知'}`,
    issue.labels.length > 0 ? `标签：${issue.labels.join('、')}` : null,
    `链接：${issue.url}`
  ]
    .filter((line) => line !== null)
    .join('\n')
  const text = [metadata, issue.body, commentSection(issue)].filter((section) => section !== null && section !== '').join('\n\n')
  const marker = '\n\n……（内容过长，后面的部分请在 GitHub 上查看）'
  return text.length > MAX_SNAPSHOT_LENGTH ? text.slice(0, MAX_SNAPSHOT_LENGTH - marker.length) + marker : text
}
