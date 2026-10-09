import { useCallback, useEffect, useState, useRef, type KeyboardEvent } from 'react'
import { itemKey, type PlanItem } from '../chat-state'
import { composeFeedback, setQuotes, useQuotes } from '../chat-quotes'
import { planMarkdownFilename } from '../plan-markdown'
import { QuoteCards } from './ChatQuoteCards'
import { PlanComments } from './PlanComments'
import { useChatSurface } from './chat-surface'
import { ChatMarkdown } from './ChatMarkdown'
import { useResponder } from './ChatRequestCards'
import { SchedulePicker } from './SchedulePicker'
import { perform, useCore, usePlanModesSupported, useSchedulesSupported } from '../core-store'
import { setPreference, usePreferences, type Preferences } from '../preferences'
import { ContextMenu, type MenuPoint } from './ContextMenu'
import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon } from './icons'
import { createSchedule } from '../schedules'
import { modeLabel } from './ChatOptionsBar'
import type { AgentKind } from '@kando/protocol'

// Approving later, once the quota is back: an empty scheduled message approves the plan waiting.
function SchedulePlanButton({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <span className="menu-anchor chat-plan-schedule">
      <button type="button" className="link-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>预约批准</button>
      {open && (
        <SchedulePicker
          align="end"
          title="预约批准这个计划"
          note="到点后批准并开始执行，不会停下来等你确认。"
          onSchedule={async (notBefore) => (await createSchedule({ kind: 'conversation', conversationId, text: '' }, notBefore)) !== null}
          onClose={close}
        />
      )}
    </span>
  )
}

// A plan Claude proposes from plan mode reads beside the conversation, in the inspector; the
// list and the dock only point to it, and the dock takes the answer.

const RESOLUTION: Record<NonNullable<PlanItem['resolution']>, string> = {
  allowed: '按计划执行，逐项确认',
  allowedForSession: '按计划执行，自动接受编辑',
  denied: '继续规划',
  // Stopped before it was answered, or the agent ended first: either way nothing was carried out.
  cancelled: '没有执行'
}

// The permission modes a plan can be carried out in, in the order the menu offers them.
type RunMode = Preferences['planRunMode']
const RUN_MODES: readonly RunMode[] = ['auto', 'acceptEdits', 'ask', 'bypass']
const RUN_MODE: Record<RunMode, { label: string; hint: string }> = {
  auto: { label: '自动模式', hint: '安全的操作直接执行，有风险的才问你' },
  acceptEdits: { label: '自动接受编辑', hint: '改文件不问，跑命令前问' },
  ask: { label: '逐项确认', hint: '改文件、跑命令前都问' },
  bypass: { label: '全部放行', hint: '什么都不问，只在你信任这次任务时用' }
}

function isRunMode(mode: string): mode is RunMode {
  return RUN_MODES.some((each) => each === mode)
}

function status(plan: PlanItem): string {
  if (plan.resolution === null) return '等你确认'
  if ((plan.resolution === 'allowed' || plan.resolution === 'allowedForSession') && plan.mode && isRunMode(plan.mode)) {
    return `按计划执行，${plan.tool === 'cursor/create_plan' ? 'Agent' : RUN_MODE[plan.mode].label}`
  }
  return RESOLUTION[plan.resolution]
}

