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

// node-pty on macOS and Linux reports a missing program only as exit code 1 with no output,
// so a spawn looks the command up first. Windows also tries each PATHEXT extension.
export function commandExists(command: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return executable(path.resolve(cwd, command))
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : ['']
  return dirs.some((dir) => extensions.some((extension) => executable(path.join(dir, command + extension))))
}
