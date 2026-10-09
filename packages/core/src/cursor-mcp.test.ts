import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { cursorMcpReadyFile, cursorMcpServer, prepareCursorMcp, waitForCursorMcp } from './cursor-mcp'
import { writePrivateJson } from './private-file'

it('binds readiness and MCP argv to each conversation and stage without editing project configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kando-cursor-mcp-'))
  try {
    const first = cursorMcpReadyFile(root, 'first', 'stage')
    const second = cursorMcpReadyFile(root, 'second', 'stage')
    await prepareCursorMcp(first)
    await prepareCursorMcp(second)
    expect(cursorMcpServer({ command: 'node', args: ['mcp', '--conversation', 'first'] }, first, true).args).toEqual(['mcp', '--conversation', 'first', '--ready-file', first, '--plan-only'])
    await writePrivateJson(first, { ready: true })
    await expect(waitForCursorMcp(first)).resolves.toBeUndefined()
    await expect(waitForCursorMcp(second, 1)).rejects.toMatchObject({ reason: 'cursor-mcp-unavailable' })
    await prepareCursorMcp(first)
    await expect(readFile(first)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
