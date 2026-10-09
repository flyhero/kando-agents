import type { Rectangle, WebContents } from 'electron'
import type { BrowserViewport } from '@kando/protocol'

// Holds the page at a size of its own, or lets it fill its view again. The debugger is the
// tab's (attached by its proxy); deviceScaleFactor 0 keeps the screen's own density.
export async function applyViewport(webContents: WebContents, viewport: BrowserViewport | null): Promise<void> {
  const debug = webContents.debugger
  if (!debug.isAttached()) debug.attach('1.3')
  if (viewport) {
    await debug.sendCommand('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 0, mobile: false })
  } else {
    await debug.sendCommand('Emulation.clearDeviceMetricsOverride')
  }
}

// Where a view held at a size goes within the panel: as large as fits at that aspect, centred,
// so a phone-sized page stands in the middle of a wide panel rather than stretching across it.
export function fitViewport(bounds: Rectangle, viewport: BrowserViewport | null): Rectangle {
  if (!viewport) return bounds
  const scale = Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height)
  const width = Math.round(viewport.width * scale)
  const height = Math.round(viewport.height * scale)
  return { x: bounds.x + Math.round((bounds.width - width) / 2), y: bounds.y + Math.round((bounds.height - height) / 2), width, height }
}
