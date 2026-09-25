import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { PROTOCOL_VERSION, type SourceDescriptor } from '@kando/protocol'
import packageJson from '../../../../package.json'
import { perform, setSettingsOpen, useCore } from '../core-store'
import { setPreference, usePreferences } from '../preferences'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import {
  ArrowLeftIcon,
  ContrastIcon,
  FolderIcon,
  GaugeIcon,
  InboxIcon,
  InfoIcon,
  SearchIcon,
  SparkIcon
} from './icons'
import { settingsSectionOf } from './SourceInboxView'
import { SourceSettingsSection } from './SourceSettingsSection'
import { projectName } from './ProjectPicker'
import { Segmented, SettingsRow, Stepper, Toggle } from './SettingsControls'

function AppearanceSettings() {
  const theme = usePreferences((s) => s.theme)
  const fontSize = usePreferences((s) => s.terminalFontSize)
  return (
    <>
      <SettingsRow
        label="主题"
        description="跟随系统时，会随 macOS / Windows 的浅色、深色设置自动切换。"
        control={(labelId) => (
          <Segmented
            labelId={labelId}
            value={theme}
            onChange={(next) => setPreference('theme', next)}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' }
            ]}
          />
        )}
      />
      <SettingsRow
        label="终端字号"
        description="agent 终端里文字的大小，已经打开的终端会立即生效。"
        control={(labelId) => (
          <Stepper
            labelId={labelId}
            value={fontSize}
            min={10}
            max={20}
            unit="px"
            onChange={(next) => setPreference('terminalFontSize', next)}
          />
        )}
      />
    </>
  )
}

function UsageSettings() {
  const showUsage = usePreferences((s) => s.showUsage)
  const display = usePreferences((s) => s.usageDisplay)
  return (
    <>
      <SettingsRow
        label="在状态栏显示用量额度"
        description="Claude Code 与 Codex 订阅的 5 小时和每周额度。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={showUsage} onChange={(next) => setPreference('showUsage', next)} />
        )}
      />
      <SettingsRow
        label="百分比显示"
        description="只改变显示的数字；快用完时的黄色、红色提醒不受影响。"
        control={(labelId) => (
          <Segmented
            labelId={labelId}
            value={display}
            onChange={(next) => setPreference('usageDisplay', next)}
            options={[
              { value: 'used', label: '已用' },
              { value: 'remaining', label: '剩余' }
            ]}
          />
        )}
      />
    </>
  )
}

function AgentSettings() {
  const defaultAgent = usePreferences((s) => s.defaultAgent)
  const openTerminal = usePreferences((s) => s.openTerminalOnRun)
  return (
    <>
      <SettingsRow
        label="新建任务的默认 agent"
        description="「最近用过的」会沿用最新一个任务选的 agent。"
        control={(labelId) => (
          <Segmented
            labelId={labelId}
            value={defaultAgent}
            onChange={(next) => setPreference('defaultAgent', next)}
            options={[
              { value: 'recent', label: '最近用过的' },
              { value: 'claude', label: 'Claude Code' },
              { value: 'codex', label: 'Codex' },
              { value: 'none', label: '不指定' }
            ]}
          />
        )}
      />
      <SettingsRow
        label="执行后切到终端"
        description="点 ▷ 执行后，右侧自动换成 agent 的终端。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={openTerminal} onChange={(next) => setPreference('openTerminalOnRun', next)} />
        )}
      />
    </>
  )
}

function ProjectSettings() {
  const connected = useCore((s) => s.connection === 'connected')
  const [projects, setProjects] = useState<string[] | null>(null)

  useEffect(() => {
    if (connected) {
      void perform((rpc) => rpc.call('projects.recent', {})).then((recent) => setProjects(recent ?? []))
    }
  }, [connected])

  const forget = async (projectPath: string) => {
    if (await perform((rpc) => rpc.call('projects.forget', { path: projectPath }))) {
      setProjects((current) => current?.filter((entry) => entry !== projectPath) ?? null)
    }
  }

  if (!connected) {
    return <p className="settings-empty">连接到 Kando core 后才能查看。</p>
  }
  if (projects === null) {
    return <p className="settings-empty">正在读取…</p>
  }
  if (projects.length === 0) {
    return <p className="settings-empty">还没有用过的项目。给任务或会话添加项目后，会出现在这里。</p>
  }
  return (
    <ul className="settings-project-list">
      {projects.map((projectPath) => (
        <li key={projectPath} className="settings-project">
          <span className="settings-project-name">{projectName(projectPath)}</span>
          <span className="settings-project-path mono" title={projectPath}>
            {projectPath}
          </span>
          <button type="button" className="button" onClick={() => void forget(projectPath)}>
            移除
          </button>
        </li>
      ))}
    </ul>
  )
}

const CONNECTION_TEXT = { connected: '已连接', connecting: '连接中…', 'waiting-for-core': '等待 core 启动' } as const

