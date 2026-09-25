import { z } from 'zod'
import { create } from 'zustand'
import { RpcError } from '@kando/protocol'
import { useCore } from './core-store'
import { reasonText } from './labels'

// Task text typed here that core hasn't confirmed yet. It is kept in localStorage and resent
// until core takes it, so a save that fails (core down, connection dropped) is not lost, even
// when the editor closes or the window reloads before it goes through.

const Field = z.enum(['title', 'details'])
type Field = z.infer<typeof Field>
const Edit = z.object({ taskId: z.string(), field: Field, value: z.string() })
type Edit = z.infer<typeof Edit>
export type SaveState = 'saving' | 'saved' | 'failed'

const STORAGE_KEY = 'kando.unsaved-edits'
const RETRY_MS = 5000
const SAVED_SHOWN_MS = 2000

const keyOf = (taskId: string, field: Field) => `${taskId}:${field}`

function load(): Record<string, Edit> {
  try {
    const parsed = z.record(z.string(), Edit).safeParse(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

const useUnsavedEdits = create<{ edits: Record<string, Edit>; states: Record<string, SaveState> }>()(() => ({
  edits: load(),
  states: {}
}))

useUnsavedEdits.subscribe((next, previous) => {
  if (next.edits === previous.edits) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.edits))
  } catch {
    // Storage full or blocked: the edit is still retried for as long as this window lives.
  }
})

function setSaveState(key: string, state: SaveState | null): void {
  useUnsavedEdits.setState((s) => {
    const { [key]: _old, ...rest } = s.states
    return { states: state ? { ...rest, [key]: state } : rest }
  })
}

function drop(key: string): void {
  useUnsavedEdits.setState((s) => {
    const { [key]: _dropped, ...edits } = s.edits
    return { edits }
  })
}

const inFlight = new Set<string>()

async function send(key: string): Promise<void> {
  const edit = useUnsavedEdits.getState().edits[key]
  if (!edit || inFlight.has(key)) return
  const { rpc } = useCore.getState()
  if (!rpc) {
    setSaveState(key, 'failed')
    return
  }
  inFlight.add(key)
  setSaveState(key, 'saving')
  try {
    await rpc.call('tasks.update', edit.field === 'title' ? { id: edit.taskId, title: edit.value } : { id: edit.taskId, details: edit.value })
    if (useUnsavedEdits.getState().edits[key]?.value === edit.value) {
      drop(key)
      setSaveState(key, 'saved')
      setTimeout(() => {
        if (useUnsavedEdits.getState().states[key] === 'saved') setSaveState(key, null)
      }, SAVED_SHOWN_MS)
    }
  } catch (error) {
    if (error instanceof RpcError) {
      // Core refused it (the task is gone, the text is invalid): sending it again changes nothing.
      drop(key)
      setSaveState(key, null)
      if (error.reason !== 'task-not-found') {
        useCore.setState({ error: `没能保存：${reasonText(error.reason ?? '', error.message)}` })
      }
    } else {
      setSaveState(key, 'failed')
    }
  } finally {
    inFlight.delete(key)
  }
  // Typing went on while this one was in flight.
  const latest = useUnsavedEdits.getState().edits[key]
  if (latest && latest.value !== edit.value) void send(key)
}

export function saveTaskText(taskId: string, field: Field, value: string): void {
  const key = keyOf(taskId, field)
  useUnsavedEdits.setState((s) => ({ edits: { ...s.edits, [key]: { taskId, field, value } } }))
  void send(key)
}

// What the user typed last, if core has not confirmed it yet; show it instead of core's copy.
export function unsavedTaskText(taskId: string, field: Field): string | undefined {
  return useUnsavedEdits.getState().edits[keyOf(taskId, field)]?.value
}

// One state for the task's text as a whole, the most urgent first.
export function useTaskSaveState(taskId: string): SaveState | null {
  return useUnsavedEdits((s) => {
    const states = [s.states[keyOf(taskId, 'title')], s.states[keyOf(taskId, 'details')]]
    return states.includes('failed') ? 'failed' : states.includes('saving') ? 'saving' : states.includes('saved') ? 'saved' : null
  })
}

// Resends whatever is waiting once core is back, and every few seconds while it keeps failing.
export function startUnsavedEditRetries(): void {
  const retryAll = () => Object.keys(useUnsavedEdits.getState().edits).forEach((key) => void send(key))
  useCore.subscribe((next, previous) => {
    if (next.rpc && next.rpc !== previous.rpc) retryAll()
  })
  setInterval(() => {
    const { edits, states } = useUnsavedEdits.getState()
    Object.keys(edits).filter((key) => states[key] !== 'saving').forEach((key) => void send(key))
  }, RETRY_MS)
  retryAll()
}
