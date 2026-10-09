// A refusal the host sends core as { reason, message }; core turns it into its own Rejection.
export class HostError extends Error {
  constructor(
    readonly reason: string,
    message: string = reason
  ) {
    super(message)
    this.name = 'HostError'
  }
}
