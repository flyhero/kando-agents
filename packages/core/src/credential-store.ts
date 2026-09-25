import { z } from 'zod'
import { readJsonIfExists, writePrivateJson } from './private-file'

// A secret a provider signed in with. `payload` is opaque to core: only its provider reads it.
export const CredentialRecord = z.object({
  kind: z.string().max(32),
  payload: z.record(z.string(), z.string()),
  // Who the credential belongs to, as the provider reported it at sign-in.
  account: z.string().max(200).nullable(),
  updatedAt: z.number()
})
export type CredentialRecord = z.infer<typeof CredentialRecord>

const CredentialFile = z.object({ version: z.literal(1), records: z.record(z.string(), CredentialRecord) })

const recordKey = (provider: string, instance: string) => `${provider}/${instance}`

// Records per provider instance in one owner-only file. Configuration elsewhere never holds secrets.
export class CredentialStore {
  private records: Record<string, CredentialRecord> = {}

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readJsonIfExists(this.file)
      const parsed = raw === undefined ? null : CredentialFile.safeParse(raw)
      if (parsed && !parsed.success) {
        console.error(`[kando-core] ${this.file} is not a credential file; ignoring it until the next sign-in`)
      }
      this.records = parsed?.success ? parsed.data.records : {}
    } catch (error) {
      console.error(`[kando-core] cannot read ${this.file}:`, error instanceof Error ? error.message : error)
      this.records = {}
    }
  }

  get(provider: string, instance: string): CredentialRecord | null {
    return this.records[recordKey(provider, instance)] ?? null
  }

  // Memory changes only once the file does, so a failed write keeps the credential that worked.
  async set(provider: string, instance: string, record: CredentialRecord): Promise<void> {
    const records = { ...this.records, [recordKey(provider, instance)]: record }
    await writePrivateJson(this.file, { version: 1, records })
    this.records = records
  }

  async delete(provider: string, instance: string): Promise<void> {
    const { [recordKey(provider, instance)]: _removed, ...records } = this.records
    await writePrivateJson(this.file, { version: 1, records })
    this.records = records
  }
}
