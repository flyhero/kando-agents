import readline from 'node:readline'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  connectRpc,
  coreUrl,
  MAX_DETAILS_LENGTH,
  PREVIEW_EXTENSIONS,
  PROPOSE_DETAILS_TOOL,
  READ_TASK_TOOL,
  shortTaskId,
  SHOW_PREVIEW_TOOL,
  type RpcConnection,
  type Task,
  untrustedSource
} from '@kando/protocol'
import { readCoreEndpoint, kandoPaths } from '@kando/protocol/node'
import { STATUS_LABEL } from './status-labels'
import { snapshotImagePaths, taskImageLines } from './task-images'

// A tools-only MCP server over stdio, so a refining agent can read the tasks it builds
// on and hand its plan back.
// Messages are newline-delimited JSON-RPC 2.0; stdout is the channel, so logs go to stderr.

const Message = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional()
})
const InitializeParams = z.object({ protocolVersion: z.string() })
const CallParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
const ProposeArguments = z.object({ markdown: z.string().trim().min(1).max(MAX_DETAILS_LENGTH) })
const ReadArguments = z.object({ task_id: z.string().trim().min(4) })
const PreviewArguments = z.object({ path: z.string().trim().min(1), title: z.string().trim().max(200).optional() })

// Tools and basic lifecycle are the same in every published MCP revision.
const FALLBACK_PROTOCOL_VERSION = '2025-06-18'

const PROPOSE_TOOL = {
  name: PROPOSE_DETAILS_TOOL,
  title: '提交任务详情',
  description:
    '把和用户商定好的任务详情提交给 Kando，作为待确认的方案显示给用户；用户接受后会替换任务现在的详情。' +
    '请提交完整的 Markdown（目标、背景、实现方案、涉及的文件、验收标准），不要只写改动的部分。再次调用会用新的一版替换上一版。',
  inputSchema: {
    type: 'object',
    properties: { markdown: { type: 'string', description: '完整的任务详情，Markdown 格式' } },
    required: ['markdown'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
} as const

const READ_TOOL = {
  name: READ_TASK_TOOL,
  title: '读取依赖任务的详情',
  description:
    '读取当前任务所依赖的某个任务（包括依赖的依赖）的状态、分支和完整详情。只能读取依赖链上的任务。',
  inputSchema: {
    type: 'object',
    properties: { task_id: { type: 'string', description: '任务 id，完整 id 或前 8 位都可以' } },
    required: ['task_id'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
} as const

const PREVIEW_TOOL = {
  name: SHOW_PREVIEW_TOOL,
  title: '在对话里展示 HTML 或 SVG 文件',
  description:
    '把你写好的 HTML 或 SVG 文件直接渲染在用户的对话里，用户能看到、能点，不需要截图。' +
    '做完样稿、原型、图表想让用户看时调用；中间产物不要调。文件要已经写到磁盘上，用绝对路径。' +
    '文件里可以用相对路径引用同目录的样式和图片；页面跟随用户的浅色/深色主题，不能访问网络。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件的绝对路径，.html / .htm / .svg' },
      title: { type: 'string', description: '给用户看的标题，可选' }
    },
    required: ['path'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
} as const

export type McpTools = {
  // The task tools are there only when the server was started for a task.
  propose?: (markdown: string) => Promise<void>
  // Resolves to the text shown to the model; throws when the task may not be read.
  readTask?: (taskId: string) => Promise<string>
  // Checks the file may be shown (it exists, and is HTML or SVG); throws with the reason if not.
  preview: (path: string) => Promise<void>
}

export type McpResponse = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

export function createMcpHandler({ propose, readTask, preview }: McpTools) {
  const tools = [PREVIEW_TOOL, ...(readTask ? [READ_TOOL] : []), ...(propose ? [PROPOSE_TOOL] : [])]
  return async (line: string): Promise<McpResponse | null> => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }
    }
    const message = Message.safeParse(raw)
    if (!message.success) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
    }
    const { id, method, params } = message.data
    // Notifications (no id), such as notifications/initialized, need no answer.
    if (id === undefined) {
      return null
    }
    const reply = (result: unknown): McpResponse => ({ jsonrpc: '2.0', id, result })
    switch (method) {
      case 'initialize': {
        const requested = InitializeParams.safeParse(params)
        return reply({
          protocolVersion: requested.success ? requested.data.protocolVersion : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'kando', version: '0.0.0' }
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools })
      case 'tools/call': {
        const call = CallParams.safeParse(params)
        if (call.success && call.data.name === SHOW_PREVIEW_TOOL) {
          const args = PreviewArguments.safeParse(call.data.arguments ?? {})
          if (!args.success) return reply(textResult('path 需要是文件的绝对路径。', true))
          try {
            await preview(args.data.path)
            return reply(textResult('已在对话里展示给用户，不用再截图。用户会在这一条下面看到页面。'))
          } catch (error) {
            return reply(textResult(`没能展示：${error instanceof Error ? error.message : String(error)}`, true))
          }
        }
        if (call.success && call.data.name === READ_TASK_TOOL && readTask) {
          const args = ReadArguments.safeParse(call.data.arguments ?? {})
          if (!args.success) {
            return reply(textResult('task_id 需要是任务 id（完整 id 或前 8 位）。', true))
          }
          try {
            return reply(textResult(await readTask(args.data.task_id)))
          } catch (error) {
            return reply(textResult(`读取失败：${error instanceof Error ? error.message : String(error)}`, true))
          }
        }
        if (!call.success || call.data.name !== PROPOSE_DETAILS_TOOL || !propose) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool` } }
        }
        // Bad arguments are the model's to fix, so they come back as a tool error it can read.
        const args = ProposeArguments.safeParse(call.data.arguments ?? {})
        if (!args.success) {
          return reply(textResult(`markdown 不能为空，且不超过 ${MAX_DETAILS_LENGTH} 个字符。`, true))
        }
        try {
          await propose(args.data.markdown)
          return reply(textResult('已提交到 Kando，等待用户确认。用户可能还会提出修改，按要求调整后再次提交即可。'))
        } catch (error) {
          return reply(textResult(`提交失败：${error instanceof Error ? error.message : String(error)}`, true))
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
    }
  }
}

// `attachmentsDir` resolves the task's images to files the agent can open.
export function describeTask(task: Task, attachmentsDir: string): string {
  const images = taskImageLines(task, attachmentsDir)
  const branches = task.repos.map((repo) => (repo.branch ? `${repo.branch}（${repo.path}）` : `直接改在 ${repo.path}`))
  return [
    `# ${task.title}`,
    `id：${shortTaskId(task.id)}　状态：${STATUS_LABEL[task.status]}`,
    ...(branches.length ? [`分支：${branches.join('；')}`] : []),
    ...(task.dependsOn.length ? [`依赖：${task.dependsOn.map(shortTaskId).join('、')}`] : []),
    '',
    task.details.trim() || '（还没有详情）',
    ...(task.plan ? ['', `在聊天里${task.plan.approved ? '确认' : '保存'}的计划：`, task.plan.markdown.trim()] : []),
    ...(images.length ? ['', `任务附了 ${images.length} 张图片：`, ...images] : []),
    // Same fence as in the agent's own prompt: a dependency's issue text is not the user's word either.
    ...(task.source ? ['', untrustedSource(task.source, task.sourceSnapshot, snapshotImagePaths(task, attachmentsDir))] : [])
  ].join('\n')
}

// Everything the task depends on, directly or not: the only tasks the agent may read.
async function dependencyChain(rpc: RpcConnection, taskId: string): Promise<Set<string>> {
  const seen = new Set<string>()
  const pending = [...(await rpc.call('tasks.get', { id: taskId })).dependsOn]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (!seen.has(id)) {
      seen.add(id)
      pending.push(...(await rpc.call('tasks.get', { id })).dependsOn)
    }
  }
  return seen
}

