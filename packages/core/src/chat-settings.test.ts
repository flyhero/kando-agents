import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatSettings } from '@kando/protocol'
import { ChatSettingsStore } from './chat-settings'

describe('ChatSettingsStore', () => {
  let root: string
  let file: string
  let changes: ChatSettings[]

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-chat-settings-'))
    file = path.join(root, 'chat-settings.json')
    changes = []
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('suggests the next message and lets scheduled runs edit, unless the user changed that, and keeps it', async () => {
    const store = new ChatSettingsStore(file, (settings) => changes.push(settings))
    expect(await store.load()).toEqual({ promptSuggestions: true, unattendedMode: 'acceptEdits', maxConcurrentAgents: 20, agentConcurrency: { claude: 6, codex: 6, cursor: 6 }, wireLog: false })

    await store.update({ promptSuggestions: false })
    await store.update({ unattendedMode: 'bypass' })
    expect(changes).toEqual([
      { promptSuggestions: false, unattendedMode: 'acceptEdits', maxConcurrentAgents: 20, agentConcurrency: { claude: 6, codex: 6, cursor: 6 }, wireLog: false },
      { promptSuggestions: false, unattendedMode: 'bypass', maxConcurrentAgents: 20, agentConcurrency: { claude: 6, codex: 6, cursor: 6 }, wireLog: false }
    ])

    const reopened = new ChatSettingsStore(file, () => {})
    expect(await reopened.load()).toEqual({ promptSuggestions: false, unattendedMode: 'bypass', maxConcurrentAgents: 20, agentConcurrency: { claude: 6, codex: 6, cursor: 6 }, wireLog: false })
  })

  it('falls back to the default for a file it cannot read', async () => {
    writeFileSync(file, '{"promptSuggestions": "nope", "unattendedMode": "yolo"}')
    expect(await new ChatSettingsStore(file, () => {}).load()).toEqual({ promptSuggestions: true, unattendedMode: 'acceptEdits', maxConcurrentAgents: 20, agentConcurrency: { claude: 6, codex: 6, cursor: 6 }, wireLog: false })
    writeFileSync(file, 'not json')
    expect(await new ChatSettingsStore(file, () => {}).load()).toEqual({ promptSuggestions: true, unattendedMode: 'acceptEdits', maxConcurrentAgents: 20, agentConcurrency: { claude: 6, codex: 6, cursor: 6 }, wireLog: false })
  })

  it('keeps per-agent limits when another agent changes, and rejects invalid limits', async () => {
    const store = new ChatSettingsStore(file, () => {})
    await store.load()
    await store.update({ agentConcurrency: { claude: 2 } })
    expect(store.current().agentConcurrency).toEqual({ claude: 2, codex: 6, cursor: 6 })
    await store.update({ maxConcurrentAgents: 3 })
    expect(store.current().maxConcurrentAgents).toBe(3)
    expect(() => ChatSettings.parse({ promptSuggestions: true, maxConcurrentAgents: 0 })).toThrow()
  })

  it('keeps no wire log until the user turns it on', async () => {
    const store = new ChatSettingsStore(file, () => {})
    expect((await store.load()).wireLog).toBe(false)
    await store.update({ wireLog: true })
    expect((await new ChatSettingsStore(file, () => {}).load()).wireLog).toBe(true)
  })
})
