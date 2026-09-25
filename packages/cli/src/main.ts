import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  AgentKind,
  RpcError,
  TaskSession,
  TaskStatus,
  connectRpc,
  coreUrl,
  shortTaskId,
  type RpcConnection,
  type SourceDescriptor,
  type SourceInbox,
  type Task
} from '@kando/protocol'
import { readCoreEndpoint, kandoPaths } from '@kando/protocol/node'
import { serveMcp } from './mcp-server'
import { STATUS_LABEL } from './status-labels'
import { snapshotImagePaths, taskImageLines, uploadImageFile } from './task-images'
import { loginInTerminal } from './terminal-login'
import { forwardConversationEvent } from './conversation-event'
import { forwardTaskEvent } from './task-event'
import { forwardOriginalCodexNotify } from './codex-notify'

const USAGE = `kando <command>

  add <title...> [--details d] [--agent a] [--repo path]... [--dep id]... [--image file]...
                                         新建任务，可以直接带上项目、agent、依赖和图片
  ls [--status <s>]                      列出任务
  show <id>                              查看任务详情
  edit <id> [--title t] [--details d] [--agent claude|codex]
            [--repo path]... [--clear-repos]    项目，可重复；给出即替换原列表
            [--dep id]... [--clear-deps]        依赖的任务，可重复；给出即替换原列表
            [--image file]...                   追加图片（png/jpg/gif/webp），可重复
  move <id> done                         把未执行或执行中的任务标记为已执行
  run <id>                               在 worktree 中启动 agent 执行
  continue <id>                          已执行的任务：在原来的 worktree 上开新会话继续做
  redo <id> [--reason r]                 已执行的任务：废弃这次结果，新建一个继承它的任务
  rm <id>                                删除任务（保留 worktree）
  source ls                              各个任务来源的连接状态和收件箱
  source set <source> key=value...       保存来源的设置，例如 source set jira site=team.atlassian.net
  source login <source>                  在终端里登录来源
  source logout <source>                 删除保存的凭据（设置保留）
  source refresh <source>                立即同步收件箱
  source import <source> <key> [--agent a]
                                         把 issue 导入成任务，issue 原文作为快照保存
  mcp --task <id> [--home dir]           细化会话里 agent 用的 MCP 服务（由 Kando 自动启动）
`

function formatRow(task: Task): string {
  return `${shortTaskId(task.id)}  ${STATUS_LABEL[task.status].padEnd(3, '　')}  ${task.title}`
}

function formatInbox(inbox: SourceInbox): string {
  if (!inbox.active) {
    return '  (未启用或未登录)'
  }
  const rows = inbox.items.map((issue) => `  ${issue.key.padEnd(12)}  ${issue.status}  ${issue.title}`)
  return [
    ...(inbox.problem ? [`  上次同步失败：${inbox.problem.message}`] : []),
    rows.length ? rows.join('\n') : '  (没有待处理的 issue)',
    ...(inbox.dismissed.length ? [`  已忽略 ${inbox.dismissed.length} 个`] : [])
  ].join('\n')
}

function formatSources(sources: SourceDescriptor[], inboxes: SourceInbox[]): string {
  return sources
    .flatMap((source) =>
      source.instances.map((entry) => {
        const { credential } = entry
        const status = !credential.configured
          ? '未登录'
          : credential.source === 'env'
            ? '已登录（来自环境变量）'
            : `已登录：${credential.account ?? '（未知账号）'}`
        const inbox = inboxes.find((item) => item.provider === source.provider && item.instance === entry.instance)
        return [`${source.name}（${source.provider}）  ${status}${entry.enabled ? '' : '  已停用'}`, inbox ? formatInbox(inbox) : ''].join('\n')
      })
    )
    .join('\n\n')
}

// key=value pairs; a value may itself contain '='.
function parseSettings(pairs: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    pairs.map((pair) => {
      const at = pair.indexOf('=')
      if (at <= 0) {
        throw new Error(`设置要写成 key=value：${pair}`)
      }
      return [pair.slice(0, at), pair.slice(at + 1)]
    })
  )
}

