import { useEffect, useRef, useState } from 'react'

// How long a "just finished" mark stays, long enough for its animation to play out.
const FINISHED_MS = 1200

// True for a moment after `running` drops from true to false while the component is mounted: a call
// or a step that finished before the user's eyes animates its finish, while one that was already
// finished when the chat opened keeps still.
export function useJustFinished(running: boolean): boolean {
  const was = useRef(running)
  const [finished, setFinished] = useState(false)
  useEffect(() => {
    const dropped = was.current && !running
    was.current = running
    if (!dropped) return
    setFinished(true)
    const timer = setTimeout(() => setFinished(false), FINISHED_MS)
    return () => clearTimeout(timer)
  }, [running])
  return finished
}

// A number that changes while mounted, marked each time it does, so a counter can tick as it
// goes up; `null` until the first change.
export function useTick(value: number | null): number | null {
  const was = useRef(value)
  const [tick, setTick] = useState<number | null>(null)
  useEffect(() => {
    if (was.current === value) return
    was.current = value
    setTick((count) => (count ?? 0) + 1)
  }, [value])
  return tick
}

// Which of a list's keys arrived after the chat was first shown: those enter with a motion, while
// what was already there when it opened, or came in by loading older history, is simply there.
// `seen` is every key shown so far, `null` before the chat's history has arrived.
export function freshKeys(seen: ReadonlySet<string> | null, keys: readonly string[], olderLoaded: boolean): ReadonlySet<string> {
  if (!seen || olderLoaded) return new Set()
  return new Set(keys.filter((key) => !seen.has(key)))
}
