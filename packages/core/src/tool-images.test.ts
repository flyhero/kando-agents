import { describe, expect, it } from 'vitest'
import { imageMarker } from '@kando/protocol'
import type { ChatRecord } from './chat-driver'
import { ClaudeStream } from './claude-stream'
import { CodexAppServer } from './codex-app-server'

const OPTIONS = { cwd: '/work/repo', extraDirs: [], resume: null }
const at = 1_790_000_000_000
const image = { id: `${'c'.repeat(64)}.jpg`, width: 1280, height: 800 }
const marker = imageMarker(image)

describe('a browser screenshot in the chat', () => {
  it('becomes an image on the Claude tool item, with the bytes kept out of the log', () => {
    const driver = new ClaudeStream('stage-1', OPTIONS)
    const records: ChatRecord[] = [
      { dir: 'in', at, frame: { type: 'system', subtype: 'init', session_id: 's-1' } },
      { dir: 'in', at, frame: { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'T1', name: 'mcp__kando__browser_screenshot', input: { fullPage: true } }] } } },
      { dir: 'in', at, frame: { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'T2', name: 'mcp__kando__browser_click', input: { ref: 'e5' } }] } } }
    ]
    records.forEach((record) => driver.apply(record))
    const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: `截图已保存\n${marker}` }] }] } }
    driver.apply({ dir: 'in', at, frame: result })
    const tools = driver.items.list().filter((item) => item.kind === 'tool')
    expect(tools[0]).toMatchObject({ name: 'mcp__kando__browser_screenshot', title: '', status: 'done', output: '截图已保存', images: [image] })
    expect(tools[0]?.kind === 'tool' && tools[0].input).toContain('fullPage')
    expect(tools[1]).toMatchObject({ name: 'mcp__kando__browser_click', title: 'e5', input: null })
    const logged = driver.logged(result)
    expect(JSON.stringify(logged)).not.toContain('AAAA')
    expect(JSON.stringify(logged)).toContain(marker)
    // The same item comes out of a replay of what was logged.
    const replayed = new ClaudeStream('stage-1', OPTIONS)
    records.forEach((record) => replayed.apply(record))
    replayed.apply({ dir: 'in', at, frame: logged })
    expect(replayed.items.list().filter((item) => item.kind === 'tool')[0]).toMatchObject({ images: [image], output: '截图已保存' })
  })

  it('becomes an image on the Codex tool item too', () => {
    const driver = new CodexAppServer('stage-1', OPTIONS)
    const item = { type: 'mcpToolCall', id: 'mcp-1', server: 'kando', tool: 'browser_screenshot', arguments: {}, status: 'completed', result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }, { type: 'text', text: `截图已保存\n${marker}` }] } }
    const frame = { method: 'item/completed', params: { threadId: 'th-1', item } }
    driver.apply({ dir: 'in', at, frame })
    expect(driver.items.list().filter((each) => each.kind === 'tool')[0]).toMatchObject({ name: 'kando.browser_screenshot', status: 'done', output: '截图已保存', images: [image] })
    expect(JSON.stringify(driver.logged(frame))).not.toContain('AAAA')
  })
})
