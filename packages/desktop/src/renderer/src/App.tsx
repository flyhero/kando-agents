import { useEffect } from 'react'
import { dismissError, setNewTaskOpen, setSettingsOpen, useCore } from './core-store'
import { NewTaskDialog } from './components/NewTaskDialog'
import { SettingsPage } from './components/SettingsPage'
import { SourceInboxView } from './components/SourceInboxView'
import { SourceLoginDialog } from './components/SourceLoginDialog'
import { TaskDetail } from './components/TaskDetail'
import { TaskList } from './components/TaskList'
import { TaskTerminal } from './components/TaskTerminal'
import { ConversationList } from './components/ConversationList'
import { ConversationTerminal } from './components/ConversationTerminal'
import { NewConversationDialog } from './components/NewConversationDialog'
import { StatusBar } from './components/StatusBar'
import { hasPrimaryModifier } from './shortcut-keys'

export function App() {
  const selectedId = useCore((s) => s.selectedId)
  const section = useCore((s) => s.section)
  const selectedConversationId = useCore((s) => s.selectedConversationId)
  const newConversationOpen = useCore((s) => s.newConversationOpen)
  const view = useCore((s) => s.view)
  const error = useCore((s) => s.error)
  const newTaskOpen = useCore((s) => s.newTaskOpen)
  const settingsOpen = useCore((s) => s.settingsOpen)
  const inboxOpen = useCore((s) => s.inboxOpen)
  const loginOpen = useCore((s) => s.login !== null)

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
    <div className="app">
      <main className="workspace">
        {settingsOpen ? (
          <SettingsPage />
        ) : (
          <>
            <div className="sidebar">
              <TaskList />
              <ConversationList />
            </div>
            {section === 'conversations' ? (
              selectedConversationId ? <ConversationTerminal key={selectedConversationId} id={selectedConversationId} /> :
                <section className="detail-empty">选择或新建一条自由会话</section>
            ) : inboxOpen ? (
              <SourceInboxView />
            ) : selectedId && view === 'terminal' ? (
              <TaskTerminal key={selectedId} taskId={selectedId} />
            ) : selectedId ? (
              <TaskDetail key={selectedId} taskId={selectedId} />
            ) : (
              <section className="detail-empty">选择左侧的任务，查看和编辑详情</section>
            )}
          </>
        )}
      </main>
      <StatusBar />
      {newTaskOpen && <NewTaskDialog />}
      {newConversationOpen && <NewConversationDialog />}
      {loginOpen && <SourceLoginDialog />}
      {error && !newTaskOpen && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" className="button ghost" onClick={dismissError}>
            知道了
          </button>
        </div>
      )}
    </div>
  )
}
