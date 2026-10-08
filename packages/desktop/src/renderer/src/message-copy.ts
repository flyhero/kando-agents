import type { ChatItem } from '@kando/protocol'
import { withoutQuoteMarkers } from './chat-quotes'

export function copyTextForItem(item: ChatItem): string {
  switch (item.kind) {
    case 'user': return withoutQuoteMarkers(item.text)
    case 'assistant': case 'reasoning': case 'notice': return item.text
    case 'tool': return [item.title, item.input, item.output, ...item.diffs.map((diff) => `${diff.path}\n${diff.patch}`)].filter(Boolean).join('\n\n')
    case 'todos': return item.todos.map((todo) => `[${todo.status === 'completed' ? 'x' : ' '}] ${todo.content}`).join('\n')
    case 'approval': return [item.title, item.detail].filter(Boolean).join('\n\n')
    case 'question': return item.questions.map((question) => [question.question, ...question.options.map((option) => option.label)].join('\n')).join('\n\n')
    case 'usageLimit': return item.message ?? item.error ?? ''
    case 'turn': return item.error ?? item.state
    case 'state': return item.activity ?? ''
  }
}
