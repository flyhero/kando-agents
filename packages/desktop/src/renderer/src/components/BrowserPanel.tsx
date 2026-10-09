import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { BrowserTab, BrowserViewport } from '@kando/protocol'
import { ALL_TABS, focusBrowserTab, selectBrowserTab, useBrowserTabs, useWatchAllBrowser } from '../browser-state'
import { perform, useCore } from '../core-store'
import { canShowNativeBrowser, onBrowserFocused, reportBrowserBounds, showNativeBrowserTab } from '../desktop-bridge'
import { ChatPicker } from './ChatPicker'
import { ArrowLeftIcon, ArrowRightIcon, CameraIcon, CloseIcon, GlobeIcon, PlusIcon, RefreshIcon } from './icons'
import { Spinner } from './Spinner'

// The hostname a tab shows in its strip, or what it has while it has no page.
function tabName(tab: BrowserTab): string {
  if (tab.title) return tab.title
  if (!tab.url || tab.url === 'about:blank') return '新标签页'
  try {
    return new URL(tab.url).hostname || tab.url
  } catch {
    return tab.url
  }
}

// The tabs as pills in the panel's top bar, the one shown filled in, each with its close, and a
// plus for a tab of the user's own after them. The pills share the width and shrink as tabs come,
// so the plus stays in reach however many there are.
export function BrowserTabStrip() {
  const ownerName = useOwnerNames()
  const { tabs, selectedId } = useBrowserTabs((s) => s[ALL_TABS]) ?? { tabs: [], selectedId: null }
  const strip = useRef<HTMLDivElement>(null)
  // A tab opened here is the one the user wants to see, as in any browser.
  const newTab = async () => {
    const opened = await perform((rpc) => rpc.call('browser.newTab', {}))
    if (opened) focusBrowserTab(opened.id)
  }
  // The shown tab is scrolled into the strip when there are more than fit.
  useEffect(() => {
    if (!selectedId) return
    strip.current?.querySelector<HTMLElement>(`[data-tab-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedId, tabs.length])
  return (
    <div className="browser-tab-strip">
    <div className="browser-tabs" role="tablist" aria-label="标签页" ref={strip}>
      {tabs.map((each) => (
        <div key={each.id} className="browser-tab" data-tab-id={each.id} data-active={each.id === selectedId || undefined} data-loading={each.loading || undefined}>
          <button type="button" role="tab" aria-selected={each.id === selectedId} title={each.url} onClick={() => selectBrowserTab(ALL_TABS, each.id)}>
            <span className="browser-tab-icon" aria-hidden="true"><GlobeIcon /></span>
            {ownerName(each) && <span className="browser-tab-owner">{ownerName(each)}</span>}
            <span className="browser-tab-name">{tabName(each)}</span>
          </button>
          <button type="button" className="browser-tab-close" aria-label={`关闭标签页 ${tabName(each)}`} onClick={() => void perform((rpc) => rpc.call('browser.closeTab', { tabId: each.id }))}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
    <button type="button" className="tool-button browser-tab-add" aria-label="新标签页" data-tooltip="新标签页" onClick={() => void newTab()}><PlusIcon /></button>
    </div>
  )
}

// What is happening on the tab, in a word, for the line under the page.
function tabState(tab: BrowserTab, focused: boolean): string {
  if (tab.userDriving) return '你在操作'
  if (tab.agentActing) return 'Agent 正在操作'
  if (tab.loading) return '页面加载中'
  return focused ? '键盘输入发给页面' : '观看中'
}

// The sizes a page can be held at from the panel, besides following it. A size the agent chose
// that is none of these is offered as it is.
const PRESETS: ReadonlyArray<{ label: string; viewport: BrowserViewport }> = [
  { label: '手机 390×844', viewport: { width: 390, height: 844 } },
  { label: '平板 768×1024', viewport: { width: 768, height: 1024 } },
  { label: '桌面 1280×800', viewport: { width: 1280, height: 800 } },
  { label: '宽屏 1920×1080', viewport: { width: 1920, height: 1080 } }
]
const FOLLOW = 'panel'
const keyOf = (viewport: BrowserViewport | null) => (viewport ? `${viewport.width}x${viewport.height}` : FOLLOW)

function ViewportPicker({ tab }: { tab: BrowserTab }) {
  const current = keyOf(tab.viewport)
  const options = [
    { value: FOLLOW, label: '跟随面板', description: '页面和面板一样大' },
    ...PRESETS.map((preset) => ({ value: keyOf(preset.viewport), label: preset.label })),
    ...(tab.viewport && !PRESETS.some((preset) => keyOf(preset.viewport) === current) ? [{ value: current, label: `${tab.viewport.width}×${tab.viewport.height}`, description: 'Agent 定的' }] : [])
  ]
  const choose = (value: string) => {
    const match = /^(\d+)x(\d+)$/.exec(value)
    const viewport = match ? { width: Number(match[1]), height: Number(match[2]) } : null
    void perform((rpc) => rpc.call('browser.userViewport', { tabId: tab.id, viewport }))
  }
  return <ChatPicker label="页面尺寸" value={current} placeholder="跟随面板" options={options} onChange={choose} align="end" placement="below" />
}

// Where the page goes: the tab's native view, placed by main over this rectangle and kept there
// as the panel moves. Checked each frame rather than on the events that move it (a separator
// dragged, the sidebar folding, the panel sliding in), of which there are many; only a change
// is reported. A tab held at a size stands centred here, framed, as main places it.
function NativeStage({ tab }: { tab: BrowserTab }) {
  const stage = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null)
  const held = tab.viewport
  useLayoutEffect(() => {
    const element = stage.current
    if (!element || !canShowNativeBrowser()) return
    showNativeBrowserTab(tab.id)
    let last = ''
    let handle = 0
    const tick = () => {
      const rect = element.getBoundingClientRect()
      const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
      if (key !== last) {
        last = key
        reportBrowserBounds(rect)
        if (held) {
          const scale = Math.min(1, rect.width / held.width, rect.height / held.height)
          setFrame({ width: Math.round(held.width * scale), height: Math.round(held.height * scale) })
        }
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(handle)
      showNativeBrowserTab(null)
    }
  }, [tab.id, held])
  return (
    <div ref={stage} className="browser-stage" data-held={held ? '' : undefined}>
      {!canShowNativeBrowser() && <span className="browser-stage-note">页面在 Kando 应用里显示</span>}
      {held && frame && <div className="browser-stage-frame" style={{ width: frame.width, height: frame.height }} />}
    </div>
  )
}

// Whose a tab is, for the browser panel that shows everyone's: a conversation by its title, the
// user's own by nothing.
function useOwnerNames(): (tab: BrowserTab) => string | null {
  const conversations = useCore((s) => s.conversations)
  const tasks = useCore((s) => s.tasks)
  return (tab) => {
    if (tab.conversationId === null) return null
    const conversation = conversations[tab.conversationId]
    if (conversation) return conversation.title
    const task = Object.values(tasks).find((each) => each.conversationId === tab.conversationId)
    return task?.title ?? '会话'
  }
}

// Every tab there is, the agents' and the user's own: the one chosen shown with the address and
// the usual buttons, and a word on who is driving. The strip of tabs is the panel's top bar.
export function BrowserPanel() {
  const status = useCore((s) => s.browser)
  const { tabs, selectedId } = useWatchAllBrowser()
  const tab = tabs.find((each) => each.id === selectedId) ?? null
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [focusedTab, setFocusedTab] = useState<string | null>(null)
  useEffect(() => {
    if (!editing) setAddress(tab?.url ?? '')
  }, [tab?.url, editing])
  useEffect(() => onBrowserFocused((tabId, focused) => setFocusedTab((was) => (focused ? tabId : was === tabId ? null : was))), [])

  const go = (event: FormEvent) => {
    event.preventDefault()
    if (!tab || !address.trim()) return
    setEditing(false)
    void perform((rpc) => rpc.call('browser.userNavigate', { tabId: tab.id, to: { url: address.trim() } }))
  }
  const history = (step: 'back' | 'forward' | 'reload') => {
    if (tab) void perform((rpc) => rpc.call('browser.userNavigate', { tabId: tab.id, to: { history: step } }))
  }
  const newTab = () => void perform((rpc) => rpc.call('browser.newTab', {}))

  if (status && status.state !== 'ready' && tabs.length === 0) {
    return (
      <div className="browser-empty">
        {status.state === 'app-closed' && <p>{status.message ?? '浏览器在 Kando 应用里运行，core 还没有连上它。'}</p>}
        {status.state === 'starting' && <p><Spinner label="正在连接" /> 正在连接浏览器…</p>}
        {status.state === 'error' && <p className="browser-error">浏览器出了问题：{status.message ?? '未知错误'}</p>}
      </div>
    )
  }
  const focused = tab !== null && focusedTab === tab.id
  return (
    <div className="browser-panel">
      {tab ? (
        <>
          <form className="browser-address" onSubmit={go}>
            <button type="button" className="tool-button" aria-label="后退" data-tooltip="后退" onClick={() => history('back')}><ArrowLeftIcon /></button>
            <button type="button" className="tool-button" aria-label="前进" data-tooltip="前进" onClick={() => history('forward')}><ArrowRightIcon /></button>
            <button type="button" className="tool-button" aria-label="刷新" data-tooltip="刷新" onClick={() => history('reload')}><RefreshIcon /></button>
            <input
              className="input browser-url mono"
              value={address}
              aria-label="地址"
              spellCheck={false}
              // Selected whole on focus, as a browser's own address bar is: typing replaces it.
              onFocus={(event) => {
                setEditing(true)
                event.currentTarget.select()
              }}
              onBlur={() => setEditing(false)}
              onChange={(event) => setAddress(event.target.value)}
            />
            <ViewportPicker tab={tab} />
            <button
              type="button"
              className="tool-button"
              aria-label="截图到对话"
              data-tooltip="截图，存为图片"
              onClick={() => void perform((rpc) => rpc.call('browser.userScreenshot', { tabId: tab.id }))}
            >
              <CameraIcon />
            </button>
          </form>
          <NativeStage key={tab.id} tab={tab} />
          <div className="browser-status">
            <span>{tabState(tab, focused)}</span>
            {tab.userDriving && (
              <button type="button" className="link-button" onClick={() => void perform((rpc) => rpc.call('browser.handBack', { tabId: tab.id }))}>交还给 Agent</button>
            )}
            <span className="chat-dock-spacer" />
            {focused && <span className="muted">Esc 回到应用 · Shift+Esc 发给页面</span>}
          </div>
        </>
      ) : (
        <div className="browser-empty">
          <p>还没有打开标签页。</p>
          <button type="button" className="button" onClick={newTab}>新标签页</button>
        </div>
      )}
    </div>
  )
}
