import type { ChatCommand } from '@kando/protocol'

// A skill's description is written for the model and runs to paragraphs; the composer's list
// shows a line, and the stage state carries every command on each update.
const MAX_DESCRIPTION = 160

export function offeredCommand(name: string, description: string | null | undefined, argumentHint: string | null | undefined): ChatCommand {
  const line = (description ?? '').trim().split('\n')[0]?.trim() ?? ''
  const hint = argumentHint?.trim()
  return {
    name,
    description: line.length > MAX_DESCRIPTION ? `${line.slice(0, MAX_DESCRIPTION - 1)}…` : line,
    argumentHint: hint ? hint : null
  }
}

// The command a message names, when it starts with one: `/name rest`.
export function commandOf(text: string): { name: string; args: string } | null {
  const match = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match?.[1] ? { name: match[1], args: (match[2] ?? '').trim() } : null
}
