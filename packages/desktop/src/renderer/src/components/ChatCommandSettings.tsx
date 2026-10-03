import { useEffect, useState, type FormEvent } from 'react'
import { CHAT_COMMAND_ARGUMENTS, ChatCommandFields, type SavedChatCommand } from '@kando/protocol'
import { deleteChatCommand, perform, saveChatCommand, useCore } from '../core-store'
import { PRIMARY_KEY_LABEL, hasPrimaryModifier } from '../shortcut-keys'
import { projectName } from './ProjectPicker'

type Draft = { id?: string; name: string; description: string; prompt: string; projectPath: string | null }

const NEW_DRAFT: Draft = { name: '', description: '', prompt: '', projectPath: null }

function CommandForm({ draft, projects, onDone }: { draft: Draft; projects: readonly string[]; onDone: () => void }) {
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [prompt, setPrompt] = useState(draft.prompt)
  const [projectPath, setProjectPath] = useState(draft.projectPath)
  const [saving, setSaving] = useState(false)
  const fields = { name: name.trim().replace(/^\//, ''), description: description.trim(), prompt: prompt.trim(), projectPath }
  const valid = ChatCommandFields.safeParse(fields).success
  const badName = fields.name.length > 0 && !ChatCommandFields.shape.name.safeParse(fields.name).success
  // The folder being edited stays a choice even when it has dropped out of the recent list.
  const choices = projectPath && !projects.includes(projectPath) ? [projectPath, ...projects] : projects

  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    const saved = await saveChatCommand({ id: draft.id, ...fields })
    setSaving(false)
    if (saved) onDone()
  }

  return (
    <form className="chat-command-form" onSubmit={(event) => void save(event)}>
      <label className="chat-command-field">
        <span>名称</span>
        <span className="chat-command-name-input">
          <span className="mono muted">/</span>
          <input
            className="input mono"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="fix-test"
            maxLength={41}
            spellCheck={false}
            autoFocus
            aria-invalid={badName}
          />
        </span>
        {badName && <span className="chat-command-hint">只能用字母、数字和 - _ :，并以字母或数字开头</span>}
      </label>
      <label className="chat-command-field">
        <span>说明</span>
        <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选，显示在命令列表里" maxLength={200} />
      </label>
      <label className="chat-command-field">
        <span>提示词</span>
        <textarea
          className="input chat-command-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && hasPrimaryModifier(event) && !event.nativeEvent.isComposing) void save()
          }}
          placeholder={`如：找出 ${CHAT_COMMAND_ARGUMENTS} 失败的原因并修好，改完跑一遍测试`}
          rows={6}
        />
        <span className="chat-command-hint">
          选中后展开到输入框，改完再发送。{CHAT_COMMAND_ARGUMENTS} 换成命令名后面输入的内容；没写它时，那些内容接在末尾。
        </span>
      </label>
      <label className="chat-command-field">
        <span>在哪些会话里显示</span>
        <select className="input" value={projectPath ?? ''} onChange={(event) => setProjectPath(event.target.value || null)}>
          <option value="">所有会话</option>
          {choices.map((project) => (
            <option key={project} value={project}>
              仅 {projectName(project)}（{project}）
            </option>
          ))}
        </select>
      </label>
      <div className="chat-command-actions">
        <button type="button" className="button ghost" onClick={onDone}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={!valid || saving}>
          保存
          <kbd>{PRIMARY_KEY_LABEL}↵</kbd>
        </button>
      </div>
    </form>
  )
}

function CommandRow({ command, onEdit }: { command: SavedChatCommand; onEdit: () => void }) {
  return (
    <li className="settings-project chat-command-row">
      <span className="settings-project-name mono">/{command.name}</span>
      <span className="chat-command-summary">
        {command.description || command.prompt}
      </span>
      <span className="chat-command-scope" title={command.projectPath ?? undefined}>
        {command.projectPath ? projectName(command.projectPath) : '所有会话'}
      </span>
      <button type="button" className="button" onClick={onEdit}>
        编辑
      </button>
      <button type="button" className="button" onClick={() => deleteChatCommand(command.id)}>
        删除
      </button>
    </li>
  )
}

export function ChatCommandSettings() {
  const connected = useCore((s) => s.connection === 'connected')
  const commands = useCore((s) => s.chatCommands)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [projects, setProjects] = useState<string[]>([])

  useEffect(() => {
    if (connected) void perform((rpc) => rpc.call('projects.recent', {})).then((recent) => setProjects(recent ?? []))
  }, [connected])

  if (!connected) return <p className="settings-empty">连接到 Kando core 后才能查看。</p>
  if (draft) return <CommandForm key={draft.id ?? 'new'} draft={draft} projects={projects} onDone={() => setDraft(null)} />
  return (
    <>
      {commands.length === 0 ? (
        <p className="settings-empty">还没有命令。在聊天输入框里输入 / 就能选用这里的命令。</p>
      ) : (
        <ul className="settings-project-list">
          {commands.map((command) => (
            <CommandRow key={command.id} command={command} onEdit={() => setDraft(command)} />
          ))}
        </ul>
      )}
      <div className="chat-command-actions">
        <button type="button" className="button" onClick={() => setDraft(NEW_DRAFT)}>
          新建命令
        </button>
      </div>
    </>
  )
}
