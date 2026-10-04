import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { HOURLY_EVERY, nextOccurrence, RoutineAgent, type AgentKind, type ChatCatalog, type Routine, type RoutineFields, type RoutineSchedule } from '@kando/protocol'
import type { RoutineTemplate } from '../routine-templates'
import { dismissError, useChatOptionsSupported, useCore } from '../core-store'
import { useInstalledAgents } from '../installed-agents'
import { AGENT_LABEL } from '../labels'
import { PRIMARY_KEY_LABEL, hasPrimaryModifier } from '../shortcut-keys'
import { createRoutine, ROUTINE_AGENT_LABEL, updateRoutine, WEEKDAY_LABEL } from '../routines'
import { scheduleTime, UNATTENDED_LABEL } from '../schedules'
import { AgentQuotaHint } from './AgentQuota'
import { ChatAddMenu, ChatImageStrip, useComposerImages } from './ChatImages'
import { effortLabel } from './ChatOptionsBar'
import { ChatModelPicker, ChatPicker } from './ChatPicker'
import { ProjectPicker } from './ProjectPicker'
import { SettingsLink } from './SchedulePicker'
import { Segmented } from './SettingsControls'

type Kind = RoutineSchedule['kind']
const KIND_OPTIONS: readonly { value: Kind; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'hourly', label: '每小时' },
  { value: 'manual', label: '手动' }
]
// Monday first, as the week is read here.
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const

function scheduleFrom(kind: Kind, time: string, days: readonly number[], every: number): RoutineSchedule {
  switch (kind) {
    case 'daily':
      return { kind, time }
    case 'weekdays':
      return { kind, time }
    case 'weekly':
      return { kind, days: [...days], time }
    case 'hourly':
      return { kind, every }
    case 'manual':
      return { kind }
  }
}

