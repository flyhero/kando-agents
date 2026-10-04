import 'react'

// The custom properties components set inline for the stylesheet to read: the share of a run's
// calls that finished, a subagent's place among its siblings, and the sidebar's width.
declare module 'react' {
  interface CSSProperties {
    '--chat-rail'?: string
    '--chat-lane'?: number
    '--sidebar-width'?: string
  }
}
