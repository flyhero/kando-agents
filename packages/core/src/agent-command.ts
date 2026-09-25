import { PROPOSE_DETAILS_TOOL, READ_TASK_TOOL, type AgentKind } from '@kando/protocol'

export type AgentCommand = { command: string; args: string[] }

// Image files for the agent: the user's own, and all of them (the user's plus the issue's).
export type CommandImages = { attached: readonly string[]; all: readonly string[] }
const NO_IMAGES: CommandImages = { attached: [], all: [] }
const CODEX_IMAGE_LIMIT = 10

// Both CLIs split these lists on commas, so a path with one in it is left out rather than garbled.
const usable = (paths: readonly string[]) => paths.filter((file) => !file.includes(','))

// Claude may read exactly these files without asking; nothing else in the attachment folder.
// `//` starts an absolute path in Claude's permission rules.
function claudeImageRules(images: CommandImages): string[] {
  return usable(images.all)
    .filter((file) => file.startsWith('/'))
    .map((file) => `Read(/${file})`)
}

// Only the user's images go into Codex's first message: an issue's images would land there as
// if the user had sent them, outside the untrusted fence the prompt puts around the issue.
function codexImageArgs(images: CommandImages): string[] {
  return usable(images.attached)
    .slice(0, CODEX_IMAGE_LIMIT)
    .map((file) => `--image=${file}`)
}

// An MCP server the agent starts over stdio.
export type McpServer = { command: string; args: string[] }

// A command (argv) the agent runs on its own events, so Kando learns when it waits for the user.
export type EventCallback = readonly string[]

// Claude hooks that run `callback` on the named events; the event arrives as JSON on stdin.
export function claudeHookArgs(callback: EventCallback, events: readonly string[]): string[] {
  const hook = { type: 'command', command: callback[0], args: callback.slice(1) }
  return ['--settings', JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [hook] }]])) })]
}

// Codex runs `notify` with the event as its last argument when a turn completes.
export function codexNotifyArgs(callback: EventCallback): string[] {
  return ['-c', `notify=${JSON.stringify(callback)}`]
}

// A turn that ends, or a prompt for permission, leaves the agent waiting; a new prompt resumes it.
const CLAUDE_TASK_EVENTS = ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification']
const claudeEvents = (callback: EventCallback | null) => (callback ? claudeHookArgs(callback, CLAUDE_TASK_EVENTS) : [])
const codexEvents = (callback: EventCallback | null) => (callback ? codexNotifyArgs(callback) : [])

// `--` stops a title such as "--yolo" from being parsed as a CLI flag.
export function agentCommand(
  agent: AgentKind,
  prompt: string,
  images: CommandImages = NO_IMAGES,
  events: EventCallback | null = null
): AgentCommand {
  switch (agent) {
    case 'claude': {
      const rules = claudeImageRules(images)
      return {
        command: 'claude',
        args: [...(rules.length ? ['--allowedTools', rules.join(',')] : []), ...claudeEvents(events), '--', prompt]
      }
    }
    case 'codex':
      return { command: 'codex', args: [...codexImageArgs(images), ...codexEvents(events), '--', prompt] }
  }
}

// Read-only git lets the agent look at a dependency's branch without a prompt.
const GIT_READ_TOOLS = ['Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)']
// Plan mode alone gives way once the user approves a plan; with the file tools denied,
// refining cannot write to the user's own checkout even then.
const CLAUDE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// Refining runs read-only (Claude's plan mode with its write tools denied, Codex's
// read-only sandbox), and the only thing it can change is the task's pending proposal,
// through Kando's MCP tools. `extraDirs` are the task's other repos.
export function refineCommand(
  agent: AgentKind,
  prompt: string,
  mcp: McpServer,
  extraDirs: readonly string[],
  images: CommandImages = NO_IMAGES,
  events: EventCallback | null = null
): AgentCommand {
  switch (agent) {
    case 'claude':
      return {
        command: 'claude',
        args: [
          ...extraDirs.flatMap((dir) => ['--add-dir', dir]),
          '--permission-mode',
          'plan',
          '--disallowedTools',
          CLAUDE_WRITE_TOOLS.join(','),
          '--mcp-config',
          JSON.stringify({ mcpServers: { kando: { type: 'stdio', command: mcp.command, args: mcp.args } } }),
          '--allowedTools',
          [
            ...[PROPOSE_DETAILS_TOOL, READ_TASK_TOOL].map((tool) => `mcp__kando__${tool}`),
            ...GIT_READ_TOOLS,
            ...claudeImageRules(images)
          ].join(','),
          ...claudeEvents(events),
          '--',
          prompt
        ]
      }
    case 'codex':
      // The read-only sandbox can read the whole disk, so the other repos need no flag.
      // -c values are TOML; a JSON string or array of strings is valid TOML too.
      return {
        command: 'codex',
        args: [
          '--sandbox',
          'read-only',
          '-c',
          `mcp_servers.kando.command=${JSON.stringify(mcp.command)}`,
          '-c',
          `mcp_servers.kando.args=${JSON.stringify(mcp.args)}`,
          ...codexImageArgs(images),
          ...codexEvents(events),
          '--',
          prompt
        ]
      }
  }
}
