import { useEffect, useRef, useState, type RefObject } from 'react'
import type { FileRead } from '@kando/protocol'
import { useCore } from '../core-store'
import { closedFile, EMPTY_FILE_TABS, updateFileTabs, useFileTabs, type FileTab } from '../file-tabs'
import { FileSource, type FileSourceHandle } from './FileSource'
import { useFocusCount } from './Inspector'
import { CloseIcon, MaximizeIcon, RefreshIcon, RestoreIcon, SearchIcon } from './icons'
import { FileMenu } from './FileMenu'

const REASON: Record<Extract<FileRead, { kind: 'unavailable' }>['reason'], string> = {
  'not-found': '文件不存在，可能已被移动或删除。',
  'is-directory': '这是一个目录，无法作为文本预览。',
  binary: '此文件不是 UTF-8 文本，暂不支持内置预览。',
  'too-large': '文件超过 2 MiB，无法内置预览。',
  unreadable: '无法读取文件，请检查访问权限。'
}

function FileContent({ conversationId, tab, wrap, source, refresh, updatedAt }: {
  conversationId: string; tab: FileTab; wrap: boolean; source: RefObject<FileSourceHandle | null>; refresh: number; updatedAt: number
}) {
  const rpc = useCore((state) => state.rpc)
  const focus = useFocusCount()
  const [result, setResult] = useState<FileRead | null>(null)
  const [loading, setLoading] = useState(true)
  const path = tab.file.path
  useEffect(() => {
    if (!rpc) return
    let current = true
    setLoading(true)
    void rpc.call('files.read', { conversationId, path }).catch(() => ({ kind: 'unavailable', reason: 'unreadable' } as const)).then((read) => {
      if (current) { setResult(read); setLoading(false) }
    })
    return () => { current = false }
  }, [rpc, conversationId, path, focus, refresh, updatedAt])
  return <div className="file-preview-content" data-file-path={path} aria-busy={loading}>
    {result?.kind === 'text'
      ? <FileSource ref={source} conversationId={conversationId} tab={tab} text={result.text} wrap={wrap} />
      : <p className="inspector-empty muted" role="status">{result?.kind === 'unavailable' ? REASON[result.reason] : '正在读取文件…'}</p>}
  </div>
}

export function FilePreview({ conversationId, updatedAt, onEmpty, inspector }: {
  conversationId: string; updatedAt: number; onEmpty(): void; inspector: 'task' | 'conversation'
}) {
  const state = useFileTabs((state) => state[conversationId] ?? EMPTY_FILE_TABS)
  const source = useRef<FileSourceHandle>(null)
  const [refresh, setRefresh] = useState(0)
  const active = state.tabs.find((tab) => tab.file.path === state.active)
  const scope = { conversationId, inspector, roots: [] }
  const close = (path: string) => {
    const next = closedFile(useFileTabs.getState()[conversationId] ?? EMPTY_FILE_TABS, path)
    updateFileTabs(conversationId, () => next)
    if (next.tabs.length === 0) onEmpty()
  }
  if (!active) return <p className="inspector-empty muted">点击聊天中的文件即可预览。</p>
  return <div className="file-preview">
    <div className="file-preview-tabs" role="tablist" aria-label="已打开的文件">
      {state.tabs.map((tab) => <div className="file-preview-tab" key={tab.file.path} data-active={tab.file.path === state.active || undefined}>
        <FileMenu scope={scope} file={tab.file}>
          <button type="button" role="tab" aria-selected={tab.file.path === state.active} title={tab.file.path} onClick={() => updateFileTabs(conversationId, (state) => ({ ...state, active: tab.file.path }))}>
            {tab.file.path.split(/[\\/]/).at(-1)}
            {state.tabs.some((other) => other.file.path !== tab.file.path && other.file.path.split(/[\\/]/).at(-1) === tab.file.path.split(/[\\/]/).at(-1)) && <span className="muted"> · {tab.file.relative ?? tab.file.path}</span>}
          </button>
        </FileMenu>
        <button type="button" className="file-preview-tab-close" aria-label={`关闭文件 ${tab.file.path}`} onClick={() => close(tab.file.path)}><CloseIcon /></button>
      </div>)}
    </div>
    <div className="file-preview-toolbar">
      <FileMenu scope={scope} file={active.file}><span className="file-preview-path mono" title={active.file.path}>{active.file.relative ?? active.file.path}</span></FileMenu>
      <button type="button" className="tool-button" aria-label="搜索文件内容" title="搜索 · Cmd/Ctrl+F" onClick={() => source.current?.search()}><SearchIcon /></button>
      <button type="button" className="tool-button file-wrap-button" aria-label="自动换行" aria-pressed={state.wrap} title="自动换行" onClick={() => updateFileTabs(conversationId, (state) => ({ ...state, wrap: !state.wrap }))}>↩</button>
      <button type="button" className="tool-button" aria-label="刷新文件" title="刷新文件" onClick={() => setRefresh((count) => count + 1)}><RefreshIcon /></button>
      <button type="button" className="tool-button" aria-label={state.maximized ? '还原文件面板' : '最大化文件面板'} title={state.maximized ? '还原' : '最大化'} onClick={() => updateFileTabs(conversationId, (state) => ({ ...state, maximized: !state.maximized }))}>{state.maximized ? <RestoreIcon /> : <MaximizeIcon />}</button>
    </div>
    <FileContent key={active.file.path} conversationId={conversationId} tab={active} wrap={state.wrap} source={source} refresh={refresh} updatedAt={updatedAt} />
  </div>
}
