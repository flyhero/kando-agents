import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// The file a command runs, or null. Windows also tries each PATHEXT extension.
export function resolveCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    const file = path.resolve(cwd, command)
    return executable(file) ? file : null
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const file = path.join(dir, command + extension)
      if (executable(file)) return file
    }
  }
  return null
}

// node-pty on macOS and Linux reports a missing program only as exit code 1 with no output,
// so a spawn looks the command up first.
export function commandExists(command: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  return resolveCommand(command, cwd, env) !== null
}
