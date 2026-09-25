import { describe, expect, it } from 'vitest'
import { checkContinue, checkMove, checkRedo, checkRefine, checkRun, type Task } from './task'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    title: 'Refactor login',
    details: '',
    status: 'pending',
    repos: [],
    dependsOn: [],
    agent: null,
    sessionId: null,
    refineSessionId: null,
    proposal: null,
    previousDetails: null,
    derivedFrom: null,
    abandonReason: null,
    source: null,
    sourceSnapshot: null,
    images: [],
    lastExit: null,
    awaitingInput: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('checkMove', () => {
  it('lets a running task be closed, but never moves a done task back', () => {
    expect(checkMove(task({ status: 'running' }), 'done')).toBeNull()
    expect(checkMove(task({ status: 'done' }), 'pending')).toBe('invalid-transition')
    expect(checkMove(task({ status: 'done' }), 'abandoned')).toBe('invalid-transition')
  })

  it('never allows a manual move into running', () => {
    expect(checkMove(task(), 'running')).toBe('invalid-transition')
    expect(checkMove(task({ status: 'running' }), 'running')).toBe('invalid-transition')
  })

  it('lets a pending task be closed without running, unless it is being refined', () => {
    expect(checkMove(task(), 'done')).toBeNull()
    expect(checkMove(task({ refineSessionId: 'session-1' }), 'done')).toBe('refining')
  })
})

describe('checkRun', () => {
  const repos = [{ path: '/repo', worktreePath: null, branch: null }]

  it('reports the first missing prerequisite', () => {
    const ready = { repos, agent: 'claude' } as const
    expect(checkRun(task({ ...ready, status: 'done' }), [])).toBe('not-pending')
    expect(checkRun(task({ ...ready, repos: [] }), [])).toBe('missing-repo')
    expect(checkRun(task({ ...ready, agent: null }), [])).toBe('missing-agent')
    expect(checkRun(task(ready), [])).toBeNull()
  })

  it('runs on the title alone when there are no details', () => {
    expect(checkRun(task({ details: '', repos, agent: 'codex' }), [])).toBeNull()
  })

  it('holds off while a refining session is open', () => {
    expect(checkRun(task({ repos, agent: 'claude', refineSessionId: 's1' }), [])).toBe('refining')
  })

  it('waits until every dependency is done', () => {
    const ready = task({ repos, agent: 'codex' })
    expect(checkRun(ready, [{ status: 'done' }, { status: 'running' }])).toBe('blocked')
    expect(checkRun(ready, [{ status: 'done' }, { status: 'done' }])).toBeNull()
  })
})

describe('checkRefine', () => {
  const repos = [{ path: '/repo', worktreePath: null, branch: null }]

  it('needs a repo and an agent, but not finished dependencies', () => {
    expect(checkRefine(task({ agent: 'claude' }))).toBe('missing-repo')
    expect(checkRefine(task({ repos }))).toBe('missing-agent')
    expect(checkRefine(task({ repos, agent: 'codex', dependsOn: ['other'] }))).toBeNull()
  })

  it('allows one refining session at a time, and only before running', () => {
    expect(checkRefine(task({ repos, agent: 'claude', refineSessionId: 's1' }))).toBe('refine-in-progress')
    expect(checkRefine(task({ repos, agent: 'claude', status: 'done' }))).toBe('not-pending')
  })
})

describe('checkContinue and checkRedo', () => {
  const repos = [{ path: '/repo', worktreePath: '/wt', branch: 'kando/x' }]

  it('continues only done tasks whose dependencies are still done', () => {
    const done = task({ status: 'done', repos, agent: 'claude' })
    expect(checkContinue(done, [])).toBeNull()
    expect(checkContinue(done, [{ status: 'running' }])).toBe('blocked')
    expect(checkContinue(task({ repos, agent: 'claude' }), [])).toBe('not-done')
  })

  it('redoes only done tasks', () => {
    expect(checkRedo(task({ status: 'done' }))).toBeNull()
    expect(checkRedo(task({ status: 'abandoned' }))).toBe('not-done')
  })
})
