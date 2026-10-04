import 'react'

// The custom properties components set inline for the stylesheet to read: the share of a run's
// calls that finished, and a subagent's place among its siblings.
declare module 'react' {
  interface CSSProperties {
    '--chat-rail'?: string
    '--chat-lane'?: number
  }
}
