import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { WebContents } from 'electron'
import { WebSocketServer, WebSocket } from 'ws'

export type TabProxy = {
  // Where Playwright connects (connectOverCDP); the token is in the path, known only to this process.
  endpoint: string
  close(): void
}

type Frame = { id?: number; method?: string; params?: unknown; sessionId?: string }

// A CDP endpoint for one tab: Playwright sees a browser holding exactly that page, so it can
// drive the tab with its own protocol while the app's windows and other tabs stay out of reach.
// Browser-level methods are answered here; page-level ones go to the tab's debugger, child
// sessions (a cross-site frame) included. The app itself opens no debugging port.
export async function startTabProxy(webContents: WebContents): Promise<TabProxy> {
  const debug = webContents.debugger
  if (!debug.isAttached()) debug.attach('1.3')
  // Playwright takes a page's target to be its main frame, so the id must be Chromium's own.
  const real = await debug.sendCommand('Target.getTargetInfo')
  const targetId: string = real.targetInfo.targetId
  const rootSession = `kando-tab-${webContents.id}`
  const token = randomBytes(16).toString('hex')
  let client: WebSocket | null = null
  const send = (frame: unknown) => {
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(frame))
  }
  const targetInfo = () => ({
    targetId,
    type: 'page',
    title: webContents.getTitle(),
    url: webContents.getURL(),
    attached: true,
    canAccessOpener: false,
    browserContextId: 'kando'
  })
  const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
    send({ method, params, sessionId: sessionId || rootSession })
  }
  debug.on('message', onMessage)

  const browserLevel = (id: number, method: string): void => {
    switch (method) {
      case 'Browser.getVersion':
        send({ id, result: { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '', userAgent: webContents.getUserAgent(), jsVersion: process.versions.v8 } })
        return
      case 'Target.setAutoAttach':
        send({ id, result: {} })
        send({ method: 'Target.attachedToTarget', params: { sessionId: rootSession, targetInfo: targetInfo(), waitingForDebugger: false } })
        return
      case 'Target.getBrowserContexts':
        send({ id, result: { browserContextIds: [] } })
        return
      case 'Target.getTargets':
        send({ id, result: { targetInfos: [targetInfo()] } })
        return
      case 'Target.getTargetInfo':
        send({ id, result: { targetInfo: targetInfo() } })
        return
      case 'Browser.setDownloadBehavior':
      case 'Target.setDiscoverTargets':
      case 'Browser.close':
        send({ id, result: {} })
        return
      default:
        send({ id, error: { code: -32601, message: `${method} is not available on a Kando tab` } })
    }
  }

  const server: Server = createServer((request, response) => {
    if (request.url === '/json/version' || request.url === '/json/version/') {
      const { port } = addressOf(server)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ Browser: `Chrome/${process.versions.chrome}`, 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${token}` }))
      return
    }
    response.statusCode = 404
    response.end()
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== `/devtools/browser/${token}`) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      client?.close()
      client = ws
      ws.on('message', (data) => {
        let frame: Frame
        try {
          frame = JSON.parse(data.toString())
        } catch {
          return
        }
        const { id, method, params, sessionId } = frame
        if (id === undefined || !method) return
        if (!sessionId) {
          browserLevel(id, method)
          return
        }
        debug.sendCommand(method, params ?? {}, sessionId === rootSession ? undefined : sessionId).then(
          (result) => send({ id, sessionId, result }),
          (error: unknown) => send({ id, sessionId, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
        )
      })
      ws.on('close', () => {
        if (client === ws) client = null
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    endpoint: `http://127.0.0.1:${addressOf(server).port}`,
    close: () => {
      debug.off('message', onMessage)
      client?.close()
      wss.close()
      server.close()
      try {
        if (debug.isAttached()) debug.detach()
      } catch {
        // The page is already gone.
      }
    }
  }
}

function addressOf(server: Server): { port: number } {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('tab proxy has no port')
  return address
}
