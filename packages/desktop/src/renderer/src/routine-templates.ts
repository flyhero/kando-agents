import type { RoutineSchedule } from '@kando/protocol'

// A template is a routine written out for a common chore, to start from: the user picks one,
// changes what they like in the editor, and creates it. The icon names one in icons.tsx; the
// text is what the agent is told each run, so it says what not to do unattended.
export type RoutineTemplate = {
  id: string
  icon: 'changes' | 'refresh' | 'branch' | 'pulse' | 'folder' | 'document' | 'book' | 'chart'
  title: string
  description: string
  text: string
  schedule: RoutineSchedule
}

export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: 'daily-review',
    icon: 'changes',
    title: '每日代码审查',
    description: '审查过去一天合进主分支的提交，指出问题和风险。',
    text: [
      '审查过去 24 小时合进主分支的提交（git log --since="24 hours ago"）。',
      '逐个提交看改动：有没有明显的 bug、遗漏的边界条件、没更新的测试或文档、可疑的安全问题。',
      '不要修改任何文件。把结论写在回复里：先列需要人看的问题（带文件和行号），再列值得一提的改进建议，没有问题就说没有。'
    ].join('\n'),
    schedule: { kind: 'weekdays', time: '09:00' }
  },
  {
    id: 'test-health',
    icon: 'pulse',
    title: '测试健康检查',
    description: '跑一遍测试，报告失败和时好时坏的用例。',
    text: [
      '运行项目的全部测试（按仓库的说明或 package.json / Makefile 里的命令）。',
      '如果有失败，把失败的用例重跑一次，分清稳定失败和时好时坏的。',
      '不要改代码。回复里写：总数、失败数、每个失败用例的名字和最可能的原因；全部通过就只说通过和用时。'
    ].join('\n'),
    schedule: { kind: 'daily', time: '07:30' }
  },
  {
    id: 'pr-digest',
    icon: 'branch',
    title: 'PR 待办摘要',
    description: '列出等着处理的 pull request，标出谁该动。',
    text: [
      '用 gh pr list 列出这个仓库所有打开的 pull request，包括草稿。',
      '对每个 PR 看一眼标题、评审状态、CI 结果和最近一次更新时间。',
      '不要评论、不要合并。回复里按紧急程度排一张清单：等我评审的、等别人改的、CI 红了的、超过一周没动的，每条一句话说明该做什么。'
    ].join('\n'),
    schedule: { kind: 'weekdays', time: '09:15' }
  },
  {
    id: 'dependency-check',
    icon: 'refresh',
    title: '依赖更新检查',
    description: '找出能升级的依赖和安全通告，不直接升级。',
    text: [
      '检查项目的依赖有哪些可以升级（npm outdated、pnpm outdated、pip list --outdated 之类，按项目用的工具来），再跑一次安全审计（npm audit 等）。',
      '对每个有新版本的依赖，看一眼变更说明里有没有破坏性改动。',
      '不要修改 lockfile 或任何文件。回复里分三组列出：有安全通告的、有破坏性改动的、可以直接升的，每条带当前版本和目标版本。'
    ].join('\n'),
    schedule: { kind: 'weekly', days: [1], time: '09:30' }
  },
  {
    id: 'repo-tidy',
    icon: 'folder',
    title: '仓库巡检',
    description: '清点过期分支、没提交的改动和散落的 TODO。',
    text: [
      '检查这个仓库的卫生状况：工作区有没有没提交的改动；哪些本地和远端分支已经合进主分支或超过一个月没动；代码里新增了哪些 TODO / FIXME / HACK；有没有误提交的大文件或密钥样式的字符串。',
      '只读，不要删分支、不要改文件。回复里按类别列出，并给出建议的处理命令让我自己决定。'
    ].join('\n'),
    schedule: { kind: 'weekly', days: [5], time: '17:00' }
  },
  {
    id: 'release-notes',
    icon: 'document',
    title: '发布说明草稿',
    description: '根据上个版本以来的提交起草面向用户的更新说明。',
    text: [
      '找出自最近一个版本标签（或 CHANGELOG 里最近的版本）以来的全部提交。',
      '把它们归成新功能、改进、修复三类，用面向用户的语言各写一句话，技术性的内部改动合并或略去。',
      '把草稿写在回复里，不要改 CHANGELOG 或任何文件；最后列出你拿不准该不该写进去的提交。'
    ].join('\n'),
    schedule: { kind: 'weekly', days: [5], time: '16:00' }
  },
  {
    id: 'docs-drift',
    icon: 'book',
    title: '文档同步检查',
    description: '对照代码检查 README 和文档有没有过时。',
    text: [
      '读一遍 README 和 docs 目录里的文档，对照当前代码检查：命令和参数还对不对、提到的文件和配置项还在不在、示例还能不能跑。',
      '不要改文件。回复里列出每处过时的说法：在哪个文件哪一段、现在实际是怎样、建议怎么改。'
    ].join('\n'),
    schedule: { kind: 'weekly', days: [3], time: '10:00' }
  },
  {
    id: 'weekly-report',
    icon: 'chart',
    title: '周报',
    description: '汇总这一周的提交和 PR，按主题写成一段话。',
    text: [
      '汇总过去 7 天这个仓库的提交和合并的 pull request（git log --since="7 days ago"，有 gh 的话也看 gh pr list --state merged）。',
      '按主题而不是按提交归类，每个主题两三句话说清做了什么、对用户有什么影响；最后一段写还在进行中和下周要注意的。',
      '只读，把周报写在回复里。'
    ].join('\n'),
    schedule: { kind: 'weekly', days: [5], time: '18:00' }
  }
]
