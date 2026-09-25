import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { DEFAULT_INSTANCE } from '@kando/protocol'
import type { CredentialStore } from './credential-store'
import { readJsonIfExists } from './private-file'
import type { SourceConfigStore } from './source-config'

const LegacyJiraConfig = z.object({ site: z.string(), email: z.string(), token: z.string(), jql: z.string() })

// The first Jira integration kept site, query and token together in jira.json. They become the
// jira/default instance and its credential record. Safe to repeat: whatever already moved is left
// alone, and jira.json goes only once both halves are in their new files.
export async function migrateLegacyJira(
  legacyFile: string,
  sources: SourceConfigStore,
  credentials: CredentialStore,
  now: () => number = Date.now
): Promise<void> {
  let raw: unknown
  try {
    raw = await readJsonIfExists(legacyFile)
  } catch (error) {
    console.error(`[kando-core] cannot read ${legacyFile}, leaving it in place:`, error instanceof Error ? error.message : error)
    return
  }
  if (raw === undefined) {
    return
  }
  const legacy = LegacyJiraConfig.safeParse(raw)
  if (!legacy.success) {
    console.error(`[kando-core] ${legacyFile} is not a Jira config, leaving it in place`)
    return
  }
  const { site, email, token, jql } = legacy.data
  if (!sources.get('jira', DEFAULT_INSTANCE)) {
    await sources.save({ provider: 'jira', instance: DEFAULT_INSTANCE, enabled: true, settings: { site, jql } })
  }
  if (!credentials.get('jira', DEFAULT_INSTANCE)) {
    await credentials.set('jira', DEFAULT_INSTANCE, { kind: 'basic', payload: { email, token }, account: null, updatedAt: now() })
  }
  // Both writes threw on failure, so reaching here means the token lives in credentials.json now;
  // keeping a second plaintext copy would only widen where it can leak from.
  await rm(legacyFile, { force: true })
}
