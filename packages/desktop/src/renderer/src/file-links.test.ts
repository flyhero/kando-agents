import { describe, expect, it } from 'vitest'
import { fileCandidates, fileReference, isImagePath, linkTarget, previewUrl } from './file-links'

describe('fileReference', () => {
  it('reads Windows paths and filenames containing spaces or Unicode', () => {
    expect(fileReference('C:\\repo\\文件 名.ts:12')).toEqual({ path: 'C:\\repo\\文件 名.ts', line: 12 })
    expect(fileReference('src/文件 名.java:8')).toEqual({ path: 'src/文件 名.java', line: 8 })
    expect(fileReference('\\\\host\\share\\a.ts')).toEqual({ path: '\\\\host\\share\\a.ts', line: null })
  })
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

describe('linkTarget', () => {
  it('normalizes Windows and UNC file URLs without dropping their authority', () => {
    expect(linkTarget('file:///C:/repo/a.ts#L8')).toEqual({ kind: 'file', path: 'C:/repo/a.ts', line: 8 })
    expect(linkTarget('file://host/share/a.ts')).toEqual({ kind: 'file', path: '//host/share/a.ts', line: null })
  })
  it('sends http and https links to the browser', () => {
    expect(linkTarget('https://example.com/a')).toEqual({ kind: 'web', href: 'https://example.com/a' })
    expect(linkTarget('http://localhost:5173/')).toEqual({ kind: 'web', href: 'http://localhost:5173/' })
  })

  it('reads a path, a file URL or a relative name as a file, with the line it points at', () => {
    expect(linkTarget('/private/tmp/kando-awake-preview-narrow.png')).toEqual({ kind: 'file', path: '/private/tmp/kando-awake-preview-narrow.png', line: null })
    expect(linkTarget('file:///Users/me/My%20Shots/a.png')).toEqual({ kind: 'file', path: '/Users/me/My Shots/a.png', line: null })
    expect(linkTarget('src/app.ts:42')).toEqual({ kind: 'file', path: 'src/app.ts', line: 42 })
    expect(linkTarget('app.ts:42:7')).toEqual({ kind: 'file', path: 'app.ts', line: 42 })
    expect(linkTarget('/repo/src/app.ts#L10-L20')).toEqual({ kind: 'file', path: '/repo/src/app.ts', line: 10 })
    expect(linkTarget('C:/repo/a.ts')).toEqual({ kind: 'file', path: 'C:/repo/a.ts', line: null })
  })

  it('leaves anchors and other schemes alone', () => {
    for (const href of ['#usage', 'mailto:me@example.com', 'vscode://file/a.ts', 'javascript:alert(1)']) {
      expect(linkTarget(href)).toBeNull()
    }
  })
})

describe('images', () => {
  it('knows an image by its extension', () => {
    expect(isImagePath('/tmp/shot.PNG')).toBe(true)
    expect(isImagePath('docs/diagram.svg')).toBe(true)
    expect(isImagePath('/tmp/notes.md')).toBe(false)
  })

  it('escapes each part of the path for the preview protocol', () => {
    expect(previewUrl('/Users/me/My Shots/#1.png')).toBe('kando-preview://file/Users/me/My%20Shots/%231.png')
  })
})
