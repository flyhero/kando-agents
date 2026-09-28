import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeChatCatalog } from './chat-catalog'
import { createDriver } from './chat-host'

// Stand-ins for the CLIs, answering on stdout the way each protocol does.
const FAKE_CLAUDE = `
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  const reply = (response) => console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } }))
  if (frame.request?.subtype === 'initialize') {
    reply({ models: [
      { value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Default', supportedEffortLevels: ['low', 'high'] },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }
    ] })
  } else if (frame.request?.subtype === 'get_settings') {
    reply({ effective: {} })
  }
})`

// Writes each method it is sent to the file named after the script.
const FAKE_CODEX = `
const log = process.argv[1]
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line)
  require('fs').appendFileSync(log, frame.method + '\\n')
  const reply = (result) => console.log(JSON.stringify({ id: frame.id, result }))
  if (frame.method === 'initialize') reply({})
  if (frame.method === 'thread/start') reply({ thread: { id: 'thread-1' } })
  if (frame.method === 'model/list') reply({ data: [
    { id: 'gpt-x', displayName: 'GPT X', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { id: 'gpt-y', displayName: 'GPT Y', isDefault: false }
  ] })
  if (frame.method === 'config/read') reply({ config: { model: 'gpt-y', mcp_servers: { secret: { env: { TOKEN: 'x' } } } } })
})`

describe('probeChatCatalog', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'kando-catalog-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const driver = (agent: 'claude' | 'codex') =>
    createDriver({ conversationId: '', stageId: 'catalog', agent, options: { cwd: root, extraDirs: [], resume: null } })

  it('lists what Claude Code offers once it has answered every question asked', async () => {
    const catalog = await probeChatCatalog(driver('claude'), { command: process.execPath, args: ['-e', FAKE_CLAUDE] }, root)
    expect(catalog?.models).toEqual([{ id: 'sonnet', label: 'Sonnet', description: null, efforts: ['low', 'high'], isDefault: true }])
  })

  it('asks Codex for its models without opening a thread, the one config.toml names as default', async () => {
    const log = path.join(root, 'methods')
    const catalog = await probeChatCatalog(driver('codex'), { command: process.execPath, args: ['-e', FAKE_CODEX, log] }, root)
    expect(catalog?.models.map((model) => [model.id, model.efforts, model.isDefault])).toEqual([['gpt-x', ['low'], false], ['gpt-y', [], true]])
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['initialize', 'initialized', 'model/list', 'config/read'])
  })

  it('gives nothing for a CLI that is not there or quits', async () => {
    expect(await probeChatCatalog(driver('claude'), { command: path.join(root, 'missing'), args: [] }, root)).toBeNull()
    expect(await probeChatCatalog(driver('claude'), { command: process.execPath, args: ['-e', 'process.exit(1)'] }, root)).toBeNull()
  })
})
