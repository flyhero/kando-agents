import { fileURLToPath } from 'node:url'

// How an agent starts Kando's MCP server (mcp-main.ts). From source it goes through the
// workspace's tsx; packaged, the launcher names the bundled mcp.mjs, run by the Electron binary as
// plain Node. The env wrapper states the flag outright because an agent's environment lacks it
// (POSIX only, like the dmg).
export function mcpCommand(...args: string[]): string[] {
  const bundled = process.env.KANDO_MCP_JS
  if (bundled) {
    return ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, bundled, ...args]
  }
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
  const entry = fileURLToPath(new URL('./mcp-main.ts', import.meta.url))
  return [process.execPath, '--import', loader, entry, ...args]
}
