import { access, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from './agent-command'
import { Rejection } from './rejection'

export function cursorMcpReadyFile(sessionsRoot: string, conversationId: string, stageId: string): string {
  return path.join(sessionsRoot, conversationId, 'cursor-mcp', `${stageId}.json`)
}

export function cursorMcpServer(server: McpServer, readyFile: string, planOnly: boolean): McpServer {
  return { ...server, args: [...server.args, '--ready-file', readyFile, ...(planOnly ? ['--plan-only'] : [])] }
}

export async function prepareCursorMcp(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await rm(file, { force: true })
}

// Cursor can swallow an MCP launch error and still open the ACP session successfully.
export async function waitForCursorMcp(file: string, waitMs = 5000): Promise<void> {
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if (await access(file).then(() => true, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Rejection('cursor-mcp-unavailable', 'Cursor 未能加载 Kando MCP，请检查 CLI 版本、服务器权限或企业策略后重试')
}
