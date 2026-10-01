import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BROWSER_VIEWPORT, type BrowserTab } from '@kando/protocol'
import { ALL_TABS, focusBrowserTab, selectBrowserTab, useBrowserTabs, useWatchAllBrowser } from '../browser-state'
import { perform, setSettingsOpen, useCore } from '../core-store'
import { createBrowserView } from './browser-view'
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

// What is happening on the tab, in a word, for the line under the picture.
function tabState(tab: BrowserTab, focused: boolean): string {
  if (tab.userDriving) return '你在操作'
  if (tab.agentActing) return 'agent 正在操作'
  if (tab.loading) return '页面加载中'
  return focused ? '键盘输入发给页面' : '观看中'
}

// The live view of one tab, drawn as it changes; clicking and typing on it go to the page.
function LiveTab({ tab, onFocus }: { tab: BrowserTab; onFocus(focused: boolean): void }) {
  const rpc = useCore((s) => s.rpc)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!rpc || !canvas.current || !textarea.current) return
    const view = createBrowserView({ canvas: canvas.current, textarea: textarea.current, rpc, tabId: tab.id, viewport: BROWSER_VIEWPORT, onFocus })
    return () => view.dispose()
  }, [rpc, tab.id, onFocus])
  return (
    <div className="browser-stage">
      <canvas ref={canvas} className="browser-canvas" width={BROWSER_VIEWPORT.width} height={BROWSER_VIEWPORT.height} />
      <textarea ref={textarea} className="browser-keys" aria-label="页面画面：点击后键盘输入发给页面，Esc 回到应用" tabIndex={-1} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
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

// Every tab there is, the agents' and the user's own: the one chosen shown live with the address
// and the usual buttons, and a word on who is driving. The strip of tabs is the panel's top bar.
export function BrowserPanel() {
  const status = useCore((s) => s.browser)
  const { tabs, selectedId } = useWatchAllBrowser()
  const tab = tabs.find((each) => each.id === selectedId) ?? null
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!editing) setAddress(tab?.url ?? '')
  }, [tab?.url, editing])

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
        {status.state === 'not-installed' && (
          <>
            <p>浏览器还没安装。第一次使用要下载 Chromium，约 150MB。</p>
            <button type="button" className="button" onClick={() => setSettingsOpen(true, 'agents')}>去设置安装</button>
          </>
        )}
        {status.state === 'installing' && <p><Spinner label="正在下载" /> 正在下载 Chromium{status.percent !== undefined ? ` ${status.percent}%` : ''}…</p>}
        {status.state === 'starting' && <p><Spinner label="正在启动" /> 浏览器正在启动…</p>}
        {status.state === 'error' && <p className="browser-error">浏览器出了问题：{status.message ?? '未知错误'}</p>}
      </div>
    )
  }
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
          <LiveTab tab={tab} onFocus={setFocused} />
          <div className="browser-status">
            <span>{tabState(tab, focused)}</span>
            {tab.userDriving && (
              <button type="button" className="link-button" onClick={() => void perform((rpc) => rpc.call('browser.handBack', { tabId: tab.id }))}>交还给 agent</button>
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
