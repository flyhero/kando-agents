import { useEffect, useRef } from 'react'
import { useCore } from '../core-store'
import { createTerminalSurface } from './terminal-surface'

const ignore = () => {}

export function ConversationTranscript({ id, sessionId }: { id: string; sessionId: string | null }) {
  const host = useRef<HTMLDivElement>(null)
  const rpc = useCore((state) => state.rpc)

  useEffect(() => {
    const element = host.current
    if (!element || !rpc) return
    const surface = createTerminalSurface(element, rpc, sessionId)
    const { term, sendSize } = surface
    let disposed = false
    let attached = false
    let cursor = 0
    const queued: Array<{ offset: number; data: string }> = []
    const write = (text: string) => new Promise<void>((resolve) => term.write(text, resolve))
    const writeAt = (offset: number, data: string) => {
      const skip = Math.max(0, cursor - offset)
      if (skip < data.length) {
        term.write(data.slice(skip))
        cursor = offset + data.length
      }
    }
    const stopData = sessionId ? rpc.on('sessions.data', (event) => {
      if (event.sessionId !== sessionId || disposed) return
      if (!attached) queued.push({ offset: event.offset, data: event.data })
      else writeAt(event.offset, event.data)
    }) : ignore
    const stopExit = sessionId ? rpc.on('sessions.exit', (event) => {
      if (event.sessionId === sessionId) term.write(`\r\n[agent 已退出，code ${event.exitCode}]\r\n`)
    }) : ignore
    const input = sessionId ? term.onData((data) => void rpc.call('sessions.write', { sessionId, data }).catch(ignore)) : null

    void (async () => {
      let offset = 0
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await rpc.call('conversations.history', { id, offset, length: 65536 })
        if (disposed) return
        const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0))
        await write(decoder.decode(bytes, { stream: chunk.nextOffset < chunk.totalBytes }))
        offset = chunk.nextOffset
        cursor = chunk.sessionOffset
        if (offset >= chunk.totalBytes) break
      }
      if (!sessionId || disposed) return
      const snapshot = await rpc.call('sessions.attach', { sessionId, fromOffset: cursor })
      if (disposed) {
        void rpc.call('sessions.detach', { sessionId }).catch(ignore)
        return
      }
      writeAt(snapshot.bufferStart, snapshot.buffer)
      queued.sort((a, b) => a.offset - b.offset).forEach((event) => writeAt(event.offset, event.data))
      queued.length = 0
      attached = true
      sendSize()
      term.focus()
    })().catch((error: unknown) => { if (!disposed) term.write(`\r\n[无法读取会话：${String(error)}]\r\n`) })

    return () => {
      disposed = true
      input?.dispose()
      stopData()
      stopExit()
      surface.dispose()
      if (sessionId && attached) void rpc.call('sessions.detach', { sessionId }).catch(ignore)
    }
  }, [rpc, id, sessionId])

  return <div className="terminal-frame"><div className="terminal" ref={host} /></div>
}
