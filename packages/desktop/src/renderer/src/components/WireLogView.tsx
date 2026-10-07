import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WireEntry, WireStage } from '@kando/protocol'
import { useCore } from '../core-store'
import { canRevealFile, revealFile } from '../desktop-bridge'
import { AGENT_LABEL } from '../labels'
import { formatBytes, groupWireEntries, isWireStream, mergeWireEntries, streamLabel, streamText, totalSize, WIRE_DIR_LABEL, WIRE_MARK, wireDetail, wireJsonl, wireLabel, wireMatches, wireSize, wireTime } from '../wire-entries'
import { CopyButton } from './CopyButton'
import { FolderIcon } from './icons'

// A live stage of a chatty agent outgrows what a list should hold; the oldest go, and paging
// back brings them again.
const MAX_HELD = 5000

type Shown = { stages: WireStage[]; stageId: string | null; entries: WireEntry[]; before: number | null }

function held(shown: Shown, entries: WireEntry[]): Shown {
  if (entries.length <= MAX_HELD) return { ...shown, entries }
  const kept = entries.slice(-MAX_HELD)
  return { ...shown, entries: kept, before: kept[0]?.pos ?? shown.before }
}

function stageText(stage: WireStage): string {
  const started = new Date(stage.startedAt).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const agent = stage.agent ? AGENT_LABEL[stage.agent] : '没能启动'
  const running = stage.agent && stage.endedAt === null ? '（运行中）' : ''
  return `${agent} · ${started}${running} · ${formatBytes(stage.bytes)}`
}

function WireRow({ entry, open, onToggle }: { entry: WireEntry; open: boolean; onToggle: () => void }) {
  const detail = open ? wireDetail(entry) : ''
  return (
    <li className="wire-entry" data-dir={entry.dir} data-open={open || undefined}>
      <button type="button" className="wire-entry-head" aria-expanded={open} onClick={onToggle}>
        <span className="wire-entry-mark" aria-label={WIRE_DIR_LABEL[entry.dir]} title={WIRE_DIR_LABEL[entry.dir]}>{WIRE_MARK[entry.dir]}</span>
        <span className="wire-entry-time">{wireTime(entry.at)}</span>
        <span className="wire-entry-label">{wireLabel(entry)}</span>
        <span className="wire-entry-size">{entry.cut !== undefined ? '已截断 · ' : ''}{wireSize(entry)}</span>
      </button>
      {open && (
        <div className="wire-entry-detail">
          <CopyButton text={detail} />
          <pre>{detail}</pre>
        </div>
      )}
    </li>
  )
}

// A run of streamed pieces as one row; opened, the text they add up to, then each piece.
function StreamRow({ entries, open, onToggle, isOpen, onToggleEntry }: {
  entries: WireEntry[]
  open: boolean
  onToggle: () => void
  isOpen: (pos: number) => boolean
  onToggleEntry: (pos: number) => void
}) {
  const first = entries[0]
  const last = entries.at(-1)
  if (!first || !last) return null
  const text = open ? streamText(entries) : ''
  return (
    <li className="wire-entry wire-stream" data-dir="stdout" data-open={open || undefined}>
      <button type="button" className="wire-entry-head" aria-expanded={open} onClick={onToggle}>
        <span className="wire-entry-mark" aria-label="流式增量" title="一段段流出来的增量，已合在一起">≋</span>
        <span className="wire-entry-time">{wireTime(first.at)}</span>
        <span className="wire-entry-label">{streamLabel(entries)}</span>
        <span className="wire-entry-size">{totalSize(entries)}</span>
      </button>
      {open && (
        <div className="wire-stream-body">
          {text && (
            <div className="wire-entry-detail">
              <CopyButton text={text} label="复制合起来的文字" />
              <pre>{text}</pre>
            </div>
          )}
          <p className="wire-stream-note">{entries.length} 条，{wireTime(first.at)} 到 {wireTime(last.at)}</p>
          <ol className="wire-entries">
            {entries.map((entry) => <WireRow key={entry.pos} entry={entry} open={isOpen(entry.pos)} onToggle={() => onToggleEntry(entry.pos)} />)}
          </ol>
        </div>
      )}
    </li>
  )
}

