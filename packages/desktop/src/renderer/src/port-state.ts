import { useEffect } from 'react'
import { create } from 'zustand'
import type { Conversation, ListeningPort, PortList, RpcConnection, Task, Terminal } from '@kando/protocol'
import { perform, showBrowserPanel, showBrowserTab, useCore } from './core-store'

export const usePorts = create<{ list: PortList; loading: boolean }>()(() => ({ list: { ports: [], problem: null }, loading: true }))

// Poll only while the panel is visible, without overlapping OS scans or applying a disconnected reply.
export function usePortPolling(): void {
  const rpc = useCore((s) => s.rpc)
  const open = useCore((s) => s.portsPanelOpen)
  useEffect(() => {
    if (!rpc) {
      usePorts.setState({ list: { ports: [], problem: null }, loading: true })
      return
    }
    if (!open || !rpc.features.includes('ports')) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const list = await rpc.call('ports.list', {})
        if (live) usePorts.setState({ list, loading: false })
      } catch (error) {
        if (live) usePorts.setState({ list: { ports: [], problem: error instanceof Error ? error.message : String(error) }, loading: false })
      }
      if (live) timer = setTimeout(() => { void poll() }, 2000)
    }
    usePorts.setState({ loading: true })
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [rpc, open])
}

export function portKey(port: Pick<ListeningPort, 'sessionId' | 'pid' | 'startedAt' | 'port' | 'address'>): string {
  return JSON.stringify([port.sessionId, port.pid, port.startedAt, port.port, port.address])
}

export function portUrl(port: Pick<ListeningPort, 'address' | 'port'>): string {
  const address = port.address === '::' ? '::1' : ['*', '0.0.0.0'].includes(port.address) ? '127.0.0.1' : port.address
  const host = address.includes(':') ? `[${address}]` : address
  return `http://${host}:${port.port}/`
}

export function portGroups(ports: readonly ListeningPort[], tasks: Record<string, Task>, conversations: Record<string, Conversation>, terminals: readonly Terminal[]): Array<{ id: string; title: string; conversation: Conversation | undefined; ports: ListeningPort[] }> {
  const groups = new Map<string, { id: string; title: string; conversation: Conversation | undefined; ports: ListeningPort[] }>()
  for (const port of ports) {
    const task = port.taskId ? tasks[port.taskId] : undefined
    const conversation = port.conversationId ? conversations[port.conversationId] : undefined
    const terminal = terminals.find((each) => each.id === port.terminalId)
    const id = port.taskId ?? port.conversationId ?? port.terminalId ?? port.sessionId
    const group = groups.get(id) ?? { id, title: task?.title ?? conversation?.title ?? terminal?.title ?? '终端', conversation, ports: [] }
    group.ports.push(port)
    groups.set(id, group)
  }
  return [...groups.values()]
}

export async function openPort(port: ListeningPort): Promise<void> {
  showBrowserPanel(null)
  const tab = await perform(async (rpc) => {
    const url = portUrl(port)
    const tabs = await rpc.call('browser.watchAll', {})
    const existing = tabs.find((each) => each.url === url && each.conversationId === port.conversationId)
    return existing
      ? rpc.call('browser.userNavigate', { tabId: existing.id, to: { history: 'reload' } })
      : rpc.call('browser.newTab', { ...(port.conversationId ? { conversationId: port.conversationId } : {}), url })
  })
  if (tab) showBrowserTab(tab.id)
}

export async function stopPort(port: ListeningPort): Promise<boolean> {
  const stopped = await perform((rpc) => rpc.call('ports.stop', { sessionId: port.sessionId, pid: port.pid, startedAt: port.startedAt, port: port.port, address: port.address }))
  if (!stopped) return false
  // A process may take a moment to close its sockets; the next scan will show it until it does.
  await refreshPorts(useCore.getState().rpc)
  return true
}

async function refreshPorts(rpc: RpcConnection | null): Promise<void> {
  if (!rpc) return
  const list = await rpc.call('ports.list', {}).catch(() => null)
  if (list && useCore.getState().rpc === rpc) usePorts.setState({ list, loading: false })
}
