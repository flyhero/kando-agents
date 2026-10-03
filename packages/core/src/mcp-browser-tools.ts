import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  browserActions,
  browserToolName,
  BrowserUrl,
  describeBrowserPage,
  imageMarker,
  RpcError,
  SnapshotRef,
  type BrowserAction,
  type BrowserConsole,
  type BrowserNavigation,
  type BrowserTab,
  type BrowserToolKind,
  type RpcConnection
} from '@kando/protocol'
import type { AttachmentStore } from './attachment-store'

// What a browser tool gives the model: text, and for a screenshot the picture itself.
export type ToolOutcome = { text: string; isError?: boolean; image?: { data: string; mimeType: string } }

export type BrowserTools = {
  call(kind: BrowserToolKind, args: Record<string, unknown>): Promise<ToolOutcome>
}

const TabId = z.string().uuid().optional()
const History = z.enum(['back', 'forward', 'reload'])

// Each tool's arguments; checked before anything is asked of core, so a mistake comes back as
// text the model can act on.
export const BROWSER_ARGUMENTS: Record<BrowserToolKind, z.ZodType<Record<string, unknown>>> = {
  navigate: z
    .object({ url: BrowserUrl.optional(), history: History.optional(), tabId: TabId })
    .refine((args) => (args.url === undefined) !== (args.history === undefined), { message: 'url 和 history 二选一' }),
  snapshot: z.object({ tabId: TabId }),
  screenshot: z.object({ tabId: TabId, fullPage: z.boolean().optional(), ref: SnapshotRef.optional() }),
  click: browserActions.click.extend({ tabId: TabId }),
  type: browserActions.type.extend({ tabId: TabId }),
  press: browserActions.press.extend({ tabId: TabId }),
  hover: browserActions.hover.extend({ tabId: TabId }),
  scroll: browserActions.scroll.extend({ tabId: TabId }),
  select: browserActions.select.extend({ tabId: TabId }),
  wait: browserActions.wait
    .extend({ tabId: TabId })
    .refine((args) => args.text !== undefined || args.textGone !== undefined || args.seconds !== undefined, { message: 'text、textGone、seconds 至少给一个' }),
  tabs: z.object({ action: z.enum(['list', 'new', 'switch', 'close']).default('list'), tabId: TabId, url: BrowserUrl.optional() }),
  console: z.object({ tabId: TabId, sinceNavigation: z.boolean().optional() })
}

const tabIdProperty = { tabId: { type: 'string', description: '标签页 id，可选；不给就用当前标签页' } }
const refProperty = (what: string) => ({ ref: { type: 'string', description: `${what}在 browser_snapshot 里的 ref，如 e12` } })

