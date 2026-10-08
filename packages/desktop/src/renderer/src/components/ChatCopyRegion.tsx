import { cloneElement, type ReactElement, type Ref } from 'react'

const texts = new WeakMap<Element, string>()

export function copyRegionText(target: Element, root: Element): string | null {
  for (let element: Element | null = target; element && root.contains(element); element = element.parentElement) {
    const text = texts.get(element)
    if (text !== undefined) return text
    if (element === root) break
  }
  return null
}

export function ChatCopyRegion({ text, children }: { text: string; children: ReactElement<{ ref?: Ref<HTMLElement> }> }) {
  return cloneElement(children, { ref: (element) => {
    if (element) texts.set(element, text)
    const original = children.props.ref
    if (typeof original === 'function') return original(element)
    if (original) original.current = element
  } })
}
