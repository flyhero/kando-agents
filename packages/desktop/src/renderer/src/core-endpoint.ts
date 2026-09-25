import { CoreEndpoint, PROTOCOL_VERSION } from '@kando/protocol'

// Inside Electron the preload bridge reads core.json; in a plain browser
// (UI preview, future web client) the endpoint comes from ?port=&token=.
export async function resolveCoreEndpoint(): Promise<CoreEndpoint | null> {
  if (window.kando) {
    const parsed = CoreEndpoint.nullable().safeParse(await window.kando.getCoreEndpoint())
    return parsed.success ? parsed.data : null
  }
  const query = new URLSearchParams(window.location.search)
  const port = Number(query.get('port'))
  const token = query.get('token')
  return port && token ? { port, token, pid: 0, protocolVersion: PROTOCOL_VERSION } : null
}