type ToolSpec = {
  name: string
  title: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const acts = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

// In the order the model should think of them: open, read, act, check.
export const BROWSER_TOOL_SPECS: ReadonlyArray<ToolSpec & { kind: BrowserToolKind }> = [
  {
    kind: 'navigate',
    name: browserToolName('navigate'),
    title: '打开页面',
    description:
      '在 Kando 托管的浏览器里打开一个 URL，或在当前标签页里后退、前进、刷新；返回页面的无障碍树快照。' +
      '本地开发地址（localhost、127.0.0.1、*.localhost、*.test）直接打开；第一次访问其他站点时会在对话里请用户确认，' +
      '返回「等待用户确认」时先停下，等用户同意后再调用一次。没有标签页时自动开一个。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的 URL；没写协议时本地地址用 http，其他用 https' },
        history: { type: 'string', enum: ['back', 'forward', 'reload'], description: '不打开新地址，而是在历史里移动' },
        ...tabIdProperty
      },
      additionalProperties: false
    },
    // Not marked open-world although it is: Codex asks before every such call through a request
    // Kando's chat does not answer, so the page would never open. The site gate in core is the
    // check that matters, the same for both agents.
    annotations: acts
  },
  {
    kind: 'snapshot',
    name: browserToolName('snapshot'),
    title: '读取页面快照',
    description:
      '读取当前标签页的无障碍树快照（YAML），每个可交互元素带一个 ref（如 e12）。' +
      '点击、输入等工具都用这个 ref 指定元素；页面变化后要重新 snapshot，旧的 ref 会失效。比截图更省、更准，优先用它。',
    inputSchema: { type: 'object', properties: { ...tabIdProperty }, additionalProperties: false },
    annotations: readOnly
  },
  {
    kind: 'screenshot',
    name: browserToolName('screenshot'),
    title: '截图',
    description: '给当前标签页截一张图（JPEG）返回给你，同时显示在用户的对话里。要看布局、颜色、遮挡这类视觉问题时用；只是找元素请用 browser_snapshot。',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: '整页截图（最高 4000 像素），默认只截视口' },
        ...refProperty('只截这一个元素：它'),
        ...tabIdProperty
      },
      additionalProperties: false
    },
    annotations: readOnly
  },
  {
    kind: 'click',
    name: browserToolName('click'),
    title: '点击',
    description: '点击快照里的一个元素，返回之后的页面快照。',
    inputSchema: {
      type: 'object',
      properties: {
        ...refProperty('要点的元素'),
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean', description: '双击' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
        ...tabIdProperty
      },
      required: ['ref'],
      additionalProperties: false
    },
    annotations: acts
  },
  {
    kind: 'type',
    name: browserToolName('type'),
    title: '输入文字',
    description: '在快照里的输入框、编辑区里输入文字，返回之后的页面快照。默认追加在已有内容后；replace 先清空；submit 输完按 Enter。',
    inputSchema: {
      type: 'object',
      properties: {
        ...refProperty('要输入的元素'),
        text: { type: 'string' },
        replace: { type: 'boolean', description: '先清空再输入' },
        submit: { type: 'boolean', description: '输完按 Enter' },
        ...tabIdProperty
      },
      required: ['ref', 'text'],
      additionalProperties: false
    },
    annotations: acts
  },
  {
    kind: 'press',
    name: browserToolName('press'),
    title: '按键',
    description: '在页面上按一个键，如 Enter、Escape、Tab、ArrowDown、Control+a。',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, ...tabIdProperty }, required: ['key'], additionalProperties: false },
    annotations: acts
  },
  {
    kind: 'hover',
    name: browserToolName('hover'),
    title: '悬停',
    description: '把鼠标移到快照里的一个元素上（展开菜单、显示提示），返回之后的页面快照。',
    inputSchema: { type: 'object', properties: { ...refProperty('元素'), ...tabIdProperty }, required: ['ref'], additionalProperties: false },
    annotations: acts
  },
  {
    kind: 'scroll',
    name: browserToolName('scroll'),
    title: '滚动',
    description: '滚动页面或快照里的一个可滚动元素，每格约 100 像素，默认 3 格。',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 20 },
        ...refProperty('要滚动的元素（不给就滚整页）'),
        ...tabIdProperty
      },
      required: ['direction'],
      additionalProperties: false
    },
    annotations: readOnly
  },
  {
    kind: 'select',
    name: browserToolName('select'),
    title: '选择下拉项',
    description: '在快照里的 <select> 里选中一个或多个选项，按选项的 value 或显示文字。',
    inputSchema: {
      type: 'object',
      properties: { ...refProperty('下拉框'), values: { type: 'array', items: { type: 'string' }, minItems: 1 }, ...tabIdProperty },
      required: ['ref', 'values'],
      additionalProperties: false
    },
    annotations: acts
  },
  {
    kind: 'wait',
    name: browserToolName('wait'),
    title: '等待',
    description: '等页面上出现某段文字、某段文字消失，或者等几秒，再返回页面快照。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '等这段文字出现' },
        textGone: { type: 'string', description: '等这段文字消失' },
        seconds: { type: 'number', minimum: 0, maximum: 30 },
        ...tabIdProperty
      },
      additionalProperties: false
    },
    annotations: readOnly
  },
  {
    kind: 'tabs',
    name: browserToolName('tabs'),
    title: '标签页',
    description: '列出这个会话的标签页（list），新开一个（new，可带 url），切换当前标签页（switch），或关闭一个（close）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'switch', 'close'], description: '默认 list' },
        tabId: { type: 'string', description: 'switch、close 要操作的标签页' },
        url: { type: 'string', description: 'new 时打开的地址' }
      },
      additionalProperties: false
    },
    annotations: { ...acts, idempotentHint: true }
  },
  {
    kind: 'console',
    name: browserToolName('console'),
    title: '读取控制台',
    description: '读取当前标签页的 console 输出、页面错误和失败的网络请求，验证改动有没有报错时用。',
    inputSchema: {
      type: 'object',
      properties: { sinceNavigation: { type: 'boolean', description: '只看最后一次导航之后的' }, ...tabIdProperty },
      additionalProperties: false
    },
    annotations: readOnly
  }
]

