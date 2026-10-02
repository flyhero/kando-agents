import { z } from 'zod'

export const COMPUTER_AWAKE_MODES = ['on', 'auto', 'off'] as const
export const ComputerAwakeMode = z.enum(COMPUTER_AWAKE_MODES)
export type ComputerAwakeMode = z.infer<typeof ComputerAwakeMode>

export const ComputerAwakeStatus = z.object({
  mode: ComputerAwakeMode,
  active: z.boolean(),
  workingAgents: z.number().int().nonnegative(),
  supported: z.boolean(),
  problem: z.string().nullable()
})
export type ComputerAwakeStatus = z.infer<typeof ComputerAwakeStatus>
