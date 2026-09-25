import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, TaskStore } from './task-store'
import { ProjectRegistry } from './project-registry'
import { ConversationStore } from './conversation-store'

describe('TaskStore migrations', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kando-store-'))
    file = path.join(dir, 'kando.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('upgrades a version-1 database: old statuses fold into pending, the repo moves to its own table', () => {
    const raw = new DatabaseSync(file)
    raw.exec(MIGRATIONS[0] ?? '')
    raw.exec('PRAGMA user_version = 1')
    const insert = raw.prepare(
      `INSERT INTO tasks (id, title, details, status, repo_path, worktree_path, branch, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, 0, 0)`
    )
    insert.run('t1', 'seed', 'seed', null, null, null)
    insert.run('t2', 'ripe', 'ripe', '/code/app', null, null)
    insert.run('t3', 'done', 'done', '/code/app', '/wt/app/t3', 'kando/t3')
    raw.close()

    const store = new TaskStore(file)
    const projects = new ProjectRegistry(file)
    expect(projects.recent()).toEqual(['/code/app'])
    projects.close()
    expect(store.list().map((task) => [task.id, task.status, task.repos])).toEqual(
      expect.arrayContaining([
        ['t1', 'pending', []],
        ['t2', 'pending', [{ path: '/code/app', worktreePath: null, branch: null }]],
        ['t3', 'done', [{ path: '/code/app', worktreePath: '/wt/app/t3', branch: 'kando/t3' }]]
      ])
    )
    store.close()
  })

  it('stores repos in order and dependencies alongside', () => {
    const store = new TaskStore(file)
    const a = store.create('A')
    const b = store.create('B')
    const repos = ['/z', '/a'].map((repoPath) => ({ path: repoPath, worktreePath: null, branch: null }))
    store.update(b.id, { repos, dependsOn: [a.id] })
    expect(store.get(b.id)).toMatchObject({ repos, dependsOn: [a.id] })
    expect(store.dependents(a.id).map((task) => task.id)).toEqual([b.id])
    store.close()
  })

  it('round-trips a proposal and treats unreadable ones as absent', () => {
    const store = new TaskStore(file)
    const task = store.create('A')
    const proposal = { markdown: '# Plan', agent: 'claude' as const, createdAt: 5 }
    expect(store.update(task.id, { proposal }).proposal).toEqual(proposal)
    store.close()

    const raw = new DatabaseSync(file)
    raw.prepare('UPDATE tasks SET proposal = ? WHERE id = ?').run('{not json', task.id)
    raw.close()
    const reopened = new TaskStore(file)
    expect(reopened.get(task.id)?.proposal).toBeNull()
    reopened.close()
  })

  it('upgrades a version-7 database: Jira sources gain provider and instance, dismissals follow', () => {
    const raw = new DatabaseSync(file)
    MIGRATIONS.slice(0, 7).forEach((sql) => raw.exec(sql))
    raw.exec('PRAGMA user_version = 7')
    raw
      .prepare(`INSERT INTO tasks (id, title, details, status, source, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, 0, 0)`)
      .run('t1', 'Bug', '旧的导入内容', JSON.stringify({ kind: 'jira', key: 'PROJ-1', url: 'https://acme.atlassian.net/browse/PROJ-1' }))
    raw.prepare('INSERT INTO dismissed_issues (kind, key, dismissed_at) VALUES (?, ?, ?)').run('jira', 'PROJ-2', 9)
    raw.close()

    const store = new TaskStore(file)
    expect(store.get('t1')).toMatchObject({
      details: '旧的导入内容',
      source: { provider: 'jira', instance: 'default', name: 'Jira', key: 'PROJ-1', url: 'https://acme.atlassian.net/browse/PROJ-1' },
      sourceSnapshot: null
    })
    expect(store.dismissedIssues('jira', 'default')).toEqual(new Set(['PROJ-2']))
    expect(store.dismissedIssues('jira', 'other')).toEqual(new Set())
    store.close()
  })

  it('retains the selected project when upgrading single-project conversations', () => {
    const raw = new DatabaseSync(file)
    // Found by content, so migrations added after it keep this test valid.
    const upgrade = MIGRATIONS.findIndex((sql) => sql.includes('ADD COLUMN project_paths'))
    MIGRATIONS.slice(0, upgrade).forEach((sql) => raw.exec(sql))
    raw.exec(`PRAGMA user_version = ${upgrade}`)
    raw.prepare(`INSERT INTO conversations
      (id, title, title_locked, agent, workspace_path, managed_workspace, created_at, updated_at)
      VALUES (?, '旧会话', 0, 'claude', ?, 0, 1, 1)`)
      .run('00000000-0000-4000-8000-000000000001', '/code/project')
    raw.prepare(`INSERT INTO conversations
      (id, title, title_locked, agent, workspace_path, managed_workspace, created_at, updated_at)
      VALUES (?, '无项目', 0, 'codex', ?, 1, 2, 2)`)
      .run('00000000-0000-4000-8000-000000000002', '/kando/sessions/session/workspace')
    raw.close()
    const tasks = new TaskStore(file)
    const conversations = new ConversationStore(file)
    expect(conversations.get('00000000-0000-4000-8000-000000000001')?.projectPaths).toEqual(['/code/project'])
    expect(conversations.get('00000000-0000-4000-8000-000000000002')?.projectPaths).toEqual([])
    conversations.close()
    tasks.close()
  })
})