const describePage = describeBrowserPage

function navigationText(result: BrowserNavigation, host: string): ToolOutcome {
  switch (result.outcome) {
    case 'done':
      return { text: describePage(result.tab, result.snapshot) }
    case 'awaiting-host':
      return { text: `等待用户确认：已在对话里请用户允许访问 ${host}。先停下来告诉用户，等他们同意后再调用一次 browser_navigate。` }
    case 'denied':
      return { text: `用户拒绝了访问 ${host}。`, isError: true }
  }
}

function hostOf(url: string | undefined, tab: BrowserTab): string {
  try {
    return new URL(url ?? tab.url).hostname || tab.url
  } catch {
    return url ?? tab.url
  }
}

function consoleText(output: BrowserConsole): string {
  const messages = output.messages.map((entry) => `[${entry.level}] ${entry.text}`)
  const errors = output.errors.map((error) => `[error] ${error}`)
  const failed = output.failedRequests.map((request) => `[request] ${request.method} ${request.url} — ${request.failure}`)
  const lines = [...messages, ...errors, ...failed]
  return lines.length ? lines.join('\n') : '（没有控制台输出、页面错误或失败的请求）'
}

// What core's refusals mean to the model, as something it can do about them.
function failureText(error: unknown): string {
  if (error instanceof RpcError && error.reason) {
    switch (error.reason) {
      case 'browser-not-installed':
      case 'browser-installing':
        return '浏览器正在下载 Chromium（第一次使用要几分钟），稍后再试。'
      case 'browser-tab-not-found':
        return '标签页不存在，先用 browser_tabs 看一下有哪些。'
      case 'browser-ref-not-found':
        return `${error.message}`
      case 'browser-user-driving':
        return '用户正在操作这个标签页，等一会儿再试，或者问用户是否可以继续。'
      case 'daemon-unavailable':
      case 'browser-unavailable':
      case 'browser-start-failed':
        return `浏览器现在用不了：${error.message}`
    }
  }
  return `浏览器操作失败：${error instanceof Error ? error.message : String(error)}`
}

const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

