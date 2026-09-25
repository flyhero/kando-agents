import { useEffect, useId, useState, type FormEvent } from 'react'
import { DEFAULT_INSTANCE, type SettingField, type SourceDescriptor } from '@kando/protocol'
import { inboxKey, perform, startLogin, useCore } from '../core-store'
import { sourceProblemText } from '../labels'
import { Toggle } from './SettingsControls'

function FieldInput({
  field,
  id,
  value,
  onChange
}: {
  field: SettingField
  id: string
  value: string
  onChange: (value: string) => void
}) {
  const className = field.mono ? 'input mono' : 'input'
  if (field.type === 'textarea') {
    return (
      <textarea
        id={id}
        className={`${className} settings-textarea`}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        spellCheck={false}
        required={field.required}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)}>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      id={id}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder}
      autoComplete="off"
      spellCheck={false}
      required={field.required}
    />
  )
}

// One task source's settings, drawn from the fields its provider declares. Secrets are never
// fields: they come in through the sign-in flow and never come back out.
export function SourceSettingsSection({ source }: { source: SourceDescriptor }) {
  const ids = useId()
  const instance = source.instances.find((entry) => entry.instance === DEFAULT_INSTANCE)
  const inbox = useCore((s) => s.inboxes[inboxKey({ provider: source.provider, instance: DEFAULT_INSTANCE })])
  const [values, setValues] = useState<Record<string, string>>(instance?.settings ?? {})
  const [busy, setBusy] = useState(false)
  const saved = instance?.settings ?? {}
  const dirty = source.settings.some((field) => (values[field.key] ?? '') !== (saved[field.key] ?? ''))
  const hasSaved = source.settings.every((field) => !field.required || (saved[field.key] ?? '') !== '')

  // Settings saved elsewhere (another window, the CLI) replace what is shown, unless the user is typing.
  useEffect(() => {
    if (!dirty) {
      setValues(instance?.settings ?? {})
    }
  }, [JSON.stringify(instance?.settings)])

  if (!instance) {
    return null
  }
  const { credential } = instance

  const save = async (): Promise<boolean> => {
    setBusy(true)
    const result = await perform((rpc) =>
      rpc.call('sources.saveSettings', { provider: source.provider, instance: DEFAULT_INSTANCE, settings: values })
    )
    setBusy(false)
    const next = result?.instances.find((entry) => entry.instance === DEFAULT_INSTANCE)
    if (next) {
      setValues(next.settings)
    }
    return result !== null
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void save()
  }
  const connect = async () => {
    if ((dirty || !hasSaved) && !(await save())) {
      return
    }
    void startLogin(source.provider, DEFAULT_INSTANCE, source.name)
  }
  const disconnect = () =>
    void perform((rpc) => rpc.call('sources.disconnect', { provider: source.provider, instance: DEFAULT_INSTANCE }))
  const setEnabled = (enabled: boolean) =>
    void perform((rpc) =>
      rpc.call('sources.saveSettings', { provider: source.provider, instance: DEFAULT_INSTANCE, settings: saved, enabled })
    )

  const status = !credential.configured
    ? '未登录'
    : credential.source === 'env'
      ? '已登录（来自环境变量）'
      : `已登录：${credential.account ?? '未知账号'}`

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      {source.settings.map((field) => (
        <div key={field.key} className="settings-field">
          <label className="settings-field-label" htmlFor={`${ids}-${field.key}`}>
            {field.label}
          </label>
          <FieldInput
            field={field}
            id={`${ids}-${field.key}`}
            value={values[field.key] ?? ''}
            onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
          />
          {field.hint && <p className="settings-field-hint">{field.hint}</p>}
          {field.bindsCredential && credential.source === 'store' && (
            <p className="settings-field-hint">修改后需要重新登录，保存的凭据不会发往新的地址。</p>
          )}
        </div>
      ))}

      <div className="source-account">
        <div className="source-account-text">
          <span className="settings-field-label">账号</span>
          <span className="source-account-status" data-connected={credential.configured || undefined}>
            {status}
          </span>
          {credential.configured && inbox?.problem && (
            <span className="settings-status" role="status">
              同步失败：{sourceProblemText(inbox.problem)}
            </span>
          )}
        </div>
        {credential.source === 'store' && (
          <button type="button" className="button ghost" onClick={disconnect}>
            退出登录
          </button>
        )}
        {credential.source !== 'env' && (
          <button type="button" className="button" disabled={busy} onClick={() => void connect()}>
            {credential.configured ? '重新登录' : '登录'}
          </button>
        )}
      </div>

      <div className="settings-form-footer">
        {hasSaved && (
          <div className="source-enabled">
            <Toggle labelId={`${ids}-enabled`} checked={instance.enabled} onChange={setEnabled} />
            <span id={`${ids}-enabled`}>同步到收件箱</span>
          </div>
        )}
        <button type="submit" className="button primary" disabled={busy || !dirty}>
          {busy ? '正在保存…' : '保存设置'}
        </button>
      </div>
    </form>
  )
}
