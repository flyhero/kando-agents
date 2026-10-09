import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { basename, delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ChatCatalog } from '@kando/protocol'
import { Rejection } from './rejection'
import { CursorAcp } from './cursor-acp'
import { probeChatCatalog } from './chat-catalog'

const execute = promisify(execFile)
const cache = new Map<string, Promise<{ version: string; compatible: boolean }>>()
const clean = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')

async function output(command: string, args: string[]): Promise<string> {
  const result = await execute(command, args, { timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true })
  return clean(result.stdout)
}

// The generic `agent` name also belongs to unrelated programs.
export async function findCursorCli(pathEnv = process.env.PATH ?? '', platform = process.platform): Promise<string | null> {
  const extensions = platform === 'win32' ? ['.exe'] : ['']
  for (const name of ['cursor-agent', 'agent']) {
    for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const file = join(directory, `${name}${extension}`)
        try {
          const info = await stat(file)
          if (!info.isFile() || (platform !== 'win32' && !(info.mode & 0o111))) continue
          if (name === 'cursor-agent' || basename(await realpath(file)).startsWith('cursor-agent')) return file
          if (/Cursor Agent|Cursor CLI/i.test(await output(file, ['--help']))) return file
        } catch { /* Try the next executable. */ }
      }
    }
  }
  return null
}

export async function cursorCliInfo(command: string): Promise<{ version: string; compatible: boolean }> {
  const info = await stat(command)
  const key = `${command}:${info.mtimeMs}:${info.size}`
  const existing = cache.get(key)
  if (existing) return existing
  const reading = (async () => {
    const version = (await output(command, ['--version'])).trim()
    // Older CLIs interpret an unknown subcommand as a prompt; identify the ACP-era release first.
    const date = /^(\d{4}\.\d{2}\.\d{2})/.exec(version)?.[1]
    if (!date || date < '2026.10.01') return { version, compatible: false }
    const help = await output(command, ['acp', '--help'])
    return { version, compatible: /\bacp\b/i.test(help) }
  })()
  cache.set(key, reading)
  void reading.catch(() => cache.delete(key))
  return reading
}

export async function requireCursorCli(): Promise<string> {
  const command = await findCursorCli()
  if (!command) throw new Rejection('cursor-cli-missing', '未找到 Cursor CLI，请安装后重新检测')
  if (!(await cursorCliInfo(command)).compatible) throw new Rejection('cursor-upgrade-required', '请升级 Cursor CLI，Kando 需要支持 ACP 的版本')
  if (await cursorSignedIn(command) === false) throw new Rejection('cursor-signed-out', '请在终端运行 agent login，登录 Cursor 后重试')
  return command
}

export async function cursorSignedIn(command: string): Promise<boolean | null> {
  try {
    const text = await output(command, ['about', '--format', 'json'])
    const start = text.indexOf('{')
    const account = z.looseObject({ userEmail: z.string().nullable() }).safeParse(JSON.parse(text.slice(start)))
    return account.success ? Boolean(account.data.userEmail) : null
  } catch { return null }
}

export async function cursorCatalog(cwd: string): Promise<ChatCatalog | null> {
  const command = await requireCursorCli()
  return probeChatCatalog(new CursorAcp('catalog', { cwd, extraDirs: [], resume: null }, true), { command, args: ['acp'] }, cwd)
}