// The execute button's mode: the one picked last, where the stage offers it; otherwise auto, then
// accepting edits. The arrow beside it opens the others the stage offers.
function RunModeButton({ modes, mode, disabled, onRun, agent }: { modes: readonly RunMode[]; mode: RunMode; disabled: boolean; onRun: () => void; agent: AgentKind }) {
  const arrow = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  return (
    <span className="plan-run">
      <button type="button" className="button primary plan-run-main" disabled={disabled} onClick={onRun}>
        执行 · {agent === 'cursor' ? modeLabel(agent, mode) : RUN_MODE[mode].label}<kbd>↵</kbd>
      </button>
      <button
        ref={arrow}
        type="button"
        className="button primary plan-run-arrow"
        aria-label="选择执行时的权限"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        disabled={disabled}
        onClick={() => {
          const box = arrow.current?.getBoundingClientRect()
          if (at || !box) return close()
          setAt({ x: box.right, y: box.top })
        }}
      >
        <ChevronDownIcon />
      </button>
      {at && (
        <ContextMenu at={at} align="end" above trigger={arrow.current} label="执行时的权限" onClose={close}>
          {modes.map((each) => (
            <button
              key={each}
              type="button"
              role="menuitemradio"
              aria-checked={each === mode}
              className="menu-item plan-run-mode"
              onClick={() => {
                setPreference('planRunMode', each)
                close()
              }}
            >
              <span className="plan-run-mode-text">
                <span className="menu-item-title">{agent === 'cursor' ? modeLabel(agent, each) : RUN_MODE[each].label}</span>
                <span className="menu-item-path">{agent === 'cursor' ? '使用 Cursor 原生 Agent 模式执行' : RUN_MODE[each].hint}</span>
              </span>
              {each === mode && <span className="menu-check"><CheckIcon /></span>}
            </button>
          ))}
        </ContextMenu>
      )}
    </span>
  )
}

export function ChatPlanLine({ item }: { item: PlanItem }) {
  const surface = useChatSurface()
  const waiting = item.resolution === null
  const note = surface.planNote(item)
  return (
    <button type="button" className="chat-request-line chat-plan-line" data-waiting={waiting || undefined} onClick={() => surface.showPlan(itemKey(item))}>
      {waiting ? '计划等你确认 · 在右侧查看，在下方回答' : `计划 · ${note ?? status(item)} · 查看`}
    </button>
  )
}

// In the composer's place while the plan waits: the plan itself, clipped until opened, then the
// answers as numbered rows like any approval's. Carry it out, in the permission mode the execute
// button picks, or send it back with a note; where the chat may only plan, keep it for later
// instead. An older core carries a plan out only asking about edits or accepting them. Or stop:
// the turn ends with nothing carried out and nothing replanned, and the next word is the user's.
type PlanChoice = 'run' | 'allow' | 'allowForSession' | 'save' | 'revise' | 'stop'
const CHOICE_LABEL: Record<Exclude<PlanChoice, 'revise'>, string> = {
  run: '按计划执行',
  allow: '按计划执行，改文件、跑命令前逐项确认',
  allowForSession: '按计划执行，文件改动自动接受',
  save: '先保存计划，等依赖的任务完成后再执行',
  stop: '不执行，先停下'
}
const SUBMIT_LABEL: Record<PlanChoice, string> = { run: '执行', allow: '执行', allowForSession: '执行', save: '保存计划', revise: '继续规划', stop: '停下' }
const PREVIEW_LINES = 12

