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

// Enough for a reattaching UI to repaint recent output; not a full history.
const PTY_SCROLLBACK_CHARS = 512 * 1024
// JSON lines are replayed into core's own log after a restart, so a pipe keeps more of them.
const PIPE_OUTPUT_CHARS = 8 * 1024 * 1024
const PIPE_STDERR_CHARS = 64 * 1024

// A running process as the registry drives it, whether it sits behind a PTY or plain pipes.
export type HostedProcess = {
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
}

export type DaemonHandlers = {
  [M in DaemonMethod]: (params: DaemonParsedParams<M>) => DaemonResult<M>
}

const NOT_STARTED: HostedProcess = { write() {}, resize() {}, kill() {} }

export function createSessionHost(emit: (event: DaemonEvent) => void): {
  handlers: DaemonHandlers
  killAll(): void
} {
  const sessions = new Map<string, Session>()

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

  function track(io: SessionIo, start: (events: ProcessEvents) => HostedProcess): { sessionId: string } {
    const output = new OutputBuffer(io === 'pty' ? PTY_SCROLLBACK_CHARS : PIPE_OUTPUT_CHARS)
    const stderr = io === 'pipe' ? new OutputBuffer(PIPE_STDERR_CHARS) : null
    const session: Session = { id: randomUUID(), io, process: NOT_STARTED, output, stderr, exitCode: null }
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
    spawn({ cols, rows, ...launch }) {
      return track('pty', (events) => startPty(launch, cols, rows, events))
    },
    spawnPipe(launch) {
      return track('pipe', (events) => startPipe(launch, events))
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
