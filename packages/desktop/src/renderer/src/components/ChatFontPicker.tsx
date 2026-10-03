import { useCallback, useState, type KeyboardEvent } from 'react'
import { setPreference, usePreferences, type Preferences } from '../preferences'
import { cssFontFamily, systemFontFamilies } from '../system-fonts'
import { CheckIcon, ChevronDownIcon } from './icons'
import { Popover } from './Popover'
import { Segmented } from './SettingsControls'

type Listing = { state: 'loading' } | { state: 'ready'; families: readonly string[] } | { state: 'unavailable' }

// The installed families to pick the chat's font from, each shown in itself. A name typed that is
// not listed can still be used: where the browser cannot list fonts, that is the only way.
function FontList({ current, onPick, listing }: { current: string; onPick: (family: string) => void; listing: Listing }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const families = listing.state === 'ready' ? listing.families : []
  const shown = needle ? families.filter((family) => family.toLowerCase().includes(needle)) : families
  const typed = query.trim()
  const offerTyped = typed !== '' && !families.some((family) => family.toLowerCase() === typed.toLowerCase())
  const onKey = (event: KeyboardEvent) => {
    const first = offerTyped ? typed : shown[0]
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && first) {
      event.preventDefault()
      onPick(first)
    }
  }
  return (
    <div className="font-picker">
      <input
        className="input menu-search"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKey}
        placeholder={listing.state === 'unavailable' ? '读不到系统字体，输入字体名，回车使用' : '搜索字体，回车选第一个'}
        aria-label="搜索字体"
      />
      {listing.state === 'loading' && <p className="font-picker-note">正在读取系统字体…</p>}
      <ul className="menu-list font-picker-list">
        {offerTyped && (
          <li>
            <button type="button" className="menu-item" onClick={() => onPick(typed)}>
              <span className="menu-item-title">使用「{typed}」</span>
            </button>
          </li>
        )}
        {shown.map((family) => (
          <li key={family}>
            <button type="button" className="menu-item" onClick={() => onPick(family)}>
              <span className="menu-item-title" style={{ fontFamily: cssFontFamily(family) }}>{family}</span>
              {family === current && <span className="menu-check"><CheckIcon /></span>}
            </button>
          </li>
        ))}
      </ul>
      {listing.state === 'ready' && shown.length === 0 && !offerTyped && <p className="font-picker-note">没有匹配的字体</p>}
    </div>
  )
}

// The chat font: the three presets, or any family installed here, picked from a list of them.
export function ChatFontPicker({ labelId }: { labelId: string }) {
  const font = usePreferences((s) => s.chatFont)
  const family = usePreferences((s) => s.chatFontFamily)
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const close = useCallback(() => setOpen(false), [])
  // Listed on the click that opens it: Chromium lists fonts only for a user's gesture.
  const openList = () => {
    setOpen(true)
    if (listing.state === 'ready') return
    setListing({ state: 'loading' })
    void systemFontFamilies().then((found) => setListing(found ? { state: 'ready', families: found } : { state: 'unavailable' }))
  }
  const choose = (next: Preferences['chatFont']) => {
    if (next === 'custom' && !family) return openList()
    setPreference('chatFont', next)
  }
  return (
    <div className="font-picker-control">
      <Segmented
        labelId={labelId}
        value={font}
        onChange={choose}
        options={[
          { value: 'system', label: '系统' },
          { value: 'geist', label: 'Geist' },
          { value: 'serif', label: '衬线' },
          { value: 'custom', label: '其他' }
        ]}
      />
      {(font === 'custom' || open) && (
        <span className="menu-anchor">
          <button
            type="button"
            className="button ghost font-picker-button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => (open ? close() : openList())}
          >
            <span style={family ? { fontFamily: cssFontFamily(family) } : undefined}>{family || '选择字体'}</span>
            <ChevronDownIcon />
          </button>
          {open && (
            <Popover label="选择聊天字体" onClose={close}>
              <FontList
                current={family}
                listing={listing}
                onPick={(picked) => {
                  setPreference('chatFontFamily', picked)
                  setPreference('chatFont', 'custom')
                  close()
                }}
              />
            </Popover>
          )}
        </span>
      )}
    </div>
  )
}
