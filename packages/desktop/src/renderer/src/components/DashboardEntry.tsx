import { setDashboardOpen, useCore, useDashboardSupported } from '../core-store'
import { ChartIcon } from './icons'

// The way to the dashboard, at the top of the sidebar above both lists: it reads across tasks and
// conversations alike, so it belongs to neither. Gone on a core that cannot serve it.
export function DashboardEntry() {
  const open = useCore((s) => s.dashboardOpen)
  const supported = useDashboardSupported()
  if (!supported) return null
  return (
    <button type="button" className="inbox-entry sidebar-dashboard" aria-current={open} onClick={() => setDashboardOpen(true)}>
      <ChartIcon />
      <span>看板</span>
    </button>
  )
}
