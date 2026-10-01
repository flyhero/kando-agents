import { fileURLToPath } from 'node:url'

// The browser host as a daemon pipe session: the bundled script under Electron's node in a
// packaged app, the source through tsx from a checkout. The same two shapes as cliCommand.
export function browserHostCommand(home: string): string[] {
  const bundled = process.env.KANDO_BROWSER_HOST_JS
  if (bundled) return ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, bundled, '--home', home]
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
  const entry = fileURLToPath(new URL('../../browser-host/src/main.ts', import.meta.url))
  return [process.execPath, '--import', loader, entry, '--home', home]
}
