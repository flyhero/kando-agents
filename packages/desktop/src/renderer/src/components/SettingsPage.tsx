import type { BrowserStatus, WireUsage } from '@kando/protocol'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { AGENT_KINDS, PROTOCOL_VERSION, UNATTENDED_MODES, type SourceDescriptor } from '@kando/protocol'
import packageJson from '../../../../package.json'
import { perform, setAwakeMode, setChatSettings, setSettingsOpen, useAwakeSupported, useCore, useBrowserSupported, useChatCommandsSupported, useWireLogSupported } from '../core-store'
import { setPreference, usePreferences } from '../preferences'
import { PRIMARY_KEY_LABEL } from '../shortcut-keys'
import { UNATTENDED_LABEL } from '../schedules'
import { useInstalledAgents } from '../installed-agents'
import { InstalledAgentsSettings } from './InstalledAgentsSettings'
import { ChatFontPicker } from './ChatFontPicker'
import { AGENT_LABEL } from '../labels'
import { canNotify, canShowRequestPopup } from '../desktop-bridge'
import { formatBytes } from '../wire-entries'
import {
  ArrowLeftIcon,
  BellIcon,
  BugIcon,
  ChatIcon,
  ContrastIcon,
  FolderIcon,
  GaugeIcon,
  GlobeIcon,
  InboxIcon,
  InfoIcon,
  SearchIcon,
  SparkIcon
} from './icons'
import { AgentStatsSettings } from './AgentStatsSettings'
import { ChatCommandSettings } from './ChatCommandSettings'
import { CopyButton } from './CopyButton'
import { checkStatusText, INSTALL_HINT } from '../environment-text'
import { settingsSectionOf } from './SourceInboxView'
import { SourceSettingsSection } from './SourceSettingsSection'
import { projectName } from './ProjectPicker'
import { Segmented, SettingsRow, Stepper, Toggle } from './SettingsControls'
import { PalettePicker } from './PalettePicker'
import { useOccludesBrowser } from '../browser-occlusion'

function AppearanceSettings() {
  const theme = usePreferences((s) => s.theme)
  const terminalFontSize = usePreferences((s) => s.terminalFontSize)
  const chatFontSize = usePreferences((s) => s.chatFontSize)
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
        label="配色"
        description="界面的整套颜色。每套都有浅色和深色两面，跟着上面的主题切换；每张色卡左边是浅色、右边是深色。"
        control={(labelId) => <PalettePicker labelId={labelId} />}
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
        description="聊天消息和过程信息用的字体。系统跟随 macOS / Windows 的界面字体；衬线只改正文，代码不变；其他可以从这台电脑装的字体里挑，它没有的字仍回落到系统字体。"
        control={(labelId) => <ChatFontPicker labelId={labelId} />}
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
        description="打开时，Agent 回完一轮，过程（思考、命令、中间的回复）收进「工作了 N 秒」，只留下最后的回答；点它仍能展开。关掉则一直全部显示。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={foldTurns} onChange={(next) => setPreference('foldTurns', next)} />
        )}
      />
    </>
  )
}

function NotificationSettings() {
  const notifications = usePreferences((s) => s.notifications)
  const requestPopup = usePreferences((s) => s.requestPopup)
  return (
    <>
      {canNotify() && (
        <SettingsRow
          label="系统通知"
          description="窗口不在前台时，Agent 等你允许或回答、这一轮做完、异常退出，以及定时任务的一次运行做完或没能开始，都发一条系统通知，点它回到那条会话或任务。关掉也不影响 Dock 图标上的数字：那是等你处理的会话、任务和没看过的定时任务运行有几个（macOS 和 Linux）。macOS 第一次会问要不要允许 Kando 通知。"
          control={(labelId) => <Toggle labelId={labelId} checked={notifications} onChange={(next) => setPreference('notifications', next)} />}
        />
      )}
      {canShowRequestPopup() && (
        <SettingsRow
          label="离开时在屏幕顶部弹出待处理的请求"
          description="你在别的应用里时，Agent 等你允许、回答问题或批准计划，屏幕顶部会弹出一张卡片，直接在上面选；不会抢走你正在打字的窗口。回到 Kando 窗口或点 ✕ 它就收起。打开时，这类请求不再另发系统通知。"
          control={(labelId) => <Toggle labelId={labelId} checked={requestPopup} onChange={(next) => setPreference('requestPopup', next)} />}
        />
      )}
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
    case 'app-closed':
      return '没有连上：浏览器在 Kando 应用里运行'
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
  return (
    <>
      <SettingsRow
        label="浏览器"
        description="聊天界面里的 Agent 用 Kando 应用自带的浏览器打开页面、截图、点击，页面就显示在右侧的浏览器面板里；本地开发地址直接打开，其他站点第一次访问时在对话里问你。应用关掉时 Agent 用不了浏览器。"
        control={() => <span className="muted">{browserStatusText(status)}</span>}
      />
      <SettingsRow
        label="Agent 打开页面时自动显示浏览器"
        description="Agent 第一次在会话里用浏览器时，自动打开右侧的浏览器面板并选中它的标签页。默认关：浏览器在后台跑，对话里的页面卡片上点「打开」才显示。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={openOnTab} onChange={(next) => setPreference('openBrowserOnTab', next)} />
        )}
      />
    </>
  )
}

