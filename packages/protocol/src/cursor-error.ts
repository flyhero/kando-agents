// Cursor sometimes ends a turn by writing its own transport error as the reply. The line is not
// something the agent meant to say, and the bracketed code is not a way to recover.
const PROVIDER_LINE = /(?:^|\n)[ \t]*Error: (?:RetriableError|ConnectError): \[([a-z_]+)\][^\n]*[ \t]*$/

export type CursorProviderError = { code: string; rest: string; summary: string; detail: string }

const COPY: Record<string, { summary: string; detail: string }> = {
  deadline_exceeded: {
    summary: 'Cursor 连接超时，回复没有写完',
    detail: 'Cursor 连接超时，这条回复被中断了。再发一次刚才的话即可。它可能已经改了一部分文件，重发前可以先看一眼。'
  },
  resource_exhausted: {
    summary: 'Cursor 这一会儿忙不过来，或额度用完了',
    detail: 'Cursor 这一会儿忙不过来，或额度用完了。等一会儿再发一次刚才的话。'
  }
}

const FALLBACK = {
  summary: 'Cursor 中途出错，回复没有完成',
  detail: 'Cursor 中途出错，这条回复没有完成。再发一次刚才的话即可。它可能已经改了一部分文件，重发前可以先看一眼。'
}

export function cursorProviderError(text: string): CursorProviderError | null {
  const match = PROVIDER_LINE.exec(text)
  if (!match) return null
  const code = match[1] ?? ''
  const copy = COPY[code] ?? FALLBACK
  return { code, rest: text.slice(0, match.index).trimEnd(), ...copy }
}
