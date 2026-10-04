import { z } from 'zod'

// A listening process identified again before it can be stopped; a port number alone is not an identity.
export const PortRef = z.object({
  sessionId: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  address: z.string().min(1)
})
export type PortRef = z.infer<typeof PortRef>

export const HostedPort = PortRef.extend({ command: z.string(), canStop: z.boolean(), cwd: z.string().optional() })
export type HostedPort = z.infer<typeof HostedPort>

export const ListeningPort = HostedPort.extend({
  terminalId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  taskId: z.string().nullable(),
  cwd: z.string(),
  label: z.string().nullable()
})
export type ListeningPort = z.infer<typeof ListeningPort>

export const PortList = z.object({ ports: z.array(ListeningPort), problem: z.string().nullable() })
export type PortList = z.infer<typeof PortList>

export const PortLabels = z.object({ ports: z.array(z.object({ port: z.number().int().min(1).max(65535), label: z.string().trim().min(1).max(80) })).max(200) })
