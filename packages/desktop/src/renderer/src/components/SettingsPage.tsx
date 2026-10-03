import type { BrowserStatus } from '@kando/protocol'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { PROTOCOL_VERSION, type SourceDescriptor } from '@kando/protocol'
import packageJson from '../../../../package.json'
import { perform, setAwakeMode, setChatSettings, setSettingsOpen, useAwakeSupported, useCore, useBrowserSupported } from '../core-store'
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
import { AgentStatsSettings } from './AgentStatsSettings'
import { settingsSectionOf } from './SourceInboxView'
import { SourceSettingsSection } from './SourceSettingsSection'
import { projectName } from './ProjectPicker'
import { Segmented, SettingsRow, Stepper, Toggle } from './SettingsControls'

function AppearanceSettings() {
  const theme = usePreferences((s) => s.theme)
  const terminalFontSize = usePreferences((s) => s.terminalFontSize)
  const chatFontSize = usePreferences((s) => s.chatFontSize)
  const chatFont = usePreferences((s) => s.chatFont)
  const chatWidth = usePreferences((s) => s.chatWidth)
  const foldTurns = usePreferences((s) => s.foldTurns)
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
        description="终端面板里文字的大小，已经打开的终端会立即生效。"
        control={(labelId) => (
          <Stepper
            labelId={labelId}
            value={terminalFontSize}
            min={10}
            max={20}
            unit="px"
            onChange={(next) => setPreference('terminalFontSize', next)}
          />
        )}
      />
      <SettingsRow
        label="聊天字号"
        description="聊天消息、过程信息和输入框文字的大小，会立即生效。"
        control={(labelId) => (
          <Stepper
            labelId={labelId}
            value={chatFontSize}
            min={10}
            max={20}
            unit="px"
            onChange={(next) => setPreference('chatFontSize', next)}
          />
        )}
      />
      <SettingsRow
        label="聊天字体"
        description="聊天消息和过程信息用的字体。系统跟随 macOS / Windows 的界面字体；Geist 是随 Kando 打包的无衬线体，中文仍回落到系统字体；衬线只改正文，代码不变。"
        control={(labelId) => (
          <Segmented
            labelId={labelId}
            value={chatFont}
            onChange={(next) => setPreference('chatFont', next)}
            options={[
              { value: 'system', label: '系统' },
              { value: 'geist', label: 'Geist' },
              { value: 'serif', label: '衬线' }
            ]}
          />
        )}
      />
      <SettingsRow
        label="聊天页宽度"
        description="聊天界面里消息和输入框最宽多少：窄是 800px，中等是 1200px，全宽占满聊天区域。窗口比这窄时都占满。"
        control={(labelId) => (
          <Segmented
            labelId={labelId}
            value={chatWidth}
            onChange={(next) => setPreference('chatWidth', next)}
            options={[
              { value: 'narrow', label: '窄' },
              { value: 'medium', label: '中等' },
              { value: 'full', label: '全宽' }
            ]}
          />
        )}
      />
      <SettingsRow
        label="折叠做完的回合"
        description="打开时，agent 回完一轮，过程（思考、命令、中间的回复）收进「工作了 N 秒」，只留下最后的回答；点它仍能展开。关掉则一直全部显示。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={foldTurns} onChange={(next) => setPreference('foldTurns', next)} />
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

// The hosted browser's state in a few words, and what to do about it.
function browserStatusText(status: BrowserStatus | null): string {
  if (!status) return '正在询问…'
  switch (status.state) {
    case 'not-installed':
      return '还没安装，第一次使用要下载 Chromium（约 150MB）'
    case 'installing':
      return status.percent !== undefined ? `正在下载 ${status.percent}%` : '正在下载…'
    case 'starting':
      return '正在启动'
    case 'ready':
      return status.running ? '就绪，正在运行' : '就绪'
    case 'error':
      return `出错：${status.message ?? '未知错误'}`
  }
}

function BrowserRows() {
  const status = useCore((s) => s.browser)
  const openOnTab = usePreferences((s) => s.openBrowserOnTab)
  const [busy, setBusy] = useState(false)
  const install = async () => {
    setBusy(true)
    await perform((rpc) => rpc.call('browser.install', {}))
    setBusy(false)
  }
  const installable = !status || status.state === 'not-installed' || status.state === 'error'
  return (
    <>
      <SettingsRow
        label="浏览器"
        description="聊天界面里的 agent 用 Kando 托管的 Chromium 打开页面、截图、点击；本地开发地址直接打开，其他站点第一次访问时在对话里问你。下载到 ~/.kando/browser。"
        control={() => (
          <span className="settings-inline">
            <span className="muted">{browserStatusText(status)}</span>
            {installable && <button type="button" className="button" disabled={busy || !status} onClick={() => void install()}>{status?.state === 'error' ? '重试' : '安装'}</button>}
          </span>
        )}
      />
      <SettingsRow
        label="agent 打开页面时自动显示浏览器"
        description="agent 第一次在会话里用浏览器时，自动打开右侧的浏览器面板并选中它的标签页。默认关：浏览器在后台跑，对话里的页面卡片上点「打开」才显示。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={openOnTab} onChange={(next) => setPreference('openBrowserOnTab', next)} />
        )}
      />
    </>
  )
}

