import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { AwakeService } from './awake-service'

const services: AwakeService[] = []

afterEach(() => services.splice(0).forEach((service) => service.dispose()))

describe('awake assertion', () => {
  it('holds a child process only while the lease is active', () => {
    const launches: Array<{ file: string; args: string[] }> = []
    const service = new AwakeService('darwin', (file, args) => {
      launches.push({ file, args })
      return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'ignore', 'ignore'] })
    })
    services.push(service)

    expect(service.set(true, 90_000)).toMatchObject({ active: true, supported: true })
    expect(launches).toEqual([{ file: '/usr/bin/caffeinate', args: ['-i', '-s'] }])
    expect(service.set(false, 90_000)).toMatchObject({ active: false, supported: true })
  })

  it('reports an unsupported platform without launching anything', () => {
    let launched = false
    const service = new AwakeService('aix', () => {
      launched = true
      return spawn(process.execPath)
    })
    services.push(service)

    expect(service.set(true, 90_000)).toEqual({ active: false, supported: false, problem: 'unsupported platform: aix' })
    expect(launched).toBe(false)
  })
})
