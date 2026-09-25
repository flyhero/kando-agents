// Codex's TUI names a thread by running this prompt in a separate, unsaved thread whose turn also
// fires notify, for a typed prompt and an argv one alike. The payload has no field that marks it,
// so the prompt is the only tell.
const TITLE_PROMPT = /^Generate a concise, single-line task title of at most \d+ characters/

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? Reflect.get(value, key) : undefined
}

// Whether a Codex notify payload is that title turn rather than a turn of the agent's own thread.
export function isCodexTitleTurn(input: unknown): boolean {
  const inputs = field(input, 'input-messages')
  const texts = Array.isArray(inputs) ? inputs.filter((value): value is string => typeof value === 'string' && value.trim() !== '') : []
  return texts.length === 1 && TITLE_PROMPT.test(texts[0] ?? '')
}
