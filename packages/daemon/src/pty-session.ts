import * as pty from 'node-pty'
import type { DaemonParsedParams } from '@kando/protocol/node'
import { commandExists } from './command-lookup'
import type { HostedProcess, ProcessEvents } from './session-host'

type Launch = Omit<DaemonParsedParams<'spawn'>, 'cols' | 'rows'>

export function startPty({ command, args, cwd, env }: Launch, cols: number, rows: number, events: ProcessEvents): HostedProcess {
  const fullEnv = { ...process.env, ...env, TERM: 'xterm-256color' }
  if (!commandExists(command, cwd, fullEnv)) {
    throw new Error('command-not-found')
  }
  const proc = pty.spawn(command, args, { name: 'xterm-256color', cwd, cols, rows, env: fullEnv })
  proc.onData(events.output)
  proc.onExit(({ exitCode }) => events.exit(exitCode))
  return {
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    // node-pty refuses a signal name on Windows, where every kill is forceful anyway.
    kill: (force) => (force && process.platform !== 'win32' ? proc.kill('SIGKILL') : proc.kill())
  }
}
