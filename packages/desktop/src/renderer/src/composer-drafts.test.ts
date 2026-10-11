import { afterEach, describe, expect, it, vi } from 'vitest'
import { composerDraft, EMPTY_DRAFT, saveComposerDraft } from './composer-drafts'

const mention = {
  start: 2,
  end: 6,
  target: { kind: 'file' as const, path: '/repo/src/a.ts', relative: 'src/a.ts' }
}

afterEach(() => {
  saveComposerDraft('one', EMPTY_DRAFT)
  saveComposerDraft('two', EMPTY_DRAFT)
  saveComposerDraft(null, EMPTY_DRAFT)
})

describe('composer drafts', () => {
  it('keeps text and mentions separately for every conversation', () => {
    saveComposerDraft('one', { text: '看 a.ts', mentions: [mention], images: [] })
    saveComposerDraft('two', { text: '另一个输入', mentions: [], images: [] })

    expect(composerDraft('one')).toEqual({ text: '看 a.ts', mentions: [mention], images: [] })
    expect(composerDraft('two')).toEqual({ text: '另一个输入', mentions: [], images: [] })
    expect(composerDraft('missing')).toEqual(EMPTY_DRAFT)
  })

  it('keeps a new conversation separate and drops a sent draft', () => {
    saveComposerDraft(null, { text: '第一条消息', mentions: [], images: [] })
    saveComposerDraft('one', { text: '下一条消息', mentions: [], images: [] })

    saveComposerDraft('one', EMPTY_DRAFT)

    expect(composerDraft('one')).toEqual(EMPTY_DRAFT)
    expect(composerDraft(null).text).toBe('第一条消息')
  })

  it('keeps attached images, even with no text', () => {
    const image = { id: `${'a'.repeat(64)}.png`, width: 640, height: 480 }
    saveComposerDraft('one', { text: '看这张图', mentions: [], images: [image] })
    saveComposerDraft('two', { text: '', mentions: [], images: [image] })

    expect(composerDraft('one').images).toEqual([image])
    expect(composerDraft('two')).toEqual({ text: '', mentions: [], images: [image] })
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

      // Kept before drafts held images.
      expect(reloaded.composerDraft('reloaded')).toEqual({ text: '窗口重开后还在', mentions: [], images: [] })
      reloaded.saveComposerDraft('reloaded', EMPTY_DRAFT)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
