import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

// Newline-delimited JSON over a Unix socket / named pipe between core and the PTY daemon.
export const DAEMON_PROTOCOL_VERSION = 2

const SessionRef = z.object({ sessionId: z.string() })
const Ok = z.object({ ok: z.literal(true) })
// pty: a terminal, for TUIs and shells · pipe: plain stdio, for agents that speak JSON lines
export const SessionIo = z.enum(['pty', 'pipe'])
export type SessionIo = z.infer<typeof SessionIo>
const SessionInfo = z.object({
  sessionId: z.string(),
  exited: z.boolean(),
  exitCode: z.number().nullable(),
  // Older daemons host PTYs only and leave it out.
  io: SessionIo.optional()
})
export type SessionInfo = z.infer<typeof SessionInfo>
const Launch = z.object({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string())
})

export const daemonMethods = {
  spawn: {
    params: Launch.extend({ cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: SessionRef
  },
  // A method of its own rather than a flag on spawn: an older daemon would drop the flag and
  // start a PTY, where this one fails with unknown-method.
  spawnPipe: { params: Launch, result: SessionRef },
  write: { params: SessionRef.extend({ data: z.string() }), result: Ok },
  resize: {
    params: SessionRef.extend({ cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: Ok
  },
  // force skips the polite signal, for a process that ignored it.
  kill: { params: SessionRef.extend({ force: z.boolean().optional() }), result: Ok },
  attach: {
    params: SessionRef,
    result: SessionInfo.extend({
      buffer: z.string(),
      bufferStart: z.number().int(),
      endOffset: z.number().int(),
      // A pipe session's recent stderr: what a CLI says when it fails before its first JSON line.
      stderr: z.string().optional()
    })
  },
  list: { params: z.object({}), result: z.object({ sessions: z.array(SessionInfo) }) },
  // Forgets an exited session and its buffered output, once core has kept what it needs.
  release: { params: SessionRef, result: Ok }
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

// A pipe session's stdout arrives as data, like a PTY's output; stderr is its own event, which
// older cores ignore.
export const DaemonEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('data'), sessionId: z.string(), data: z.string(), offset: z.number().int() }),
  z.object({ event: z.literal('stderr'), sessionId: z.string(), data: z.string() }),
  z.object({ event: z.literal('exit'), sessionId: z.string(), exitCode: z.number() })
])
export type DaemonEvent = z.infer<typeof DaemonEvent>

// Error before result, for the same missing-key reason as RpcFrame.
export const DaemonInbound = z.union([
  DaemonEvent,
  z.object({ id: z.number(), error: z.string() }),
  z.object({ id: z.number(), result: z.unknown() })
])

// A socket hands over bytes in arbitrary chunks, so a character can straddle two of them; decoding
// each chunk alone would garble it and change the text's length, which offsets are counted in.
export function createLineDecoder(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8')
  let rest = ''
  return (chunk) => {
    rest += typeof chunk === 'string' ? chunk : decoder.write(chunk)
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
