// An expected, user-facing refusal. `reason` is a stable code clients can localize.
export class Rejection extends Error {
  constructor(
    readonly reason: string,
    message: string = reason
  ) {
    super(message)
    this.name = 'Rejection'
  }
}
