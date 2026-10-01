import { randomUUID } from 'node:crypto'
import type { AgentKind, ChatImage, ChatItem, ChatOption, ChatQueued, ChatTurnActivity } from '@kando/protocol'
import type { AttachmentStore } from './attachment-store'
import type { ChatAnswer, ChatDriver, ChatImageFile, ChatOutgoing, ChatStageOptions, StageMessage } from './chat-driver'
import { ChatLog, type LoggedRecord } from './chat-log'
import type { KandoAsk, KandoResolution } from './kando-requests'
import { ClaudeStream } from './claude-stream'
import { CodexAppServer } from './codex-app-server'
import type { SessionHost } from './daemon-client'
import { LineFramer } from './line-framer'
import { Rejection } from './rejection'

const START_TIMEOUT_MS = 30_000
const STDERR_TAIL_CHARS = 8 * 1024
// Ended stages kept rebuilt in memory, most recently read last.
const HISTORY_CACHE = 20

export type ChatStage = { conversationId: string; stageId: string; agent: AgentKind; options: ChatStageOptions }

// Where a chat stage's news goes: to the clients watching it, and into the conversation's records.
export type ChatSink = {
  items(conversationId: string, items: ChatItem[]): void
  delta(conversationId: string, stageId: string, itemId: string, append: string): void
  messages(stage: ChatStage, messages: StageMessage[]): void
  // The provider session (Claude session, Codex thread) the stage turned out to run.
  provider(stage: ChatStage, providerSessionId: string): void
  activity(conversationId: string): void
  // How far the stage's output has been read, for picking up after a restart.
  offset(stageId: string, end: number): void
}

type Live = ChatStage & {
  sessionId: string
  driver: ChatDriver
  log: ChatLog
  framer: LineFramer
  // Until the daemon's buffer has been read, live output waits here.
  attached: boolean
  queued: Array<{ offset: number; data: string }>
  exitedEarly: { code: number } | null
  stderr: string
  activity: ChatTurnActivity
  provider: string | null
  started: { resolve(): void; reject(error: Error): void } | null
  // When anything last went either way, or the user last changed something.
  lastActive: number
}

export function createDriver(stage: ChatStage): ChatDriver {
  switch (stage.agent) {
    case 'claude':
      return new ClaudeStream(stage.stageId, stage.options)
    case 'codex':
      return new CodexAppServer(stage.stageId, stage.options)
  }
}

const ignore = () => {}

// Drives the chat-mode agents core has running: feeds each one's output to its driver, sends what
// the driver or the user asks for, and keeps the stage's log.
export class ChatHost {
  private readonly lives = new Map<string, Live>()
  private readonly history = new Map<string, ChatDriver>()

  constructor(
    private readonly daemon: SessionHost,
    private readonly sessionsRoot: string,
    // Where a message's images are read from; the caller has checked they are there.
    private readonly attachments: Pick<AttachmentStore, 'fileOf'>,
    private readonly sink: ChatSink,
    private readonly now: () => number = Date.now
  ) {}

  owns(sessionId: string): boolean {
    return this.lives.has(sessionId)
  }

  // Takes over the process a chat stage runs: its log is replayed first, then whatever the daemon
  // holds past it, while output arriving meanwhile waits so nothing is read twice or out of order.
  // With waitForStart it resolves once the agent can take a message.
  async open(stage: ChatStage, sessionId: string, consumed: number, waitForStart: boolean): Promise<void> {
    const open = this.lives.get(sessionId)
    if (open) return this.catchUp(open)
    const log = ChatLog.of(this.sessionsRoot, stage.conversationId, stage.stageId)
    const driver = createDriver(stage)
    const { records, end } = log.read()
    records.forEach((record) => driver.apply(record))
    const live: Live = {
      ...stage,
      sessionId,
      driver,
      log,
      framer: new LineFramer(Math.max(consumed, end)),
      attached: false,
      queued: [],
      exitedEarly: null,
      stderr: '',
      activity: driver.activity(),
      provider: null,
      started: null,
      lastActive: records.at(-1)?.at ?? this.now()
    }
    this.lives.set(sessionId, live)
    this.history.delete(stage.stageId)
    const started = waitForStart
      ? new Promise<void>((resolve, reject) => { live.started = { resolve, reject } })
      : null
    try {
      await this.catchUp(live)
    } catch (error) {
      this.lives.delete(sessionId)
      live.started = null
      throw error
    }
    if (started) await this.withinStartTimeout(started)
  }

