/**
 * The study pane's pure rules: what it shows (§8.15 precedence over `sidePane.follow`), which chip its header offers,
 * how a range is listed, and how the "add" cards rank packs (§9.8).
 */
import { describe, expect, it } from 'vitest'
import type { PackMeta } from '$lib/stores/translations.svelte'
import { chipFor, listedAyahs, MAX_SPAN, resolveSubject, spanHas, type SubjectInput } from './pane.svelte'
import { actionOf, packRows, rank, translationRows } from './picker'

const base: SubjectInput = {
  follow: 'selection_or_audio',
  pin: null,
  selection: null,
  paneFollow: 'audio',
  recited: null,
  reading: 1,
}

const sel = (from: number, to = from) => ({ fromAyahId: from, toAyahId: to })

describe('resolveSubject', () => {
  it('shows the reading position when nothing is selected or recited', () => {
    expect(resolveSubject(base)).toEqual({ from: 1, to: 1, source: 'reading' })
    expect(resolveSubject({ ...base, reading: null })).toBeNull()
    expect(resolveSubject({ ...base, reading: 0 })).toBeNull()
  })

  it('a selection that pins the pane wins over the recitation', () => {
    const input = { ...base, selection: sel(262, 264), paneFollow: 'selection' as const, recited: 270 }
    expect(resolveSubject(input)).toEqual({ from: 262, to: 264, source: 'selection' })
  })

  it('follows the recitation when no selection pins it ("selected or recited")', () => {
    expect(resolveSubject({ ...base, recited: 270 })).toEqual({ from: 270, to: 270, source: 'recitation' })
    // After "Follow recitation" the selection stays, but the recitation leads.
    expect(resolveSubject({ ...base, selection: sel(262), recited: 270 })?.source).toBe('recitation')
    // With nothing playing, that selection is shown again.
    expect(resolveSubject({ ...base, selection: sel(262) })).toEqual({
      from: 262,
      to: 262,
      source: 'selection',
    })
  })

  it('never follows the recitation in "selection" mode', () => {
    const input = { ...base, follow: 'selection' as const, recited: 270 }
    expect(resolveSubject(input)).toEqual({ from: 1, to: 1, source: 'reading' })
    expect(resolveSubject({ ...input, selection: sel(262) })?.from).toBe(262)
  })

  it('a pin holds whatever else happens; without a pin, "pinned" behaves like "selected or recited"', () => {
    const pinned = { ...base, follow: 'pinned' as const, pin: { from: 40, to: 41 } }
    expect(resolveSubject({ ...pinned, selection: sel(262), paneFollow: 'selection', recited: 270 })).toEqual(
      {
        from: 40,
        to: 41,
        source: 'pinned',
      },
    )
    expect(resolveSubject({ ...pinned, pin: null, recited: 270 })?.source).toBe('recitation')
    // A pin is ignored outside "pinned" mode.
    expect(resolveSubject({ ...base, pin: { from: 40, to: 40 } })?.source).toBe('reading')
  })
})

describe('chipFor', () => {
  it('offers "Follow recitation" while a selection holds the pane during a recitation', () => {
    const input = { ...base, selection: sel(262), paneFollow: 'selection' as const, recited: 270 }
    expect(chipFor(input, resolveSubject(input))).toEqual({ kind: 'follow', ayahId: 270 })
    // Not in "selection" mode: the pane never follows the recitation there.
    const strict = { ...input, follow: 'selection' as const }
    expect(chipFor(strict, resolveSubject(strict))).toBeNull()
    // Nothing playing: no chip.
    const quiet = { ...input, recited: null }
    expect(chipFor(quiet, resolveSubject(quiet))).toBeNull()
  })

  it('a pinned pane offers to follow the recitation, else to show another selection', () => {
    const pinned = { ...base, follow: 'pinned' as const, pin: { from: 40, to: 40 } }
    expect(chipFor({ ...pinned, recited: 270 }, resolveSubject(pinned))).toEqual({
      kind: 'follow',
      ayahId: 270,
    })
    const other = { ...pinned, selection: sel(262, 263) }
    expect(chipFor(other, resolveSubject(other))).toEqual({ kind: 'selection', span: { from: 262, to: 263 } })
    const same = { ...pinned, selection: sel(40) }
    expect(chipFor(same, resolveSubject(same))).toBeNull()
  })

  it('offers nothing while following the recitation or the reading position', () => {
    const following = { ...base, recited: 270 }
    expect(chipFor(following, resolveSubject(following))).toBeNull()
    expect(chipFor(base, resolveSubject(base))).toBeNull()
    expect(chipFor(base, null)).toBeNull()
  })
})

