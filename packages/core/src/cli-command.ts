import { fileURLToPath } from 'node:url'

// How core tells another process to run the Kando CLI: agents run it as their event callbacks
// and as the refine MCP server. From source it goes through the workspace's tsx; packaged, the
// launcher names the bundled cli.mjs, run by the Electron binary as plain Node. The env wrapper
// states the flag outright because an agent's environment lacks it (POSIX only, like the dmg).
export function cliCommand(...args: string[]): string[] {
  const bundled = process.env.KANDO_CLI_JS
  if (bundled) {
    return ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, bundled, ...args]
  }
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
  const cli = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
  return [process.execPath, '--import', loader, cli, ...args]
}