  // Drops a stage that never got going without logging its end.
  forget(sessionId: string, stageId: string): void {
    this.lives.delete(sessionId)
    this.history.delete(stageId)
  }

  // Reads what the daemon holds past what the stage has seen: on open, and again after the
  // connection to the daemon dropped and output went by unseen.
  private async catchUp(live: Live): Promise<void> {
    live.attached = false
    const snapshot = await this.daemon.request('attach', { sessionId: live.sessionId })
    live.stderr = (snapshot.stderr ?? '').slice(-STDERR_TAIL_CHARS)
    this.feed(live, snapshot.bufferStart, snapshot.buffer)
    live.queued.sort((a, b) => a.offset - b.offset).forEach((event) => this.feed(live, event.offset, event.data))
    live.queued = []
    live.attached = true
    this.pump(live)
    this.flush(live)
    const exitCode = snapshot.exited ? snapshot.exitCode : live.exitedEarly?.code
    if (exitCode !== undefined) this.end(live, exitCode)
  }

  handleData(sessionId: string, offset: number, data: string): boolean {
    const live = this.lives.get(sessionId)
    if (!live) return false
    if (!live.attached) {
      live.queued.push({ offset, data })
      return true
    }
    this.feed(live, offset, data)
    this.pump(live)
    this.flush(live)
    return true
  }

  handleStderr(sessionId: string, data: string): void {
    const live = this.lives.get(sessionId)
    if (live) live.stderr = (live.stderr + data).slice(-STDERR_TAIL_CHARS)
  }

  handleExit(sessionId: string, exitCode: number | null): void {
    const live = this.lives.get(sessionId)
    if (!live) return
    // The attach reply may predate the exit; open() finishes the stage once it has the buffer.
    if (!live.attached) {
      live.exitedEarly = { code: exitCode ?? -1 }
      return
    }
    this.end(live, exitCode)
  }

  activity(conversationId: string): ChatTurnActivity | null {
    return this.liveOf(conversationId)?.driver.activity() ?? null
  }

  // Whether the running stage holds nothing the user would lose if its agent went: no turn, no
  // request waiting on the user, no message queued or held.
  idle(conversationId: string): boolean {
    const live = this.liveOf(conversationId)
    return live !== undefined && this.isIdle(live)
  }

  // Conversations whose agent has sat idle since before `before`.
  idleSince(before: number): string[] {
    return [...this.lives.values()].filter((live) => live.lastActive < before && this.isIdle(live)).map((live) => live.conversationId)
  }

  private isIdle(live: Live): boolean {
    return live.attached && live.driver.ready() && live.driver.activity() === 'idle' && this.queued(live).length === 0
  }

  // A running stage's items, or an ended one's rebuilt from its log.
  items(stage: ChatStage): ChatItem[] {
    const live = [...this.lives.values()].find((each) => each.stageId === stage.stageId)
    if (live) return live.driver.items.list()
    let driver = this.history.get(stage.stageId)
    if (driver) {
      this.history.delete(stage.stageId)
    } else {
      driver = createDriver(stage)
      const replayed = driver
      ChatLog.of(this.sessionsRoot, stage.conversationId, stage.stageId).read().records.forEach((record) => replayed.apply(record))
    }
    this.remember(stage.stageId, driver)
    return driver.items.list()
  }

  // While a turn runs: with steer, the message goes into it (an agent that takes none rejects);
  // with queue, it waits its turn behind any already waiting. Idle, it starts a turn either way.
  async send(conversationId: string, text: string, images: readonly ChatImage[] = [], queue = false, steer = false): Promise<void> {
    const live = this.running(conversationId)
    const busy = live.driver.activity() !== 'idle'
    if (busy && queue && !steer) {
      this.enqueue(live, text, images)
      return
    }
    const outgoing = busy && steer ? live.driver.steer(text, this.files(images)) : live.driver.send(text, this.files(images))
    const sent = this.dispatch(live, outgoing, randomUUID(), images)
    this.flush(live)
    await sent
  }

  // Drops the waiting message with this ref, or all of them.
  cancelQueued(conversationId: string, ref?: string): void {
    const live = this.running(conversationId)
    this.record(live, { dir: 'queue', at: this.now(), text: null, ...(ref ? { ref } : {}) })
    this.flush(live)
  }

