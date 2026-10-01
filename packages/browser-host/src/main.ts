import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { BROWSER_HOST_PROTOCOL_VERSION, kandoHome, kandoPaths } from '@kando/protocol/node'

// The browser host: a daemon pipe session that owns Kando's Chromium. Its stdout carries one
// line, where to connect; everything else goes over that socket, and its log goes to stderr.
const { values } = parseArgs({ options: { home: { type: 'string' } }, strict: true })
const paths = kandoPaths(values.home ? path.resolve(values.home) : kandoHome())

await mkdir(paths.browser, { recursive: true, mode: 0o700 })
await mkdir(paths.browserProfile, { recursive: true, mode: 0o700 })
await mkdir(paths.browserBinaries, { recursive: true })
// playwright-core reads where its browsers live when it loads, so this comes before any import of it.
process.env.PLAYWRIGHT_BROWSERS_PATH = paths.browserBinaries

process.on('unhandledRejection', (error) => console.error('[browser-host] unhandled rejection', error))

const { startBrowserHost } = await import('./host')
const server = await startBrowserHost(paths)
process.stdout.write(`${JSON.stringify({ event: 'listening', port: server.port, token: server.token, pid: process.pid, protocolVersion: BROWSER_HOST_PROTOCOL_VERSION })}\n`)
