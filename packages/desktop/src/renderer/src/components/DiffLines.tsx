function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  if (line.startsWith('@@')) return 'diff-hunk'
  return /^(diff |index |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line) ? 'diff-meta' : 'diff-context'
}

// A unified diff, one line per row, coloured by what each line does.
export function DiffLines({ patch }: { patch: string }) {
  return (
    <pre className="diff-view">
      {patch.split('\n').map((line, index) => (
        <div key={index} className={lineClass(line)}>{line || ' '}</div>
      ))}
    </pre>
  )
}
