import { randomUUID } from 'node:crypto'
import type {
  DaemonEvent,
  DaemonMethod,
  DaemonParsedParams,
  DaemonResult,
  SessionInfo,
  SessionIo
} from '@kando/protocol/node'
import { OutputBuffer } from './output-buffer'
import { startPipe } from './pipe-session'
import { startPty } from './pty-session'
import type { AwakeBackendStatus } from './awake-service'
import { SessionPorts } from './session-ports'

// Enough for a reattaching UI to repaint recent output; not a full history.
const PTY_SCROLLBACK_CHARS = 512 * 1024
// JSON lines are replayed into core's own log after a restart, so a pipe keeps more of them.
const PIPE_OUTPUT_CHARS = 8 * 1024 * 1024
const PIPE_STDERR_CHARS = 64 * 1024

// A running process as the registry drives it, whether it sits behind a PTY or plain pipes.
export type HostedProcess = {
  pid?: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(force: boolean): void
}

export type ProcessEvents = {
  output(data: string): void
  errorOutput(data: string): void
  exit(exitCode: number): void
}

type Session = {
  id: string
  io: SessionIo
  process: HostedProcess
  output: OutputBuffer
  stderr: OutputBuffer | null
  exitCode: number | null
  // A browser host: replacing the daemon need not wait for it.
  disposable: boolean
}

export type DaemonHandlers = {
  [M in DaemonMethod]: (params: DaemonParsedParams<M>) => M extends 'portsList' | 'portsStop' ? Promise<DaemonResult<M>> : DaemonResult<M>
}

const NOT_STARTED: HostedProcess = { write() {}, resize() {}, kill() {} }

type AwakeController = {
  set(active: boolean, leaseMs: number): AwakeBackendStatus
  status(): AwakeBackendStatus
}

const NO_AWAKE: AwakeController = {
  set: () => ({ active: false, supported: false, problem: 'awake service unavailable' }),
  status: () => ({ active: false, supported: false, problem: 'awake service unavailable' })
}

// What the daemon is and how it leaves, for info and retire.
type Lifecycle = { version: string; leave(): void }
const NO_LIFECYCLE: Lifecycle = { version: '0.0.0', leave() {} }

// The browser host is core's to start again whenever it needs one, so it keeps no daemon from
// being replaced; anything else running does (an agent, a shell in the terminal panel).
function disposable(launch: { args: readonly string[] }): boolean {
  return launch.args.some((arg) => /(^|\/)browser-host(\.mjs|\/src\/main\.ts)$/.test(arg))
}

export function createSessionHost(emit: (event: DaemonEvent) => void, awake: AwakeController = NO_AWAKE, lifecycle: Lifecycle = NO_LIFECYCLE): {
  handlers: DaemonHandlers
  killAll(): void
} {
  const sessions = new Map<string, Session>()
  const ports = new SessionPorts(() => [...sessions.values()].flatMap((session) => session.exitCode === null && session.process.pid !== undefined
    ? [{ sessionId: session.id, pid: session.process.pid, canStopRoot: session.io === 'pty' }]
    : []))

  function getSession(sessionId: string): Session {
    const session = sessions.get(sessionId)
    if (!session) {
      throw new Error('session-not-found')
    }
    return session
  }

  function info(session: Session): SessionInfo {
    return {
      sessionId: session.id,
      exited: session.exitCode !== null,
      exitCode: session.exitCode,
      io: session.io
    }
  }

  function track(io: SessionIo, start: (events: ProcessEvents) => HostedProcess, isDisposable = false): { sessionId: string } {
    const output = new OutputBuffer(io === 'pty' ? PTY_SCROLLBACK_CHARS : PIPE_OUTPUT_CHARS)
    const stderr = io === 'pipe' ? new OutputBuffer(PIPE_STDERR_CHARS) : null
    const session: Session = { id: randomUUID(), io, process: NOT_STARTED, output, stderr, exitCode: null, disposable: false }
    session.disposable = isDisposable
    const sessionId = session.id
    sessions.set(sessionId, session)
    try {
      session.process = start({
        output: (data) => emit({ event: 'data', sessionId, data, offset: output.append(data) }),
        errorOutput: (data) => {
          stderr?.append(data)
          emit({ event: 'stderr', sessionId, data })
        },
        exit: (exitCode) => {
          session.exitCode = exitCode
          emit({ event: 'exit', sessionId, exitCode })
        }
      })
    } catch (error) {
      sessions.delete(sessionId)
      throw error
    }
    return { sessionId }
  }

  const handlers: DaemonHandlers = {
    portsList: () => ports.list(),
    async portsStop(ref) {
      await ports.stop(ref)
      return { ok: true }
    },
    spawn({ cols, rows, ...launch }) {
      return track('pty', (events) => startPty(launch, cols, rows, events))
    },
    spawnPipe(launch) {
      return track('pipe', (events) => startPipe(launch, events), disposable(launch))
    },
    write({ sessionId, data }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.process.write(data)
      }
      return { ok: true }
    },
    resize({ sessionId, cols, rows }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.process.resize(cols, rows)
      }
      return { ok: true }
    },
    kill({ sessionId, force }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.process.kill(force ?? false)
      }
      return { ok: true }
    },
    attach({ sessionId }) {
      const session = getSession(sessionId)
      return {
        ...info(session),
        ...session.output.snapshot(),
        ...(session.stderr ? { stderr: session.stderr.snapshot().buffer } : {})
      }
    },
    list() {
      return { sessions: [...sessions.values()].map(info) }
    },
    release({ sessionId }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        throw new Error('session-running')
      }
      sessions.delete(sessionId)
      return { ok: true }
    },
    awakeSet({ active, leaseMs }) {
      return awake.set(active, leaseMs)
    },
    awakeStatus() {
      return awake.status()
    },
    info() {
      return { version: lifecycle.version, pid: process.pid }
    },
    retire() {
      const live = [...sessions.values()].filter((session) => session.exitCode === null && !session.disposable).length
      // After the answer has gone out.
      if (live === 0) setTimeout(() => lifecycle.leave(), 50)
      return { retired: live === 0, live }
    }
  }

  return {
    handlers,
    killAll() {
      sessions.forEach((session) => {
        if (session.exitCode === null) {
          session.process.kill(false)
        }
      })
    }
  }
}
