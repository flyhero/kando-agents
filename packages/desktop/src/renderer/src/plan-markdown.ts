// A downloaded plan is named from its first heading. A blank line before that heading does not
// count: agents often leave one. Anything else, including a heading further down, is just 计划.
const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g

export function planMarkdownFilename(markdown: string, version: number, count: number): string {
  const line = markdown.split('\n').find((each) => each.trim() !== '')?.trim() ?? ''
  const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)?.[1]?.trim() ?? ''
  const title = heading.replace(UNSAFE, '').replace(/\s+/g, ' ').trim() || '计划'
  return `${title}${count > 1 ? `-第${version}版` : ''}.md`
}
