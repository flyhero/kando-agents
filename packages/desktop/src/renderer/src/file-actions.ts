import type { ResolvedFile } from '@kando/protocol'
import { perform, showError, useCore } from './core-store'
import { canRevealFile, openFile, revealFile } from './desktop-bridge'
import { fileCandidates, type FileReference } from './file-links'
import { openedFile, updateFileTabs } from './file-tabs'

export type ChatFileScope = { conversationId: string; inspector: 'task' | 'conversation'; roots: readonly string[] }
export const FILE_MANAGER = window.kando?.platform === 'darwin' ? '访达' : window.kando?.platform === 'win32' ? '资源管理器' : '文件管理器'

export function filePreviewSupported(): boolean {
  return useCore.getState().rpc?.features.includes('file-preview') ?? false
}

export function useFilePreviewSupported(): boolean {
  return useCore((state) => state.rpc?.features.includes('file-preview') ?? false)
}

export function showResolvedFile(scope: ChatFileScope, file: ResolvedFile, line: number | null): void {
  updateFileTabs(scope.conversationId, (state) => openedFile(state, file, line))
  useCore.setState(scope.inspector === 'task'
    ? { inspectorOpen: true, taskInspectorTab: 'files' }
    : { conversationInspectorOpen: true, conversationInspectorTab: 'files' })
}

export async function resolveChatFile(scope: ChatFileScope, reference: FileReference): Promise<ResolvedFile | null> {
  return perform(async (rpc) => {
    const found = await rpc.call('files.resolve', { conversationId: scope.conversationId, path: reference.path })
    if (!found) showError(`找不到文件：${reference.path}`)
    return found
  })
}

export async function showChatFile(scope: ChatFileScope, reference: FileReference): Promise<void> {
  if (filePreviewSupported()) {
    const found = await resolveChatFile(scope, reference)
    if (found) showResolvedFile(scope, found, reference.line)
  } else if (canRevealFile()) {
    if (await revealFile(fileCandidates(reference.path, scope.roots))) return
    const found = useCore.getState().rpc?.features.includes('find-file')
      ? await perform((rpc) => rpc.call('projects.findFile', { roots: [...scope.roots], path: reference.path })) : null
    if (found?.length && await revealFile(found)) return
    showError(`找不到文件：${reference.path}`)
  }
}

export async function revealResolvedFile(file: ResolvedFile): Promise<void> {
  if (!await revealFile([file.path])) showError(`无法在${FILE_MANAGER}中显示：${file.path}`)
}

export async function openResolvedFile(file: ResolvedFile): Promise<void> {
  const error = await openFile(file.path)
  if (error) showError(error)
}

export async function copyFileText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    showError('复制失败，请重试')
  }
}
