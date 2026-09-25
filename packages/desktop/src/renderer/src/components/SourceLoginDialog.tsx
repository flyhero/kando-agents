import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { LoginPrompt } from '@kando/protocol'
import { answerLogin, closeLogin, useCore } from '../core-store'
import { sourceProblemText } from '../labels'

// One question of a sign-in flow. Keyed by prompt id, so each question starts empty.
function PromptForm({ prompt }: { prompt: LoginPrompt }) {
  const ids = useId()
  const input = useRef<HTMLInputElement & HTMLSelectElement>(null)
  const [value, setValue] = useState(prompt.defaultValue ?? prompt.options?.[0]?.value ?? '')

  useEffect(() => {
    input.current?.focus()
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void answerLogin(value)
  }

  return (
    <form className="login-form" onSubmit={submit}>
      {prompt.error && (
        <p className="modal-error" role="alert">
          {prompt.error}
        </p>
      )}
      <label className="modal-field" htmlFor={`${ids}-answer`}>
        <span className="modal-label">{prompt.label}</span>
        {prompt.kind === 'select' ? (
          <select id={`${ids}-answer`} ref={input} className="input modal-input" value={value} onChange={(e) => setValue(e.target.value)}>
            {(prompt.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`${ids}-answer`}
            ref={input}
            className={prompt.kind === 'secret' ? 'input modal-input mono' : 'input modal-input'}
            type={prompt.kind === 'secret' ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={prompt.placeholder}
            autoComplete={prompt.kind === 'secret' ? 'new-password' : 'off'}
            spellCheck={false}
          />
        )}
      </label>
      {(prompt.hint || prompt.link) && (
        <p className="settings-field-hint">
          {prompt.hint}
          {prompt.link && (
            <>
              {' '}
              <a href={prompt.link.url} target="_blank" rel="noreferrer">
                {prompt.link.label}
              </a>
            </>
          )}
        </p>
      )}
      <footer className="modal-footer">
        <button type="button" className="button ghost" onClick={closeLogin}>
          取消
        </button>
        <button type="submit" className="button primary" disabled={value.trim() === ''}>
          继续
        </button>
      </footer>
    </form>
  )
}

// Renders whatever a source's sign-in flow asks, in the vocabulary every client shares.
export function SourceLoginDialog() {
  const login = useCore((s) => s.login)
  const dialog = useRef<HTMLDialogElement>(null)
  const ids = useId()

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    return () => element?.close()
  }, [])

  if (!login) {
    return null
  }
  const { result, prompt, notices } = login

  return (
    <dialog
      ref={dialog}
      className="modal login-dialog"
      aria-labelledby={`${ids}-heading`}
      onCancel={(event) => {
        event.preventDefault()
        closeLogin()
      }}
    >
      <div className="modal-body">
        <header className="modal-header">
          <h2 id={`${ids}-heading`}>登录 {login.name}</h2>
          <button type="button" className="icon-button modal-close" aria-label="关闭" onClick={closeLogin}>
            ×
          </button>
        </header>

        {notices.map((notice, index) => (
          <div key={index} className="login-notice">
            <p>{notice.message}</p>
            {notice.code && (
              <div className="login-code">
                <code>{notice.code}</code>
                <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(notice.code ?? '').catch(() => {})}>
                  复制
                </button>
              </div>
            )}
            {notice.url && (
              <a href={notice.url} target="_blank" rel="noreferrer">
                {notice.url}
              </a>
            )}
          </div>
        ))}

        {result ? (
          <>
            <p className={result.problem ? 'modal-error' : 'login-success'} role="status">
              {result.problem ? `登录失败：${sourceProblemText(result.problem)}` : `已登录：${result.account ?? ''}`}
            </p>
            <footer className="modal-footer">
              <button type="button" className="button primary" onClick={closeLogin}>
                完成
              </button>
            </footer>
          </>
        ) : prompt ? (
          <PromptForm key={prompt.promptId} prompt={prompt.prompt} />
        ) : (
          <>
            <p className="muted" role="status">
              正在连接…
            </p>
            <footer className="modal-footer">
              <button type="button" className="button ghost" onClick={closeLogin}>
                取消
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>
  )
}
