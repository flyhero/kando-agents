import { randomUUID } from 'node:crypto'
import type { AgentKind, ChatItem, ChatTurnActivity } from '@kando/protocol'
import type { ChatAnswer, ChatDriver, ChatStageOptions, StageMessage } from './chat-driver'
import { ChatLog, type LoggedRecord } from './chat-log'
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
  delta(conversationId: string, itemId: string, append: string): void
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
      started: null
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

  async send(conversationId: string, text: string): Promise<void> {
    const live = this.running(conversationId)
    const sent = this.write(live, live.driver.send(text), randomUUID())
    this.flush(live)
    await sent
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
    if (end !== null) this.sink.offset(live.stageId, end)
  }

  // Sends what the driver says is owed, such as the handshake.
  private pump(live: Live): void {
    for (const frame of live.driver.due()) {
      void this.write(live, frame).catch(ignore)
    }
  }

  // Logged and applied before it is written, so a crash in between cannot send it twice.
  private write(live: Live, frame: unknown, ref?: string): Promise<unknown> {
    const record: LoggedRecord = { dir: 'out', at: this.now(), frame, ...(ref ? { ref } : {}) }
    live.log.append([record])
    live.driver.apply(record)
    return this.daemon.request('write', { sessionId: live.sessionId, data: `${JSON.stringify(frame)}\n` })
  }

  private flush(live: Live): void {
    const { items, deltas } = live.driver.items.drain()
    if (items.length) this.sink.items(live.conversationId, items)
    deltas.forEach((delta) => this.sink.delta(live.conversationId, delta.itemId, delta.append))
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
