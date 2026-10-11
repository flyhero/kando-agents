import { useEffect, useState } from 'react'
import { checkStartMode, type ChatCatalog, type ChatPermissionMode, type Task, type TaskLaunchOptions } from '@kando/protocol'
import { resolveModel, useAgentCatalog, type ResolvedModel } from '../agent-models'
import { updateTask, useCore, useTaskLaunchSupported } from '../core-store'
import { usePreferences } from '../preferences'
import { ChatModelPicker } from './ChatPicker'
import { effortLabel, startModes } from './ChatOptionsBar'

export type TaskLaunch = ResolvedModel & {
  // undefined while core is asked, null when the agent lists none.
  catalog: ChatCatalog | null | undefined
  offered: readonly ChatPermissionMode[]
  // The task's own mode while it can take it, else planning.
  mode: ChatPermissionMode
  // Unfinished dependencies leave planning only.
  planOnly: boolean
}

// How the task starts from its details: as its launch says, within what its agent and model offer
// now. null when not `enabled`, when core does not keep a launch, or when there is no agent to start.
export function useTaskLaunch(task: Task, dependencies: readonly Task[], enabled = true): TaskLaunch | null {
  const supported = useTaskLaunchSupported() && enabled
  const allowBypass = usePreferences((s) => s.allowBypass)
  const catalog = useAgentCatalog(task.agent, supported && task.status === 'pending')
  if (!supported || !task.agent) return null
  const resolved = resolveModel(catalog, { model: task.launch.model ?? undefined, effort: task.launch.effort ?? undefined })
  const offered = startModes(task.agent, resolved.model, allowBypass)
  const wanted = task.launch.permissionMode ?? 'plan'
  // Auto depends on the model, so the task's mode stands until the catalog says otherwise.
  const takes = offered.includes(wanted) || catalog === undefined
  const mode = takes && !checkStartMode(dependencies, wanted) ? wanted : 'plan'
  return { ...resolved, catalog, offered, mode, planOnly: checkStartMode(dependencies, 'ask') !== null }
}

// What a start sends: the mode it shows, and the model and effort as the catalog takes them. Before
// the catalog is in, core uses the task's own.
export function launchOptions(launch: TaskLaunch): TaskLaunchOptions {
  return launch.catalog
    ? { permissionMode: launch.mode, model: launch.modelId ?? null, effort: launch.effort ?? null }
    : { permissionMode: launch.mode }
}

// Whether one of the task's projects is no git repository, so a start that edits writes there itself.
export function useEditsInPlace(task: Task, enabled = true): boolean {
  const rpc = useCore((s) => s.rpc)
  const [inPlace, setInPlace] = useState(false)
  useEffect(() => {
    if (!enabled || !rpc?.features.includes('task-start')) return
    let current = true
    rpc.call('tasks.startOptions', { id: task.id }).then((repos) => {
      if (current) setInPlace(repos.some((repo) => !repo.git))
    }, () => {})
    return () => { current = false }
  }, [enabled, rpc, task.id, task.repos])
  return inPlace
}

// The model and effort the task starts in, kept on the task as they are picked. The default model
// shows by name, so the button always says what will run.
export function TaskModelPicker({ task, launch }: { task: Task; launch: TaskLaunch }) {
  const { catalog } = launch
  if (!catalog?.models.length) return null
  const shown = launch.modelId ?? launch.defaultModel?.id ?? null
  const save = (next: TaskLaunchOptions) => void updateTask(task.id, { launch: { ...task.launch, ...next } })
  return (
    <ChatModelPicker
      models={catalog.models.map((each) => ({ value: each.id, label: each.label, description: each.description, efforts: each.efforts.map((one) => ({ value: one, label: effortLabel(one) })) }))}
      model={shown}
      effort={launch.effort ?? null}
      align="start"
      placement="below"
      size="large"
      onModel={(model) => {
        const efforts = catalog.models.find((each) => each.id === model)?.efforts ?? []
        save({ model, effort: launch.effort && efforts.includes(launch.effort) ? launch.effort : null })
      }}
      onEffort={(effort) => save({ model: shown, effort })}
    />
  )
}
