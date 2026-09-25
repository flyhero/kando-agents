import { ChevronDownIcon } from './icons'

export function SidebarCollapseButton({ label, count, collapsed, controls, onToggle }: {
  label: string
  count: number
  collapsed: boolean
  controls: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="sidebar-section-toggle"
      aria-label={`${collapsed ? '展开' : '折叠'}${label}`}
      aria-expanded={!collapsed}
      aria-controls={controls}
      title={`${collapsed ? '展开' : '折叠'}${label}`}
      onClick={onToggle}
    >
      <span>{label}</span>
      <span className="count">{count}</span>
      <span className="sidebar-collapse-icon"><ChevronDownIcon /></span>
    </button>
  )
}