  // Lets a message a failed turn held go out when the agent is idle: the one with this ref, or the
  // first. With now, it leaves the queue and goes at once, into the running turn if there is one.
  async sendQueued(conversationId: string, ref?: string, now = false): Promise<void> {
    const live = this.running(conversationId)
    const entry = this.queued(live).find((each) => ref === undefined || each.ref === ref)
    if (!entry) throw new Rejection('chat-nothing-queued', 'no message is waiting')
    if (now) {
      if (live.driver.activity() !== 'idle' && !live.driver.canSteer()) throw new Rejection('chat-no-steer', 'the agent takes no message into a running turn')
      this.record(live, { dir: 'queue', at: this.now(), text: null, ref: entry.ref })
      await this.send(conversationId, entry.text, entry.images, false, true)
      return
    }
    this.record(live, { dir: 'queue', at: this.now(), text: null, ref: entry.ref, release: true })
    this.pump(live)
    this.flush(live)
  }

  private enqueue(live: Live, text: string, images: readonly ChatImage[]): void {
    this.record(live, { dir: 'queue', at: this.now(), text, ref: randomUUID(), ...(images.length ? { images: [...images] } : {}) })
    this.pump(live)
    this.flush(live)
  }

  private queued(live: Live): ChatQueued[] {
    const state = live.driver.items.list().find((item) => item.kind === 'state')
    return state?.kind === 'state' ? state.queue : []
  }

  private files(images: readonly ChatImage[]): ChatImageFile[] {
    return images.map((image) => ({ ...image, ...this.attachments.fileOf(image.id) }))
  }

  private record(live: Live, record: LoggedRecord): void {
    live.log.append([record])
    live.driver.apply(record)
    live.lastActive = record.at
  }

  // Kando's own question to the user, put to the running stage as an approval: logged first like
  // everything else, so a replay shows it, and answered through answer() rather than the agent.
  ask(conversationId: string, ask: KandoAsk): string {
    const live = this.running(conversationId)
    const requestId = `kando:${ask.kind}:${randomUUID()}`
    this.record(live, { dir: 'ask', at: this.now(), requestId, ask })
    this.flush(live)
    return requestId
  }

  answer(conversationId: string, requestId: string, resolution: KandoResolution, message?: string): void {
    const live = this.liveOf(conversationId)
    if (!live) return
    this.record(live, { dir: 'answer', at: this.now(), requestId, resolution, ...(message ? { message } : {}) })
    this.flush(live)
  }

  // Kando's questions a replayed stage left open: nothing waits on them any more.
  cancelAsks(conversationId: string): void {
    const live = this.liveOf(conversationId)
    if (!live) return
    for (const item of live.driver.items.list()) {
      if (item.kind === 'approval' && item.resolution === null && item.requestId.startsWith('kando:')) {
        this.record(live, { dir: 'answer', at: this.now(), requestId: item.requestId, resolution: 'cancelled' })
      }
    }
    this.flush(live)
  }

  async respond(conversationId: string, requestId: string, answer: ChatAnswer): Promise<void> {
    const live = this.running(conversationId)
    const sent = live.driver.respond(requestId, answer).map((frame) => this.write(live, frame))
    this.flush(live)
    await Promise.all(sent)
  }

  async interrupt(conversationId: string): Promise<void> {
    const live = this.running(conversationId)
    const sent = live.driver.interrupt().map((frame) => this.write(live, frame))
    this.flush(live)
    await Promise.all(sent)
  }

  async setOption(conversationId: string, option: ChatOption, value: string): Promise<void> {
    const live = this.running(conversationId)
    const frames = live.driver.setOption(option, value)
    this.record(live, { dir: 'option', at: this.now(), option, value })
    const sent = frames.map((frame) => this.write(live, frame))
    this.flush(live)
    await Promise.all(sent)
  }

  private running(conversationId: string): Live {
    const live = this.liveOf(conversationId)
    if (!live?.attached) throw new Rejection('chat-not-running', 'no chat-mode agent is running here')
    return live
  }

  private liveOf(conversationId: string): Live | undefined {
    return [...this.lives.values()].find((live) => live.conversationId === conversationId)
  }

  private feed(live: Live, offset: number, data: string): void {
    const { lines, gap } = live.framer.feed(offset, data)
    this.read(live, lines, gap)
  }

