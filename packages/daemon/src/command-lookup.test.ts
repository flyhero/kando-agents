import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { commandExists } from './command-lookup'

describe.skipIf(process.platform === 'win32')('commandExists', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds only an executable file on PATH', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-command-'))
    const file = path.join(dir, 'agent')
    writeFileSync(file, '#!/bin/sh\n')
    const env = { PATH: `/nowhere${path.delimiter}${dir}` }
    expect(commandExists('agent', '/', env)).toBe(false)
    chmodSync(file, 0o755)
    expect(commandExists('agent', '/', env)).toBe(true)
    expect(commandExists('claude-not-installed', '/', env)).toBe(false)
  })

  it('checks a path as it is, relative to the working directory', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-command-'))
    expect(commandExists(process.execPath, '/', {})).toBe(true)
    expect(commandExists('./missing', dir, {})).toBe(false)
  })
})
