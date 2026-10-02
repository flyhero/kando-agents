import { z } from 'zod'
import { ComputerAwakeMode, type ComputerAwakeMode as ComputerAwakeModeValue } from '@kando/protocol'
import { readJsonIfExists, writePrivateJson } from './private-file'

const AwakeConfig = z.object({ version: z.literal(1), mode: ComputerAwakeMode }).catch({ version: 1, mode: 'off' })

export class AwakeConfigStore {
  private mode: ComputerAwakeModeValue = 'off'

  constructor(private readonly file: string) {}

  async load(): Promise<ComputerAwakeModeValue> {
    this.mode = AwakeConfig.parse(await readJsonIfExists(this.file)).mode
    return this.mode
  }

  async save(mode: ComputerAwakeModeValue): Promise<void> {
    await writePrivateJson(this.file, { version: 1, mode })
    this.mode = mode
  }
}
