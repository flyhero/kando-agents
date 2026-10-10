import { useEffect, useState, type RefObject } from 'react'

// How far ahead of the view a picture starts loading, so scrolling seldom meets a blank one.
const AHEAD = '800px 0px'

// The box an element scrolls in: the chat's own list rather than the window, which would clip the
// look-ahead to what the list already shows.
function scrollerOf(element: Element): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') return parent
  }
  return null
}

// Whether an element has come near enough to the view to load what it shows; it stays true once
// it has, so a picture scrolled past is not dropped and fetched again.
export function useNearView(element: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const target = element.current
    if (near || !target) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true)
    }, { root: scrollerOf(target), rootMargin: AHEAD })
    observer.observe(target)
    return () => observer.disconnect()
  }, [element, near])
  return near
}
