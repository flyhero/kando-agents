import { useState } from 'react'
import type { Task } from '@kando/protocol'
import { perform } from '../core-store'
import { dayAndTime } from '../labels'
import { ChevronDownIcon, RefreshIcon } from './icons'
import { ImageStrip } from './ImageStrip'
import { ImageViewer } from './ImageViewer'
import { MarkdownEditor } from './MarkdownEditor'

const ignore = () => {}

// The issue as the tracker had it, read-only: the plan belongs in the details below, and agents
// get this text only as untrusted reference data.
export function SourceSnapshotCard({ task }: { task: Task }) {
  const { source, sourceSnapshot: snapshot } = task
  // Open while there is no plan yet: then the issue is all there is to read.
  const [open, setOpen] = useState(task.details.trim() === '')
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  if (!source || !snapshot) {
    return null
  }
  const resync = async () => {
    setBusy(true)
    await perform((rpc) => rpc.call('sources.resync', { taskId: task.id }))
    setBusy(false)
  }
  return (
    <section className="snapshot" data-open={open || undefined} aria-label={`${source.name} 原文`}>
      <header className="snapshot-header">
        <button type="button" className="snapshot-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDownIcon />
          {source.name} 原文
        </button>
        <span className="muted">拉取于 {dayAndTime(snapshot.fetchedAt)}</span>
        <button
          type="button"
          className="tool-button snapshot-resync"
          aria-label="重新拉取"
          data-tooltip="重新拉取"
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => void resync()}
        >
          <RefreshIcon />
        </button>
      </header>
      {open && (
        <MarkdownEditor
          key={snapshot.fetchedAt}
          value={snapshot.markdown || '（原文是空的）'}
          onSave={ignore}
          label={`${source.name} ${source.key} 原文`}
          hint=""
          readOnly
        />
      )}
      {open && snapshot.images.length > 0 && (
        <div className="snapshot-images">
          <span className="muted">来自 {source.name} 的 {snapshot.images.length} 张图片，和原文一样只作参考</span>
          <ImageStrip images={snapshot.images} onOpen={setViewing} />
        </div>
      )}
      {viewing !== null && snapshot.images.length > 0 && (
        <ImageViewer
          images={snapshot.images}
          index={Math.min(viewing, snapshot.images.length - 1)}
          note={`来自 ${source.name}`}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  )
}