// Makes a routine, or changes one: what to do, which agent in which projects, and when. Runs go
// unattended in the mode the settings give every scheduled run. A new one may start from a
// template, which fills in the title, the instruction and the schedule to change at will.
export function RoutineEditor({ routine, template = null, onClose }: { routine: Routine | null; template?: RoutineTemplate | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const ids = useId()
  const error = useCore((s) => s.error)
  const connected = useCore((s) => s.connection === 'connected')
  const mode = useCore((s) => s.chatSettings?.unattendedMode ?? 'acceptEdits')
  const rpc = useCore((s) => s.rpc)
  const optionsSupported = useChatOptionsSupported()
  const installed = useInstalledAgents()
  const [title, setTitle] = useState(routine?.title ?? template?.title ?? '')
  const [text, setText] = useState(routine?.target.text ?? template?.text ?? '')
  const [agent, setAgent] = useState<RoutineAgent>(routine?.target.agent ?? installed[0] ?? 'claude')
  const [projectPaths, setProjectPaths] = useState<string[]>(routine?.target.projectPaths ?? [])
  const [model, setModel] = useState<string | null>(routine?.target.model ?? null)
  const [effort, setEffort] = useState<string | null>(routine?.target.effort ?? null)
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentKind, ChatCatalog | null>>>({})
  const given = routine?.schedule ?? template?.schedule
  const [kind, setKind] = useState<Kind>(given?.kind ?? 'daily')
  const [time, setTime] = useState(given && 'time' in given ? given.time : '09:00')
  const [days, setDays] = useState<number[]>(given?.kind === 'weekly' ? given.days : [1])
  const [every, setEvery] = useState(given?.kind === 'hourly' ? given.every : 1)
  const [busy, setBusy] = useState(false)
  const attached = useComposerImages()
  const submitting = useRef(false)

  useEffect(() => {
    // Sizes are not kept with the routine; the strip shows them by their ids alone.
    if (routine?.target.images?.length) attached.setImages(routine.target.images.map((id) => ({ id, width: 0, height: 0 })))
    const element = dialog.current
    if (element && !element.open) element.showModal()
    titleInput.current?.focus()
    dismissError()
    return () => element?.close()
    // Once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (agent === 'auto' || !rpc || !optionsSupported || agent in catalogs) return
    let current = true
    const settle = (catalog: ChatCatalog | null) => current && setCatalogs((known) => ({ ...known, [agent]: catalog }))
    rpc.call('conversations.chatCatalog', { agent }).then(settle, () => settle(null))
    return () => { current = false }
  }, [agent, rpc, optionsSupported, catalogs])

  const schedule = scheduleFrom(kind, time, days, every)
  const next = nextOccurrence(schedule, Date.now())
  const catalog = agent === 'auto' ? null : catalogs[agent]
  const modelId = model ?? catalog?.models.find((each) => each.isDefault)?.id ?? null
  const efforts = catalog?.models.find((each) => each.id === modelId)?.efforts ?? []
  const chosenEffort = effort && efforts.includes(effort) ? effort : null
  const hasPrompt = text.trim() !== '' || attached.images.length > 0
  const validSchedule = kind === 'manual' || (kind === 'weekly' ? days.length > 0 : true)
  const canSubmit = connected && !busy && attached.uploading === 0 && hasPrompt && validSchedule

  async function submit() {
    if (!canSubmit || submitting.current) return
    submitting.current = true
    setBusy(true)
    dismissError()
    const fields: RoutineFields = {
      title: title.trim() || text.trim().split('\n')[0]?.slice(0, 40) || '定时任务',
      schedule,
      target: {
        kind: 'new',
        agent,
        projectPaths,
        text: text.trim(),
        ...(attached.images.length ? { images: attached.images.map((image) => image.id) } : {}),
        ...(agent !== 'auto' && model ? { model } : {}),
        ...(agent !== 'auto' && chosenEffort ? { effort: chosenEffort } : {})
      }
    }
    const saved = routine ? await updateRoutine(routine.id, fields) : await createRoutine(fields)
    submitting.current = false
    setBusy(false)
    if (saved) onClose()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && hasPrimaryModifier(event)) {
      event.preventDefault()
      void submit()
    }
  }
  const onBackdrop = (event: MouseEvent) => {
    if (event.target === dialog.current) onClose()
  }
  const toggleDay = (day: number) => setDays((current) => (current.includes(day) ? current.filter((each) => each !== day) : [...current, day]))

  return (
    <dialog
      ref={dialog}
      className="modal routine-editor"
      aria-labelledby={`${ids}-heading`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={onKeyDown}
      onClick={onBackdrop}
    >
      <div className="modal-body">
        <header className="modal-header">
          <h2 id={`${ids}-heading`}>{routine ? '编辑定时任务' : '新建定时任务'}</h2>
          <button type="button" className="icon-button modal-close" aria-label="关闭" onClick={onClose}>×</button>
        </header>

        <label className="modal-field">
          <span className="modal-label">名称 <span className="modal-optional">[留空则取指令的第一行]</span></span>
          <input ref={titleInput} className="input modal-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="比如：每日代码审查" maxLength={200} />
        </label>

        <div className="modal-field">
          <span className="modal-label" id={`${ids}-prompt`}>每次运行时让 agent 做什么</span>
          <div className="chat-input-card routine-editor-card" onDragOver={attached.handlers.onDragOver} onDrop={attached.handlers.onDrop}>
            <ChatImageStrip images={attached.images} uploading={attached.uploading} onRemove={attached.remove} />
            <textarea
              className="chat-input routine-editor-prompt"
              aria-labelledby={`${ids}-prompt`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={attached.handlers.onPaste}
              placeholder="像在聊天里一样写指令。到点会新开一个会话，把这段话发给 agent，无人值守地做完。"
              rows={4}
            />
            <div className="chat-options routine-editor-options">
              <ChatAddMenu disabled={busy} onAdd={attached.add} />
              <ChatPicker
                label="agent"
                value={agent}
                placeholder="agent"
                options={[
                  ...installed.map((kind) => ({ value: kind, label: AGENT_LABEL[kind] })),
                  { value: 'auto', label: ROUTINE_AGENT_LABEL.auto, description: '到点时用有额度的那个' }
                ]}
                disabled={busy}
                onChange={(value) => {
                  const picked = RoutineAgent.safeParse(value)
                  if (picked.success) setAgent(picked.data)
                }}
              />
              {agent !== 'auto' && optionsSupported && catalog && (
                <ChatModelPicker
                  models={catalog.models.map((each) => ({ value: each.id, label: each.label, description: each.description }))}
                  model={modelId}
                  efforts={efforts.map((each) => ({ value: each, label: effortLabel(each) }))}
                  effort={chosenEffort}
                  disabled={busy}
                  onModel={(value) => {
                    setModel(value)
                    const picked = catalog.models.find((each) => each.id === value)
                    if (effort && !picked?.efforts.includes(effort)) setEffort(null)
                  }}
                  onEffort={setEffort}
                />
              )}
              {agent !== 'auto' && <AgentQuotaHint agent={agent} className="routine-editor-quota" />}
              <span className="chat-dock-spacer" />
              <ProjectPicker projects={projectPaths.map((path) => ({ path, worktreePath: null }))} onChange={setProjectPaths} locked={busy} />
            </div>
          </div>
          {(agent === 'auto' || projectPaths.length === 0) && (
            <span className="muted routine-editor-note">
              {agent === 'auto' ? '到点时用有额度的那个 agent。' : ''}
              {projectPaths.length === 0 ? '不选项目时，用 Kando 的工作目录。' : ''}
            </span>
          )}
        </div>

        <div className="modal-field">
          <span className="modal-label" id={`${ids}-when`}>什么时候</span>
          <Segmented labelId={`${ids}-when`} value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <div className="routine-editor-when">
            {(kind === 'daily' || kind === 'weekdays' || kind === 'weekly') && (
              <input type="time" className="input routine-editor-time" aria-label="时间" value={time} onChange={(e) => setTime(e.target.value)} />
            )}
            {kind === 'weekly' && (
              <div className="routine-editor-days" role="group" aria-label="星期">
                {WEEK.map((day) => (
                  <button key={day} type="button" role="checkbox" aria-checked={days.includes(day)} className="weekday-toggle" onClick={() => toggleDay(day)}>
                    {WEEKDAY_LABEL[day]}
                  </button>
                ))}
              </div>
            )}
            {kind === 'hourly' && (
              <label className="routine-editor-every">
                每
                <select className="input" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                  {HOURLY_EVERY.map((count) => <option key={count} value={count}>{count}</option>)}
                </select>
                小时，从 0 点起算
              </label>
            )}
            <span className="muted routine-editor-note">
              {kind === 'manual' ? '只在你点「立即运行」时运行。' : next === null ? '选一个星期几。' : `下次：${scheduleTime(next, Date.now())}`}
            </span>
          </div>
        </div>

        <p className="muted routine-editor-mode">
          以「{UNATTENDED_LABEL[mode]}」无人值守运行，<SettingsLink />。电脑睡着时到点不会运行，醒来后只补最近错过的一次。
        </p>

        {error && <p className="modal-error" role="alert">{error}</p>}

        <footer className="modal-footer">
          <button type="button" className="button" onClick={onClose}>取消</button>
          <button type="button" className="button primary modal-submit" disabled={!canSubmit} onClick={() => void submit()}>
            {routine ? '保存' : '创建'}
            <kbd>{PRIMARY_KEY_LABEL}↵</kbd>
          </button>
        </footer>
      </div>
    </dialog>
  )
}
