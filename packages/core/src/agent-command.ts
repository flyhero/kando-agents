export type AgentCommand = { command: string; args: string[] }

// Both CLIs split these lists on commas, so a path with one in it is left out rather than garbled.
const usable = (paths: readonly string[]) => paths.filter((file) => !file.includes(','))

// Claude may read exactly these files without asking; nothing else in the attachment folder.
// `//` starts an absolute path in Claude's permission rules.
export function claudeReadRules(files: readonly string[]): string[] {
  return usable(files)
    .filter((file) => file.startsWith('/'))
    .map((file) => `Read(/${file})`)
}

// Claude may edit nothing under these folders, whatever mode it is switched to. Its plan drafts go
// to ~/.claude/plans instead, so plan mode still works; an Edit rule covers every editing tool.
export function claudeEditDenials(dirs: readonly string[]): string[] {
  return usable(dirs)
    .filter((dir) => dir.startsWith('/'))
    .map((dir) => `Edit(/${dir}/**)`)
}

// An MCP server the agent starts over stdio.
export type McpServer = { command: string; args: string[] }

// Read-only git lets the agent look at a dependency's branch without a prompt.
export const GIT_READ_TOOLS = ['Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)']
