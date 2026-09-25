import { randomUUID } from 'node:crypto'
import type { LoginPrompt } from '@kando/protocol'
import { Rejection } from './rejection'
import type { Connection } from './rpc-server'
import { SourceError, sourceProblem } from './source-error'
import type { LoginSession } from './source-provider'

export type FlowOwner = Pick<Connection, 'notify' | 'onClose'>
export type FlowTarget = { provider: string; instance: string }

type Pending = { promptId: string; resolve(value: string): void; reject(error: Error): void }
type Flow = FlowTarget & {
  id: string
  owner: FlowOwner
  controller: AbortController
  pending: Pending | null
  release: () => void
}

const PROMPT_TIMEOUT_MS = 5 * 60_000

// Sign-in flows in progress. Each belongs to the connection that started it: only that client
// sees its prompts and may answer or cancel, and the flow ends when that client goes away.
export class LoginFlows {
  private readonly flows = new Map<string, Flow>()

  constructor(private readonly promptTimeoutMs: number = PROMPT_TIMEOUT_MS) {}

  // `run` gets the session to talk through and resolves with the account name once it has committed.
  // The client names the flow, since its first prompt may arrive before the reply that starts it.
  start(
    owner: FlowOwner,
    target: FlowTarget,
    flowId: string,
    run: (session: LoginSession, signal: AbortSignal) => Promise<string>
  ): string {
    const busy = [...this.flows.values()].some(
      (flow) => flow.provider === target.provider && flow.instance === target.instance
    )
    if (busy) {
      throw new Rejection('source-login-in-progress', 'a sign-in for this source is already in progress')
    }
    if (this.flows.has(flowId)) {
      throw new Rejection('source-login-duplicate', 'that sign-in id is taken')
    }
    const flow: Flow = { ...target, id: flowId, owner, controller: new AbortController(), pending: null, release: () => {} }
    flow.release = owner.onClose(() => this.abort(flow, new SourceError('login-cancelled', 'the client went away')))
    this.flows.set(flow.id, flow)
    const session: LoginSession = {
      prompt: (prompt) => this.ask(flow, prompt),
      notify: (notice) => {
        if (!flow.controller.signal.aborted) {
          owner.notify('sources.loginNotice', { flowId: flow.id, notice })
        }
      }
    }
    // After this call returns, so the client has the flow id before the first prompt names it.
    setImmediate(() => void this.execute(flow, session, run))
    return flow.id
  }

  answer(owner: FlowOwner, flowId: string, promptId: string, value: string): void {
    const flow = this.owned(owner, flowId)
    if (flow.pending?.promptId !== promptId) {
      throw new Rejection('source-login-stale', 'that question is no longer open')
    }
    flow.pending.resolve(value)
  }

  cancel(owner: FlowOwner, flowId: string): void {
    this.abort(this.owned(owner, flowId), new SourceError('login-cancelled', 'sign-in cancelled'))
  }

  private owned(owner: FlowOwner, flowId: string): Flow {
    const flow = this.flows.get(flowId)
    if (!flow || flow.owner !== owner) {
      throw new Rejection('source-login-not-found', 'no such sign-in in progress')
    }
    return flow
  }

  private async execute(flow: Flow, session: LoginSession, run: (session: LoginSession, signal: AbortSignal) => Promise<string>) {
    const { signal } = flow.controller
    let account: string | null = null
    let problem = null
    try {
      account = await run(session, signal)
    } catch (error) {
      // A cancelled flow fails however the provider noticed; the reason is the cancellation.
      problem = sourceProblem(signal.aborted ? signal.reason : error)
    }
    flow.release()
    this.flows.delete(flow.id)
    flow.owner.notify('sources.loginFinished', {
      flowId: flow.id,
      provider: flow.provider,
      instance: flow.instance,
      account,
      problem
    })
  }

  private ask(flow: Flow, prompt: LoginPrompt): Promise<string> {
    if (flow.controller.signal.aborted) {
      return Promise.reject(flow.controller.signal.reason)
    }
    if (flow.pending) {
      return Promise.reject(new Error('a sign-in flow asks one question at a time'))
    }
    return new Promise((resolve, reject) => {
      const promptId = randomUUID()
      const timer = setTimeout(
        () => this.abort(flow, new SourceError('login-timeout', 'no answer in time')),
        this.promptTimeoutMs
      )
      timer.unref()
      const settle = () => {
        clearTimeout(timer)
        flow.pending = null
      }
      flow.pending = {
        promptId,
        resolve: (value) => {
          settle()
          resolve(value)
        },
        reject: (error) => {
          settle()
          reject(error)
        }
      }
      flow.owner.notify('sources.loginPrompt', { flowId: flow.id, promptId, prompt })
    })
  }

  private abort(flow: Flow, reason: SourceError): void {
    if (!flow.controller.signal.aborted) {
      flow.controller.abort(reason)
    }
    flow.pending?.reject(reason)
  }
}
