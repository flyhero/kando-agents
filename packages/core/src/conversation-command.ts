import type { AgentKind } from '@kando/protocol'
import { claudeEditDenials, claudeReadRules, GIT_READ_TOOLS, type AgentCommand, type McpServer } from './agent-command'
import { browserToolName, SHOW_PREVIEW_TOOL, terminalToolName } from '@kando/protocol'
import type { ChatPreferences } from './chat-driver'
import { CLAUDE_MODE_NAMES } from './claude-stream'

// The browser tools that only read: what the page shows, says in its console, or is waited on.
export const BROWSER_READ_TOOLS: readonly string[] = (['snapshot', 'screenshot', 'scroll', 'wait', 'console', 'tabs'] as const).map(browserToolName)

// The ChatGPT app's own browser, which its unified-computer-use plugin gives every Codex as the
// cua_repl MCP server: beside Kando's browser tools Codex reached for it first, and its policy,
// kept in that app, refuses a Codex that Kando runs. A whole entry, disabled, overrides the
// plugin's; enabled=false alone is an incomplete server that Codex refuses to start with, and a
// whole one is harmless where the plugin is not installed.
const HIDDEN_CODEX_BROWSERS: readonly string[] = ['-c', 'mcp_servers.cua_repl={command="/usr/bin/true",enabled=false}']

const HANDOFF_PREFIX = '请先阅读 Kando 移交文件 '
const HANDOFF_SUFFIX = '，结合当前项目目录现状继续协助用户。'

export function handoffPrompt(handoffPath: string): string {
  return `${HANDOFF_PREFIX}${handoffPath}${HANDOFF_SUFFIX}`
}

// The agent reports the handoff prompt back as the user's first message; this finds its path.
export function handoffPromptPath(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(HANDOFF_PREFIX) || !trimmed.endsWith(HANDOFF_SUFFIX)) return null
  return trimmed.slice(HANDOFF_PREFIX.length, -HANDOFF_SUFFIX.length)
}

// The agent speaks JSON lines over stdio: the stream carries every message, and none goes in argv
// (messages, the handoff prompt included, go to stdin).
export function chatCommand(
  agent: AgentKind,
  providerSessionId: string | null,
  resume: boolean,
  handoffPath: string | null,
  extraProjects: readonly string[] = [],
  launch: {
    preferred?: ChatPreferences
    allowBypass?: boolean
    // Plans only, read-only in these folders: plan mode, their files never editable, no bypass.
    planOnly?: { dirs: readonly string[] }
    // Files the agent may read without asking, such as a task's images.
    readable?: readonly string[]
    // Resume only through this message (its uuid), as a new session: a fork of the one resumed.
    forkAt?: string | null
    // Kando's own tools for the agent (showing a file it wrote); none for an older setup.
    mcp?: McpServer
  } = {}
): AgentCommand {
  if (agent === 'claude') {
    const { preferred = {}, planOnly, readable = [], mcp, forkAt } = launch
    const allowBypass = (launch.allowBypass ?? false) && !planOnly
    // A remembered bypass needs the user's say-so for this start too. Asking goes by manual on
    // the command line, and is passed too, so Claude Code's own default mode cannot override it.
    const chosen = preferred.permissionMode && (preferred.permissionMode !== 'bypass' || allowBypass) ? preferred.permissionMode : undefined
    const allowed = planOnly ? 'plan' : chosen
    const wanted = allowed === 'ask' ? 'manual' : allowed ? CLAUDE_MODE_NAMES[allowed] : undefined
    const reads = [
      ...(handoffPath ? [`Read(/${handoffPath})`] : []),
      ...claudeReadRules(readable),
      // Planning around what dependencies left on their branches means reading git history.
      ...(planOnly ? GIT_READ_TOOLS : []),
      // Showing a file the agent wrote asks nothing of the user, nor does reading the browser's
      // page; opening and acting on a page go through Claude's own confirmation. (Codex asks
      // nothing for MCP tools, so for it the site gate in core is the only check.)
      // Reading or stopping a terminal the conversation opened itself asks nothing either; running
      // a command in one is the agent's to ask about, under the mode the user set.
      ...(mcp ? [SHOW_PREVIEW_TOOL, ...BROWSER_READ_TOOLS, terminalToolName('read'), terminalToolName('stop')].map((tool) => `mcp__kando__${tool}`) : [])
    ]
    const denials = planOnly ? claudeEditDenials(planOnly.dirs) : []
    return { command: 'claude', args: [
      '-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      // Makes bypass a mode the user can switch to, without starting in it.
      ...(allowBypass ? ['--allow-dangerously-skip-permissions'] : []),
      ...(wanted ? ['--permission-mode', wanted] : []),
      ...(preferred.model ? ['--model', preferred.model] : []),
      ...(preferred.effort ? ['--effort', preferred.effort] : []),
      ...(resume && providerSessionId ? ['--resume', providerSessionId, ...(forkAt ? ['--resume-session-at', forkAt, '--fork-session'] : [])] : providerSessionId ? ['--session-id', providerSessionId] : []),
      ...extraProjects.flatMap((project) => ['--add-dir', project]),
      ...(denials.length ? ['--disallowedTools', denials.join(',')] : []),
      ...(reads.length ? ['--allowedTools', reads.join(',')] : []),
      ...(mcp ? ['--mcp-config', JSON.stringify({ mcpServers: { kando: { type: 'stdio', command: mcp.command, args: mcp.args } } })] : [])
    ] }
  }
  // app-server takes the thread, sandbox and extra roots over the protocol instead; Kando's MCP
  // server goes in as a config override.
  const { mcp } = launch
  return { command: 'codex', args: [
    'app-server',
    ...(mcp ? ['-c', `mcp_servers.kando.command=${JSON.stringify(mcp.command)}`, '-c', `mcp_servers.kando.args=${JSON.stringify(mcp.args)}`, ...HIDDEN_CODEX_BROWSERS] : [])
  ] }
}