function AgentSettings() {
  const browser = useBrowserSupported()
  const awakeSupported = useAwakeSupported()
  const awake = useCore((s) => s.awake)
  const defaultAgent = usePreferences((s) => s.defaultAgent)
  const allowBypass = usePreferences((s) => s.allowBypass)
  const chatSettings = useCore((s) => s.chatSettings)
  return (
    <>
      {awakeSupported && awake && (
        <SettingsRow
          label="保持电脑唤醒"
          description="「Agent 工作时」只在至少一个 agent 正在执行时阻止系统睡眠；agent 等待输入时允许睡眠。关闭 Kando 窗口不影响正在运行的 agent。"
          control={(labelId) => (
            <Segmented
              labelId={labelId}
              value={awake.mode}
              onChange={(mode) => void setAwakeMode(mode)}
              options={[
                { value: 'on', label: '始终' },
                { value: 'auto', label: 'Agent 工作时' },
                { value: 'off', label: '关闭' }
              ]}
            />
          )}
        />
      )}
      {chatSettings && (
        <SettingsRow
          label="回合结束后建议下一步"
          description="Claude Code 在聊天界面里每轮回复完，预测你接下来可能要说的话，灰字显示在输入框里，按 Tab 或 → 填入，直接打字就忽略。生成建议要再发一次简短请求，复用对话缓存，花费很少，但会计入用量。关掉立即生效；打开后，已经在跑的 Claude 会话要等下次启动才有建议。Codex 没有这个功能。"
          control={(labelId) => (
            <Toggle labelId={labelId} checked={chatSettings.promptSuggestions} onChange={(next) => void setChatSettings({ promptSuggestions: next })} />
          )}
        />
      )}
      <SettingsRow
        label="允许「全部放行」"
        description="打开后，聊天界面的权限模式里多出「全部放行」：agent 不再请求确认，Codex 也不再受沙箱限制。Claude Code 自己建议只在没有网络的沙箱里这样用。只影响之后启动的聊天会话。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={allowBypass} onChange={(next) => setPreference('allowBypass', next)} />
        )}
      />
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
      {browser && <BrowserRows />}
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
    description: '主题、终端和聊天页的显示方式。',
    keywords: ['主题', '浅色', '深色', '跟随系统', '终端', '字号', '字体', '聊天', '宽度', '全宽', '折叠', '回合', '工作了'],
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
    description: '新建和执行任务、开始会话时 agent 的默认行为。',
    keywords: ['agent', '默认', 'claude', 'codex', '执行', '聊天', '会话', '任务', '规划', '浏览器', '截图', '网页', 'chromium'],
    Icon: SparkIcon,
    Body: AgentSettings
  },
  {
    id: 'agent-stats',
    group: '任务',
    title: '智能体表现',
    description: '每个 agent 和模型的表现。任务（包括在聊天界面里执行的任务）看结果：你接受、继续修改、重做各占多少，从 0.10.0 开始记录；自由会话没有验收，只看用量：回合、失败、撞额度、耗时和 token。',
    keywords: ['表现', '统计', '通过率', '接受', '继续修改', '重做', '异常退出', '耗时', 'token', '模型', '会话', '用量', '回合', '失败', '额度', 'claude', 'codex'],
    Icon: GaugeIcon,
    Body: AgentStatsSettings
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
