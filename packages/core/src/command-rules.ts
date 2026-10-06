// What a shell command may be remembered by: the words a later command must start with to go
// through without asking. Short enough to be worth keeping (git add, not git add -A src/a.ts),
// never for what could do anything (rm, sudo, an interpreter given a script inline, a command
// substitution) or write a file (a redirection). Each part of a compound command counts; null
// when any part may not be remembered.

// Tools whose first argument says what they do, so the rule keeps it: git log, not git.
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'cargo', 'go', 'docker', 'kubectl', 'gh',
  'brew', 'pip', 'pip3', 'uv', 'poetry', 'make', 'mvn', 'gradle', './gradlew', 'dotnet', 'swift', 'deno',
  'terraform', 'helm', 'composer', 'bundle', 'rails', 'rake', 'mix', 'flutter', 'dart', 'xcrun'
])
// Of those, ones that run a project's scripts by name: npm run dev, not every npm run.
const SCRIPT_RUNNERS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['run', 'run-script', 'exec']),
  pnpm: new Set(['run', 'exec', 'dlx']),
  yarn: new Set(['run', 'exec', 'dlx']),
  bun: new Set(['run', 'x'])
}
// What may do anything, or anything to the machine: asked about every time.
const NEVER = new Set([
  'rm', 'rmdir', 'sudo', 'su', 'doas', 'chmod', 'chown', 'chgrp', 'dd', 'mkfs', 'diskutil', 'shred',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet',
  'kill', 'killall', 'pkill', 'launchctl', 'shutdown', 'reboot', 'halt',
  'eval', 'exec', 'source', '.', 'xargs', 'env', 'nohup', 'time', 'watch', 'osascript', 'open',
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell',
  'crontab', 'security', 'defaults'
])
// Subcommands that rewrite history, publish, or tear down: asked about every time.
const NEVER_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(['push', 'reset', 'clean', 'rebase', 'filter-branch', 'filter-repo', 'update-ref', 'reflog', 'gc', 'prune']),
  npm: new Set(['publish', 'unpublish', 'deprecate', 'adduser', 'login', 'token']),
  pnpm: new Set(['publish']),
  yarn: new Set(['publish', 'npm']),
  cargo: new Set(['publish', 'yank', 'login']),
  docker: new Set(['rm', 'rmi', 'system', 'volume', 'network', 'prune', 'push', 'login']),
  kubectl: new Set(['delete', 'apply', 'replace', 'patch', 'edit', 'drain', 'scale', 'exec']),
  terraform: new Set(['apply', 'destroy', 'import', 'state']),
  helm: new Set(['install', 'upgrade', 'uninstall', 'delete', 'rollback']),
  gh: new Set(['repo', 'release', 'secret', 'api', 'auth', 'workflow']),
  brew: new Set(['uninstall', 'remove', 'rm', 'cleanup'])
}
// Interpreters, and the flags that hand them a script inline: node -e '…' remembered would let
// any script through.
const INLINE_CODE: Record<string, ReadonlySet<string>> = {
  node: new Set(['-e', '--eval', '-p', '--print']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  ruby: new Set(['-e']),
  perl: new Set(['-e', '-E']),
  php: new Set(['-r']),
  deno: new Set(['eval']),
  bun: new Set(['-e', '--eval'])
}
const OPERATORS = new Set(['&&', '||', ';', '|', '&', '\n'])

type Token = { word: string; operator: boolean }

// Shell words and the operators between them; null for what cannot be read as plain words
// (a command or process substitution, an unclosed quote).
function tokens(command: string): Token[] | null {
  const out: Token[] = []
  let word = ''
  let inWord = false
  const end = () => {
    if (inWord) out.push({ word, operator: false })
    word = ''
    inWord = false
  }
  for (let at = 0; at < command.length; at++) {
    const char = command.charAt(at)
    const next = command.charAt(at + 1)
    if (char === "'") {
      const close = command.indexOf("'", at + 1)
      if (close < 0) return null
      word += command.slice(at + 1, close)
      inWord = true
      at = close
    } else if (char === '"') {
      let at2 = at + 1
      for (; at2 < command.length && command[at2] !== '"'; at2++) {
        if (command[at2] === '\\') at2++
        else if (command[at2] === '$' && command[at2 + 1] === '(') return null
        else if (command[at2] === '`') return null
      }
      if (at2 >= command.length) return null
      word += command.slice(at + 1, at2).replace(/\\(.)/g, '$1')
      inWord = true
      at = at2
    } else if (char === '\\') {
      word += next
      inWord = true
      at++
    } else if (char === '`' || (char === '$' && next === '(') || ((char === '<' || char === '>') && next === '(')) {
      return null
    } else if (char === ' ' || char === '\t') {
      end()
    } else if (char === '&' && inWord && word.endsWith('>')) {
      // 2>&1: a redirection to another stream, not a command sent to the background.
      word += char
    } else if ((char === '&' || char === '|') && next === char) {
      end()
      out.push({ word: char + char, operator: true })
      at++
    } else if (OPERATORS.has(char)) {
      end()
      out.push({ word: char, operator: true })
    } else {
      word += char
      inWord = true
    }
  }
  end()
  return out
}

// One simple command's prefix: its words up to what it does, or null when it may not be kept.
function prefixOf(words: readonly string[]): string[] | null {
  // FOO=bar before the command sets its environment; the command is what follows.
  const first = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  const [tool, ...args] = first < 0 ? [] : words.slice(first)
  if (!tool) return null
  // Output written to a file is a write, whatever the command; to /dev/null or another stream it is not.
  for (const [index, arg] of args.entries()) {
    if (!/^\d?>>?/.test(arg) && arg !== '&>') continue
    const target = /^\d?>>?(.+)$/.exec(arg)?.[1] ?? args[index + 1] ?? ''
    if (!/^(&\d|\/dev\/null)$/.test(target)) return null
  }
  if (NEVER.has(tool)) return null
  const inline = INLINE_CODE[tool]
  if (inline && args.some((arg) => inline.has(arg))) return null
  if (!SUBCOMMAND_TOOLS.has(tool)) return [tool]
  const sub = args[0]
  if (!sub) return [tool]
  if (NEVER_SUBCOMMANDS[tool]?.has(sub)) return null
  // A flag first (git -c k=v push, npm --prefix dir publish): kept, it would let any subcommand
  // after it through, so it is asked about each time.
  if (sub.startsWith('-')) return null
  const script = SCRIPT_RUNNERS[tool]?.has(sub) ? args[1] : undefined
  return script && !script.startsWith('-') ? [tool, sub, script] : [tool, sub]
}

// Every distinct prefix the command's parts start with, in order, or null when one may not be kept.
export function commandPrefixes(command: string): string[][] | null {
  const read = tokens(command.trim())
  if (!read || read.length === 0) return null
  const parts: string[][] = []
  let part: string[] = []
  for (const token of read) {
    if (!token.operator) {
      part.push(token.word)
      continue
    }
    parts.push(part)
    part = []
  }
  parts.push(part)
  const prefixes: string[][] = []
  for (const words of parts) {
    if (words.length === 0) continue
    const prefix = prefixOf(words)
    if (!prefix) return null
    if (!prefixes.some((known) => known.join(' ') === prefix.join(' '))) prefixes.push(prefix)
  }
  return prefixes.length ? prefixes : null
}
