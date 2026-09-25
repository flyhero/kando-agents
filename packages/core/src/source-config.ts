import { z } from 'zod'
import { SourceId } from '@kando/protocol'
import { readJsonIfExists, writePrivateJson } from './private-file'

export const InstanceConfig = z.object({
  provider: SourceId,
  instance: SourceId,
  enabled: z.boolean(),
  settings: z.record(z.string(), z.string())
})
export type InstanceConfig = z.infer<typeof InstanceConfig>

const SourcesFile = z.object({ version: z.literal(1), instances: z.array(InstanceConfig) })

// Which source instances exist and their non-secret settings. Owner-only anyway: a JQL or a site
// name says something about the user's work.
export class SourceConfigStore {
  private instances: InstanceConfig[] = []

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readJsonIfExists(this.file)
      const parsed = raw === undefined ? null : SourcesFile.safeParse(raw)
      if (parsed && !parsed.success) {
        console.error(`[kando-core] ${this.file} is not a sources file; ignoring it until settings are saved`)
      }
      this.instances = parsed?.success ? parsed.data.instances : []
    } catch (error) {
      console.error(`[kando-core] cannot read ${this.file}:`, error instanceof Error ? error.message : error)
      this.instances = []
    }
  }

  list(): readonly InstanceConfig[] {
    return this.instances
  }

  get(provider: string, instance: string): InstanceConfig | null {
    return this.instances.find((entry) => entry.provider === provider && entry.instance === instance) ?? null
  }

  async save(config: InstanceConfig): Promise<void> {
    const others = this.instances.filter((entry) => entry.provider !== config.provider || entry.instance !== config.instance)
    const instances = [...others, config]
    await writePrivateJson(this.file, { version: 1, instances })
    this.instances = instances
  }
}
