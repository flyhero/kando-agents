import { z } from 'zod'
import { RpcError, terminalToolName, type RpcConnection, type TerminalOutput, type TerminalToolKind } from '@kando/protocol'
import type { ToolOutcome } from './mcp-browser-tools'

export type TerminalTools = {
  call(kind: TerminalToolKind, args: Record<string, unknown>): Promise<ToolOutcome>
}

const Id = z.string().uuid()

// Checked before anything is asked of core, so a mistake comes back as text the model can act on.
export const TERMINAL_ARGUMENTS: Record<TerminalToolKind, z.ZodType<Record<string, unknown>>> = {
  run: z.object({ command: z.string().trim().min(1).max(4000), cwd: z.string().trim().optional() }),
  read: z.object({ id: Id, tail: z.number().int().min(200).max(50_000).optional() }),
  stop: z.object({ id: Id })
}

const acts = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

export const TERMINAL_TOOL_SPECS = [
  {
    kind: 'run' as const,
    name: terminalToolName('run'),
    title: '在用户能看到的终端里运行',
    description:
      '在 Kando 的终端面板里为这条会话新开一个标签，用用户的登录 shell 运行一条命令；用户能实时看到输出，也能停掉它。' +
      '用来跑要一直运行、用户也想看的进程：开发服务器、watch、测试的 watch 模式、日志 tail。' +
      '一次性的命令（构建、测试、git、查看文件）继续用你自己的 shell 工具，不要用这个。' +
      '返回标签 id 和刚启动时的输出；之后用 terminal_read 读，用 terminal_stop 停。' +
      '可能要用户先在对话里确认：返回「等待用户确认」时先停下，等用户同意后再用同样的命令调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要运行的命令，原样交给 shell' },
        cwd: { type: 'string', description: '工作目录的绝对路径，可选；不给就用这条会话的项目目录' }
      },
      required: ['command'],
      additionalProperties: false
    },
    annotations: acts
  },
  {
    kind: 'read' as const,
    name: terminalToolName('read'),
    title: '读终端的输出',
    description: '读 terminal_run 开的某个终端最近的输出（纯文本，去掉了颜色），以及命令是否还在运行、退出码。只能读这条会话自己开的终端。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'terminal_run 返回的标签 id' },
        tail: { type: 'number', description: '最多返回最后多少个字符，默认 8000' }
      },
      required: ['id'],
      additionalProperties: false
    },
    annotations: readOnly
  },
  {
    kind: 'stop' as const,
    name: terminalToolName('stop'),
    title: '停下终端里的命令',
    description: '停掉 terminal_run 开的某个终端里还在运行的命令。标签会留着，写明命令怎么结束的，用户关掉它才消失。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'terminal_run 返回的标签 id' } },
      required: ['id'],
      additionalProperties: false
    },
    annotations: acts
  }
] as const

// The output as the model reads it: where it stands, then what it printed.
export function describeOutput(output: TerminalOutput): string {
  const state = output.running ? '还在运行' : `已结束${output.exitCode === null ? '' : `，退出码 ${output.exitCode}`}`
  const body = output.output.trim() ? output.output : '（还没有输出）'
  return `命令：${output.command}\n状态：${state}${output.truncated ? '\n（只保留了最后一部分输出）' : ''}\n\n${body}`
}

// How long a run waits before reading what the command printed first: long enough to catch one
// that fails at once, short of a call the agent would think hung.
const FIRST_OUTPUT_MS = 1500

type WithCore = <T>(work: (rpc: RpcConnection) => Promise<T>) => Promise<T>

// The terminal tools for one conversation, each a call to core.
export function terminalToolsOverCore(withCore: WithCore, conversationId: string, settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): TerminalTools {
  const attempt = async (work: () => Promise<ToolOutcome>): Promise<ToolOutcome> => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof RpcError && error.reason === 'terminal-not-found') {
        return { text: '没有这个终端，或者它不是这条会话开的（也可能用户已经关掉了）。', isError: true }
      }
      return { text: `没能完成：${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  }
  return {
    call: (kind, args) => attempt(async () => {
      if (kind === 'run') {
        const { command, cwd } = z.object({ command: z.string(), cwd: z.string().optional() }).parse(args)
        const run = await withCore((rpc) => rpc.call('terminals.run', { conversationId, command, ...(cwd ? { cwd } : {}) }))
        if (run.outcome === 'awaiting') return { text: '等待用户确认：已在对话里请用户确认这条命令。先停下，等用户同意后再用同样的命令调用一次。' }
        if (run.outcome === 'denied') return { text: '用户没有同意运行这条命令。', isError: true }
        await settle(FIRST_OUTPUT_MS)
        const first = await withCore((rpc) => rpc.call('terminals.read', { conversationId, id: run.terminal.id }))
        return {
          text: `已在终端面板里为这条会话开了一个标签运行它，用户能看到。\n标签 id：${run.terminal.id}\n工作目录：${run.terminal.cwd}\n` +
            `用 terminal_read 读之后的输出，用 terminal_stop 停下。\n\n${describeOutput(first)}`
        }
      }
      const { id, tail } = z.object({ id: z.string(), tail: z.number().optional() }).parse(args)
      if (kind === 'read') {
        return { text: describeOutput(await withCore((rpc) => rpc.call('terminals.read', { conversationId, id, ...(tail ? { tail } : {}) }))) }
      }
      await withCore((rpc) => rpc.call('terminals.stop', { conversationId, id }))
      return { text: '已经让它停下。用 terminal_read 可以看它最后的输出和退出码。' }
    })
  }
}
