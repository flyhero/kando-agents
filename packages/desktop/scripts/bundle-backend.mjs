// Bundles daemon, core, Kando's MCP server and the browser host into out/backend for a packaged app: one ESM
// file each, run by Electron's binary as plain Node (ELECTRON_RUN_AS_NODE), so users need no Node
// install. node-pty stays external — its prebuilt binding is copied beside the bundles — and so
// does playwright-core, which finds its driver and browser list beside its own package.json.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const desktop = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const repo = path.resolve(desktop, '../..')
const out = path.join(desktop, 'out', 'backend')

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// Some bundled CJS dependencies call require() at runtime; give the ESM output one.
const banner = `import { createRequire as __kandoRequire } from 'node:module';\nconst require = __kandoRequire(import.meta.url);\n`

for (const [name, entry] of [
  ['daemon', 'packages/daemon/src/main.ts'],
  ['core', 'packages/core/src/main.ts'],
  ['mcp', 'packages/core/src/mcp-main.ts'],
  ['browser-host', 'packages/browser-host/src/main.ts']
]) {
  await build({
    entryPoints: [path.join(repo, entry)],
    outfile: path.join(out, `${name}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node-pty', 'playwright-core'],
    banner: { js: banner },
    logLevel: 'warning'
  })
}

// The prebuilt binding next to the bundles, where `import 'node-pty'` resolves it. Only the
// macOS prebuilds: the dmg is a macOS artifact, and the rest is 50MB of other platforms.
const requireDaemon = createRequire(path.join(repo, 'packages/daemon/package.json'))
const ptyRoot = path.dirname(requireDaemon.resolve('node-pty/package.json'))
const ptyOut = path.join(out, 'node_modules', 'node-pty')
for (const piece of ['package.json', 'lib', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64']) {
  const from = path.join(ptyRoot, piece)
  if (existsSync(from)) cpSync(from, path.join(ptyOut, piece), { recursive: true })
}
// node-pty ships its spawn-helper without the exec bit (see scripts/fix-node-pty-spawn-helper.mjs).
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = path.join(ptyOut, 'prebuilds', arch, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}

// playwright-core as it is on npm, minus its type declarations; Chromium itself is downloaded
// into ~/.kando on first use, never shipped.
const requireHost = createRequire(path.join(repo, 'packages/browser-host/package.json'))
const playwrightRoot = path.dirname(requireHost.resolve('playwright-core/package.json'))
const playwrightOut = path.join(out, 'node_modules', 'playwright-core')
for (const piece of ['package.json', 'index.js', 'index.mjs', 'cli.js', 'browsers.json', 'lib', 'bin', 'ThirdPartyNotices.txt', 'LICENSE']) {
  const from = path.join(playwrightRoot, piece)
  if (existsSync(from)) cpSync(from, path.join(playwrightOut, piece), { recursive: true })
}

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
console.log(`[bundle-backend] daemon, core, mcp and browser-host bundled at ${commit}`)
