import { useId, type ReactNode } from 'react'

export function SettingsRow({
  label,
  description,
  control
}: {
  label: string
  description?: string
  control: (labelId: string) => ReactNode
}) {
  const labelId = useId()
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div id={labelId} className="settings-row-label">
          {label}
        </div>
        {description && <p className="settings-row-description">{description}</p>}
      </div>
      <div className="settings-row-control">{control(labelId)}</div>
    </div>
  )
}

export function Segmented<T extends string>({
  labelId,
  value,
  options,
  onChange
}: {
  labelId: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={labelId}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  labelId,
  checked,
  onChange
}: {
  labelId: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        aria-labelledby={labelId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
    </label>
  )
}

export function Stepper({
  labelId,
  value,
  min,
  max,
  unit,
  onChange
}: {
  labelId: string
  value: number
  min: number
  max: number
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <div className="stepper" role="group" aria-labelledby={labelId}>
      <button type="button" aria-label="减小" disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <output aria-live="polite">
        {value} {unit}
      </output>
      <button type="button" aria-label="增大" disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  )
}
