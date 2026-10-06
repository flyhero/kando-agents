import { z } from 'zod'
import type { ApprovalChoice, ApprovalGrant, ApprovalScope, ChatDecision } from '@kando/protocol'
import { commandPrefixes } from './command-rules'

// Where Claude writes a permission update: session lasts the CLI's run, as does a cliArg one.
const CLAUDE_SCOPES: Record<string, ApprovalScope> = {
  session: 'run',
  cliArg: 'run',
  localSettings: 'local',
  projectSettings: 'project',
  userSettings: 'user'
}

const ClaudeUpdate = z.looseObject({
  type: z.string(),
  destination: z.string().optional(),
  behavior: z.enum(['allow', 'deny', 'ask']).optional().catch(undefined),
  rules: z.array(z.looseObject({ toolName: z.string(), ruleContent: z.string().optional() })).optional().catch(undefined),
  mode: z.string().optional(),
  directories: z.array(z.string()).optional().catch(undefined)
})

// What Claude's suggested permission updates would do, read as Claude writes them; one it does not
// describe in a way Kando knows still counts, as other, so the card never makes it look like less.
// modes: Claude's permission modes by Kando's names.
export function claudeGrants(suggestions: readonly unknown[], modes: Readonly<Record<string, string>>): ApprovalGrant[] {
  return suggestions.map((suggestion): ApprovalGrant => {
    const parsed = ClaudeUpdate.safeParse(suggestion)
    if (!parsed.success) return { kind: 'other', values: [], scope: 'run', behavior: 'allow' }
    const update = parsed.data
    const scope = CLAUDE_SCOPES[update.destination ?? ''] ?? 'run'
    if ((update.type === 'addRules' || update.type === 'replaceRules') && update.rules) {
      const values = update.rules.map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName))
      return { kind: 'rules', values, scope, behavior: update.behavior ?? 'allow' }
    }
    if (update.type === 'setMode' && update.mode) return { kind: 'mode', values: [modes[update.mode] ?? update.mode], scope, behavior: 'allow' }
    if (update.type === 'addDirectories' && update.directories) return { kind: 'directories', values: update.directories, scope, behavior: 'allow' }
    return { kind: 'other', values: [], scope, behavior: 'allow' }
  })
}

// What a Bash call is remembered by, in Claude's own permission update: Kando's short rules (see
// command-rules) for this project's local settings, in place of Claude's suggestion, which is the
// command whole; none for a command that may not be remembered.
export function claudeBashRules(command: string): unknown[] {
  const prefixes = commandPrefixes(command)
  if (!prefixes) return []
  return [{
    type: 'addRules',
    // As Claude Code writes its own: the words, then a wildcard for whatever follows.
    rules: prefixes.map((words) => ({ toolName: 'Bash', ruleContent: `${words.join(' ')} *` })),
    behavior: 'allow',
    destination: 'localSettings'
  }]
}

// Claude's answers to a tool call: once, with what it suggests remembering when it suggests
// anything, or no.
export function claudeChoices(grants: readonly ApprovalGrant[]): ApprovalChoice[] {
  return [
    { id: 'allow', decision: 'allow', grants: [] },
    ...(grants.length ? [{ id: 'allowForSession', decision: 'allowForSession' as const, grants: [...grants] }] : []),
    { id: 'deny', decision: 'deny', grants: [] }
  ]
}

const ExecPolicy = z.looseObject({ acceptWithExecpolicyAmendment: z.looseObject({ execpolicy_amendment: z.array(z.string()) }) })
const NetworkPolicy = z.looseObject({
  applyNetworkPolicyAmendment: z.looseObject({
    network_policy_amendment: z.looseObject({ host: z.string(), action: z.enum(['allow', 'deny']) })
  })
})

// A Codex answer as it is sent back, with Kando's choice for it.
export type CodexChoice = ApprovalChoice & { raw: unknown }

// Codex's answers in the order it lists them, each sent back exactly as listed: once, the same
// command or files again this run, commands starting the same way from now on (Codex keeps those
// in its rules), a host let through or kept out. Of decline and cancel, only the one that stands
// for no. Older servers list none: then once, this run, and no. what: the command, or the files.
// Commands starting the same way are remembered by Kando's own short prefix (command-rules), sent
// in place of Codex's, which is the command word for word; when the command has no single prefix
// to keep, that answer is not offered.
export function codexChoices(
  available: readonly unknown[] | null | undefined,
  what: { kind: 'command' | 'files'; values: readonly string[] },
  denial: 'decline' | 'cancel'
): CodexChoice[] {
  const prefixes = what.kind === 'command' && what.values[0] ? commandPrefixes(what.values[0]) : null
  const prefix = prefixes?.length === 1 ? prefixes[0] : undefined
  const listed = available ?? ['accept', 'acceptForSession', denial]
  // No is always an answer, whatever the list says.
  return [...listed, ...(listed.includes(denial) ? [] : [denial])].flatMap((raw): CodexChoice[] => {
    if (raw === 'accept') return [{ id: 'accept', decision: 'allow', grants: [], raw }]
    if (raw === 'acceptForSession') {
      const grant: ApprovalGrant = { kind: what.kind, values: [...what.values], scope: 'run', behavior: 'allow' }
      return [{ id: 'acceptForSession', decision: 'allowForSession', grants: [grant], raw }]
    }
    if (raw === denial) return [{ id: denial, decision: 'deny', grants: [], raw }]
    const exec = ExecPolicy.safeParse(raw)
    if (exec.success) {
      if (!prefix) return []
      const ours = { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } }
      return [{ id: 'execpolicy', decision: 'allowForSession', grants: [{ kind: 'prefix', values: prefix, scope: 'agent', behavior: 'allow' }], raw: ours }]
    }
    const network = NetworkPolicy.safeParse(raw)
    if (network.success) {
      const { host, action } = network.data.applyNetworkPolicyAmendment.network_policy_amendment
      const decision: ChatDecision = action === 'deny' ? 'deny' : 'allowForSession'
      return [{ id: `network:${action}:${host}`, decision, grants: [{ kind: 'host', values: [host], scope: 'agent', behavior: action }], raw }]
    }
    return []
  })
}

// The choice an answer sent to Codex was, read back off the answer, as a replay reads it. An
// amendment sent before Kando chose the prefix is Codex's own, and still the same choice.
export function codexChoiceOf(choices: readonly CodexChoice[], decision: unknown): CodexChoice | undefined {
  const sent = JSON.stringify(decision)
  return choices.find((choice) => JSON.stringify(choice.raw) === sent)
    ?? (ExecPolicy.safeParse(decision).success ? choices.find((choice) => choice.id === 'execpolicy') : undefined)
}

// What an answer Codex was sent amounts to when no choice on the card is it any more: an amendment
// remembered something, and let the command through.
export function codexAnswerAllows(decision: unknown): boolean {
  return ExecPolicy.safeParse(decision).success || NetworkPolicy.safeParse(decision).data?.applyNetworkPolicyAmendment.network_policy_amendment.action === 'allow'
}

// The decisions older clients pick from, in their order, from what the choices amount to.
export function choiceDecisions(choices: readonly ApprovalChoice[]): ChatDecision[] {
  return (['allow', 'allowForSession', 'deny'] as const).filter((decision) => choices.some((choice) => choice.decision === decision))
}
