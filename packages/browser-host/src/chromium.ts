import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { chromium } from 'playwright-core'

// Whether the Chromium build under PLAYWRIGHT_BROWSERS_PATH is there to launch.
export function chromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

// The percentage a download line reports, or null for a line that reports none.
export function installPercent(line: string): number | null {
  const match = /(\d{1,3})%/.exec(line)
  if (!match) return null
  const percent = Number(match[1])
  return percent >= 0 && percent <= 100 ? percent : null
}

// Downloads Chromium with playwright-core's own installer in a child, so a crash there never
// takes the host. Under Electron's node the child needs the same run-as-node flag the host got.
export function installChromium(onPercent: (percent: number) => void): Promise<void> {
  // cli.js is the package's bin, not an export, so it is found beside its package.json.
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'cli.js')
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium', '--no-shell'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const tail: string[] = []
    const read = (chunk: string) => {
      for (const line of chunk.split(/\r?\n|\r/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 20) tail.shift()
        const percent = installPercent(line)
        if (percent !== null) onPercent(percent)
      }
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && chromiumInstalled()) resolve()
      else reject(new Error(tail.slice(-5).join('\n') || `installer exited with ${code}`))
    })
  })
}
