import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { SessionPorts } from './session-ports'

describe('live session ports', () => {
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('discovers and stops a child HTTP server, leaving its session and other servers alive', async () => {
    const foreign = createServer()
    foreign.listen(0, '127.0.0.1')
    await once(foreign, 'listening')
    const server = "const http=require('node:http');const s=http.createServer((q,r)=>r.end('kando-port-test'));s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:s.address().port})))"
    const root = spawn(process.execPath, ['-e', `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{stdio:['ignore','pipe','inherit']});c.stdout.pipe(process.stdout);process.on('SIGTERM',()=>{c.kill();process.exit()});setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let childPid: number | null = null
    try {
      const announced = await new Promise<{ pid: number; port: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('HTTP server never started')), 5000)
        let text = ''
        root.stdout.setEncoding('utf8')
        root.stdout.on('data', (chunk: string) => {
          text += chunk
          if (!text.includes('\n')) return
          clearTimeout(timeout)
          const result: unknown = JSON.parse(text.split('\n')[0] ?? '')
          if (typeof result === 'object' && result !== null && 'pid' in result && typeof result.pid === 'number' && 'port' in result && typeof result.port === 'number') resolve({ pid: result.pid, port: result.port })
          else reject(new Error('invalid server announcement'))
        })
        root.once('error', reject)
      })
      childPid = announced.pid
      if (!root.pid) throw new Error('no session pid')
      const rootPid = root.pid
      const service = new SessionPorts(() => [{ sessionId: 'test-session', pid: rootPid, canStopRoot: false }])
      const ports = await service.list()
      const port = ports.find((each) => each.port === announced.port && each.pid === announced.pid)
      expect(port).toMatchObject({ sessionId: 'test-session', canStop: true, cwd: process.cwd() })
      expect(ports.every((each) => each.sessionId === 'test-session' && each.pid !== process.pid)).toBe(true)
      expect(await (await fetch(`http://127.0.0.1:${announced.port}`)).text()).toBe('kando-port-test')
      if (!port) throw new Error('port was not discovered')
      await service.stop(port)
      await expect.poll(async () => (await service.list()).some((each) => each.pid === announced.pid), { timeout: 5000 }).toBe(false)
      expect(() => process.kill(rootPid, 0)).not.toThrow()
      expect(foreign.listening).toBe(true)
    } finally {
      if (childPid) { try { process.kill(childPid, 'SIGTERM') } catch {} }
      root.kill('SIGTERM')
      await new Promise<void>((resolve) => foreign.close(() => resolve()))
    }
  }, 20_000)
})
