import { blocksEverything, environmentProblems } from '@kando/protocol'
import { setSettingsOpen, useCore } from '../core-store'
import { problemText } from '../environment-text'
import { PulseIcon } from './icons'

// Shown over the lists while nothing can run: a missing git or agent is found out at the first
// start otherwise, as an agent that fails. Clicking goes to the check, which says what to type.
export function EnvironmentNotice() {
  const environment = useCore((s) => s.environment)
  if (!environment) return null
  const blocking = environmentProblems(environment).filter(blocksEverything)
  if (blocking.length === 0) return null
  return (
    <button type="button" className="environment-notice" onClick={() => setSettingsOpen(true, 'environment')}>
      <PulseIcon />
      <span>{problemText(blocking[0]!)}</span>
      <span className="environment-notice-action">查看</span>
    </button>
  )
}
