import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findFiles } from './file-search'

describe('findFiles', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'kando-find-file-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(path.join(root, 'src/rules/deep'), { recursive: true })
    mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true })
    writeFileSync(path.join(root, 'src/rules/inventory.json'), '{}')
    writeFileSync(path.join(root, 'src/rules/deep/inventory.json'), '{}')
    writeFileSync(path.join(root, 'node_modules/pkg/inventory.json'), '{}')
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
    execFileSync('git', ['add', 'src/rules/inventory.json'], { cwd: root })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds a file by its name, tracked or not, the shallowest first, never an ignored one', async () => {
    expect(await findFiles([root], 'inventory.json')).toEqual([
      path.join(root, 'src/rules/inventory.json'),
      path.join(root, 'src/rules/deep/inventory.json')
    ])
  })

  it('takes the tail of a path, and finds nothing outside a repo', async () => {
    expect(await findFiles([root], 'deep/inventory.json')).toEqual([path.join(root, 'src/rules/deep/inventory.json')])
    expect(await findFiles([root], './rules/inventory.json')).toEqual([path.join(root, 'src/rules/inventory.json')])
    expect(await findFiles([os.tmpdir()], 'inventory.json')).toEqual([])
  })
})