function AgentSettings() {
  const awakeSupported = useAwakeSupported()
  const awake = useCore((s) => s.awake)
  const defaultAgent = usePreferences((s) => s.defaultAgent)
  const allowBypass = usePreferences((s) => s.allowBypass)
  const chatSettings = useCore((s) => s.chatSettings)
  const installed = useInstalledAgents()
  return (
    <>
      <InstalledAgentsSettings />
      {chatSettings?.maxConcurrentAgents !== undefined && (
        <SettingsRow
          label="同时运行的 Agent 总数"
          description="达到上限后，新启动的会话会提示稍后重试；预约任务会等待空位。等待你批准的 Agent 也占一个位置，调低上限不会停止已运行的会话。"
          control={(labelId) => (
            <Stepper labelId={labelId} value={chatSettings.maxConcurrentAgents ?? 20} min={1} max={50} unit="个" onChange={(maxConcurrentAgents) => void setChatSettings({ maxConcurrentAgents })} />
          )}
        />
      )}
      {chatSettings?.agentConcurrency && AGENT_KINDS.map((agent) => (
        <SettingsRow
          key={agent}
          label={`${AGENT_LABEL[agent]} 同时运行`}
          description="同一 Agent 的上限；实际可启动数量也受总数上限约束。"
          control={(labelId) => (
            <Stepper labelId={labelId} value={chatSettings.agentConcurrency?.[agent] ?? 6} min={1} max={50} unit="个" onChange={(count) => void setChatSettings({ agentConcurrency: { [agent]: count } })} />
          )}
        />
      ))}
      {awakeSupported && awake && (
        <SettingsRow
          label="保持电脑唤醒"
          description="「Agent 工作时」只在至少一个 Agent 正在执行、或还有预约等着运行时阻止系统睡眠；Agent 等待输入时允许睡眠。合上笔记本仍会睡眠。关闭 Kando 窗口不影响正在运行的 Agent。"
          control={(labelId) => (
            <Segmented
              labelId={labelId}
              value={awake.mode}
              onChange={(mode) => void setAwakeMode(mode)}
              options={[
                { value: 'on', label: '始终' },
                { value: 'auto', label: 'Agent 工作或有预约时' },
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
      {chatSettings?.unattendedMode && (
        <SettingsRow
          label="预约运行的权限"
          description="预约的任务和会话到点时没人在场，以这个模式开始，不先规划、不等确认。「自动接受编辑」：改文件不再问，运行命令等其他操作仍会问，没人回答就停在那里，第二天再处理。「全部放行」：什么都不问，Codex 也不受沙箱限制，只在你信任这些任务时用。"
          control={(labelId) => (
            <Segmented
              labelId={labelId}
              value={chatSettings.unattendedMode ?? 'acceptEdits'}
              onChange={(unattendedMode) => void setChatSettings({ unattendedMode })}
              options={UNATTENDED_MODES.map((value) => ({ value, label: UNATTENDED_LABEL[value] }))}
            />
          )}
        />
      )}
      <SettingsRow
        label="允许「全部放行」"
        description="打开后，聊天界面的权限模式里多出「全部放行」：Agent 不再请求确认，Codex 也不再受沙箱限制。Claude Code 自己建议只在没有网络的沙箱里这样用。只影响之后启动的聊天会话。"
        control={(labelId) => (
          <Toggle labelId={labelId} checked={allowBypass} onChange={(next) => setPreference('allowBypass', next)} />
        )}
      />
      <SettingsRow
        label="新建任务的默认 Agent"
        description="「最近用过的」会沿用最新一个任务选的 Agent。"
        control={(labelId) => (
          <Segmented
            labelId={labelId}
            value={defaultAgent}
            onChange={(next) => setPreference('defaultAgent', next)}
            options={[
              { value: 'recent', label: '最近用过的' },
              ...installed.map((kind) => ({ value: kind, label: AGENT_LABEL[kind] })),
              { value: 'none', label: '不指定' }
            ]}
          />
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

// Read when the section opens and after each change: the wire log grows while agents run.
function DebugSettings() {
  const rpc = useCore((s) => s.rpc)
  const wireLog = useCore((s) => s.chatSettings?.wireLog ?? false)
  const [usage, setUsage] = useState<WireUsage | null>(null)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    if (!rpc) return
    let current = true
    void rpc.call('debug.wireUsage', {}).then((found) => { if (current) setUsage(found) }, () => {})
    return () => { current = false }
  }, [rpc, wireLog])
  const clear = async () => {
    if (!rpc || clearing) return
    setClearing(true)
    const left = await perform((connection) => connection.call('debug.clearWire', {}))
    if (left) setUsage(left)
    setClearing(false)
  }
  return (
    <>
      <SettingsRow
        label="记录和 Agent 之间的原始数据"
        description="打开后，Kando 把和聊天里的 Agent 之间收发的每一行原样记下来：发给 Agent 的、Agent 输出的（包括不是 JSON 的行和一段段流出来的文字）、stderr、启动命令和退出码。会话和任务的检查器里多出「原始数据」，可以按时间看、搜索、展开 JSON、复制。正在运行的 Agent 从下一行开始记录。"
        control={(labelId) => <Toggle labelId={labelId} checked={wireLog} onChange={(next) => void setChatSettings({ wireLog: next })} />}
      />
      <SettingsRow
        label="已经记下的"
        description={`${usage ? `${usage.files} 段，共 ${formatBytes(usage.bytes)}。` : ''}存在这台电脑的 ~/.kando/sessions/<会话>/wire/ 下，Agent 的每一段最多记 50 MB，超过 7 天的自动删除。里面有文件内容和命令输出，分享前看一眼。`}
        control={() => (
          <button type="button" className="button" disabled={clearing || !usage || usage.files === 0} onClick={() => void clear()}>
            全部删除
          </button>
        )}
      />
    </>
  )
}

const CONNECTION_TEXT = { connected: '已连接', connecting: '连接中…', 'waiting-for-core': '等待 core 启动' } as const

// Not an agent, but every task needs it for its worktree: what core found, and how to install it.
function GitRow() {
  const git = useCore((s) => s.environment?.checks.find((check) => check.tool === 'git'))
  if (!git) return null
  const missing = git.status === 'missing'
  return (
    <SettingsRow
      label="Git"
      description={missing ? '每个任务在自己的 worktree 里执行，没有 Git 就建不了。' : (git.path ?? undefined)}
      control={() => (
        <span className="git-status">
          <span className="environment-pill" data-level={missing ? 'danger' : 'ok'}>{checkStatusText(git)}</span>
          {missing && (
            <span className="environment-fix">
              <code>{INSTALL_HINT.git}</code>
              <CopyButton text={INSTALL_HINT.git} label="复制命令" />
            </span>
          )}
        </span>
      )}
    />
  )
}

function AboutSettings() {
  const connection = useCore((s) => s.connection)
  const shortcuts = [
    ['新建任务', `${PRIMARY_KEY_LABEL}N`],
    ['创建任务（新建任务对话框中）', `${PRIMARY_KEY_LABEL}↵`],
    ['打开 / 关闭设置', `${PRIMARY_KEY_LABEL},`]
  ] as const
  return (
    <>
      <SettingsRow
        label="项目地址"
        control={() => (
          <a className="settings-about-link" href="https://github.com/flyhero/kando-agents" target="_blank" rel="noreferrer">
            https://github.com/flyhero/kando-agents
          </a>
        )}
      />
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
      <GitRow />
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
    description: '底部状态栏里的 Agent 订阅额度。',
    keywords: ['状态栏', '额度', '百分比', '已用', '剩余', 'claude', 'codex'],
    Icon: GaugeIcon,
    Body: UsageSettings
  },
  {
    // In Electron only: a plain browser has no dock icon and nothing to click back to.
    id: 'notifications',
    group: '界面',
    title: '通知',
    description: 'Agent 需要你的时候，怎么告诉你。',
    keywords: ['通知', '提醒', '角标', 'dock', '前台', '等待', '确认', '做完', '异常退出', '弹窗', '卡片', '顶部', '审批', '允许'],
    Icon: BellIcon,
    Body: NotificationSettings
  },
  {
    id: 'agents',
    group: '任务',
    title: '智能体',
    description: '这台电脑上的 Agent：装没装、什么版本、登没登录，没装或没登录的给出要敲的命令；以及新建和执行任务、开始会话时它们的默认行为。',
    keywords: ['agent', '默认', '已安装', '未安装', '安装', '登录', '版本', '检测', '环境', '检查', 'path', '找不到', '启用', '禁用', 'claude', 'codex', '执行', '聊天', '会话', '任务', '规划', '预约', '无人值守'],
    Icon: SparkIcon,
    Body: AgentSettings
  },
  {
    id: 'agent-stats',
    group: '任务',
    title: '智能体表现',
    description: '每个 Agent 和模型的表现。任务（包括在聊天界面里执行的任务）看结果：你接受、继续修改、重做各占多少，从 0.10.0 开始记录；自由会话没有验收，只看用量：回合、失败、撞额度、耗时和 token。',
    keywords: ['表现', '统计', '通过率', '接受', '继续修改', '重做', '耗时', 'token', '模型', '会话', '用量', '回合', '失败', '额度', 'claude', 'codex'],
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
    description: '项目地址、版本、连接状态、Git 与快捷键。',
    keywords: ['项目地址', 'GitHub', '仓库', '版本', '协议', '连接', 'core', 'git', '环境', '快捷键'],
    Icon: InfoIcon,
    Body: AboutSettings
  }
]

// On a core that keeps them: the user's own slash commands; it follows 智能体.
const CHAT_COMMANDS_SECTION: Section = {
  id: 'chat-commands',
  group: '任务',
  title: '聊天命令',
  description: '自己的斜杠命令：在聊天输入框里输入 / 选用，把存好的提示词展开到输入框，改完再发。Claude Code 和 Codex 都能用。',
  keywords: ['命令', '斜杠', '/', '提示词', '模板', 'prompt', '聊天', '会话', '快捷'],
  Icon: ChatIcon,
  Body: ChatCommandSettings
}

// On a core that keeps a wire log: whether it does, and what it holds.
const DEBUG_SECTION: Section = {
  id: 'debug',
  group: '其他',
  title: '调试',
  description: '看清 Kando 和 Agent 之间到底传了什么：打开后，原样记下收发的每一行，在检查器的「原始数据」里查看。',
  keywords: ['调试', 'debug', '原始数据', '日志', 'log', 'stdout', 'stderr', 'stdin', 'json', '协议', '抓包', 'wire'],
  Icon: BugIcon,
  Body: DebugSettings
}

// The browser Kando hosts for chat agents, where core offers one; it follows the task sources.
const BROWSER_SECTION: Section = {
  id: 'browser',
  group: '集成',
  title: '浏览器',
  description: '聊天里的 Agent 用 Kando 托管的 Chromium 看页面：安装状态，以及 Agent 打开页面时要不要自动显示浏览器面板。',
  keywords: ['浏览器', 'chromium', '网页', '截图', '安装', '面板', '集成'],
  Icon: GlobeIcon,
  Body: BrowserRows
}

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
  useOccludesBrowser()
  const sources = useCore((s) => s.sources)
  const browser = useBrowserSupported()
  const chatCommands = useChatCommandsSupported()
  const wireLog = useWireLogSupported()
  const sections = useMemo(() => {
    const about = SECTIONS.filter((section) => section.id === 'about')
    const own = SECTIONS.filter((section) => section.id !== 'about' && (section.id !== 'notifications' || canNotify() || canShowRequestPopup()))
      .flatMap((section) => (section.id === 'agents' && chatCommands ? [section, CHAT_COMMANDS_SECTION] : [section]))
    return [...own, ...sourceSections(sources ?? []), ...(browser ? [BROWSER_SECTION] : []), ...(wireLog ? [DEBUG_SECTION] : []), ...about]
  }, [sources, browser, chatCommands, wireLog])
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
