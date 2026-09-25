import { MAX_SNAPSHOT_LENGTH } from '@kando/protocol'
import { adfToMarkdown, escapeLinkText, type MediaDescriber } from './jira-adf'
import type { JiraAttachment, JiraIssue } from './jira-client'

const pad = (value: number) => String(value).padStart(2, '0')

function formatTime(ms: number | null): string {
  if (ms === null) {
    return ''
  }
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

// What happened to each image attachment: shown under the snapshot, too big or too many to
// fetch, or failed on the way.
export type ImageOutcome = 'saved' | 'skipped' | 'failed'

const IMAGE_NOTE: Record<ImageOutcome, string> = {
  saved: '图片见下方',
  skipped: '图片太大或太多，没有下载',
  failed: '图片没能下载'
}

export function isImageAttachment(file: Pick<JiraAttachment, 'mimeType' | 'filename'>): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/i.test(file.mimeType) || /\.(png|jpe?g|gif|webp)$/i.test(file.filename)
}

function attachmentSection(issue: JiraIssue, outcomes: ReadonlyMap<string, ImageOutcome>): string | null {
  if (issue.attachments.length === 0) {
    return null
  }
  return [
    '## 附件',
    ...issue.attachments.map((file) => {
      const outcome = outcomes.get(file.id)
      const note = outcome ? `，${IMAGE_NOTE[outcome]}` : ''
      return `- ${escapeLinkText(file.filename)}（${formatSize(file.size)}${note}）`
    }),
    '',
    `附件需要登录 Jira 查看：${issue.url}`
  ].join('\n')
}

// The client fetched only the latest comments: that is where a bug's analysis ends up.
function commentSection(issue: JiraIssue, describeMedia: MediaDescriber): string | null {
  const comments = issue.comments.flatMap((comment) => {
    const body = adfToMarkdown(comment.body, { describeMedia })
    const byline = [`**${comment.author || '匿名'}**`, formatTime(comment.created)].filter(Boolean).join(' · ')
    return body ? [`${byline}\n\n${body}`] : []
  })
  if (comments.length === 0) {
    return null
  }
  const earlier = issue.commentTotal - issue.comments.length
  const note = earlier > 0 ? [`（这里是最近 ${issue.comments.length} 条，更早的 ${earlier} 条在 Jira 上）`] : []
  return ['## 评论', ...note, ...comments].join('\n\n')
}

// The issue as a snapshot: its description, what is attached, and the latest comments. An
// embedded image is named where it sat in the text; the pictures themselves travel separately.
export function issueSnapshot(issue: JiraIssue, outcomes: ReadonlyMap<string, ImageOutcome> = new Map()): string {
  const describeMedia: MediaDescriber = (name) => {
    const file = issue.attachments.find((attachment) => attachment.filename === name)
    const label = escapeLinkText(name ?? '文件')
    return file && isImageAttachment(file) ? `（图片：${label}）` : `（附件：${label}）`
  }
  const text = [adfToMarkdown(issue.description, { describeMedia }), attachmentSection(issue, outcomes), commentSection(issue, describeMedia)]
    .filter((section) => section !== null && section !== '')
    .join('\n\n')
  const marker = '\n\n……（内容过长，后面的部分请在 Jira 上查看）'
  return text.length > MAX_SNAPSHOT_LENGTH ? text.slice(0, MAX_SNAPSHOT_LENGTH - marker.length) + marker : text
}
