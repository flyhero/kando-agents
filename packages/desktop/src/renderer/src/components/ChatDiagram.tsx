import { useEffect, useState, type ReactNode } from 'react'
import { isDarkTheme, onThemeChange } from '../appearance'
import { tokenColor } from '../css-color'
import { CopyButton } from './CopyButton'

type Drawn = { svg: string } | { error: string }

let drawn = 0
// Mermaid is configured globally, so one diagram is drawn at a time, each with the colours of now.
let queue: Promise<unknown> = Promise.resolve()

// Mermaid is large and few replies hold a diagram: it loads the first time one is drawn.
function draw(source: string): Promise<Drawn> {
  const next = queue.then(async (): Promise<Drawn> => {
    const { default: mermaid } = await import('mermaid')
    const font = getComputedStyle(document.body).fontFamily
    mermaid.initialize({
      startOnLoad: false,
      // A diagram that fails says so in the reply; Mermaid's own error picture would be left in <body>.
      suppressErrorRendering: true,
      // No scripts, links or raw HTML from the diagram's text: it comes from an agent.
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: font,
      themeVariables: {
        darkMode: isDarkTheme(),
        fontFamily: font,
        background: tokenColor('--surface'),
        primaryColor: tokenColor('--surface'),
        primaryTextColor: tokenColor('--text'),
        primaryBorderColor: tokenColor('--text-muted'),
        secondaryColor: tokenColor('--bg'),
        tertiaryColor: tokenColor('--bg'),
        lineColor: tokenColor('--text-muted'),
        textColor: tokenColor('--text')
      }
    })
    try {
      await mermaid.parse(source)
      return { svg: (await mermaid.render(`chat-diagram-${++drawn}`, source)).svg }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  queue = next.catch(() => {})
  return next
}

// A mermaid block in a reply or a plan, drawn; its source is a click away, and is what it copies.
// One the diagram's syntax defeats stays as its source, saying why.
export function ChatDiagram({ source, code }: { source: string; code: ReactNode }) {
  const [result, setResult] = useState<Drawn | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [theme, setTheme] = useState(0)
  useEffect(() => onThemeChange(() => setTheme((n) => n + 1)), [])
  useEffect(() => {
    let live = true
    void draw(source).then((next) => { if (live) setResult(next) })
    return () => { live = false }
  }, [source, theme])
  const failed = result !== null && 'error' in result
  return (
    <div className="chat-code chat-diagram">
      <div className="chat-code-header">
        <span className="chat-code-language">mermaid</span>
        <span className="chat-code-actions">
          {result && !failed && (
            <button type="button" className="chat-diagram-toggle" onClick={() => setShowSource(!showSource)}>{showSource ? '看图' : '看源码'}</button>
          )}
          <CopyButton text={source.replace(/\n$/, '')} label="复制代码" />
        </span>
      </div>
      {result && 'svg' in result && !showSource
        // Mermaid's own sanitizer (securityLevel strict) has cleaned it.
        ? <div className="chat-diagram-figure" role="img" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: result.svg }} />
        : <>
            {failed && <p className="chat-diagram-error">图表没能画出来，下面是源码：{result.error.split('\n')[0]}</p>}
            {code}
          </>}
    </div>
  )
}