describe('spans', () => {
  it('lists a range up to MAX_SPAN ayahs', () => {
    expect(listedAyahs({ from: 262, to: 264 })).toEqual([262, 263, 264])
    const long = listedAyahs({ from: 1, to: 200 })
    expect(long).toHaveLength(MAX_SPAN)
    expect(long.at(-1)).toBe(MAX_SPAN)
  })

  it('tells whether a span holds an ayah', () => {
    expect(spanHas({ from: 2, to: 4 }, 3)).toBe(true)
    expect(spanHas({ from: 2, to: 4 }, 5)).toBe(false)
    expect(spanHas(null, 3)).toBe(false)
    expect(spanHas({ from: 2, to: 4 }, null)).toBe(false)
  })
})

function meta(id: string, over: Partial<PackMeta> = {}): PackMeta {
  return {
    id,
    kind: 'tafsir',
    title: { en: id, ar: id },
    language: 'en',
    dir: 'ltr',
    availability: 'not_installed',
    onDemand: false,
    sizeKib: 800,
    recommended: false,
    ...over,
  }
}

describe('picker', () => {
  const ctx = { uiLanguage: 'ar', osLanguage: 'en' }

  it('a pack usable now says Use; others say what their download state allows', () => {
    expect(actionOf(meta('a', { availability: 'installed' }))).toBe('use')
    expect(actionOf(meta('a', { onDemand: true }))).toBe('use')
    expect(actionOf(meta('a', { availability: 'unknown' }))).toBe('use')
    expect(actionOf(meta('a', { availability: 'downloading' }))).toBe('downloading')
    expect(actionOf(meta('a', { availability: 'failed' }))).toBe('failed')
    expect(actionOf(meta('a'))).toBe('install')
  })

  it('ranks usable packs first, then by language (UI, OS, English) and recommendation', () => {
    const list = [
      meta('en-whole'),
      meta('ar-whole', { language: 'ar' }),
      meta('ar-ondemand', { language: 'ar', onDemand: true }),
      meta('en-ondemand', { onDemand: true }),
      meta('fr-installed', { language: 'fr', availability: 'installed' }),
    ]
    expect(rank(list, ctx).map((m) => m.id)).toEqual([
      'ar-ondemand',
      'en-ondemand',
      'fr-installed',
      'ar-whole',
      'en-whole',
    ])
    expect(packRows('tafsir', list, ctx, 2).map((r) => [r.meta.id, r.action])).toEqual([
      ['ar-ondemand', 'use'],
      ['en-ondemand', 'use'],
    ])
    // Only packs of the asked kind.
    expect(packRows('wbw', list, ctx, 5)).toEqual([])
  })

  it('translations: missing selected packs first, then installed ones (Show), then the best matches', () => {
    const tr = (id: string, over: Partial<PackMeta> = {}) => meta(id, { kind: 'translation', ...over })
    const missing = [tr('tr.sel', { availability: 'downloading' })]
    const catalogue = [
      tr('tr.sel', { availability: 'downloading' }),
      tr('tr.en.a'),
      tr('tr.ar.b', { language: 'ar' }),
      tr('tr.fr.installed', { language: 'fr', availability: 'installed' }),
    ]
    expect(translationRows(missing, catalogue, ['tr.sel'], ctx).map((r) => [r.meta.id, r.action])).toEqual([
      ['tr.sel', 'downloading'],
      ['tr.fr.installed', 'show'],
      ['tr.ar.b', 'install'],
    ])
    // Nothing selected: installed first, then the UI language, then the OS language and English (catalogue order).
    expect(translationRows([], catalogue, [], ctx, 4).map((r) => r.meta.id)).toEqual([
      'tr.fr.installed',
      'tr.ar.b',
      'tr.sel',
      'tr.en.a',
    ])
  })
})
