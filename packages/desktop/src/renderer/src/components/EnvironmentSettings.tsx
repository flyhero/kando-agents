import { useState } from 'react'
import { blocksEverything, environmentProblems, type EnvironmentCheck } from '@kando/protocol'
import { refreshEnvironment, useCore } from '../core-store'
import { checkStatusText, INSTALL_HINT, problemText, SIGN_IN_HINT, signedInText, TOOL_LABEL, TOOL_ROLE } from '../environment-text'
import { RefreshIcon } from './icons'
import { CopyButton } from './CopyButton'

type Level = 'ok' | 'warning' | 'danger'

// Git missing stops everything; an agent missing only narrows the choice.
function installLevel(check: EnvironmentCheck): Level {
  if (check.status !== 'missing') return 'ok'
  return check.tool === 'git' ? 'danger' : 'warning'
}

// What to type next, when the tool is not there or has no account; nothing for one that is fine.
function fix(check: EnvironmentCheck): string | null {
  if (check.status === 'missing') return INSTALL_HINT[check.tool]
  return check.signedIn === false ? SIGN_IN_HINT[check.tool] : null
}

function CheckRow({ check }: { check: EnvironmentCheck }) {
  const hint = fix(check)
  const signedIn = signedInText(check)
  return (
    <div className="settings-row environment-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{TOOL_LABEL[check.tool]}</div>
        <p className="settings-row-description">{TOOL_ROLE[check.tool]}</p>
        {check.path && <p className="settings-row-description mono environment-path">{check.path}</p>}
        {hint && (
          <p className="environment-fix">
            <span>{check.status === 'missing' ? '安装：' : '登录：'}</span>
            <code>{hint}</code>
            <CopyButton text={hint} label="复制命令" />
          </p>
        )}
      </div>
      <div className="settings-row-control environment-status">
        <span className="environment-pill" data-level={installLevel(check)}>{checkStatusText(check)}</span>
        {signedIn && <span className="environment-pill" data-level={check.signedIn ? 'ok' : 'warning'}>{signedIn}</span>}
      </div>
    </div>
  )
}

// What core found when it last looked, and a way to look again after installing something.
export function EnvironmentSettings() {
  const environment = useCore((s) => s.environment)
  const [checking, setChecking] = useState(false)
  if (!environment) return <p className="settings-row-description">还没有检查过。</p>
  const problems = environmentProblems(environment)
  const blocking = problems.filter(blocksEverything)
  const first = blocking[0] ?? problems[0]
  const recheck = async () => {
    setChecking(true)
    try {
      await refreshEnvironment()
    } finally {
      setChecking(false)
    }
  }
  return (
    <>
      <div className="environment-summary" data-level={blocking.length > 0 ? 'danger' : problems.length > 0 ? 'warning' : 'ok'}>
        <span>{first ? problemText(first) : '可以开始任务和会话了'}</span>
        <button type="button" className="button ghost" onClick={() => void recheck()} disabled={checking}>
          <RefreshIcon />
          {checking ? '检查中…' : '重新检查'}
        </button>
      </div>
      {environment.checks.map((check) => (
        <CheckRow key={check.tool} check={check} />
      ))}
      <details className="environment-search-path">
        <summary>Kando 在这些目录里找它们（{environment.searchPath.length} 个）</summary>
        <p className="settings-row-description">
          这是 core 启动时的 PATH，agent 也用它启动。装在别处的，把它所在的目录加进登录 shell 的 PATH，再重启 Kando。
        </p>
        <ul className="mono">
          {environment.searchPath.map((dir) => (
            <li key={dir}>{dir}</li>
          ))}
        </ul>
      </details>
    </>
  )
}
