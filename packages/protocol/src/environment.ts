import { z } from 'zod'

// What Kando needs on the machine to run a task: git for the worktrees, and at least one agent CLI.
export const ENVIRONMENT_TOOLS = ['git', 'claude', 'codex', 'cursor'] as const
export const EnvironmentTool = z.enum(ENVIRONMENT_TOOLS)
export type EnvironmentTool = z.infer<typeof EnvironmentTool>

// ok: found, and it said its version · missing: nowhere on the search path
// unknown: found, but could not be asked (a Windows .cmd shim only a shell can run)
export const EnvironmentCheckStatus = z.enum(['ok', 'missing', 'unknown'])
export type EnvironmentCheckStatus = z.infer<typeof EnvironmentCheckStatus>

export const EnvironmentCheck = z.object({
  tool: EnvironmentTool,
  status: EnvironmentCheckStatus,
  version: z.string().nullable(),
  // Where it was found, so the user can tell which install Kando runs.
  path: z.string().nullable(),
  // Whether the tool has an account to run with; null for git, and for a tool that is not there.
  signedIn: z.boolean().nullable()
})
export type EnvironmentCheck = z.infer<typeof EnvironmentCheck>

// Inventory is independent of the agent kinds Kando can run. A detected application may not
// have a CLI, and a CLI may have no desktop application.
export const DetectedAgent = z.object({
  id: z.string(),
  name: z.string(),
  locations: z.array(z.object({ source: z.enum(['cli', 'application']), path: z.string() })),
  // A version response proves the CLI can be launched, not that Kando speaks its protocol or
  // that the user is signed in. Older cores omit this field.
  cliCheck: z.object({
    status: z.enum(['responded', 'unverified']),
    version: z.string().nullable(),
    reason: z.enum(['probe-failed', 'windows-shim']).nullable()
  }).optional()
})
export type DetectedAgent = z.infer<typeof DetectedAgent>

export const Environment = z.object({
  checks: z.array(EnvironmentCheck),
  // Older cores only report checks for the two agents they can run.
  detectedAgents: z.array(DetectedAgent).optional(),
  // The directories looked in, in order: the PATH core starts agents with.
  searchPath: z.array(z.string()),
  checkedAt: z.number()
})
export type Environment = z.infer<typeof Environment>

// git-missing: no worktree can be made · no-agent: neither CLI is installed
// no-signed-in-agent: an agent is installed, but none has an account · signed-out: this one has none
export type EnvironmentProblem =
  | { code: 'git-missing' }
  | { code: 'no-agent' }
  | { code: 'no-signed-in-agent' }
  | { code: 'signed-out'; tool: EnvironmentTool }

const installed = (check: EnvironmentCheck) => check.status !== 'missing'

// What keeps a task from running, most serious first, then what would stop one agent. The UI
// shows these; it never decides on its own what counts.
export function environmentProblems(environment: Pick<Environment, 'checks'>): EnvironmentProblem[] {
  const problems: EnvironmentProblem[] = []
  const of = (tool: EnvironmentTool) => environment.checks.find((check) => check.tool === tool)
  const git = of('git')
  if (git && !installed(git)) problems.push({ code: 'git-missing' })
  const agents = environment.checks.filter((check) => check.tool !== 'git')
  const present = agents.filter(installed)
  if (agents.length > 0 && present.length === 0) {
    problems.push({ code: 'no-agent' })
    return problems
  }
  // A tool that could not be asked is given the benefit of the doubt.
  if (present.length > 0 && present.every((check) => check.signedIn === false)) problems.push({ code: 'no-signed-in-agent' })
  else present.filter((check) => check.signedIn === false).forEach((check) => problems.push({ code: 'signed-out', tool: check.tool }))
  return problems
}

// Whether a problem keeps every task and conversation from running, rather than one agent.
export function blocksEverything(problem: EnvironmentProblem): boolean {
  return problem.code !== 'signed-out'
}