function formatTask(task: Task): string {
  return [
    `${task.title}  [${STATUS_LABEL[task.status]}]`,
    `id:       ${task.id}`,
    `agent:    ${task.agent ?? '-'}`,
    ...(task.repos.length
      ? task.repos.map(
          (repo, index) =>
            `${index === 0 ? 'repos:   ' : '         '} ${repo.path}${repo.branch ? `  [${repo.branch}] ${repo.worktreePath ?? ''}` : ''}`
        )
      : ['repos:    -']),
    `depends:  ${task.dependsOn.length ? task.dependsOn.map(shortTaskId).join(', ') : '-'}`,
    ...(task.derivedFrom ? [`redoes:   ${shortTaskId(task.derivedFrom)}`] : []),
    ...(task.abandonReason ? [`reason:   ${task.abandonReason}`] : []),
    ...(task.source ? [`source:   ${task.source.name} ${task.source.key}  ${task.source.url}`] : []),
    '',
    task.details || '(还没有详情)',
    ...(task.images.length ? ['', '图片：', ...taskImageLines(task, kandoPaths().attachments)] : []),
    ...(task.sourceSnapshot
      ? ['', `--- ${task.source?.name ?? '来源'} 原文（拉取于 ${new Date(task.sourceSnapshot.fetchedAt).toLocaleString('zh-CN')}）---`, task.sourceSnapshot.markdown]
      : []),
    ...snapshotImagePaths(task, kandoPaths().attachments).map((image) => `  ${image.name}：${image.path ?? '（图片已丢失）'}`)
  ].join('\n')
}

async function uploadImages(rpc: RpcConnection, files: readonly string[] | undefined) {
  const uploaded = []
  for (const file of files ?? []) {
    const info = await uploadImageFile(rpc, resolveFromCaller(file))
    uploaded.push({ id: info.id, name: path.basename(file).replace(/\.[^.]+$/, '') })
  }
  return uploaded
}

async function connect(): Promise<RpcConnection> {
  const endpoint = await readCoreEndpoint()
  if (!endpoint) {
    throw new Error('Kando core 没有运行，先执行 pnpm dev:core')
  }
  return connectRpc(coreUrl(endpoint))
}

