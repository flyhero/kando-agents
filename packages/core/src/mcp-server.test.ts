import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPreviewFile, createMcpHandler } from './mcp-server'

const frame = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
const notification = (method: string) => JSON.stringify({ jsonrpc: '2.0', method })

describe('kando MCP server', () => {
  const handle = createMcpHandler({ preview: checkPreviewFile })

  it('answers the handshake with the client version and a tools capability', async () => {
    const response = await handle(frame('initialize', { protocolVersion: '2025-03-26', capabilities: {} }))
    expect(response?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} } })
    expect(await handle(notification('notifications/initialized'))).toBeNull()
  })

  it('lists the preview tool alone without a conversation', async () => {
    const response = await handle(frame('tools/list'))
    expect(response?.result).toEqual({ tools: [expect.objectContaining({ name: 'show_preview', annotations: expect.objectContaining({ readOnlyHint: true }) })] })
  })

  it('adds the browser tools for a conversation, checks their arguments, and passes a screenshot through', async () => {
    const called: Array<[string, unknown]> = []
    const chat = createMcpHandler({
      preview: checkPreviewFile,
      browser: {
        call: async (kind, args) => {
          called.push([kind, args])
          return kind === 'screenshot' ? { text: '截图已保存', image: { data: 'AAAA', mimeType: 'image/jpeg' } } : { text: `did ${kind}` }
        }
      }
    })
    const listed = (await chat(frame('tools/list')))?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }
    expect(listed.tools.map((tool) => tool.name)).toEqual(['show_preview', 'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_press', 'browser_hover', 'browser_scroll', 'browser_select', 'browser_wait', 'browser_tabs', 'browser_console'])
    expect(listed.tools.find((tool) => tool.name === 'browser_snapshot')?.annotations.readOnlyHint).toBe(true)
    const bad = await chat(frame('tools/call', { name: 'browser_click', arguments: { ref: 'nope' } }))
    expect(bad?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('参数不对') }] })
    expect(called).toEqual([])
    const shot = await chat(frame('tools/call', { name: 'browser_screenshot', arguments: { fullPage: true } }))
    expect(shot?.result).toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }, { type: 'text', text: '截图已保存' }], isError: false })
    expect(called).toEqual([['screenshot', { fullPage: true }]])
    const unknown = await chat(frame('tools/call', { name: 'browser_fly', arguments: {} }))
    expect(unknown?.error?.code).toBe(-32602)
  })

  it('shows an HTML file that exists and refuses anything else', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kando-preview-'))
    try {
      const page = path.join(dir, 'index.html')
      writeFileSync(page, '<h1>hi</h1>')
      const ok = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: page } }))
      expect(ok?.result).toMatchObject({ isError: false })
      const missing = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: path.join(dir, 'gone.html') } }))
      expect(missing?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('文件不存在') }] })
      const other = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: path.join(dir, 'notes.md') } }))
      expect(other?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('.html') }] })
      const relative = await handle(frame('tools/call', { name: 'show_preview', arguments: { path: 'index.html' } }))
      expect(relative?.result).toMatchObject({ isError: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unknown tools, unknown methods and garbage', async () => {
    expect((await handle(frame('tools/call', { name: 'rm_rf' })))?.error?.code).toBe(-32602)
    expect((await handle(frame('resources/list')))?.error?.code).toBe(-32601)
    expect((await handle('{oops'))?.error?.code).toBe(-32700)
  })
})

