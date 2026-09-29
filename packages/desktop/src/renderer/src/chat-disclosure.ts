import { createContext, useCallback, useContext } from 'react'
import { create } from 'zustand'

// What the user opened in each chat, by key within it: a turn's work, a run of calls, a thought, a
// long message. Kept while the window is open, so a chat they come back to is as they left it.
const useOpened = create<Record<string, Readonly<Record<string, true>>>>()(() => ({}))

// The chat whose openings a component reads and sets.
export const ChatDisclosureScope = createContext('')

export function setOpened(conversationId: string, key: string, open: boolean): void {
  useOpened.setState((s) => {
    const { [key]: _was, ...rest } = s[conversationId] ?? {}
    return { [conversationId]: open ? { ...rest, [key]: true } : rest }
  })
}

export function useDisclosure(key: string): [boolean, (open: boolean) => void] {
  const id = useContext(ChatDisclosureScope)
  const open = useOpened((s) => Boolean(s[id]?.[key]))
  const set = useCallback((next: boolean) => setOpened(id, key, next), [id, key])
  return [open, set]
}
