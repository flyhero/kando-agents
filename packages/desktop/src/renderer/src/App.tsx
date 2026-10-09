import { onBrowserShortcut } from './desktop-bridge'
import { useEffect } from 'react'
import { setNewTaskOpen, setSettingsOpen, toggleBrowserPanel, toggleTerminalPanel, useCore } from './core-store'
import { NewTaskDialog } from './components/NewTaskDialog'
import { SettingsPage } from './components/SettingsPage'
import { SourceInboxView } from './components/SourceInboxView'
import { SourceLoginDialog } from './components/SourceLoginDialog'
import { TaskDetail } from './components/TaskDetail'
import { TaskList } from './components/TaskList'
import { TaskChat } from './components/TaskChat'
import { ConversationList } from './components/ConversationList'
import { Sidebar } from './components/Sidebar'
import { ConversationView } from './components/ConversationView'
import { ConversationDraft } from './components/ConversationDraft'
import { EnvironmentNotice } from './components/EnvironmentNotice'
import { StatusBar } from './components/StatusBar'
import { hasPrimaryModifier } from './shortcut-keys'
import { UtilityPanelDock } from './components/UtilityPanelDock'
import { WorktreeManager } from './components/WorktreeManager'
import { SchedulesView } from './components/SchedulesView'
import { RoutinesView } from './components/RoutinesView'
import { DashboardView } from './components/DashboardView'
import { DashboardEntry } from './components/DashboardEntry'
import { RoutinesEntry } from './components/RoutinesEntry'
import { AttentionEntry } from './components/AttentionEntry'
import { AttentionView } from './components/AttentionView'
import { WindowBrand } from './components/WindowBrand'
import { ErrorToast } from './components/ErrorToast'
import { usePreferences } from './preferences'
import { usePortPolling } from './port-state'

export function App() {
  usePortPolling()
  const selectedId = useCore((s) => s.selectedId)
  const section = useCore((s) => s.section)
  const selectedConversationId = useCore((s) => s.selectedConversationId)
  const conversationDraft = useCore((s) => s.conversationDraft)
  const view = useCore((s) => s.view)
  const error = useCore((s) => s.error)
  const newTaskOpen = useCore((s) => s.newTaskOpen)
  const settingsOpen = useCore((s) => s.settingsOpen)
  const worktreesOpen = useCore((s) => s.worktreesOpen)
  const schedulesOpen = useCore((s) => s.schedulesOpen)
  const routinesOpen = useCore((s) => s.routinesOpen)
  const dashboardOpen = useCore((s) => s.dashboardOpen)
  const attentionOpen = useCore((s) => s.attentionOpen)
  const inboxOpen = useCore((s) => s.inboxOpen)
  const loginOpen = useCore((s) => s.login !== null)
  const terminalPanelOpen = useCore((s) => s.terminalPanelOpen)
  const terminalMaximized = useCore((s) => s.terminalMaximized)
  const browserPanelOpen = useCore((s) => s.browserPanelOpen)
  const browserMaximized = useCore((s) => s.browserMaximized)
  const portsPanelOpen = useCore((s) => s.portsPanelOpen)
  const portsMaximized = useCore((s) => s.portsMaximized)
  const utilityPanelOrder = useCore((s) => s.utilityPanelOrder)
  const sidebarHidden = usePreferences((s) => s.sidebarHidden)
  const maximizedUtility = browserPanelOpen && browserMaximized
    ? 'browser'
    : terminalPanelOpen && terminalMaximized
      ? 'terminal'
      : portsPanelOpen && portsMaximized
        ? 'ports'
        : undefined

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const plain = hasPrimaryModifier(event) && !event.shiftKey && !event.altKey
      if (plain && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setNewTaskOpen(true)
      } else if (plain && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(!useCore.getState().settingsOpen)
      } else if (event.key === 'Escape' && useCore.getState().settingsOpen && !useCore.getState().newTaskOpen) {
        setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Ctrl+` everywhere, as in VS Code. Caught before the focused terminal sees it, which would
  // otherwise send the shell a NUL.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === '`') {
        event.preventDefault()
        event.stopPropagation()
        void toggleTerminalPanel()
      } else if (event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && event.key === '~') {
        // Ctrl+Shift+` beside it, for the browser panel.
        event.preventDefault()
        event.stopPropagation()
        toggleBrowserPanel()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // The same shortcuts pressed while a browser tab has the keyboard: the page's view sees them,
  // not this window, so main passes them on.
  useEffect(() => onBrowserShortcut((kind) => {
    if (kind === 'toggle-browser') toggleBrowserPanel()
    else setSettingsOpen(!useCore.getState().settingsOpen)
  }), [])

  // Files dragged anywhere but a drop target are swallowed here rather than opened by the window.
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault()
      }
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  return (
    <div className="app" data-sidebar-hidden={(sidebarHidden && !settingsOpen) || undefined}>
      <main className="workspace" data-utility-maximized={maximizedUtility}>
        {settingsOpen ? (
          <SettingsPage />
        ) : (
          <>
            <Sidebar hidden={sidebarHidden}>
              <AttentionEntry />
              <DashboardEntry />
              <RoutinesEntry />
              <EnvironmentNotice />
              <TaskList />
              <ConversationList />
            </Sidebar>
            {attentionOpen ? (
              <AttentionView />
            ) : worktreesOpen ? (
              <WorktreeManager />
            ) : schedulesOpen ? (
              <SchedulesView />
            ) : routinesOpen ? (
              <RoutinesView />
            ) : dashboardOpen ? (
              <DashboardView />
            ) : section === 'conversations' ? (
              selectedConversationId ? <ConversationView key={selectedConversationId} id={selectedConversationId} /> :
                conversationDraft ? <ConversationDraft /> :
                <section className="detail-empty">选择或新建一条会话</section>
            ) : inboxOpen ? (
              <SourceInboxView />
            ) : selectedId && view === 'chat' ? (
              <TaskChat key={selectedId} taskId={selectedId} />
            ) : selectedId ? (
              <TaskDetail key={selectedId} taskId={selectedId} />
            ) : (
              <section className="detail-empty">选择左侧的任务，查看和编辑详情</section>
            )}
          </>
        )}
        {(portsPanelOpen || browserPanelOpen || terminalPanelOpen) && (
          <UtilityPanelDock
            open={{ browser: browserPanelOpen, terminal: terminalPanelOpen, ports: portsPanelOpen }}
            maximized={maximizedUtility}
            order={utilityPanelOrder}
          />
        )}
      </main>
      {/* After the workspace: where drag regions overlap, the later one wins, and the sidebar and
          pane headers under it are drag regions. */}
      {!settingsOpen && !maximizedUtility && <WindowBrand />}
      <StatusBar />
      {newTaskOpen && <NewTaskDialog />}
      {loginOpen && <SourceLoginDialog />}
      {error && !newTaskOpen && <ErrorToast message={error} />}
    </div>
  )
}
