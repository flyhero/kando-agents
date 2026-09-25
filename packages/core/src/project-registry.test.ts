import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from './project-registry'
import { TaskStore } from './task-store'

describe('ProjectRegistry', () => {
  let dir: string
  let tasks: TaskStore
  let projects: ProjectRegistry

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-projects-'))
    const file = path.join(dir, 'kando.db')
    // Creates the table the registry reads.
    tasks = new TaskStore(file)
    let now = 1
    projects = new ProjectRegistry(file, () => now++)
  })

  afterEach(() => {
    projects.close()
    tasks.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists projects most recent first, a repeat moving to the front', () => {
    projects.remember(['/a', '/b'])
    projects.remember(['/a'])
    expect(projects.recent()).toEqual(['/a', '/b'])
  })

  it('stores and forgets paths in their normal form', () => {
    projects.remember(['/code/tmp/../app'])
    projects.remember(['/code/./lib'])
    expect(projects.recent()).toEqual(['/code/lib', '/code/app'])
    projects.forget('/code/lib/../app')
    expect(projects.recent()).toEqual(['/code/lib'])
  })
})
