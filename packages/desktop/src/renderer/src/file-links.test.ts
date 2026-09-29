import { describe, expect, it } from 'vitest'
import { fileCandidates, fileReference } from './file-links'

describe('fileReference', () => {
  it('reads a file name, with its line, out of inline code', () => {
    expect(fileReference('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 })
    expect(fileReference('greet.js')).toEqual({ path: 'greet.js', line: null })
    expect(fileReference('../api/ping.js')).toEqual({ path: '../api/ping.js', line: null })
    expect(fileReference('/etc/hosts')).toEqual({ path: '/etc/hosts', line: null })
  })

  it('leaves code that only looks a little like a path alone', () => {
    for (const text of ['module.exports', 'v1.2.3', 'origin/main', 'hello()', 'git status', 'https://example.com/a.js']) {
      expect(fileReference(text)).toBeNull()
    }
  })
})

describe('fileCandidates', () => {
  it('looks for a relative path under each folder, the primary first', () => {
    expect(fileCandidates('../api/ping.js', ['/wt/web', '/wt/api'])).toEqual(['/wt/api/ping.js'])
    expect(fileCandidates('src/a.ts', ['/wt/web', '/wt/api'])).toEqual(['/wt/web/src/a.ts', '/wt/api/src/a.ts'])
    expect(fileCandidates('/abs/a.ts', ['/wt/web'])).toEqual(['/abs/a.ts'])
  })
})