  private read(live: Live, lines: ReadonlyArray<{ text: string; end: number }>, gap: boolean): void {
    const records: LoggedRecord[] = []
    if (gap) {
      const note: LoggedRecord = { dir: 'note', at: this.now(), level: 'warning', text: 'core 不在线时有一部分输出没能保存下来' }
      live.driver.apply(note)
      records.push(note)
    }
    let end: number | null = null
    for (const line of lines) {
      end = line.end
      let frame: unknown
      try {
        frame = JSON.parse(line.text)
      } catch {
        // Not a frame: a CLI that prints a warning on stdout, say.
        continue
      }
      const at = this.now()
      live.driver.apply({ dir: 'in', at, frame })
      const kept = live.driver.logged(frame)
      if (kept !== null) records.push({ dir: 'in', at, frame: kept, end: line.end })
    }
    live.log.append(records)
    if (lines.length) live.lastActive = this.now()
    if (end !== null) this.sink.offset(live.stageId, end)
  }

  // Sends what the driver says is owed (the handshake, say), and a queued message the agent can
  // now take. Each goes into the log before it goes out, so none is sent twice.
  private pump(live: Live): void {
    for (const frame of live.driver.due()) {
      void this.write(live, frame).catch(ignore)
    }
    const queued = live.driver.queuedToSend()
    if (!queued) return
    try {
      void this.dispatch(live, live.driver.send(queued.text, this.files(queued.images)), queued.ref, queued.images).catch(ignore)
    } catch (error) {
      // An image gone from the store since it was queued: that message is dropped with a word.
      this.record(live, { dir: 'queue', at: this.now(), text: null, ref: queued.ref })
      this.record(live, { dir: 'note', at: this.now(), level: 'error', text: `排队的消息没能发出：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  private write(live: Live, frame: unknown, ref?: string): Promise<unknown> {
    return this.dispatch(live, { wire: frame, logged: frame }, ref)
  }

  // Logged and applied before it is written, so a crash in between cannot send it twice.
  private dispatch(live: Live, message: ChatOutgoing, ref?: string, images: readonly ChatImage[] = []): Promise<unknown> {
    this.record(live, { dir: 'out', at: this.now(), frame: message.logged, ...(ref ? { ref } : {}), ...(images.length ? { images: [...images] } : {}) })
    return this.daemon.request('write', { sessionId: live.sessionId, data: `${JSON.stringify(message.wire)}\n` })
  }

  private flush(live: Live): void {
    const { items, deltas } = live.driver.items.drain()
    if (items.length) this.sink.items(live.conversationId, items)
    deltas.forEach((delta) => this.sink.delta(live.conversationId, live.stageId, delta.itemId, delta.append))
    const provider = live.driver.providerSessionId()
    if (provider && provider !== live.provider) {
      live.provider = provider
      this.sink.provider(live, provider)
    }
    const messages = live.driver.takeMessages()
    if (messages.length) this.sink.messages(live, messages)
    const activity = live.driver.activity()
    if (activity !== live.activity) {
      live.activity = activity
      this.sink.activity(live.conversationId)
    }
    if (live.driver.ready()) {
      live.started?.resolve()
      live.started = null
    }
    const failure = live.driver.failure()
    if (failure && live.started) {
      live.started.reject(new Rejection('chat-start-failed', this.failureText(live, failure)))
      live.started = null
    }
  }

  private end(live: Live, code: number | null): void {
    const last = live.framer.flush()
    if (last) this.read(live, [last], false)
    const record: LoggedRecord = { dir: 'exit', at: this.now(), code, stderr: live.stderr.slice(-2000) }
    live.log.append([record])
    live.driver.apply(record)
    this.flush(live)
    live.started?.reject(new Rejection('chat-start-failed', this.failureText(live, live.driver.failure() ?? 'exited')))
    live.started = null
    this.lives.delete(live.sessionId)
    this.remember(live.stageId, live.driver)
    this.sink.activity(live.conversationId)
    // Everything is in the log now; the daemon can let go of the output it kept.
    void this.daemon.request('release', { sessionId: live.sessionId }).catch(ignore)
  }

  private failureText(live: Live, failure: string): string {
    const tail = live.stderr.trim().split('\n').slice(-5).join('\n')
    return tail || failure
  }

  private remember(stageId: string, driver: ChatDriver): void {
    this.history.set(stageId, driver)
    for (const oldest of this.history.keys()) {
      if (this.history.size <= HISTORY_CACHE) break
      this.history.delete(oldest)
    }
  }

  private withinStartTimeout(started: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Rejection('chat-start-timeout', 'the agent did not start in time')), START_TIMEOUT_MS)
      timer.unref()
      started.then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }
}
