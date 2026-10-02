import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatSettings } from '@kando/protocol'
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

  it('suggests the next message unless the user turned it off, and keeps that', async () => {
    const store = new ChatSettingsStore(file, (settings) => changes.push(settings))
    expect(await store.load()).toEqual({ promptSuggestions: true })

    await store.update({ promptSuggestions: false })
    expect(changes).toEqual([{ promptSuggestions: false }])

    const reopened = new ChatSettingsStore(file, () => {})
    expect(await reopened.load()).toEqual({ promptSuggestions: false })
  })

  it('falls back to the default for a file it cannot read', async () => {
    writeFileSync(file, '{"promptSuggestions": "nope"}')
    expect(await new ChatSettingsStore(file, () => {}).load()).toEqual({ promptSuggestions: true })
    writeFileSync(file, 'not json')
    expect(await new ChatSettingsStore(file, () => {}).load()).toEqual({ promptSuggestions: true })
  })
})