// A file the agent wants shown: it exists, is a file, and is the kind the desktop renders.
export async function checkPreviewFile(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('要用绝对路径')
  const extension = extname(path).slice(1).toLowerCase()
  if (!PREVIEW_EXTENSIONS.has(extension)) throw new Error('只能展示 .html、.htm 或 .svg 文件')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`文件不存在：${path}`)
}

// The task is fixed by whoever started the server: the agent proposes only for it and reads only
// along its dependency chain; a server started for a chat with no task has the preview tool alone.
// Each call connects anew, so a core restart between calls is harmless.
export async function serveMcp(taskId: string | undefined, home: string | undefined): Promise<void> {
  const withCore = async <T>(work: (rpc: RpcConnection) => Promise<T>): Promise<T> => {
    const endpoint = await readCoreEndpoint(home)
    if (!endpoint) {
      throw new Error('Kando core 没有运行')
    }
    const rpc = await connectRpc(coreUrl(endpoint))
    try {
      return await work(rpc)
    } finally {
      rpc.close()
    }
  }
  const handle = createMcpHandler({
    preview: checkPreviewFile,
    ...(taskId ? {
      propose: (markdown: string) => withCore(async (rpc) => void (await rpc.call('tasks.propose', { id: taskId, markdown }))),
      readTask: (ref: string) =>
        withCore(async (rpc) => {
          const allowed = await dependencyChain(rpc, taskId)
          const target = await rpc.call('tasks.get', { id: ref })
          if (!allowed.has(target.id)) {
            throw new Error('只能读取当前任务依赖链上的任务')
          }
          return describeTask(target, kandoPaths(home).attachments)
        })
    } : {})
  })
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) {
    if (line.trim()) {
      const response = await handle(line)
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`)
      }
    }
  }
}