// What passed between core and the conversation's agent, line by line, as core's wire log kept
// it: one stage at a time, newest stage first, following new lines while it is open.
export function WireLogView({ conversationId }: { conversationId: string }) {
  const rpc = useCore((state) => state.rpc)
  // null follows the newest stage, a new one included.
  const [chosen, setChosen] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [shown, setShown] = useState<Shown | null>(null)
  const [showStream, setShowStream] = useState(false)
  const [query, setQuery] = useState('')
  // Open entries by pos, open runs of streamed pieces by their first pos.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [loadingOlder, setLoadingOlder] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // Whether the list sits at its bottom, so new lines keep it there.
  const stick = useRef(true)

  useEffect(() => {
    setShown(null)
    setOpen(new Set())
    stick.current = true
  }, [conversationId, chosen])

  useEffect(() => {
    if (!rpc) return
    let current = true
    let known: Shown | null = null
    const off = rpc.on('debug.wireEntries', ({ conversationId: id, stageId, entries }) => {
      if (!current || id !== conversationId || !known) return
      if (stageId === known.stageId) {
        setShown((previous) => (previous && previous.stageId === stageId ? held(previous, mergeWireEntries(previous.entries, entries)) : previous))
      } else if (chosen === null && !known.stages.some((stage) => stage.stageId === stageId)) {
        // A stage that started since: following the newest, show it.
        setReload((count) => count + 1)
      }
    })
    void rpc.call('debug.watchWire', { id: conversationId }).catch(() => {})
    rpc.call('debug.wire', { id: conversationId, ...(chosen ? { stageId: chosen } : {}) }).then(
      (page) => {
        if (!current) return
        known = page
        setShown((previous) => (previous && previous.stageId === page.stageId ? held(page, mergeWireEntries(page.entries, previous.entries)) : held(page, page.entries)))
      },
      () => {
        if (current) setShown({ stages: [], stageId: null, entries: [], before: null })
      }
    )
    return () => {
      current = false
      off()
      void rpc.call('debug.unwatchWire', { id: conversationId }).catch(() => {})
    }
  }, [rpc, conversationId, chosen, reload])

  const needle = query.trim().toLowerCase()
  const entries = shown?.entries ?? []
  const streamCount = useMemo(() => entries.filter(isWireStream).length, [entries])
  const visible = useMemo(
    () => entries.filter((entry) => (showStream || !isWireStream(entry)) && wireMatches(entry, needle)),
    [entries, showStream, needle]
  )
  const rows = useMemo(() => groupWireEntries(visible), [visible])

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stick.current) list.scrollTop = list.scrollHeight
  }, [visible.length])

  const loadOlder = async () => {
    if (!rpc || !shown?.stageId || shown.before === null || loadingOlder) return
    setLoadingOlder(true)
    const list = listRef.current
    const fromBottom = list ? list.scrollHeight - list.scrollTop : 0
    try {
      const page = await rpc.call('debug.wire', { id: conversationId, stageId: shown.stageId, before: shown.before })
      setShown((previous) => (previous && previous.stageId === page.stageId ? { ...previous, entries: [...page.entries, ...previous.entries], before: page.before } : previous))
      // Keep the rows on screen where they were once the older ones are above them.
      requestAnimationFrame(() => {
        if (list) list.scrollTop = list.scrollHeight - fromBottom
      })
    } finally {
      setLoadingOlder(false)
    }
  }

  const toggle = (key: string) => {
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!shown) return <p className="inspector-empty muted">正在读取原始数据…</p>
  if (shown.stages.length === 0) {
    return (
      <p className="inspector-empty muted">
        这个会话还没有原始数据。记录打开后，Agent 收发的每一行都会记下来：正在运行的 Agent 从下一行开始，新启动的从启动命令开始。
      </p>
    )
  }
  const stage = shown.stages.find((each) => each.stageId === shown.stageId)
  return (
    <div className="wire-log">
      <div className="wire-toolbar">
        {shown.stages.length > 1 ? (
          <select
            className="input wire-stage"
            aria-label="Agent 的哪一段"
            value={chosen ?? ''}
            onChange={(event) => setChosen(event.target.value || null)}
          >
            <option value="">最新一段</option>
            {shown.stages.map((each) => <option key={each.stageId} value={each.stageId}>{stageText(each)}</option>)}
          </select>
        ) : (
          stage && <span className="wire-stage-text muted">{stageText(stage)}</span>
        )}
        <input className="input wire-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索原始数据" />
        <button
          type="button"
          className="wire-chip"
          aria-pressed={showStream}
          title="Claude 的 stream_event、keep_alive 和 Codex 的 …/delta：一段段流出来的文字，数量很多。显示时连续的合成一行"
          onClick={() => setShowStream(!showStream)}
        >
          流式增量 {streamCount}
        </button>
        <CopyButton text={wireJsonl(visible)} label={`复制显示的 ${visible.length} 行（jsonl）`} />
        {stage && canRevealFile() && (
          <button type="button" className="tool-button" aria-label="显示文件" data-tooltip="在文件管理器里显示" onClick={() => void revealFile([stage.file])}>
            <FolderIcon />
          </button>
        )}
      </div>
      <div
        className="wire-list"
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget
          stick.current = list.scrollTop + list.clientHeight >= list.scrollHeight - 24
        }}
      >
        {shown.before !== null && (
          <button type="button" className="link-button wire-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? '正在读取…' : '读取更早的'}
          </button>
        )}
        {visible.length === 0 ? (
          <p className="inspector-empty muted">{needle ? `没有包含「${query.trim()}」的行` : '只有流式增量，打开上面的「流式增量」查看'}</p>
        ) : (
          <ol className="wire-entries">
            {rows.map((row) => {
              if (row.kind === 'entry') {
                const key = String(row.entry.pos)
                return <WireRow key={key} entry={row.entry} open={open.has(key)} onToggle={() => toggle(key)} />
              }
              const key = `s${row.entries[0]?.pos ?? 0}`
              return (
                <StreamRow
                  key={key}
                  entries={row.entries}
                  open={open.has(key)}
                  onToggle={() => toggle(key)}
                  isOpen={(pos) => open.has(String(pos))}
                  onToggleEntry={(pos) => toggle(String(pos))}
                />
              )
            })}
          </ol>
        )}
      </div>
      <p className="wire-footnote">
        → 发给 Agent　← Agent 输出　! stderr　≋ 合在一起的流式增量。点一行展开。
      </p>
    </div>
  )
}
