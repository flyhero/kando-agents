import { expect, it } from 'vitest'
import { planMarkdownFilename } from './plan-markdown'

it('names a plan from its first heading', () => {
  expect(planMarkdownFilename('# 改检查器\n\n正文', 1, 1)).toBe('改检查器.md')
  expect(planMarkdownFilename('\n\n## 第二行才是标题\n', 1, 1)).toBe('第二行才是标题.md')
  expect(planMarkdownFilename('# 标题 #\n', 1, 1)).toBe('标题.md')
})

it('drops characters a filename cannot hold', () => {
  expect(planMarkdownFilename('# 方案: a/b?\n', 1, 1)).toBe('方案 ab.md')
})

it('falls back when the first line is not a heading', () => {
  expect(planMarkdownFilename('先写一段\n\n# 后面的标题\n', 1, 1)).toBe('计划.md')
  expect(planMarkdownFilename('# \n', 1, 1)).toBe('计划.md')
  expect(planMarkdownFilename('', 1, 1)).toBe('计划.md')
})

it('numbers a version only when the plan has more than one', () => {
  expect(planMarkdownFilename('# 方案\n', 2, 3)).toBe('方案-第2版.md')
  expect(planMarkdownFilename('正文', 2, 3)).toBe('计划-第2版.md')
  expect(planMarkdownFilename('# 方案\n', 1, 1)).toBe('方案.md')
})
