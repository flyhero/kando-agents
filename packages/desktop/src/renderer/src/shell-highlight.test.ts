import { describe, expect, it } from 'vitest'
import { shellTokens, type ShellTokenKind } from './shell-highlight'

const marked = (text: string, kind: ShellTokenKind) => shellTokens(text).filter((token) => token.kind === kind).map((token) => token.text)

describe('shellTokens', () => {
  const command = `git show -s --format='%B' 7cd235c; git show --stat a9de077 | grep -E "\\|" | head -20`

  it('names each command, after the start and after every operator', () => {
    expect(marked(command, 'command')).toEqual(['git', 'git', 'grep', 'head'])
    expect(marked(command, 'operator')).toEqual([';', '|', '|'])
  })

  it('marks flags and strings, but not plain arguments', () => {
    expect(marked(command, 'flag')).toEqual(['-s', '--format=', '--stat', '-E', '-20'])
    expect(marked(command, 'string')).toEqual([`'%B'`, `"\\|"`])
  })

  it('keeps every character, in order', () => {
    expect(shellTokens(command).map((token) => token.text).join('')).toBe(command)
  })

  it('reads variables, comments, assignments and a command inside $(…)', () => {
    const tokens = `FOO=1 pnpm dev # start\necho $(date) "$HOME" > out.txt`
    expect(marked(tokens, 'assignment')).toEqual(['FOO='])
    expect(marked(tokens, 'command')).toEqual(['pnpm', 'echo', 'date'])
    expect(marked(tokens, 'comment')).toEqual(['# start'])
    expect(marked(tokens, 'variable')).toEqual(['$('])
    expect(marked(tokens, 'string')).toEqual(['"$HOME"'])
  })

  it('carries a command across a line ending in a backslash', () => {
    expect(marked('docker run \\\n  --rm image', 'command')).toEqual(['docker'])
  })
})
