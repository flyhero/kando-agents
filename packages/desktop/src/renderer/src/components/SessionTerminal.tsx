import { useEffect, useRef } from 'react'
import { useCore } from '../core-store'
import { createTerminalSurface } from './terminal-surface'

const ignore = () => {}

export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const container = useRef<HTMLDivElement>(null)
  const rpc = useCore((s) => s.rpc)

  useEffect(() => {
    const element = container.current
    if (!element || !rpc) {
      return
    }
    const surface = createTerminalSurface(element, rpc, sessionId)
    const { term, sendSize } = surface
    // Shown full-pane right after a run starts: keystrokes should reach the agent.
    term.focus()

    let disposed = false
    let attached = false
    let cursor = 0
    const queued: Array<{ offset: number; data: string }> = []
    const writeAt = (offset: number, data: string) => {
      const skip = Math.max(0, cursor - offset)
      if (skip < data.length) {
        term.write(data.slice(skip))
        cursor = offset + data.length
      }
    }
    const stopData = rpc.on('sessions.data', (event) => {
      if (event.sessionId !== sessionId || disposed) return
      if (!attached) queued.push(event)
      else writeAt(event.offset, event.data)
    })
    const stopExit = rpc.on('sessions.exit', (event) => {
      if (event.sessionId === sessionId && !disposed) term.write(`\r\n\x1b[2m[进程已退出，code ${event.exitCode}]\x1b[0m\r\n`)
    })

    rpc
      .call('sessions.attach', { sessionId })
      .then(({ buffer, bufferStart, exited }) => {
        if (disposed) {
          return
        }
        writeAt(bufferStart, buffer)
        queued.sort((a, b) => a.offset - b.offset).forEach((event) => writeAt(event.offset, event.data))
        queued.length = 0
        attached = true
        if (exited) {
          term.write('\r\n\x1b[2m[会话已结束]\x1b[0m\r\n')
          return
        }
        sendSize()
      })
      .catch((error: unknown) => {
        term.write(`\r\n[无法连接会话：${error instanceof Error ? error.message : String(error)}]\r\n`)
      })

    const input = term.onData((data) => void rpc.call('sessions.write', { sessionId, data }).catch(ignore))
    return () => {
      disposed = true
      stopData()
      stopExit()
      input.dispose()
      surface.dispose()
      void rpc.call('sessions.detach', { sessionId }).catch(ignore)
    }
  }, [rpc, sessionId])

  // FitAddon sizes rows from the host's box and ignores its padding, so the
  // padding and background live on a frame around a padding-free host.
  return (
    <div className="terminal-frame">
      <div className="terminal" ref={container} />
    </div>
  )
}
