import { updateUtilityPanelOrder, type UtilityPanelKind } from './utility-panel-order'

export type SidePanels = {
  terminalPanelOpen: boolean
  inspectorOpen: boolean
  conversationInspectorOpen: boolean
  utilityPanelOrder: UtilityPanelKind[]
}

// The terminal panel and the inspectors take the same room beside the content, so one opening puts
// the other away, whichever way it was opened (a button, a shortcut, a plan or a review showing
// itself). The browser panel is not among them. Null when nothing need change.
export function exclusivePanels(next: SidePanels, previous: SidePanels): Partial<SidePanels> | null {
  const terminalOpened = next.terminalPanelOpen && !previous.terminalPanelOpen
  const inspectorOpened = (next.inspectorOpen && !previous.inspectorOpen) || (next.conversationInspectorOpen && !previous.conversationInspectorOpen)
  if (terminalOpened) {
    return next.inspectorOpen || next.conversationInspectorOpen ? { inspectorOpen: false, conversationInspectorOpen: false } : null
  }
  if (inspectorOpened && next.terminalPanelOpen) {
    return { terminalPanelOpen: false, utilityPanelOrder: updateUtilityPanelOrder(next.utilityPanelOrder, 'terminal', false) }
  }
  return null
}
