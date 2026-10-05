import { describe, expect, it } from 'vitest'
import { blockCommand, runsAtOnce } from './code-commands'

describe('blockCommand', () => {
  it('takes a shell block whole, without its last newline', () => {
    expect(blockCommand('bash', 'cd /work/demo\n')).toBe('cd /work/demo')
    expect(blockCommand('ZSH', 'mvn spring-boot:run\n')).toBe('mvn spring-boot:run')
  })

  it('takes only the prompted lines of a console block', () => {
    expect(blockCommand('console', '$ pnpm dev\nready on :5173\n$ curl localhost:5173\n')).toBe('pnpm dev\ncurl localhost:5173')
    expect(blockCommand('console', 'no prompt here\n')).toBeNull()
  })

  it('leaves other languages, unnamed blocks and empty ones alone', () => {
    expect(blockCommand('text', 'Tomcat started on port 8080\n')).toBeNull()
    expect(blockCommand(null, 'ls\n')).toBeNull()
    expect(blockCommand('bash', '\n\n')).toBeNull()
  })
})

describe('runsAtOnce', () => {
  it('runs one line and pastes several', () => {
    expect(runsAtOnce('pnpm dev')).toBe(true)
    expect(runsAtOnce('cd demo\npnpm dev')).toBe(false)
  })
})
