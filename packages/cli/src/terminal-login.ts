import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { LoginPrompt, RpcConnection } from '@kando/protocol'

// A sign-in flow rendered in the terminal: the same prompt vocabulary the desktop draws as a dialog.

type Terminal = {
  line(question: string): Promise<string>
  secret(question: string): Promise<string>
  close(): void
}

// Piped input arrives all at once, so one reader must hand it out line by line; a reader per
// question would swallow the rest of the input with the first answer.
function pipedTerminal(): Terminal {
  const reader = createInterface({ input: process.stdin })
  const lines = reader[Symbol.asyncIterator]()
  const line = async (question: string) => {
    process.stdout.write(question)
    const next = await lines.next()
    process.stdout.write('\n')
    return next.done ? '' : next.value
  }
  return { line, secret: line, close: () => reader.close() }
}

function interactiveTerminal(): Terminal {
  const { stdin, stdout } = process
  return {
    async line(question) {
      const reader = createInterface({ input: stdin, output: stdout })
      try {
        return await reader.question(question)
      } finally {
        reader.close()
      }
    },
    // Typed characters are not echoed.
    secret(question) {
      stdout.write(question)
      stdin.setRawMode(true)
      stdin.setEncoding('utf8')
      stdin.resume()
      return new Promise((resolve, reject) => {
        let value = ''
        const finish = () => {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          stdout.write('\n')
        }
        const onData = (chunk: string) => {
          for (const char of chunk) {
            if (char === '\r' || char === '\n') {
              finish()
              resolve(value)
              return
            }
            if (char === '\u0003') {
              finish()
              reject(new Error('已取消'))
              return
            }
            value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char
          }
        }
        stdin.on('data', onData)
      })
    },
    close: () => {}
  }
}

async function ask(terminal: Terminal, prompt: LoginPrompt): Promise<string> {
  if (prompt.error) {
    console.log(`✗ ${prompt.error}`)
  }
  if (prompt.hint) {
    console.log(`  ${prompt.hint}`)
  }
  if (prompt.link) {
    console.log(`  ${prompt.link.label}：${prompt.link.url}`)
  }
  if (prompt.kind === 'secret') {
    return terminal.secret(`${prompt.label}：`)
  }
  if (prompt.kind === 'select') {
    const options = prompt.options ?? []
    options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`))
    const picked = Number(await terminal.line(`${prompt.label}（输入序号）：`)) - 1
    return options[picked]?.value ?? ''
  }
  const fallback = prompt.defaultValue ? `（回车用 ${prompt.defaultValue}）` : ''
  const answer = (await terminal.line(`${prompt.label}${fallback}：`)).trim()
  return answer || prompt.defaultValue || ''
}

export function loginInTerminal(rpc: RpcConnection, provider: string, instance: string): Promise<string> {
  const terminal = process.stdin.isTTY ? interactiveTerminal() : pipedTerminal()
  return new Promise<string>((resolve, reject) => {
    const flowId = randomUUID()
    const unsubscribe = [
      rpc.on('sources.loginPrompt', (params) => {
        if (params.flowId !== flowId) {
          return
        }
        void ask(terminal, params.prompt)
          .then((value) => rpc.call('sources.answer', { flowId: params.flowId, promptId: params.promptId, value }))
          .catch((error: unknown) => {
            void rpc.call('sources.cancelLogin', { flowId: params.flowId }).catch(() => {})
            reject(error)
          })
      }),
      rpc.on('sources.loginNotice', ({ flowId: id, notice }) => {
        if (id === flowId) {
          console.log([notice.message, notice.url, notice.code && `验证码：${notice.code}`].filter(Boolean).join('\n'))
        }
      }),
      rpc.on('sources.loginFinished', ({ flowId: id, account, problem }) => {
        if (id !== flowId) {
          return
        }
        unsubscribe.forEach((off) => off())
        if (problem) {
          reject(new Error(problem.message))
        } else {
          resolve(account ?? '')
        }
      })
    ]
    rpc.call('sources.login', { provider, instance, flowId }).catch((error: unknown) => {
      unsubscribe.forEach((off) => off())
      reject(error)
    })
  }).finally(() => terminal.close())
}
