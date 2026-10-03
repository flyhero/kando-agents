import { z } from 'zod'
import { UnattendedMode, type ChatSettings } from '@kando/protocol'
import { readJsonIfExists, writePrivateJson } from './private-file'

// Suggestions on, as in Claude Code itself; scheduled runs let edits through but still ask for
// anything else. Each field falls back on its own, so one bad value resets nothing else.
const DEFAULTS = { promptSuggestions: true, unattendedMode: 'acceptEdits' } satisfies Required<ChatSettings>
const Saved = z.object({
  promptSuggestions: z.boolean().catch(DEFAULTS.promptSuggestions),
  unattendedMode: UnattendedMode.catch(DEFAULTS.unattendedMode)
}).catch(DEFAULTS)

// Machine-level, like keeping the computer awake: every window and every chat goes by the same.
export class ChatSettingsStore {
  private settings: Required<ChatSettings> = DEFAULTS

  constructor(
    private readonly file: string,
    private readonly changed: (settings: ChatSettings) => void
  ) {}

  // A file it cannot read leaves the defaults rather than keeping core from starting.
  async load(): Promise<Required<ChatSettings>> {
    let saved: unknown
    try {
      saved = await readJsonIfExists(this.file)
    } catch (error) {
      console.error('[kando-core] unreadable chat settings; using the defaults', error)
    }
    this.settings = Saved.parse(saved ?? {})
    return this.settings
  }

  current(): Required<ChatSettings> {
    return this.settings
  }

  async update(patch: Partial<ChatSettings>): Promise<Required<ChatSettings>> {
    const next: Required<ChatSettings> = {
      promptSuggestions: patch.promptSuggestions ?? this.settings.promptSuggestions,
      unattendedMode: patch.unattendedMode ?? this.settings.unattendedMode
    }
    await writePrivateJson(this.file, { version: 1, ...next })
    this.settings = next
    this.changed(next)
    return next
  }
}
