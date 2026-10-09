// core.log is core's stdout and stderr, which carry no time of their own. Each line says when it
// was written, so a failure can be matched to the restart or the click behind it.
export function timestampConsole(now: () => Date = () => new Date()): void {
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const write = console[method].bind(console)
    console[method] = (...args: unknown[]) => write(localTime(now()), ...args)
  }
}

// Local time as the user reads a clock, to the millisecond: 2026-10-09 16:13:16.512.
export function localTime(at: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
}
