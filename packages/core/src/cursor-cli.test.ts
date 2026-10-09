import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cursorCliInfo, cursorSignedIn, findCursorCli, requireCursorCli } from './cursor-cli'

let root: string
const executable = (name: string, body: string) => {
  const file = path.join(root, name)
  writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 })
  return file
}

beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'kando-cursor-cli-')) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('Cursor CLI identity and compatibility', () => {
  it('accepts cursor-agent and its agent alias but rejects an unrelated agent executable', async () => {
    executable('agent', "console.log('Other Agent')")
    expect(await findCursorCli(root)).toBeNull()
    const cursor = executable('cursor-agent', "console.log('Cursor Agent')")
    expect(await findCursorCli(root)).toBe(cursor)
    rmSync(path.join(root, 'agent'))
    symlinkSync(cursor, path.join(root, 'agent'))
    expect(await findCursorCli(root)).toBe(cursor)
    rmSync(cursor)
    rmSync(path.join(root, 'agent'))
    const target = executable('cursor-agent-real', 'process.exit(1)')
    symlinkSync(target, path.join(root, 'agent'))
    expect(await findCursorCli(root)).toBe(path.join(root, 'agent'))
    rmSync(path.join(root, 'agent'))
    executable('agent', "console.log('Cursor Agent')")
    expect(await findCursorCli(root)).toBe(path.join(root, 'agent'))
  })

  it('never passes an unknown acp subcommand to an older CLI that could treat it as a prompt', async () => {
    const cursor = executable('cursor-agent', "if(process.argv[2]!=='--version') process.exit(2); console.log('2026.02.01-old')")
    expect(await cursorCliInfo(cursor)).toEqual({ version: '2026.02.01-old', compatible: false })
  })

  it('recognizes ACP-capable calendar releases and distinguishes signed out from an unreadable account', async () => {
    const cursor = executable('cursor-agent', "console.log(process.argv[2]==='--version'?'2026.10.01-release':process.argv[2]==='acp'?'Usage: cursor-agent acp':JSON.stringify({userEmail:null}))")
    expect(await cursorCliInfo(cursor)).toEqual({ version: '2026.10.01-release', compatible: true })
    expect(await cursorSignedIn(cursor)).toBe(false)
    vi.stubEnv('PATH', root)
    await expect(requireCursorCli()).rejects.toMatchObject({ reason: 'cursor-signed-out' })
    const unavailable = executable('unavailable', 'process.exit(1)')
    expect(await cursorSignedIn(unavailable)).toBeNull()
    const signedIn = executable('signed-in', "console.log(JSON.stringify({userEmail:'test@example.invalid'}))")
    expect(await cursorSignedIn(signedIn)).toBe(true)
  })

  it('launches on the sign-in the environment check last saw, and asks again once it is stale', async () => {
    const asked = path.join(root, 'asked')
    const cursor = executable('cursor-agent', `const fs=require('fs');if(process.argv[2]==='about')fs.appendFileSync(${JSON.stringify(asked)},'x');console.log(process.argv[2]==='--version'?'2026.10.01-release':process.argv[2]==='acp'?'Usage: cursor-agent acp':JSON.stringify({userEmail:'test@example.invalid'}))`)
    vi.stubEnv('PATH', root)
    const times = () => readFileSync(asked, 'utf8').length
    expect(await cursorSignedIn(cursor)).toBe(true)
    await requireCursorCli()
    await requireCursorCli()
    expect(times()).toBe(1)
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000, toFake: ['Date'] })
    try {
      await requireCursorCli()
    } finally {
      vi.useRealTimers()
    }
    expect(times()).toBe(2)
  })
})