export function ChatPlanCard({ conversationId, item, modes }: { conversationId: string; item: PlanItem; modes: readonly string[] }) {
  const surface = useChatSurface()
  const { busy, respond } = useResponder(conversationId, item.requestId)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const { savePlan } = surface
  // Not in a routine's chat, whose follow-ups nobody is told of (ChatComposer).
  const routine = useCore((s) => Boolean(s.conversations[conversationId]?.routineId))
  const agent = useCore((s) => s.conversations[conversationId]?.agent ?? 'claude')
  const schedulable = useSchedulesSupported() && agent !== 'cursor' && !savePlan && !routine
  const runModes = RUN_MODES.filter((mode) => modes.includes(mode))
  const picked = usePreferences((s) => s.planRunMode)
  const runMode: RunMode = runModes.includes(picked) ? picked : runModes.includes('auto') ? 'auto' : runModes[0] ?? 'ask'
  const modesSupported = usePlanModesSupported() && runModes.length > 0
  const choices: PlanChoice[] = savePlan ? ['save', 'revise', 'stop'] : modesSupported ? ['run', 'revise', 'stop'] : ['allow', 'allowForSession', 'revise', 'stop']
  const [choice, setChoice] = useState<PlanChoice>(choices[0] ?? 'revise')
  const noteInput = useRef<HTMLInputElement>(null)
  const long = (item.detail ?? '').split('\n').length > PREVIEW_LINES
  // The inspector beside the chat already shows this plan in full: no second copy here.
  const key = itemKey(item)
  const inView = useCore((s) => surface.inspector === 'task'
    ? s.inspectorOpen && s.taskInspectorTab === 'plan' && (s.taskInspectorPlan === null || s.taskInspectorPlan === key)
    : s.conversationInspectorOpen && s.conversationInspectorTab === 'plan' && (s.conversationPlan === null || s.conversationPlan === key))
  // Comments made on the plan, and passages quoted from the chat, go back with it to keep planning.
  const quotes = useQuotes(conversationId)
  const commented = quotes.length > 0
  useEffect(() => {
    if (commented) setChoice('revise')
  }, [commented, quotes.length])
  // Ends the turn: what waits is turned down on the way, so the plan reads as not carried out.
  const stop = async () => {
    setSaving(true)
    await perform((rpc) => rpc.call('conversations.interrupt', { id: conversationId }))
    setSaving(false)
  }
  const submit = async () => {
    if (busy || saving) return
    if (choice === 'stop') {
      await stop()
    } else if (choice === 'save') {
      if (!savePlan) return
      setSaving(true)
      await savePlan(item)
      setSaving(false)
    } else if (choice === 'revise') {
      const message = commented ? composeFeedback(quotes, note) : note.trim()
      if (await respond('deny', message ? { message } : {}) && commented) setQuotes(conversationId, [])
    } else if (choice === 'run') {
      // The decision too, for what reads only that: asking is allow, anything freer goes ahead.
      await respond(runMode === 'ask' ? 'allow' : 'allowForSession', { mode: runMode })
    } else {
      await respond(choice)
    }
  }
  const pick = (next: PlanChoice) => {
    setChoice(next)
    if (next === 'revise') noteInput.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy && !saving) void stop()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (/^[1-9]$/.test(event.key) && !(event.target instanceof HTMLInputElement)) {
      const next = choices[Number(event.key) - 1]
      if (next) {
        event.preventDefault()
        pick(next)
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = choices.indexOf(choice)
      const next = choices[(at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]
      if (next) pick(next)
      if (next !== 'revise') noteInput.current?.blur()
    }
  }
  return (
    <div className="chat-request chat-plan" data-waiting onKeyDown={onKeyDown}>
      <div className="chat-request-title">
        计划等你确认
        {inView
          ? <span className="chat-plan-aside">完整计划在右侧</span>
          : <button type="button" className="link-button" onClick={() => surface.showPlan(key)}>在检查器里看完整计划</button>}
        {schedulable && <SchedulePlanButton conversationId={conversationId} />}
      </div>
      {savePlan && <p className="chat-request-detail muted">依赖的任务还没完成：现在只能保存计划，等它们完成后开始执行时再按计划做。</p>}
      {item.detail && !inView && (
        <div className="chat-plan-preview" data-clipped={(long && !open) || undefined}>
          <ChatMarkdown text={item.detail} />
          {long && (
            <button type="button" className="link-button chat-plan-preview-more" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '收起' : '展开全部'}
            </button>
          )}
        </div>
      )}
      {commented && <QuoteCards conversationId={conversationId} quotes={quotes} onDone={() => noteInput.current?.focus()} />}
      <div className="chat-approve-options" role="radiogroup" aria-label="怎么回答">
        {choices.map((each, index) => (
          <div
            key={each}
            role="radio"
            tabIndex={each === 'revise' ? -1 : 0}
            aria-checked={choice === each}
            className="chat-approve-option"
            onClick={() => pick(each)}
          >
            <span className="chat-approve-number">{index + 1}.</span>
            {each === 'revise' ? (
              <input
                ref={noteInput}
                className="chat-approve-reason"
                aria-label="继续规划，告诉 Agent 要改哪里"
                placeholder={commented ? `继续规划：带上 ${quotes.length} 条评论，还可以再补充（可不填）` : '继续规划，告诉 Agent 要改哪里（可不填）'}
                value={note}
                disabled={busy || saving}
                onFocus={() => setChoice('revise')}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setNote(event.target.value)}
              />
            ) : (
              <span>{CHOICE_LABEL[each]}</span>
            )}
          </div>
        ))}
      </div>
      <div className="chat-approve-footer">
        <span className="chat-approve-hint">数字键选择 · Enter 提交 · Esc 停下</span>
        {choice === 'run'
          ? <RunModeButton modes={runModes} mode={runMode} disabled={busy || saving} onRun={() => void submit()} agent={agent} />
          : (
            <button type="button" className="button primary" disabled={busy || saving} onClick={() => void submit()}>
              {SUBMIT_LABEL[choice]}<kbd>↵</kbd>
            </button>
          )}
      </div>
    </div>
  )
}

function downloadMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function PlanMarkdownActions({ markdown, filename }: { markdown: string; filename: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <span className="chat-plan-view-actions">
      <button
        type="button"
        className="tool-button"
        data-copied={copied || undefined}
        aria-label={copied ? '已复制' : '复制 Markdown'}
        data-tooltip={copied ? '已复制' : '复制 Markdown'}
        onClick={() => void navigator.clipboard.writeText(markdown).then(() => setCopied(true), () => {})}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button type="button" className="tool-button" aria-label="下载 Markdown" data-tooltip="下载 Markdown" onClick={() => downloadMarkdown(filename, markdown)}>
        <DownloadIcon />
      </button>
    </span>
  )
}

// The inspector's plan tab: the newest plan, or an earlier version the user picked. It shows beside
// the chat rather than in it, so it is told how to pick a version and what its owner kept.
// Text selected in it takes a comment, where the chat it belongs to is known.
export function ChatPlanView({ conversationId, plans, selected, onSelect, note = () => null }: {
  conversationId: string | null
  plans: readonly PlanItem[]
  selected: string | null
  onSelect: (key: string) => void
  note?: (item: PlanItem) => string | null
}) {
  const body = useRef<HTMLDivElement>(null)
  const quotes = useQuotes(conversationId ?? '')
  const plan = plans.find((each) => itemKey(each) === selected) ?? plans.at(-1)
  const said = (each: PlanItem) => note(each) ?? status(each)
  if (!plan) return <p className="inspector-empty muted">Agent 还没有提出计划。</p>
  const planKey = itemKey(plan)
  const comments = quotes.filter((quote) => quote.source === planKey).length
  const version = plans.indexOf(plan) + 1
  return (
    <div className="chat-plan-view">
      <div className="chat-plan-view-status" data-waiting={plan.resolution === null || undefined}>
        <div className="chat-plan-view-status-text">
          {plans.length > 1 ? (
            <select className="chat-select" aria-label="计划的版本" value={itemKey(plan)} onChange={(event) => onSelect(event.target.value)}>
              {plans.map((each, index) => <option key={itemKey(each)} value={itemKey(each)}>第 {index + 1} 版 · {said(each)}</option>)}
            </select>
          ) : said(plan)}
          {plan.resolution === null && <span className="muted"> · 在对话下方确认</span>}
        </div>
        {plan.detail && <PlanMarkdownActions markdown={plan.detail} filename={planMarkdownFilename(plan.detail, version, plans.length)} />}
      </div>
      {conversationId && plan.detail && comments > 0 && (
        <p className="chat-plan-view-hint">
          {comments} 条评论{plan.resolution === null ? '，在下方选「继续规划」交给 agent' : '，在输入框里，发送后 agent 据此修改'}
        </p>
      )}
      {plan.detail
        ? <div className="chat-plan-body" ref={body}><ChatMarkdown text={plan.detail} /></div>
        : <p className="muted">这份计划是空的。</p>}
      {conversationId && plan.detail && <PlanComments conversationId={conversationId} planKey={planKey} body={body} />}
    </div>
  )
}
