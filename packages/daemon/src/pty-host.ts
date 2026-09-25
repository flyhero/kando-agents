import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import type {
  DaemonEvent,
  DaemonMethod,
  DaemonParsedParams,
  DaemonResult,
  SessionInfo
} from '@kando/protocol/node'
import { commandExists } from './command-lookup'

// Enough for a reattaching UI to repaint recent output; not a full history.
const MAX_SCROLLBACK_CHARS = 512 * 1024

type Session = { id: string; proc: pty.IPty; buffer: string; bufferStart: number; endOffset: number; exitCode: number | null }

export type DaemonHandlers = {
  [M in DaemonMethod]: (params: DaemonParsedParams<M>) => DaemonResult<M>
}

export function createPtyHost(emit: (event: DaemonEvent) => void): {
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
      exitCode: session.exitCode
    }
  }

  const handlers: DaemonHandlers = {
    spawn({ command, args, cwd, env, cols, rows }) {
      const fullEnv = { ...process.env, ...env, TERM: 'xterm-256color' }
      if (!commandExists(command, cwd, fullEnv)) {
        throw new Error('command-not-found')
      }
      const proc = pty.spawn(command, args, { name: 'xterm-256color', cwd, cols, rows, env: fullEnv })
      const session: Session = { id: randomUUID(), proc, buffer: '', bufferStart: 0, endOffset: 0, exitCode: null }
      sessions.set(session.id, session)
      proc.onData((data) => {
        const offset = session.endOffset
        session.endOffset += data.length
        session.buffer = (session.buffer + data).slice(-MAX_SCROLLBACK_CHARS)
        session.bufferStart = session.endOffset - session.buffer.length
        emit({ event: 'data', sessionId: session.id, data, offset })
      })
      proc.onExit(({ exitCode }) => {
        session.exitCode = exitCode
        emit({ event: 'exit', sessionId: session.id, exitCode })
      })
      return { sessionId: session.id }
    },
    write({ sessionId, data }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.proc.write(data)
      }
      return { ok: true }
    },
    resize({ sessionId, cols, rows }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.proc.resize(cols, rows)
      }
      return { ok: true }
    },
    kill({ sessionId }) {
      const session = getSession(sessionId)
      if (session.exitCode === null) {
        session.proc.kill()
      }
      return { ok: true }
    },
    attach({ sessionId }) {
      const session = getSession(sessionId)
      return { ...info(session), buffer: session.buffer, bufferStart: session.bufferStart, endOffset: session.endOffset }
    },
    list() {
      return { sessions: [...sessions.values()].map(info) }
    }
  }

  return {
    handlers,
    killAll() {
      sessions.forEach((session) => {
        if (session.exitCode === null) {
          session.proc.kill()
        }
      })
    }
  }
}
