// Text the user selected within one region of a container (one reply, one plan), where a control
// for it goes, and the range itself, so a highlight can keep marking it once the focus moves.
export type SelectedText = { x: number; y: number; below: boolean; text: string; range: Range; region: HTMLElement }

function regionOf(node: Node | null, selector: string): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement
  return element?.closest<HTMLElement>(selector) ?? null
}

// Nothing when the selection is empty, or runs out of one region or out of the container.
export function selectedTextIn(container: HTMLElement, selector: string): SelectedText | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const region = regionOf(range.startContainer, selector)
  const text = selection.toString().trim()
  if (!region || region !== regionOf(range.endContainer, selector) || !container.contains(region) || !text) return null
  const box = range.getBoundingClientRect()
  // Over the selection, unless that would run above the container.
  const below = box.top - 40 < container.getBoundingClientRect().top
  return { x: box.left + box.width / 2, y: below ? box.bottom : box.top, below, text, range: range.cloneRange(), region }
}
