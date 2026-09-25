import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Codex's `notify` is one argv command. Our per-run override calls Ripen, which then
// invokes the user's original command with the same event instead of replacing it.
export function parseCodexNotify(config: string): string[] | null {
  config = config.replace(/\r\n/g, '\n')
  const lines = config.split(/\r?\n/)
  let start = -1
  let prefix = 0
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break
    const match = /^\s*notify\s*=\s*/.exec(line)
    if (match) { start = prefix + match[0].length; break }
    prefix += line.length + 1
  }
  if (start < 0 || config[start] !== '[') return null
  let index = start + 1
  const result: string[] = []
  const skip = () => {
    while (index < config.length) {
      if (/\s/.test(config[index]!)) index++
      else if (config[index] === '#') { while (index < config.length && config[index] !== '\n') index++ }
      else break
    }
  }
  for (;;) {
    skip()
    if (config[index] === ']') return result.length ? result : null
    const quote = config[index]
    if (quote !== '"' && quote !== "'") return null
    index++
    let value = ''
    while (index < config.length && config[index] !== quote) {
      if (quote === '"' && config[index] === '\\') {
        const escape = config[++index]
        if (escape === undefined) return null
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
        if (simple[escape] !== undefined) value += simple[escape]
        else if (escape === 'u' || escape === 'U') {
          const digits = config.slice(index + 1, index + (escape === 'u' ? 5 : 9))
          if (!new RegExp(`^[0-9a-fA-F]{${escape === 'u' ? 4 : 8}}$`).test(digits)) return null
          value += String.fromCodePoint(Number.parseInt(digits, 16))
          index += digits.length
        } else return null
      } else value += config[index]
      index++
    }
    if (config[index] !== quote) return null
    index++
    result.push(value)
    skip()
    if (config[index] === ']') return result.length ? result : null
    if (config[index] !== ',') return null
    index++
  }
}

export function forwardOriginalCodexNotify(payload: string): void {
  let config: string
  try {
    config = readFileSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8')
  } catch { return }
  const command = parseCodexNotify(config)
  if (!command) return
  const child = spawn(command[0]!, [...command.slice(1), payload], { stdio: 'ignore', env: process.env })
  child.on('error', () => {})
  child.unref()
}
