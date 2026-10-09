import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freeProfile, profileOwner, systemProcesses, type ProcessTable } from './profile-lock'

let profile: string
beforeEach(() => { profile = mkdtempSync(path.join(os.tmpdir(), 'kando-profile-')) })
afterEach(() => rmSync(profile, { recursive: true, force: true }))

const lock = (target: string) => symlinkSync(target, path.join(profile, 'SingletonLock'))

// Processes by pid: command line, parent, and whether a signal ends it.
type Processes = Record<number, { command: string; parent: number; stubborn?: boolean }>

function table(processes: Processes) {
  const live = new Set(Object.keys(processes).map(Number))
  const signals: Array<[number, string]> = []
  const fake: ProcessTable = {
    command: async (pid) => (live.has(pid) ? processes[pid]?.command ?? null : null),
    parent: async (pid) => (live.has(pid) ? processes[pid]?.parent ?? null : null),
    alive: (pid) => live.has(pid),
    signal: (pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGKILL' || !processes[pid]?.stubborn) {
        live.delete(pid)
        // A host that goes takes its browser with it.
        for (const [child, info] of Object.entries(processes)) if (info.parent === pid && !info.stubborn) live.delete(Number(child))
      }
    }
  }
  return { fake, signals }
}

const chromium = () => `/browsers/Google Chrome for Testing --headless --user-data-dir=${profile} about:blank`
const host = '/Applications/Kando.app/Contents/MacOS/Kando /Applications/Kando.app/Contents/Resources/backend/browser-host.mjs --home /Users/me/.kando'

describe('profileOwner', () => {
  it('reads the pid of a lock taken on this machine only', async () => {
    expect(await profileOwner(profile)).toBeNull()
    lock(`${os.hostname()}-4321`)
    expect(await profileOwner(profile)).toBe(4321)
    expect(await profileOwner(profile, 'another-machine')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('freeProfile', () => {
  it('ends an earlier browser host still holding the profile, politely first', async () => {
    lock(`${os.hostname()}-200`)
    const { fake, signals } = table({ 100: { command: host, parent: 1 }, 200: { command: chromium(), parent: 100 } })
    expect(await freeProfile(profile, fake, 50)).toBe(100)
    expect(signals).toEqual([[100, 'SIGTERM']])
  })

  it('kills a host and browser that ignore the request', async () => {
    lock(`${os.hostname()}-200`)
    const { fake, signals } = table({ 100: { command: host, parent: 1, stubborn: true }, 200: { command: chromium(), parent: 100, stubborn: true } })
    expect(await freeProfile(profile, fake, 50)).toBe(100)
    expect(signals).toEqual([[100, 'SIGTERM'], [200, 'SIGKILL'], [100, 'SIGKILL']])
  })

  it('leaves alone a lock that is stale, foreign, or held by anything but a Kando browser host', async () => {
    lock(`${os.hostname()}-200`)
    const cases: Processes[] = [
      {},
      { 200: { command: '/browsers/Chrome --user-data-dir=/somewhere/else', parent: 100 }, 100: { command: host, parent: 1 } },
      { 200: { command: chromium(), parent: 100 }, 100: { command: '/usr/bin/some-test-runner', parent: 1 } }
    ]
    for (const processes of cases) {
      const { fake, signals } = table(processes)
      expect(await freeProfile(profile, fake, 50)).toBeNull()
      expect(signals).toEqual([])
    }
  })
})

describe.skipIf(process.platform === 'win32')('systemProcesses', () => {
  it('reads a live process and its parent from ps', async () => {
    expect(systemProcesses.alive(process.pid)).toBe(true)
    expect(await systemProcesses.command(process.pid)).toContain('node')
    expect(await systemProcesses.parent(process.pid)).toBe(process.ppid)
    expect(await systemProcesses.command(2 ** 22 + 7)).toBeNull()
  })
})
