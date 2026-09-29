// A spinner in step with every other on screen: each starts at the point in its turn the clock is
// at, so ones that came up at different times still turn together.
const TURN_MS = 800

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      className="chat-spinner"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ animationDelay: `-${Date.now() % TURN_MS}ms` }}
    />
  )
}
