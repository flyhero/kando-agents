import { z } from 'zod'
import type { ChatTodo } from '@kando/protocol'

// Claude Code keeps its checklist with task tools: TaskCreate adds one (its result names the id),
// TaskUpdate changes one by id, TaskList restates them all. Older versions wrote the whole list
// with TodoWrite instead. Their cards stay out of the chat; this turns the calls back into the list.
export const CLAUDE_TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite'])

const Status = z.enum(['pending', 'in_progress', 'completed']).catch('pending')
const Text = z.string().trim().min(1).optional().catch(undefined)
const Task = z.looseObject({ id: z.union([z.string(), z.number()]).transform(String), subject: Text, status: Status.optional(), activeForm: Text })
const CreateInput = z.looseObject({ subject: Text, activeForm: Text })
const UpdateInput = z.looseObject({ taskId: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined), subject: Text, status: Status.optional(), activeForm: Text })
const Result = z.looseObject({ task: Task.optional().catch(undefined), tasks: z.array(z.unknown()).optional().catch(undefined) })
const Todos = z.looseObject({ todos: z.array(z.looseObject({ content: z.string(), status: Status, activeForm: Text })).catch([]) })

type Entry = { content: string; status: ChatTodo['status']; activeForm: string | null }

export class ClaudeTasks {
  private readonly entries = new Map<string, Entry>()
  // Calls whose result has not come back, by tool use id, with what they asked for.
  private readonly calls = new Map<string, { name: string; input: unknown }>()

  call(name: string, toolUseId: string, input: unknown): void {
    if (name === 'TodoWrite') {
      this.entries.clear()
      Todos.parse(input).todos.forEach((todo, index) =>
        this.entries.set(String(index), { content: todo.content, status: todo.status, activeForm: todo.activeForm ?? null })
      )
      return
    }
    this.calls.set(toolUseId, { name, input })
  }

  result(toolUseId: string, result: unknown): void {
    const call = this.calls.get(toolUseId)
    if (!call) return
    this.calls.delete(toolUseId)
    const parsed = Result.safeParse(result)
    const data = parsed.success ? parsed.data : {}
    if (data.tasks) {
      // A listing is the whole truth; it leaves out how each step reads while under way.
      const known = new Map(this.entries)
      this.entries.clear()
      for (const raw of data.tasks) {
        const task = Task.safeParse(raw)
        if (!task.success) continue
        const before = known.get(task.data.id)
        this.entries.set(task.data.id, {
          content: task.data.subject ?? before?.content ?? task.data.id,
          status: task.data.status ?? before?.status ?? 'pending',
          activeForm: task.data.activeForm ?? before?.activeForm ?? null
        })
      }
      return
    }
    if (call.name === 'TaskCreate') {
      const input = CreateInput.parse(call.input)
      const id = data.task?.id ?? toolUseId
      this.entries.set(id, {
        content: data.task?.subject ?? input.subject ?? id,
        status: data.task?.status ?? 'pending',
        activeForm: input.activeForm ?? data.task?.activeForm ?? null
      })
      return
    }
    if (call.name === 'TaskUpdate') {
      const input = UpdateInput.parse(call.input)
      const id = input.taskId
      if (!id) return
      const before = this.entries.get(id)
      this.entries.set(id, {
        content: input.subject ?? before?.content ?? id,
        status: input.status ?? before?.status ?? 'pending',
        activeForm: input.activeForm ?? before?.activeForm ?? null
      })
    }
  }

  list(): ChatTodo[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }))
  }
}
