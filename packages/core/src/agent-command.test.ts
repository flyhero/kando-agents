import { describe, expect, it } from 'vitest'
import { claudeEditDenials, claudeReadRules } from './agent-command'

describe('Claude permission rules', () => {
  it('lets Claude read exactly those files, and nothing about the folder', () => {
    expect(claudeReadRules(['/home/me/.kando/attachments/a.png', '/home/me/odd,name/b.png', 'relative.png'])).toEqual([
      'Read(//home/me/.kando/attachments/a.png)'
    ])
  })

  it('denies edits under each folder, leaving out what a comma would garble', () => {
    expect(claudeEditDenials(['/work/web app', '/work/a,b', 'relative'])).toEqual(['Edit(//work/web app/**)'])
  })
})
