import type { ChatContextUse, ChatItem, ChatModel, ChatTodo } from '@kando/protocol'
import type { ChatItems } from './chat-items'

type StateItem = Extract<ChatItem, { kind: 'state' }>
export type StageStateFields = Omit<StateItem, 'id' | 'kind' | 'stageId' | 'revision' | 'at'>

const INITIAL: StageStateFields = {
  permissionMode: null,
  permissionModes: [],
  model: null,
  models: [],
  effort: null,
  context: null,
  todos: [],
  activity: null,
  queued: null,
  queue: [],
  steerable: false
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// A stage's options, progress and queue as one item the composer reads. Drivers change fields as
// frames come in and publish once per record, so a burst of frames sends one update.
export class StageState {
  private fields: StageStateFields = INITIAL
  private published: StageStateFields | null = null

  constructor(private readonly items: ChatItems) {}

  get current(): StageStateFields {
    return this.fields
  }

  set(patch: Partial<StageStateFields>): void {
    this.fields = { ...this.fields, ...patch }
  }

  setModels(models: ChatModel[]): void {
    this.set({ models })
  }

  setContext(context: ChatContextUse): void {
    this.set({ context })
  }

  // The checklist changed during the turn `ref`: the stage's state and that turn's todos item follow.
  setTodos(todos: ChatTodo[], ref: string | null, at: number): void {
    if (same(todos, this.fields.todos)) return
    this.set({ todos })
    if (ref !== null) this.items.put({ id: `todos:${ref}`, kind: 'todos', todos }, at)
  }

  endTurn(): void {
    this.set({ activity: null })
  }

  publish(at: number): void {
    if (this.published && same(this.published, this.fields)) return
    this.published = this.fields
    this.items.put({ id: 'state', kind: 'state', ...this.fields }, at)
  }
}
