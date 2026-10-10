import remarkBreaks from 'remark-breaks'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'

// The Markdown a reply is read as. A newline is a line break, as it is in the agent's terminal, not
// a space. CommonMark will not close `**加粗：**正文` (punctuation inside, a letter after), which
// Chinese writes all the time: emphasis is relaxed next to CJK text, and only there.
export const remarkPlugins = [remarkGfm, remarkBreaks, remarkCjkFriendly]
