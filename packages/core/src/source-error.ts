import type { SourceFailure, SourceProblem } from '@kando/protocol'
import { Rejection } from './rejection'

// A provider's failure, in terms every client can explain without knowing the tracker.
export class SourceError extends Error {
  constructor(
    readonly code: SourceFailure,
    message: string
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

export function sourceProblem(error: unknown): SourceProblem {
  if (error instanceof SourceError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'request-failed', message: error instanceof Error ? error.message : String(error) }
}

export function sourceRejection(error: unknown): Rejection {
  const { code, message } = sourceProblem(error)
  return new Rejection(`source-${code}`, message)
}
