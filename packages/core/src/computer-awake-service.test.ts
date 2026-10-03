import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AwakeConfigStore } from './awake-config'
import { shouldKeepComputerAwake } from './computer-awake-service'

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('computer awake policy', () => {
  it('keeps awake always, only while working or a scheduled run waits, or never', () => {
    expect(shouldKeepComputerAwake('on', 0)).toBe(true)
    expect(shouldKeepComputerAwake('auto', 0)).toBe(false)
    expect(shouldKeepComputerAwake('auto', 2)).toBe(true)
    expect(shouldKeepComputerAwake('auto', 0, 1)).toBe(true)
    expect(shouldKeepComputerAwake('off', 2, 1)).toBe(false)
  })

  it('defaults to off and persists the machine setting', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'kando-awake-'))
    roots.push(root)
    const file = path.join(root, 'awake.json')
    const config = new AwakeConfigStore(file)
    expect(await config.load()).toBe('off')
    await config.save('auto')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, mode: 'auto' })
    expect(await new AwakeConfigStore(file).load()).toBe('auto')
  })
})