// The tools over core's RPC, for one conversation. The process remembers which tab the agent
// last used; a tool without a tabId acts on it.
export function browserToolsOverCore(
  withCore: <T>(work: (rpc: RpcConnection) => Promise<T>) => Promise<T>,
  conversationId: string,
  attachments: Pick<AttachmentStore, 'pathOf'>
): BrowserTools {
  let currentTab: string | null = null

  async function tabFor(rpc: RpcConnection, tabId: unknown): Promise<string> {
    if (typeof tabId === 'string') {
      currentTab = tabId
      return tabId
    }
    const tabs = await rpc.call('browser.tabs', { conversationId })
    if (currentTab && tabs.some((tab) => tab.id === currentTab)) return currentTab
    const chosen = tabs.find((tab) => tab.active) ?? tabs.at(-1)
    if (!chosen) throw new RpcError('没有打开的标签页，先用 browser_navigate 打开一个页面', -32000, 'browser-no-tab')
    currentTab = chosen.id
    return chosen.id
  }

  // One action on a tab; its arguments passed BROWSER_ARGUMENTS already, and are read again
  // through the action's own shape so each call is typed on its own.
  function act(rpc: RpcConnection, kind: Exclude<BrowserToolKind, 'navigate' | 'snapshot' | 'screenshot' | 'tabs' | 'console'>, tabId: string, rest: Record<string, unknown>): Promise<BrowserAction> {
    switch (kind) {
      case 'click':
        return rpc.call('browser.click', { conversationId, tabId, ...browserActions.click.parse(rest) })
      case 'type':
        return rpc.call('browser.type', { conversationId, tabId, ...browserActions.type.parse(rest) })
      case 'press':
        return rpc.call('browser.press', { conversationId, tabId, ...browserActions.press.parse(rest) })
      case 'hover':
        return rpc.call('browser.hover', { conversationId, tabId, ...browserActions.hover.parse(rest) })
      case 'scroll':
        return rpc.call('browser.scroll', { conversationId, tabId, ...browserActions.scroll.parse(rest) })
      case 'select':
        return rpc.call('browser.select', { conversationId, tabId, ...browserActions.select.parse(rest) })
      case 'wait':
        return rpc.call('browser.wait', { conversationId, tabId, ...browserActions.wait.parse(rest) })
    }
  }

  async function run(kind: BrowserToolKind, args: Record<string, unknown>, rpc: RpcConnection): Promise<ToolOutcome> {
    const page = (result: { tab: BrowserTab; snapshot: string }) => ({ text: describePage(result.tab, result.snapshot) })
    switch (kind) {
      case 'navigate': {
        const { url, history, tabId } = args
        const tabs = typeof tabId === 'string' ? null : await rpc.call('browser.tabs', { conversationId })
        if (tabs && tabs.length === 0 && typeof url === 'string') {
          const opened = await rpc.call('browser.open', { conversationId, url })
          currentTab = opened.tab.id
          return navigationText(opened, hostOf(url, opened.tab))
        }
        const id = await tabFor(rpc, tabId)
        const to = typeof url === 'string' ? { url } : { history: History.parse(history) }
        const result = await rpc.call('browser.navigate', { conversationId, tabId: id, to })
        return navigationText(result, hostOf(typeof url === 'string' ? url : undefined, result.tab))
      }
      case 'snapshot':
        return page(await rpc.call('browser.snapshot', { conversationId, tabId: await tabFor(rpc, args.tabId) }))
      case 'screenshot': {
        const { tabId, ...options } = args
        const shot = await rpc.call('browser.screenshot', { conversationId, tabId: await tabFor(rpc, tabId), ...options })
        const file = await attachments.pathOf(shot.image.id)
        const image = file ? { data: (await readFile(file)).toString('base64'), mimeType: MIME[shot.image.id.split('.').pop() ?? ''] ?? 'image/jpeg' } : undefined
        return { text: `截图已保存，用户在对话里能看到这张图。\n${describePage(shot.tab, null)}\n${imageMarker(shot.image)}`, ...(image ? { image } : {}) }
      }
      case 'click':
      case 'type':
      case 'press':
      case 'hover':
      case 'scroll':
      case 'select':
      case 'wait': {
        const { tabId, ...rest } = args
        const id = await tabFor(rpc, tabId)
        return page(await act(rpc, kind, id, rest))
      }
      case 'tabs': {
        const { action, tabId, url } = args
        if (action === 'new') {
          const opened = await rpc.call('browser.open', { conversationId, ...(typeof url === 'string' ? { url } : {}) })
          currentTab = opened.tab.id
          return navigationText(opened, hostOf(typeof url === 'string' ? url : undefined, opened.tab))
        }
        const tabs = await rpc.call('browser.tabs', { conversationId })
        if (action === 'switch' || action === 'close') {
          const target = tabs.find((tab) => tab.id === tabId)
          if (!target) return { text: '标签页不存在，先用 browser_tabs 看一下有哪些。', isError: true }
          if (action === 'close') {
            await rpc.call('browser.close', { conversationId, tabId: target.id })
            if (currentTab === target.id) currentTab = null
            return { text: `已关闭标签页 ${target.id}` }
          }
          currentTab = target.id
          return { text: `当前标签页：${describePage(target, null)}` }
        }
        if (tabs.length === 0) return { text: '这个会话还没有打开标签页。' }
        return { text: tabs.map((tab) => `- ${tab.id}${tab.id === currentTab ? '（当前）' : ''} ${tab.title || '(无标题)'} ${tab.url}`).join('\n') }
      }
      case 'console': {
        const { tabId, sinceNavigation } = args
        const output = await rpc.call('browser.console', { conversationId, tabId: await tabFor(rpc, tabId), sinceNavigation: sinceNavigation === true })
        return { text: consoleText(output) }
      }
    }
  }

  return {
    call: (kind, args) =>
      withCore((rpc) => run(kind, args, rpc)).catch((error: unknown) => ({ text: failureText(error), isError: true }))
  }
}
