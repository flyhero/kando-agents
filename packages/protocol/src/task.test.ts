import { describe, expect, it } from 'vitest'
import { checkChangePrimary, checkChatResume, checkContinue, checkEditProjects, checkMove, checkRedo, checkRefine, checkRun, checkSavePlan, checkStart, checkSubmit, startKind, type Task } from './task'

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
    conversationId: null,
    plan: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('checkEditProjects', () => {
  it('locks projects for live, launching and abandoned tasks', () => {
    expect(checkEditProjects(task({ status: 'running' }))).toBe('task-running')
    expect(checkEditProjects(task({ refineSessionId: 'session' }))).toBe('refining')
    expect(checkEditProjects(task({ status: 'abandoned' }))).toBe('task-abandoned')
    expect(checkEditProjects(task(), true)).toBe('run-in-progress')
    for (const status of ['pending', 'review', 'done'] as const) {
      expect(checkEditProjects(task({ status }))).toBeNull()
    }
  })
})

describe('checkChangePrimary', () => {
  it('keeps the primary project once a task\'s chat has begun', () => {
    expect(checkChangePrimary(task({ conversationId: 'chat' }))).toBe('primary-fixed')
    expect(checkChangePrimary(task({ sessionId: 'terminal', status: 'review' }))).toBeNull()
    expect(checkChangePrimary(task())).toBeNull()
  })
})

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

  it('accepts a task under review, and moves it nowhere else', () => {
    expect(checkMove(task({ status: 'review' }), 'done')).toBeNull()
    expect(checkMove(task({ status: 'review' }), 'pending')).toBe('invalid-transition')
    expect(checkMove(task({ status: 'review' }), 'running')).toBe('invalid-transition')
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

  it('waits until every dependency is accepted, not just finished', () => {
    const ready = task({ repos, agent: 'codex' })
    expect(checkRun(ready, [{ status: 'done' }, { status: 'running' }])).toBe('blocked')
    expect(checkRun(ready, [{ status: 'done' }, { status: 'review' }])).toBe('blocked')
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

  it('continues only finished tasks, under review or accepted, whose dependencies are still accepted', () => {
    const done = task({ status: 'done', repos, agent: 'claude' })
    expect(checkContinue(done, [])).toBeNull()
    expect(checkContinue(task({ status: 'review', repos, agent: 'claude' }), [])).toBeNull()
    expect(checkContinue(done, [{ status: 'running' }])).toBe('blocked')
    expect(checkContinue(task({ repos, agent: 'claude' }), [])).toBe('not-done')
  })

  it('redoes only finished tasks', () => {
    expect(checkRedo(task({ status: 'done' }))).toBeNull()
    expect(checkRedo(task({ status: 'review' }))).toBeNull()
    expect(checkRedo(task({ status: 'running' }))).toBe('not-done')
    expect(checkRedo(task({ status: 'abandoned' }))).toBe('not-done')
  })
})

describe('a task in the chat view', () => {
  const ready = { repos: [{ path: '/code/app', worktreePath: null, branch: null }], agent: 'claude' as const }
  const done = [{ status: 'done' as const }]
  const unfinished = [{ status: 'done' as const }, { status: 'review' as const }]

  it('starts by planning, carrying the plan out only once what it builds on is done', () => {
    expect(startKind(done)).toBe('execute')
    expect(startKind([])).toBe('execute')
    expect(startKind(unfinished)).toBe('plan')
    expect(checkStart(task(ready), unfinished)).toBeNull()
    expect(checkStart(task({ ...ready, conversationId: 'c' }), unfinished)).toBe('planning')
    expect(checkStart(task({ ...ready, conversationId: 'c' }), done)).toBeNull()
    expect(checkStart(task({ ...ready, status: 'running' }), done)).toBe('not-pending')
    expect(checkStart(task({ ...ready, refineSessionId: 'r' }), done)).toBe('refining')
    expect(checkStart(task({ agent: 'claude' }), done)).toBe('missing-repo')
    expect(checkStart(task({ ...ready, agent: null }), done)).toBe('missing-agent')
  })

  it('keeps a task in the view it started in', () => {
    expect(checkRun(task({ ...ready, conversationId: 'c' }), done)).toBe('chat-task')
    expect(checkRefine(task({ ...ready, conversationId: 'c' }))).toBe('chat-task')
  })

  it('hands a running chat task in for review, never mid-turn', () => {
    const running = task({ ...ready, status: 'running', conversationId: 'c' })
    expect(checkSubmit(running, 'idle')).toBeNull()
    expect(checkSubmit(running, null)).toBeNull()
    expect(checkSubmit(running, 'running')).toBe('agent-working')
    expect(checkSubmit(running, 'awaiting')).toBe('agent-working')
    expect(checkSubmit(task({ ...ready, status: 'running' }), 'idle')).toBe('not-chat')
    expect(checkSubmit(task({ ...ready, status: 'review', conversationId: 'c' }), 'idle')).toBe('not-running')
  })

  it('goes on by message while planning or working, and reopens a finished task as continuing does', () => {
    const chat = { ...ready, conversationId: 'c' }
    expect(checkChatResume(task(chat), unfinished)).toBeNull()
    expect(checkChatResume(task({ ...chat, status: 'running' }), done)).toBeNull()
    expect(checkChatResume(task({ ...chat, status: 'review' }), done)).toBeNull()
    expect(checkChatResume(task({ ...chat, status: 'done' }), unfinished)).toBe('blocked')
    expect(checkChatResume(task({ ...chat, status: 'abandoned' }), done)).toBe('abandoned')
    expect(checkChatResume(task(ready), done)).toBe('no-chat')
  })

  it('keeps a plan for later only while the task cannot run', () => {
    expect(checkSavePlan(task({ ...ready, conversationId: 'c' }))).toBeNull()
    expect(checkSavePlan(task({ ...ready, conversationId: 'c', status: 'running' }))).toBe('not-pending')
    expect(checkSavePlan(task(ready))).toBe('no-chat')
  })
})
