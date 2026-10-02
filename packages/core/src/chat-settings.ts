import { z } from 'zod'
import type { ChatSettings } from '@kando/protocol'
import { readJsonIfExists, writePrivateJson } from './private-file'

// On, as in Claude Code itself. Each field falls back on its own, so one bad value resets nothing else.
const DEFAULTS: ChatSettings = { promptSuggestions: true }
const Saved = z.object({ promptSuggestions: z.boolean().catch(DEFAULTS.promptSuggestions) }).catch(DEFAULTS)

// Machine-level, like keeping the computer awake: every window and every chat goes by the same.
export class ChatSettingsStore {
  private settings: ChatSettings = DEFAULTS

  constructor(
    private readonly file: string,
    private readonly changed: (settings: ChatSettings) => void
  ) {}

  // A file it cannot read leaves the defaults rather than keeping core from starting.
  async load(): Promise<ChatSettings> {
    let saved: unknown
    try {
      saved = await readJsonIfExists(this.file)
    } catch (error) {
      console.error('[kando-core] unreadable chat settings; using the defaults', error)
    }
    this.settings = Saved.parse(saved ?? {})
    return this.settings
  }

  current(): ChatSettings {
    return this.settings
  }

  async update(patch: Partial<ChatSettings>): Promise<ChatSettings> {
    const next = { ...this.settings, ...patch }
    await writePrivateJson(this.file, { version: 1, ...next })
    this.settings = next
    this.changed(next)
    return next
  }
}
