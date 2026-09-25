// node-pty 1.1.0 ships its macOS prebuilt spawn-helper without the exec bit,
// so every PTY spawn fails with "posix_spawnp failed". Other platforms don't use it.
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

if (process.platform === 'darwin') {
  const require = createRequire(new URL('../packages/daemon/package.json', import.meta.url))
  const root = path.dirname(require.resolve('node-pty/package.json'))
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = path.join(root, 'prebuilds', arch, 'spawn-helper')
    if (existsSync(helper)) {
      chmodSync(helper, 0o755)
    }
  }
}
