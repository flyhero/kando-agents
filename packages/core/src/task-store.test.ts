import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, TaskStore } from './task-store'
import { ProjectRegistry } from './project-registry'
import { ConversationStore } from './conversation-store'
import { AgentRunStore } from './agent-run-store'

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
        ['t2', 'pending', [{ path: '/code/app', worktreePath: null, branch: null, startRef: null, start: null }]],
        ['t3', 'done', [{ path: '/code/app', worktreePath: '/wt/app/t3', branch: 'kando/t3', startRef: null, start: null }]]
      ])
    )
    store.close()
  })

  it('stores repos in order and dependencies alongside', () => {
    const store = new TaskStore(file)
    const a = store.create('A')
    const b = store.create('B')
    const repos = ['/z', '/a'].map((repoPath) => ({ path: repoPath, worktreePath: null, branch: null, startRef: null, start: null }))
    store.update(b.id, { repos, dependsOn: [a.id] })
    expect(store.get(b.id)).toMatchObject({ repos, dependsOn: [a.id] })
    expect(store.dependents(a.id).map((task) => task.id)).toEqual([b.id])
    store.close()
  })

  it('round-trips a source and treats an unreadable one as absent', () => {
    const store = new TaskStore(file)
    const task = store.create('A')
    const source = { provider: 'jira', instance: 'default', name: 'Jira', key: 'PROJ-1', url: 'https://acme.atlassian.net/browse/PROJ-1' }
    expect(store.update(task.id, { source }).source).toEqual(source)
    store.close()

    const raw = new DatabaseSync(file)
    raw.prepare('UPDATE tasks SET source = ? WHERE id = ?').run('{not json', task.id)
    raw.close()
    const reopened = new TaskStore(file)
    expect(reopened.get(task.id)?.source).toBeNull()
    reopened.close()
  })

  it('drops what the terminal view left: tasks run there with their runs, terminal stages, and conversations with no other', () => {
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA foreign_keys = ON')
    const dropTerminal = MIGRATIONS.findIndex((sql) => sql.includes('DROP COLUMN output_offset'))
    MIGRATIONS.slice(0, dropTerminal).forEach((sql) => raw.exec(sql))
    raw.exec(`PRAGMA user_version = ${dropTerminal}`)
    const task = raw.prepare("INSERT INTO tasks (id, title, status, agent, session_id, created_at, updated_at) VALUES (?, ?, ?, 'claude', ?, 0, 0)")
    task.run('terminal-done', 'Ran in a terminal', 'done', 'pty-1')
    task.run('refined', 'Only refined', 'pending', null)
    task.run('chat-task', 'Ran in its chat', 'review', null)
    task.run('waits', 'Waits on the terminal one', 'pending', null)
    raw.prepare("UPDATE tasks SET refine_session_id = 'pty-2', proposal = '{}' WHERE id = 'refined'").run()
    raw.prepare("INSERT INTO task_dependencies (task_id, depends_on) VALUES ('waits', 'terminal-done')").run()
    raw.prepare("INSERT INTO task_repos (task_id, position, path, worktree_path) VALUES ('terminal-done', 0, '/code/app', '/wt/app')").run()
    const runRow = raw.prepare("INSERT INTO agent_runs (id, task_id, kind, view, agent, started_at) VALUES (?, ?, 'run', ?, 'claude', 0)")
    runRow.run('terminal-run', 'terminal-done', 'terminal')
    runRow.run('chat-run', 'chat-task', 'chat')
    const conversation = raw.prepare("INSERT INTO conversations (id, title, title_locked, agent, workspace_path, managed_workspace, session_id, created_at, updated_at, task_id) VALUES (?, ?, 0, 'claude', '/code/app', 0, ?, 0, 0, ?)")
    conversation.run('11111111-1111-4111-8111-111111111111', 'Terminal only', null, null)
    conversation.run('22222222-2222-4222-8222-222222222222', 'Terminal, then chat', 'pty-3', null)
    conversation.run('33333333-3333-4333-8333-333333333333', 'The task chat', null, 'chat-task')
    const stage = raw.prepare("INSERT INTO conversation_stages (id, conversation_id, agent, session_id, started_at, mode) VALUES (?, ?, 'claude', ?, ?, ?)")
    stage.run('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', null, 1, 'tui')
    stage.run('aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', null, 1, 'chat')
    stage.run('aaaaaaaa-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'pty-3', 2, 'tui')
    stage.run('aaaaaaaa-0000-4000-8000-000000000004', '33333333-3333-4333-8333-333333333333', null, 1, 'chat')
    raw.prepare("INSERT INTO conversation_messages (conversation_id, stage_id, role, agent, text, event_key, complete, created_at) VALUES ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000003', 'user', 'claude', 'hi', 'u1', 1, 0)").run()
    raw.close()

    const store = new TaskStore(file)
    const conversations = new ConversationStore(file)
    const runs = new AgentRunStore(file)
    expect(store.list().map((each) => each.id).sort()).toEqual(['chat-task', 'refined', 'waits'])
    expect(store.get('waits')?.dependsOn).toEqual([])
    expect(runs.list().map((each) => each.id)).toEqual(['chat-run'])
    expect(conversations.list().map((each) => [each.title, each.sessionId]).sort()).toEqual([['Terminal, then chat', null], ['The task chat', null]])
    expect(conversations.stages('22222222-2222-4222-8222-222222222222').map((each) => each.id)).toEqual(['aaaaaaaa-0000-4000-8000-000000000002'])
    expect(conversations.messages('22222222-2222-4222-8222-222222222222')).toEqual([])
    const schema = new DatabaseSync(file)
    const columns = (table: string) => schema.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => String(row.name))
    expect(columns('tasks').filter((name) => ['session_id', 'refine_session_id', 'proposal', 'previous_details', 'last_exit'].includes(name))).toEqual([])
    expect(columns('conversations')).not.toContain('output_offset')
    expect(columns('conversation_stages')).not.toContain('mode')
    expect(columns('agent_runs').filter((name) => name === 'view' || name === 'exit_code')).toEqual([])
    schema.close()
    runs.close()
    conversations.close()
    store.close()
  })

  it('moves the usage-limit resumes still waiting over to scheduled runs, and drops the ones turned off', () => {
    const raw = new DatabaseSync(file)
    raw.exec('PRAGMA foreign_keys = ON')
    const fold = MIGRATIONS.findIndex((sql) => sql.includes('FROM conversation_usage_limits l'))
    MIGRATIONS.slice(0, fold).forEach((sql) => raw.exec(sql))
    raw.exec(`PRAGMA user_version = ${fold}`)
    raw.prepare(`INSERT INTO conversations (id, title, title_locked, agent, workspace_path, managed_workspace, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'Payments', 0, 'claude', '/code/app', 0, 0, 0)`).run()
    raw.prepare(`INSERT INTO scheduled_runs (id, target, title, agent, position, status, created_at, updated_at)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '{"kind":"task","taskId":"t1"}', 'Night', 'claude', 3, 'waiting', 0, 0)`).run()
    const limit = raw.prepare(`INSERT INTO conversation_usage_limits (id, conversation_id, stage_id, item_id, agent, resets_at, continue_at, auto_continue, status, attempts, error, created_at, updated_at)
      VALUES (?, '11111111-1111-4111-8111-111111111111', ?, ?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?)`)
    limit.run('bbbbbbbb-0000-4000-8000-000000000001', 'stage-1', 'limit:1', 1000, 1005, 1, 'waiting', 0, null, 10, 10)
    limit.run('bbbbbbbb-0000-4000-8000-000000000002', 'stage-2', 'limit:2', null, 2000, 1, 'retrying', 1, 'spawn failed', 20, 20)
    limit.run('bbbbbbbb-0000-4000-8000-000000000003', 'stage-3', 'limit:3', 3000, null, 0, 'waiting', 0, null, 30, 30)
    limit.run('bbbbbbbb-0000-4000-8000-000000000004', 'stage-4', 'limit:4', 4000, null, 1, 'continued', 0, null, 40, 40)
    raw.close()

    new TaskStore(file).close()
    const schema = new DatabaseSync(file)
    const runs = schema.prepare('SELECT id, target, title, agent, not_before AS notBefore, check_at AS checkAt, resets_at AS resetsAt, position, status, attempts, error FROM scheduled_runs ORDER BY position').all()
    expect(runs).toEqual([
      expect.objectContaining({ id: 'aaaaaaaa-0000-4000-8000-000000000001', position: 3 }),
      expect.objectContaining({
        id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Payments', agent: 'claude', notBefore: 6000, checkAt: 1005, resetsAt: 1000, position: 4, status: 'waiting', attempts: 0, error: null,
        target: JSON.stringify({ kind: 'resume', conversationId: '11111111-1111-4111-8111-111111111111', stageId: 'stage-1', itemId: 'limit:1' })
      }),
      expect.objectContaining({ id: 'bbbbbbbb-0000-4000-8000-000000000002', notBefore: null, checkAt: 2000, position: 5, status: 'starting', attempts: 1, error: 'spawn failed' })
    ])
    expect(schema.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_usage_limits'").all()).toEqual([])
    schema.close()
  })

  it('keeps a task\'s plan, and finds the conversation that runs it through that conversation', () => {
    const store = new TaskStore(file)
    const conversations = new ConversationStore(file)
    const task = store.create('Chat me')
    expect(task).toMatchObject({ plan: null, conversationId: null })
    const plan = { markdown: '1. Do it', agent: 'claude' as const, approved: false, stageId: 's', requestId: 'r', createdAt: 5 }
    expect(store.update(task.id, { plan }).plan).toEqual(plan)
    const conversation = conversations.create('claude', '/code/app', ['/code/app'], undefined, {}, { id: task.id, title: task.title })
    expect(conversation).toMatchObject({ taskId: task.id, title: 'Chat me', titleLocked: true, planOnly: false })
    expect(store.get(task.id)?.conversationId).toBe(conversation.id)
    expect(conversations.byTask(task.id)?.id).toBe(conversation.id)
    const stage = conversations.startStage(conversation.id, 'claude', null, 0, undefined, true)
    expect(stage.planOnly).toBe(true)
    expect(conversations.get(conversation.id)?.planOnly).toBe(true)
    const moved = conversations.moveWorkspace(conversation.id, '/wt/app', ['/wt/app', '/wt/web'])
    expect(moved).toMatchObject({ workspacePath: '/wt/app', projectPaths: ['/wt/app', '/wt/web'], managedWorkspace: false })
    expect(store.update(task.id, { plan: null }).plan).toBeNull()
    conversations.close()
    store.close()
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

  it('adds an empty run record to a database from before runs were kept, leaving its tasks as they were', () => {
    const raw = new DatabaseSync(file)
    const upgrade = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE agent_runs'))
    MIGRATIONS.slice(0, upgrade).forEach((sql) => raw.exec(sql))
    raw.exec(`PRAGMA user_version = ${upgrade}`)
    raw.prepare("INSERT INTO tasks (id, title, details, status, agent, created_at, updated_at) VALUES ('t1', 'old', '', 'done', 'codex', 1, 1)").run()
    raw.close()
    const tasks = new TaskStore(file)
    const runs = new AgentRunStore(file)
    expect(tasks.get('t1')?.status).toBe('done')
    // Nothing is made up for work done before: which done tasks were accepted cannot be told apart.
    expect(runs.list()).toEqual([])
    runs.close()
    tasks.close()
  })
})