function AboutSettings() {
  const connection = useCore((s) => s.connection)
  const shortcuts = [
    ['新建任务', `${PRIMARY_KEY_LABEL}N`],
    ['创建任务（新建任务对话框中）', `${PRIMARY_KEY_LABEL}↵`],
    ['打开 / 关闭设置', `${PRIMARY_KEY_LABEL},`]
  ] as const
  return (
    <>
      <SettingsRow label="桌面端版本" control={() => <span className="mono">{packageJson.version}</span>} />
      <SettingsRow label="协议版本" control={() => <span className="mono">{PROTOCOL_VERSION}</span>} />
      <SettingsRow
        label="Kando core"
        control={() => (
          <span className="connection" data-state={connection}>
            <span className="connection-dot" aria-hidden="true" />
            {CONNECTION_TEXT[connection]}
          </span>
        )}
      />
      {shortcuts.map(([label, keys]) => (
        <SettingsRow key={label} label={label} control={() => <kbd className="settings-kbd">{keys}</kbd>} />
      ))}
    </>
  )
}

type Section = {
  id: string
  group: string
  title: string
  description: string
  keywords: readonly string[]
  Icon: () => ReactElement
  Body: () => ReactElement
}

const SECTIONS: readonly Section[] = [
  {
    id: 'appearance',
    group: '界面',
    title: '外观',
    description: '主题与终端的显示方式。',
    keywords: ['主题', '浅色', '深色', '跟随系统', '终端', '字号', '字体'],
    Icon: ContrastIcon,
    Body: AppearanceSettings
  },
  {
    id: 'usage',
    group: '界面',
    title: '用量额度',
    description: '底部状态栏里的 agent 订阅额度。',
    keywords: ['状态栏', '额度', '百分比', '已用', '剩余', 'claude', 'codex'],
    Icon: GaugeIcon,
    Body: UsageSettings
  },
  {
    id: 'agents',
    group: '任务',
    title: '智能体',
    description: '新建和执行任务时 agent 的默认行为。',
    keywords: ['agent', '默认', 'claude', 'codex', '执行', '终端'],
    Icon: SparkIcon,
    Body: AgentSettings
  },
  {
    id: 'projects',
    group: '项目',
    title: '最近使用',
    description: '给任务或会话添加项目时「最近使用」里列出的项目。移除只是不再列出，不影响已有的任务和会话。',
    keywords: ['项目', '仓库', '最近使用', '路径', '文件夹'],
    Icon: FolderIcon,
    Body: ProjectSettings
  },
  {
    id: 'about',
    group: '其他',
    title: '关于',
    description: '版本、连接状态与快捷键。',
    keywords: ['版本', '协议', '连接', 'core', '快捷键'],
    Icon: InfoIcon,
    Body: AboutSettings
  }
]

// One section per task source, from what its provider declares; they sit before 关于.
function sourceSections(sources: readonly SourceDescriptor[]): Section[] {
  return sources.map((source) => ({
    id: settingsSectionOf(source.provider),
    group: '集成',
    title: source.name,
    description: `把分给你的 issue 从 ${source.name} 同步到左侧的收件箱，挑出要做的导入成任务。`,
    keywords: [source.name, source.provider, 'token', '登录', '收件箱', 'issue', 'bug', '集成', ...source.settings.map((field) => field.label)],
    Icon: InboxIcon,
    Body: () => <SourceSettingsSection source={source} />
  }))
}

function matches(section: Section, needle: string): boolean {
  return [section.title, section.description, ...section.keywords].some((text) => text.toLowerCase().includes(needle))
}

// Laid out like Orca's settings: sections on the left, one section at a time on the right.
export function SettingsPage() {
  const sources = useCore((s) => s.sources)
  const sections = useMemo(() => {
    const about = SECTIONS.filter((section) => section.id === 'about')
    return [...SECTIONS.filter((section) => section.id !== 'about'), ...sourceSections(sources ?? []), ...about]
  }, [sources])
  const [activeId, setActiveId] = useState(() => useCore.getState().settingsSection ?? SECTIONS[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = needle ? sections.filter((section) => matches(section, needle)) : sections
  // While searching, stay on the chosen section if it still matches, else show the first match.
  const active = visible.find((section) => section.id === activeId) ?? visible[0]
  const groups = [...new Set(visible.map((section) => section.group))]

  return (
    <div className="settings">
      <aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-top">
          <button type="button" className="settings-back" onClick={() => setSettingsOpen(false)}>
            <ArrowLeftIcon />
            返回
          </button>
        </div>
        <div className="settings-search">
          <SearchIcon />
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索设置"
            aria-label="搜索设置"
            autoFocus
          />
        </div>
        <nav className="settings-groups">
          {groups.map((group) => (
            <div key={group} className="settings-group">
              <p className="settings-group-title">{group}</p>
              {visible
                .filter((section) => section.group === group)
                .map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className="settings-nav-item"
                    aria-current={section.id === active?.id ? 'page' : undefined}
                    onClick={() => setActiveId(section.id)}
                  >
                    <section.Icon />
                    {section.title}
                  </button>
                ))}
            </div>
          ))}
        </nav>
      </aside>

      <main className="settings-content">
        <div className="titlebar-drag" aria-hidden="true" />
        <div className="settings-inner">
          {active ? (
            <section aria-labelledby={`settings-${active.id}`}>
              <header className="settings-section-header">
                <h2 id={`settings-${active.id}`}>{active.title}</h2>
                <p>{active.description}</p>
              </header>
              <div className="settings-card">
                <active.Body />
              </div>
            </section>
          ) : (
            <p className="settings-none">没有找到与「{query.trim()}」相关的设置</p>
          )}
        </div>
      </main>
    </div>
  )
}
