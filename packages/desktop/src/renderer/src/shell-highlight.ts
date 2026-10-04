// A shell command cut into the pieces worth colouring. highlight.js's bash grammar marks strings and
// a few builtins only, so `git show --stat a9de077 | grep -E x` would read as one plain line; here
// each command's name, its flags, the operators between commands, strings, variables and comments
// stand apart. Not a parser: a heredoc's body or a nested quote simply reads as words.
export type ShellTokenKind = 'command' | 'flag' | 'string' | 'variable' | 'operator' | 'comment' | 'assignment'
export type ShellToken = { kind: ShellTokenKind | null; text: string }

const OPERATOR = /^(?:&&|\|\||;;|[|;&]|\d?>>?|<<?|[()])/
const VARIABLE = /^\$(?:\{[^}]*\}|\(|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*-])/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// A word runs to whitespace, a quote, a variable or an operator.
const WORD = /^(?:\\.|[^\s'"$|;&<>()\\])+/

function quoted(text: string, at: number): number {
  const quote = text[at]
  let end = at + 1
  while (end < text.length && text[end] !== quote) end += quote === '"' && text[end] === '\\' ? 2 : 1
  return Math.min(end + 1, text.length)
}

export function shellTokens(text: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const push = (kind: ShellTokenKind | null, part: string) => {
    const last = tokens.at(-1)
    if (last && last.kind === kind && kind === null) last.text += part
    else tokens.push({ kind, text: part })
  }
  // Whether the next word names a command: at the start, and after an operator or a newline.
  let expectCommand = true
  let at = 0
  while (at < text.length) {
    const rest = text.slice(at)
    const space = /^[ \t]+/.exec(rest)?.[0]
    if (space) {
      push(null, space)
      at += space.length
      continue
    }
    const char = rest[0]
    if (char === '\n') {
      push(null, char)
      at += 1
      // A backslash before the newline continues the same command.
      if (!text.slice(0, at - 1).endsWith('\\')) expectCommand = true
      continue
    }
    if (char === '#' && (at === 0 || /\s/.test(text[at - 1] ?? ''))) {
      const end = text.indexOf('\n', at)
      const comment = end < 0 ? rest : text.slice(at, end)
      push('comment', comment)
      at += comment.length
      continue
    }
    if (char === "'" || char === '"') {
      const end = quoted(text, at)
      push('string', text.slice(at, end))
      at = end
      expectCommand = false
      continue
    }
    const variable = VARIABLE.exec(rest)?.[0]
    if (variable) {
      push('variable', variable)
      at += variable.length
      // $( opens a command of its own.
      if (variable === '$(') expectCommand = true
      continue
    }
    const operator = OPERATOR.exec(rest)?.[0]
    if (operator) {
      push('operator', operator)
      at += operator.length
      // After a redirection comes its target, and after a closing bracket the same command's words.
      expectCommand = !/[<>)]/.test(operator)
      continue
    }
    const word = WORD.exec(rest)?.[0] ?? rest.slice(0, 1)
    if (expectCommand && ASSIGNMENT.test(word)) {
      // FOO=bar before a command: the command is still to come.
      const name = ASSIGNMENT.exec(word)?.[0] ?? word
      push('assignment', name)
      push(null, word.slice(name.length))
    } else if (expectCommand) {
      push('command', word)
      expectCommand = false
    } else {
      push(/^--?[A-Za-z0-9]/.test(word) ? 'flag' : null, word)
    }
    at += word.length
  }
  return tokens
}
