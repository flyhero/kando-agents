import { useEffect, useRef, useState } from 'react'
import type { CommitRef } from '../git-refs'
import { BranchIcon, TagIcon } from './icons'
import { Popover } from './Popover'

const KIND_LABEL: Record<CommitRef['kind'], string> = { local: '本地分支', remote: '远程分支', tag: '标签', head: '当前检出（游离）' }
// Long enough to pass over a row on the way elsewhere without a list popping up.
const OPEN_DELAY_MS = 250

// One branch or tag, coloured by kind as IDEA's log does: local and remote apart at a glance.
export function GitRefName({ item }: { item: CommitRef }) {
  return (
    <span className="git-ref" data-kind={item.kind} data-current={item.current || undefined} title={`${KIND_LABEL[item.kind]}${item.current ? '，当前' : ''}`}>
      {item.kind === 'tag' ? <TagIcon /> : <BranchIcon />}
      <span className="git-ref-name">{item.name}</span>
    </span>
  )
}

// A commit's branches and tags in its history row: the first of them and how many more, all of
// them listed while the pointer rests on it, so a commit on many branches keeps its subject in view.
export function GitRefLabel({ refs }: { refs: readonly CommitRef[] }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const first = refs[0]
  if (!first) return null
  const more = refs.length - 1
  const enter = () => { clearTimeout(timer.current); if (more > 0) timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS) }
  const leave = () => { clearTimeout(timer.current); setOpen(false) }
  return (
    <span className="menu-anchor git-ref-label" onMouseEnter={enter} onMouseLeave={leave}>
      <GitRefName item={first} />
      {more > 0 && <span className="git-ref-more">+{more}</span>}
      {open && (
        <Popover label="提交所在的分支和标签" onClose={leave}>
          <ul className="git-ref-list">{refs.map((item) => <li key={`${item.kind}:${item.name}`}><GitRefName item={item} /></li>)}</ul>
        </Popover>
      )}
    </span>
  )
}
