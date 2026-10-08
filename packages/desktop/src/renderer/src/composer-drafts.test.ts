import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerDraft, saveComposerDraft } from './composer-drafts'

const mention = {
  start: 2,
  end: 6,
  target: { kind: 'file' as const, path: '/repo/src/a.ts', relative: 'src/a.ts' }
}

afterEach(() => {
  saveComposerDraft('one', { text: '', mentions: [] })
  saveComposerDraft('two', { text: '', mentions: [] })
  saveComposerDraft(null, { text: '', mentions: [] })
})

describe('composer drafts', () => {
  it('keeps text and mentions separately for every conversation', () => {
    saveComposerDraft('one', { text: '看 a.ts', mentions: [mention] })
    saveComposerDraft('two', { text: '另一个输入', mentions: [] })

    expect(composerDraft('one')).toEqual({ text: '看 a.ts', mentions: [mention] })
    expect(composerDraft('two')).toEqual({ text: '另一个输入', mentions: [] })
    expect(composerDraft('missing')).toEqual({ text: '', mentions: [] })
  })

  it('keeps a new conversation separate and drops a sent draft', () => {
    saveComposerDraft(null, { text: '第一条消息', mentions: [] })
    saveComposerDraft('one', { text: '下一条消息', mentions: [] })

    saveComposerDraft('one', { text: '', mentions: [] })

    expect(composerDraft('one')).toEqual({ text: '', mentions: [] })
    expect(composerDraft(null).text).toBe('第一条消息')
  })

  it('restores a draft after the module reloads', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    })

    try {
      localStorage.setItem('kando.composer-drafts', JSON.stringify({
        'conversation:reloaded': { text: '窗口重开后还在', mentions: [] }
      }))
      vi.resetModules()
      const reloaded = await import('./composer-drafts')

      expect(reloaded.composerDraft('reloaded').text).toBe('窗口重开后还在')
      reloaded.saveComposerDraft('reloaded', { text: '', mentions: [] })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