// `pnpm kando` runs from the repo root; INIT_CWD is where the user typed it.
function resolveFromCaller(repoPath: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), repoPath)
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`缺少参数 <${name}>\n\n${USAGE}`)
  }
  return value
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'task-event') {
    // Hidden agent-hook callback, like conversation-event: Codex passes JSON in argv, Claude on stdin.
    const [, home, id, sessionName, agentName, payload] = argv
    const agent = AgentKind.parse(agentName)
    const raw = payload ?? await new Promise<string>((resolve) => {
      let chunks = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => { chunks += chunk })
      process.stdin.on('end', () => resolve(chunks))
    })
    try {
      await forwardTaskEvent(home ?? '', id ?? '', TaskSession.parse(sessionName), agent, JSON.parse(raw))
    } catch {
      // A failed callback must never fail the agent's own turn.
    } finally {
      if (agent === 'codex' && payload) forwardOriginalCodexNotify(payload)
    }
    return
  }
  if (argv[0] === 'conversation-event') {
    // Hidden provider callback. Codex passes JSON in argv; Claude sends JSON on stdin.
    const [, home, id, stageId, agentName, payload] = argv
    const agent = AgentKind.parse(agentName)
    const raw = payload ?? await new Promise<string>((resolve) => {
      let chunks = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => { chunks += chunk })
      process.stdin.on('end', () => resolve(chunks))
    })
    try {
      await forwardConversationEvent(home ?? '', id ?? '', stageId ?? '', agent, JSON.parse(raw))
    } catch {
      // A failed callback must never fail the agent's own turn.
    } finally {
      if (agent === 'codex' && payload) forwardOriginalCodexNotify(payload)
    }
    return
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      status: { type: 'string' },
      title: { type: 'string' },
      details: { type: 'string' },
      repo: { type: 'string', multiple: true },
      'clear-repos': { type: 'boolean' },
      dep: { type: 'string', multiple: true },
      'clear-deps': { type: 'boolean' },
      task: { type: 'string' },
      reason: { type: 'string' },
      home: { type: 'string' },
      agent: { type: 'string' },
      image: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' }
    }
  })
  const [command, ...rest] = positionals
  if (!command || values.help) {
    console.log(USAGE)
    return
  }

  if (command === 'mcp') {
    // Speaks MCP on stdout, so nothing else may print there.
    await serveMcp(required(values.task, 'task'), values.home)
    return
  }

  const rpc = await connect()
  try {
    switch (command) {
      case 'add': {
        const images = await uploadImages(rpc, values.image)
        const task = await rpc.call('tasks.create', {
          title: rest.join(' '),
          images,
          details: values.details,
          repos: values.repo?.map(resolveFromCaller),
          dependsOn: values.dep,
          agent: values.agent ? AgentKind.parse(values.agent) : undefined
        })
        console.log(formatRow(task))
        break
      }
      case 'ls': {
        const status = values.status ? TaskStatus.parse(values.status) : undefined
        const tasks = await rpc.call('tasks.list', { status })
        console.log(tasks.length ? tasks.map(formatRow).join('\n') : '(没有任务)')
        break
      }
      case 'show':
        console.log(formatTask(await rpc.call('tasks.get', { id: required(rest[0], 'id') })))
        break
      case 'edit': {
        const task = await rpc.call('tasks.update', {
          id: required(rest[0], 'id'),
          title: values.title,
          details: values.details,
          repos: values['clear-repos'] ? [] : values.repo?.map(resolveFromCaller),
          dependsOn: values['clear-deps'] ? [] : values.dep,
          agent: values.agent ? AgentKind.parse(values.agent) : undefined
        })
        const images = await uploadImages(rpc, values.image)
        console.log(formatTask(images.length ? await rpc.call('tasks.addImages', { id: task.id, images }) : task))
        break
      }
      case 'move': {
        const status = TaskStatus.parse(required(rest[1], 'status'))
        console.log(formatRow(await rpc.call('tasks.move', { id: required(rest[0], 'id'), status })))
        break
      }
      case 'run': {
        const task = await rpc.call('tasks.run', { id: required(rest[0], 'id') })
        const dirs = task.repos.map((repo) => repo.worktreePath ?? repo.path).join('、')
        console.log(`${formatRow(task)}\n已在 ${dirs} 启动 ${task.agent}`)
        break
      }
      case 'continue': {
        const task = await rpc.call('tasks.continue', { id: required(rest[0], 'id') })
        const dirs = task.repos.map((repo) => repo.worktreePath ?? repo.path).join('、')
        console.log(`${formatRow(task)}\n已在 ${dirs} 继续`)
        break
      }
      case 'redo': {
        const successor = await rpc.call('tasks.redo', { id: required(rest[0], 'id'), reason: values.reason })
        console.log(`已废弃原任务，新任务：\n${formatRow(successor)}`)
        break
      }
      case 'source': {
        const [sub, provider, ...args] = rest
        const instance = 'default'
        if (sub === 'ls') {
          const [sources, inboxes] = await Promise.all([rpc.call('sources.list', {}), rpc.call('sources.inbox', {})])
          console.log(formatSources(sources, inboxes))
        } else if (sub === 'set') {
          const saved = await rpc.call('sources.saveSettings', {
            provider: required(provider, 'source'),
            instance,
            settings: parseSettings(args)
          })
          console.log(formatSources([saved], []))
        } else if (sub === 'login') {
          console.log(`已登录：${await loginInTerminal(rpc, required(provider, 'source'), instance)}`)
        } else if (sub === 'logout') {
          await rpc.call('sources.disconnect', { provider: required(provider, 'source'), instance })
          console.log('已删除保存的凭据')
        } else if (sub === 'refresh') {
          console.log(formatInbox(await rpc.call('sources.refresh', { provider: required(provider, 'source'), instance })))
        } else if (sub === 'import') {
          const agent = values.agent ? AgentKind.parse(values.agent) : undefined
          const task = await rpc.call('sources.import', {
            provider: required(provider, 'source'),
            instance,
            key: required(args[0], 'key'),
            agent
          })
          console.log(formatRow(task))
        } else {
          throw new Error(`未知命令 source ${sub ?? ''}\n\n${USAGE}`)
        }
        break
      }
      case 'rm':
        await rpc.call('tasks.delete', { id: required(rest[0], 'id') })
        console.log('已删除')
        break
      default:
        throw new Error(`未知命令 ${command}\n\n${USAGE}`)
    }
  } finally {
    rpc.close()
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const reason = error instanceof RpcError && error.reason ? ` (${error.reason})` : ''
  console.error(`kando: ${error instanceof Error ? error.message : String(error)}${reason}`)
  process.exitCode = 1
})
