import type { DaemonEvent, DaemonMethod, DaemonParams, DaemonResult } from '@kando/protocol/node'
import type { SessionHost } from './daemon-client'

type PipeSession = { output: string; exitCode: number | null; stderr: string; io: 'pty' | 'pipe' }

// For tests: a daemon whose pipe sessions answer like Claude Code in stream-json mode (its PTY
// sessions stay silent). Events go to `deliver`, which a test points at whatever handles them.
// A catalog as Claude Code lists it: the default and two others, one of them without efforts.
const FAKE_MODELS = [
  { value: 'default', resolvedModel: 'claude-sonnet-5', displayName: 'Default', supportedEffortLevels: ['low', 'high'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku' }
]

export function fakeChatDaemon() {
  const sessions = new Map<string, PipeSession>()
  const writes: Array<{ sessionId: string; frame: unknown }> = []
  const spawns: DaemonParams<'spawnPipe'>[] = []
  const ptySpawns: DaemonParams<'spawn'>[] = []
  const killed: Array<{ sessionId: string; force: boolean }> = []
  const released: string[] = []

  const fake = {
    sessions,
    writes,
    spawns,
    ptySpawns,
    killed,
    released,
    deliver: (_event: DaemonEvent) => {},
    // Whether a new session answers the initialize request by itself.
    answerInit: true,
    // A stubborn process lets stop-sequence tests observe escalation before ending it explicitly.
    exitOnKill: true,
    // What a session prints for each user message; by default a reply and a finished turn.
    reply: (sessionId: string, text: string) => {
      fake.emit(sessionId, { type: 'assistant', uuid: `uuid-${text}`, message: { id: `msg-${text}`, content: [{ type: 'text', text: `echo: ${text}` }] }, parent_tool_use_id: null })
      fake.emit(sessionId, { type: 'result', subtype: 'success', is_error: false, result: `echo: ${text}`, terminal_reason: 'completed', duration_ms: 5 })
    },
    emit(sessionId: string, frame: unknown): void {
      fake.print(sessionId, `${JSON.stringify(frame)}\n`)
    },
    // Output as it comes, frame or not.
    print(sessionId: string, data: string): void {
      const session = sessions.get(sessionId)
      if (!session || session.exitCode !== null) return
      const offset = session.output.length
      session.output += data
      fake.deliver({ event: 'data', sessionId, data, offset })
    },
    exit(sessionId: string, exitCode: number): void {
      const session = sessions.get(sessionId)
      if (!session || session.exitCode !== null) return
      session.exitCode = exitCode
      fake.deliver({ event: 'exit', sessionId, exitCode })
    },
    written(sessionId: string): unknown[] {
      return writes.filter((write) => write.sessionId === sessionId).map((write) => write.frame)
    }
  }

  const handlers: { [M in DaemonMethod]: (params: DaemonParams<M>) => DaemonResult<M> } = {
    portsList: () => [],
    portsStop: () => ({ ok: true }),
    awakeSet: () => ({ active: false, supported: true, problem: null }),
    awakeStatus: () => ({ active: false, supported: true, problem: null }),
    info: () => ({ version: '0.0.0', pid: process.pid }),
    retire: () => ({ retired: false, live: 0 }),
    spawn: (params) => {
      ptySpawns.push(params)
      const sessionId = `pty-${ptySpawns.length}`
      sessions.set(sessionId, { output: '', exitCode: null, stderr: '', io: 'pty' })
      return { sessionId }
    },
    spawnPipe: (params) => {
      spawns.push(params)
      const sessionId = `pipe-${spawns.length}`
      sessions.set(sessionId, { output: '', exitCode: null, stderr: '', io: 'pipe' })
      return { sessionId }
    },
    write: ({ sessionId, data }) => {
      for (const line of data.split('\n').filter(Boolean)) {
        const frame: unknown = JSON.parse(line)
        writes.push({ sessionId, frame })
        const text = JSON.stringify(frame)
        if (text.includes('"subtype":"initialize"') && fake.answerInit) {
          queueMicrotask(() => fake.emit(sessionId, { type: 'control_response', response: { subtype: 'success', request_id: 'kando-init', response: { models: FAKE_MODELS } } }))
        }
        // A mode switch is taken as Claude takes it: acknowledged, then reported.
        const switched = /"request_id":"(kando-option-\d+)","request":\{"subtype":"set_permission_mode","mode":"(\w+)"/.exec(text)
        if (switched) {
          const [, requestId, mode] = switched
          queueMicrotask(() => {
            fake.emit(sessionId, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { mode } } })
            fake.emit(sessionId, { type: 'system', subtype: 'status', status: null, permissionMode: mode })
          })
        }
        const user = typeof frame === 'object' && frame !== null && Reflect.get(frame, 'type') === 'user'
        if (user) {
          const content = String(Reflect.get(Reflect.get(frame, 'message'), 'content'))
          queueMicrotask(() => fake.reply(sessionId, content))
        }
      }
      return { ok: true }
    },
    resize: () => ({ ok: true }),
    kill: ({ sessionId, force }) => {
      killed.push({ sessionId, force: force ?? false })
      if (fake.exitOnKill) queueMicrotask(() => fake.exit(sessionId, force ? 137 : 143))
      return { ok: true }
    },
    attach: ({ sessionId }) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session-not-found')
      return {
        sessionId,
        exited: session.exitCode !== null,
        exitCode: session.exitCode,
        io: session.io,
        buffer: session.output,
        bufferStart: 0,
        endOffset: session.output.length,
        stderr: session.stderr
      }
    },
    list: () => ({
      sessions: [...sessions].map(([sessionId, session]) => ({ sessionId, exited: session.exitCode !== null, exitCode: session.exitCode, io: session.io }))
    }),
    release: ({ sessionId }) => {
      released.push(sessionId)
      return { ok: true }
    }
  }

  const host: SessionHost = {
    request: async (method, params) => handlers[method](params),
    onEvent: () => () => {}
  }
  return Object.assign(fake, host)
}
