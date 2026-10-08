import { useCallback, useState, type ReactNode } from 'react'
import type { ResolvedFile } from '@kando/protocol'
import { canOpenFile, canRevealFile } from '../desktop-bridge'
import { copyFileText, FILE_MANAGER, openResolvedFile, revealResolvedFile, showResolvedFile, type ChatFileScope } from '../file-actions'
import { ContextMenu, MenuItem, menuPoint, type MenuPoint } from './ContextMenu'

export function FileMenuItems({ scope, file, line = null, onClose }: {
  scope: ChatFileScope; file: ResolvedFile; line?: number | null; onClose(): void
}) {
  const act = (action: () => void | Promise<void>) => { onClose(); void action() }
  return <>
    <MenuItem label="在侧栏预览" onSelect={() => act(() => showResolvedFile(scope, file, line))} />
    <MenuItem label="复制绝对路径" onSelect={() => act(() => copyFileText(file.path))} />
    {file.relative !== null && <MenuItem label="复制项目相对路径" onSelect={() => act(() => copyFileText(file.relative ?? file.path))} />}
    {canRevealFile() && <MenuItem label={`在${FILE_MANAGER}中显示`} onSelect={() => act(() => revealResolvedFile(file))} />}
    {canOpenFile() && <MenuItem label="用系统默认应用打开" onSelect={() => act(() => openResolvedFile(file))} />}
  </>
}

export function FileMenu({ scope, file, children }: { scope: ChatFileScope; file: ResolvedFile; children: ReactNode }) {
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  return <span className="file-menu-target" onKeyDown={(event) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    event.stopPropagation()
    const box = event.currentTarget.getBoundingClientRect()
    setAt({ x: box.left + 12, y: box.bottom })
  }} onContextMenu={(event) => {
    event.preventDefault()
    event.stopPropagation()
    setAt(menuPoint(event))
  }}>
    {children}
    {at && <ContextMenu at={at} label="文件操作" onClose={close}><FileMenuItems scope={scope} file={file} onClose={close} /></ContextMenu>}
  </span>
}
