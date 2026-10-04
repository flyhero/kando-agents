import { setAttentionOpen, useActionableItems, useCore } from '../core-store'
import { BellIcon } from './icons'

export function AttentionEntry() {
  const open = useCore((s) => s.attentionOpen)
  const count = useActionableItems().length
  return (
    <button type="button" className="inbox-entry sidebar-attention" aria-current={open}
      aria-label={`需要我处理${count ? `，${count} 项` : ''}`} onClick={() => setAttentionOpen(true)}>
      <BellIcon />
      <span>需要我处理</span>
      {count > 0 && <span className="inbox-entry-count">{count}</span>}
    </button>
  )
}
