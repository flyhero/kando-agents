import type { LoginNotice, LoginPrompt, SettingField, SourceIssue } from '@kando/protocol'

// The seam a task source plugs into. Core owns everything around it (settings and credential
// storage, polling, the inbox, turning issues into tasks); a provider only talks to its tracker.
// Everything a provider returns is checked again by core before it is used.

export type SourceSettings = Readonly<Record<string, string>>

// Opaque to core: whatever the provider needs to authenticate, stored per instance.
export type SourceCredential = { kind: string; payload: Readonly<Record<string, string>> }

// All a sign-in flow may do with the user. Clients render these, never provider-made UI.
export type LoginSession = {
  prompt(prompt: LoginPrompt): Promise<string>
  notify(notice: LoginNotice): void
}

export type SourceIssueDetail = SourceIssue & {
  // The issue's own text, converted by the provider; it reaches agents only as untrusted data.
  markdown: string
  // The issue's images as fetched; core checks each one and stores what passes.
  images?: readonly { name: string; bytes: Uint8Array }[]
}

export type SourceProvider = {
  readonly id: string
  readonly name: string
  readonly settings: readonly SettingField[]
  // Checks and canonicalizes settings before they are saved; throws SourceError('invalid-settings').
  normalizeSettings(values: SourceSettings): Record<string, string>
  // Lets users type a key loosely (lower case, spaces); core validates the result.
  normalizeKey?(key: string): string
  // A credential from the environment, for machines without a UI; applies to the default instance.
  envCredential?(env: NodeJS.ProcessEnv): SourceCredential | null
  // Asks the user through `session` and returns only a credential it has verified.
  login(
    session: LoginSession,
    settings: SourceSettings,
    signal: AbortSignal
  ): Promise<{ credential: SourceCredential; account: string }>
  list(settings: SourceSettings, credential: SourceCredential, signal: AbortSignal): Promise<SourceIssue[]>
  fetch(settings: SourceSettings, credential: SourceCredential, key: string, signal: AbortSignal): Promise<SourceIssueDetail>
}
