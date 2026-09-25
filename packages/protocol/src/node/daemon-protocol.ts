import { z } from 'zod'

// Newline-delimited JSON over a Unix socket / named pipe between core and the PTY daemon.
export const DAEMON_PROTOCOL_VERSION = 2

const SessionRef = z.object({ sessionId: z.string() })
const Ok = z.object({ ok: z.literal(true) })
const SessionInfo = z.object({
  sessionId: z.string(),
  exited: z.boolean(),
  exitCode: z.number().nullable()
})
export type SessionInfo = z.infer<typeof SessionInfo>

export const daemonMethods = {
  spawn: {
    params: z.object({
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      env: z.record(z.string(), z.string()),
      cols: z.number().int().min(1),
      rows: z.number().int().min(1)
    }),
    result: SessionRef
  },
  write: { params: SessionRef.extend({ data: z.string() }), result: Ok },
  resize: {
    params: SessionRef.extend({ cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: Ok
  },
  kill: { params: SessionRef, result: Ok },
  attach: {
    params: SessionRef,
    result: SessionInfo.extend({ buffer: z.string(), bufferStart: z.number().int(), endOffset: z.number().int() })
  },
  list: { params: z.object({}), result: z.object({ sessions: z.array(SessionInfo) }) }
} as const

export type DaemonMethod = keyof typeof daemonMethods
export type DaemonParams<M extends DaemonMethod> = z.input<(typeof daemonMethods)[M]['params']>
export type DaemonParsedParams<M extends DaemonMethod> = z.output<
  (typeof daemonMethods)[M]['params']
>
export type DaemonResult<M extends DaemonMethod> = z.output<(typeof daemonMethods)[M]['result']>

// Same generic-index narrowing as rpcSchemas.
export const daemonSchemas: {
  [M in DaemonMethod]: {
    params: z.ZodType<DaemonParsedParams<M>>
    result: z.ZodType<DaemonResult<M>>
  }
} = daemonMethods

export function isDaemonMethod(name: string): name is DaemonMethod {
  return Object.hasOwn(daemonMethods, name)
}

export const DaemonRequest = z.object({ id: z.number(), method: z.string(), params: z.unknown() })

export const DaemonEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('data'), sessionId: z.string(), data: z.string(), offset: z.number().int() }),
  z.object({ event: z.literal('exit'), sessionId: z.string(), exitCode: z.number() })
])
export type DaemonEvent = z.infer<typeof DaemonEvent>

// Error before result, for the same missing-key reason as RpcFrame.
export const DaemonInbound = z.union([
  DaemonEvent,
  z.object({ id: z.number(), error: z.string() }),
  z.object({ id: z.number(), result: z.unknown() })
])

export function createLineDecoder(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let rest = ''
  return (chunk) => {
    rest += chunk.toString()
    let index = rest.indexOf('\n')
    while (index !== -1) {
      const line = rest.slice(0, index)
      rest = rest.slice(index + 1)
      if (line.trim() !== '') {
        onLine(line)
      }
      index = rest.indexOf('\n')
    }
  }
}
