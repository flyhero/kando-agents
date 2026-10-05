import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ContextMenu, type MenuPoint } from './ContextMenu'
import { CheckIcon, ChevronDownIcon } from './icons'

export type PickerOption = { value: string; label: string; description?: string | null; disabled?: boolean }

// A choice in the composer's toolbar: its value as a small button as wide as its words, and a menu
// above it. A native select is as wide as its longest option, which left most values far from their
// arrow.
function PickerShell({ label, spoken, tone, disabled, title, align, placement = 'above', value, children }: {
  label: string
  // The button's name for a screen reader, which cannot see the value's colour or suffix.
  spoken: string
  tone?: string
  disabled: boolean
  title?: string
  align: 'start' | 'end'
  // Above in the composer, where below is the rest of it; below for one at the top of a panel.
  placement?: 'above' | 'below'
  value: ReactNode
  children: (close: () => void) => ReactNode
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<MenuPoint | null>(null)
  const close = useCallback(() => setAt(null), [])
  const open = () => {
    const box = button.current?.getBoundingClientRect()
    if (box) setAt({ x: align === 'end' ? box.right : box.left, y: placement === 'above' ? box.top : box.bottom + 4 })
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className="chat-picker"
        data-tone={tone}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        aria-label={spoken}
        title={title}
        disabled={disabled}
        onClick={() => (at ? close() : open())}
      >
        <span className="chat-picker-value">{value}</span>
        <ChevronDownIcon />
      </button>
      {at && (
        <ContextMenu at={at} align={align} above={placement === 'above'} trigger={button.current} label={label} onClose={close}>
          {children(close)}
        </ContextMenu>
      )}
    </>
  )
}

function PickerItem({ option, checked, onSelect }: { option: PickerOption; checked: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="menu-item chat-picker-item"
      disabled={option.disabled}
      onClick={onSelect}
    >
      <span className="chat-picker-item-text">
        <span className="chat-picker-item-label">{option.label}</span>
        {option.description && <span className="chat-picker-item-description">{option.description}</span>}
      </span>
      {checked && <span className="menu-check"><CheckIcon /></span>}
    </button>
  )
}

// One setting: its options listed with what each means, the current one checked.
export function ChatPicker({ label, value, placeholder, options, onChange, disabled = false, title, tone, align = 'start', placement }: {
  label: string
  value: string | null
  placeholder: string
  options: readonly PickerOption[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
  // Colours the value, as the permission mode does for plan and bypass.
  tone?: string
  align?: 'start' | 'end'
  placement?: 'above' | 'below'
}) {
  const current = options.find((option) => option.value === value)?.label ?? placeholder
  return (
    <PickerShell label={label} spoken={`${label}：${current}`} tone={tone} disabled={disabled} title={title} align={align} placement={placement} value={current}>
      {(close) => (
        <>
          <div className="chat-picker-heading">{label}</div>
          {options.map((option) => (
            <PickerItem
              key={option.value}
              option={option}
              checked={option.value === value}
              onSelect={() => {
                close()
                if (option.value !== value) onChange(option.value)
              }}
            />
          ))}
        </>
      )}
    </PickerShell>
  )
}

// The model and how hard it thinks, as one button: "Opus 5.5 · 高". Its menu has the model's
// efforts as a row of chips, which keep the menu open, above the models to switch to.
export function ChatModelPicker({ models, model, efforts, effort, onModel, onEffort, disabled = false, title }: {
  models: readonly PickerOption[]
  model: string | null
  efforts: readonly PickerOption[]
  effort: string | null
  onModel: (model: string) => void
  onEffort: (effort: string) => void
  disabled?: boolean
  title?: string
}) {
  const modelLabel = models.find((each) => each.value === model)?.label ?? '默认模型'
  const effortLabel = efforts.find((each) => each.value === effort)?.label ?? null
  return (
    <PickerShell
      label="模型和推理强度"
      spoken={`模型：${modelLabel}${effortLabel ? `，推理强度：${effortLabel}` : ''}`}
      disabled={disabled}
      title={title}
      align="end"
      value={<>{modelLabel}{effortLabel && <span className="chat-picker-suffix"> · {effortLabel}</span>}</>}
    >
      {(close) => (
        <>
          {efforts.length > 0 && (
            <>
              <div className="chat-picker-heading">推理强度</div>
              <div className="chat-picker-chips">
                {efforts.map((each) => (
                  <button
                    key={each.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={each.value === effort}
                    className="chat-picker-chip"
                    onClick={() => {
                      if (each.value !== effort) onEffort(each.value)
                    }}
                  >
                    {each.label}
                  </button>
                ))}
              </div>
              <div className="menu-separator" role="separator" />
            </>
          )}
          <div className="chat-picker-heading">模型</div>
          {models.map((option) => (
            <PickerItem
              key={option.value}
              option={option}
              checked={option.value === model}
              onSelect={() => {
                close()
                if (option.value !== model) onModel(option.value)
              }}
            />
          ))}
        </>
      )}
    </PickerShell>
  )
}
