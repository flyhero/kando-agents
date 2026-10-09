import { browserToolKind, parseBrowserPage, type ChatItem } from '@kando/protocol'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type BrowserPage = { item: ToolItem; page: NonNullable<ReturnType<typeof parseBrowserPage>> }

// Only successful page results replace a tab's last known page; history keeps every call.
export function latestBrowserPages(tools: readonly ToolItem[]): BrowserPage[] {
  const pages = new Map<string, BrowserPage>()
  for (const item of tools) {
    if (!browserToolKind(item.name) || item.status !== 'done' || !item.output) continue
    const page = parseBrowserPage(item.output)
    if (page) pages.set(page.id, { item, page })
  }
  return [...pages.values()]
}
