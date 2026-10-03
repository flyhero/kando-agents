import readline from 'node:readline'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { connectRpc, coreUrl, PREVIEW_EXTENSIONS, SHOW_PREVIEW_TOOL, type RpcConnection } from '@kando/protocol'
import { readCoreEndpoint, kandoPaths } from '@kando/protocol/node'
import { AttachmentStore } from './attachment-store'
import { BROWSER_ARGUMENTS, BROWSER_TOOL_SPECS, browserToolsOverCore, type BrowserTools, type ToolOutcome } from './mcp-browser-tools'

// A tools-only MCP server over stdio, giving an agent Kando's own tools: showing a file it wrote in
// the chat, and the browser Kando hosts.
// Messages are newline-delimited JSON-RPC 2.0; stdout is the channel, so logs go to stderr.

const Message = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional()
})
const InitializeParams = z.object({ protocolVersion: z.string() })
const CallParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
const PreviewArguments = z.object({ path: z.string().trim().min(1), title: z.string().trim().max(200).optional() })

// Tools and basic lifecycle are the same in every published MCP revision.
const FALLBACK_PROTOCOL_VERSION = '2025-06-18'

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
  // Checks the file may be shown (it exists, and is HTML or SVG); throws with the reason if not.
  preview: (path: string) => Promise<void>
  // The browser tools, there when the server was started for a conversation.
  browser?: BrowserTools
}

export type McpResponse = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

type McpResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError: boolean }

function textResult(text: string, isError = false): McpResult {
  return { content: [{ type: 'text', text }], isError }
}

function outcomeResult(outcome: ToolOutcome): McpResult {
  return {
    content: [...(outcome.image ? [{ type: 'image' as const, data: outcome.image.data, mimeType: outcome.image.mimeType }] : []), { type: 'text', text: outcome.text }],
    isError: outcome.isError ?? false
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What the model may call: the tool as listed, and what a call with its arguments does. Bad
// arguments are the model's to fix, so they come back as a tool error it can read.
type ToolEntry = { spec: object & { name: string }; run(args: Record<string, unknown>): Promise<McpResult> }

function toolTable({ preview, browser }: McpTools): ToolEntry[] {
  const entries: ToolEntry[] = [
    {
      spec: PREVIEW_TOOL,
      run: async (raw) => {
        const args = PreviewArguments.safeParse(raw)
        if (!args.success) return textResult('path 需要是文件的绝对路径。', true)
        try {
          await preview(args.data.path)
          return textResult('已在对话里展示给用户，不用再截图。用户会在这一条下面看到页面。')
        } catch (error) {
          return textResult(`没能展示：${describe(error)}`, true)
        }
      }
    }
  ]
  if (browser) {
    for (const { kind, ...spec } of BROWSER_TOOL_SPECS) {
      entries.push({
        spec,
        run: async (raw) => {
          const args = BROWSER_ARGUMENTS[kind].safeParse(raw)
          if (!args.success) return textResult(`参数不对：${args.error.issues.map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`).join('；')}`, true)
          return outcomeResult(await browser.call(kind, args.data))
        }
      })
    }
  }
  return entries
}

export function createMcpHandler(tools: McpTools) {
  const table = toolTable(tools)
  const specs = table.map((entry) => entry.spec)
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
        return reply({ tools: specs })
      case 'tools/call': {
        const call = CallParams.safeParse(params)
        const entry = call.success ? table.find((candidate) => candidate.spec.name === call.data.name) : undefined
        if (!call.success || !entry) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool` } }
        }
        return reply(await entry.run(call.data.arguments ?? {}))
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
    }
  }
}

// A file the agent wants shown: it exists, is a file, and is the kind the desktop renders.
export async function checkPreviewFile(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('要用绝对路径')
  const extension = extname(path).slice(1).toLowerCase()
  if (!PREVIEW_EXTENSIONS.has(extension)) throw new Error('只能展示 .html、.htm 或 .svg 文件')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`文件不存在：${path}`)
}

// A server started for a conversation has the browser tools, acting for that conversation alone;
// one without has the preview tool alone. Each call connects anew, so a core restart between calls
// is harmless.
export async function serveMcp(home: string | undefined, conversationId?: string): Promise<void> {
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
    ...(conversationId ? { browser: browserToolsOverCore(withCore, conversationId, new AttachmentStore(kandoPaths(home).attachments)) } : {})
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
