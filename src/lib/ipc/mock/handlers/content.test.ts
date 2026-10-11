import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { FOOTNOTE_PATTERN, REF_PATTERN } from '$lib/text/html'
import type { TranslationText } from '../../bindings'
import { fixtures } from '../fixtures'
import type { Result } from '../result'
import { state } from '../state'
import { refOf } from '../synthetic'
import { contentHandlers, contentMock, MAX_PACKS, PREVIOUS_RUN_AGE_DAYS } from './content'
import { packsMock } from './packs'

function install(...ids: string[]): void {
  state.packs.update((v) => {
    for (const p of v.list) {
      if (!ids.includes(p.id)) continue
      p.state = { type: 'installed', data: { version: p.version } }
      p.installedKib = p.sizeKib
    }
  })
}

function data<T>(r: Result<T>): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`)
  return r.data
}

function kind<T>(r: Result<T>): string {
  return r.status === 'ok' ? 'ok' : r.error.kind
}

/** The ids of `sup.fn[data-fn]` markers in an HTML string. */
function markers(html: string): string[] {
  return [...html.matchAll(/<sup class="fn" data-fn="([^"]+)">/g)].map((m) => m[1] ?? '')
}

beforeAll(async () => {
  await fixtures.preload()
})

beforeEach(() => {
  state.resetAll()
  state.loadAll()
  contentMock.reset()
  packsMock.reset()
})

afterEach(() => {
  state.resetAll()
})

describe('translation_get', () => {
  it('validates like the command: ranges, pack count, duplicates, unknown and uninstalled packs', async () => {
    install('tr.en.rwwad')
    const get = contentHandlers.translationGet
    expect(kind(await get(['tr.en.rwwad'], 1, 301))).toBe('invalid_argument')
    expect(kind(await get(['tr.en.rwwad'], 0, 1))).toBe('invalid_argument')
    expect(kind(await get(['tr.en.rwwad'], 9, 8))).toBe('invalid_argument')
    expect(kind(await get(['tr.en.rwwad', 'tr.en.rwwad'], 1, 1))).toBe('invalid_argument')
    expect(
      kind(
        await get(
          Array.from({ length: MAX_PACKS + 1 }, (_, i) => `tr.x${i}`),
          1,
          1,
        ),
      ),
    ).toBe('invalid_argument')
    expect(kind(await get(['tr.xx.none'], 1, 1))).toBe('not_found')
    expect(kind(await get(['tafsir.ar.muyassar'], 1, 1))).toBe('invalid_argument')
    expect(kind(await get(['tr.en.hilali_khan'], 1, 1))).toBe('not_found')
    expect(data(await get([], 1, 2))).toEqual([
      { ayahId: 1, items: [] },
      { ayahId: 2, items: [] },
    ])
  })

  it('answers every ayah with the packs in order; an update of a pack still works', async () => {
    install('tr.en.rwwad', 'tr.fr.rashid')
    state.packs.update((v) => {
      const p = v.list.find((x) => x.id === 'tr.fr.rashid')
      if (p) p.state = { type: 'update_available', data: { installed: '1', latest: p.version } }
    })
    const rows = data(await contentHandlers.translationGet(['tr.fr.rashid', 'tr.en.rwwad'], 255, 262))
    expect(rows.map((r) => r.ayahId)).toEqual([255, 256, 257, 258, 259, 260, 261, 262])
    for (const row of rows) expect(row.items.map((i) => i.packId)).toEqual(['tr.fr.rashid', 'tr.en.rwwad'])
  })

  it('writes synthetic text in the pack’s language with QuranEnc-style footnotes, the same on every call', async () => {
    install('tr.en.rwwad', 'tr.bn.zakaria')
    const a = data(await contentHandlers.translationGet(['tr.en.rwwad', 'tr.bn.zakaria'], 4000, 4299))
    const b = data(await contentHandlers.translationGet(['tr.en.rwwad', 'tr.bn.zakaria'], 4000, 4299))
    expect(a).toEqual(b)
    const items = a.flatMap((r) => r.items)
    const en = items.filter((i) => i.packId === 'tr.en.rwwad')
    expect(en.every((i) => i.html.startsWith('Synthetic translation of '))).toBe(true)
    const withNotes = items.filter((i) => i.footnotes.length > 0)
    expect(withNotes.length).toBeGreaterThan(20)
    for (const item of withNotes) checkFootnotes(item)
    // Bengali markers keep Bengali digits (`data-fn="s:a:৩"`), as QuranEnc's do.
    const bn = withNotes.filter((i) => i.packId === 'tr.bn.zakaria').flatMap((i) => markers(i.html))
    expect(bn.length).toBeGreaterThan(0)
    expect(bn.every((id) => /:[০-৯]+$/u.test(id))).toBe(true)
    // Some notes point at another ayah (a reference button), and some surahs open with a general note.
    expect(items.some((i) => i.footnotes.some((f) => /<a data-ref="\d+:\d+">/.test(f.html)))).toBe(true)
  })

  it('opens some surahs with a general note (empty marker, no marker in the text)', async () => {
    install('tr.en.rwwad')
    const surahStarts: number[] = []
    const index = await fixtures.index()
    for (const s of index.surahs) surahStarts.push(s.firstAyahId)
    let general = 0
    for (let from = 1; from <= 6236; from += 300) {
      const rows = data(
        await contentHandlers.translationGet(['tr.en.rwwad'], from, Math.min(6236, from + 299)),
      )
      for (const row of rows) {
        for (const note of row.items[0]?.footnotes ?? []) {
          if (note.marker !== '') continue
          general++
          expect(surahStarts).toContain(row.ayahId)
          expect(note.id).toMatch(/^\d+:1:0$/)
          expect(markers(row.items[0]?.html ?? '')).not.toContain(note.id)
        }
      }
    }
    expect(general).toBeGreaterThan(5)
  })
})

function checkFootnotes(item: TranslationText): void {
  const ids = markers(item.html)
  const numbered = item.footnotes.filter((f) => f.marker !== '')
  expect(ids).toEqual(numbered.map((f) => f.id))
  for (const f of numbered) {
    expect(f.id).toMatch(FOOTNOTE_PATTERN)
    expect(f.id.endsWith(`:${f.marker}`)).toBe(true)
  }
  for (const ref of item.footnotes.flatMap((f) =>
    [...f.html.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]),
  ))
    expect(ref).toMatch(REF_PATTERN)
}

describe('tafsir_get', () => {
  it('needs a whole pack installed, and gives one ayah per entry without QF stamps', async () => {
    expect(kind(await contentHandlers.tafsirGet('tafsir.ar.muyassar', 1))).toBe('not_found')
    expect(kind(await contentHandlers.tafsirGet('tr.en.rwwad', 1))).toBe('invalid_argument')
    expect(kind(await contentHandlers.tafsirGet('tafsir.ar.muyassar', 6237))).toBe('invalid_argument')
    install('tafsir.ar.muyassar')
    const entry = data(await contentHandlers.tafsirGet('tafsir.ar.muyassar', 4000))
    expect(entry).toMatchObject({ fromAyahId: 4000, toAyahId: 4000, lang: 'ar', dir: 'rtl', fetchedAt: null })
    expect(entry.stale).toBe(false)
  })

  it('fetches on-demand chapters online, records them, and serves ranges of 1–3 ayahs', async () => {
    const entry = data(await contentHandlers.tafsirGet('tafsir.en.ibn_kathir', 4000))
    expect(entry.fromAyahId).toBeLessThanOrEqual(4000)
    expect(entry.toAyahId).toBeGreaterThanOrEqual(4000)
    expect(entry.toAyahId - entry.fromAyahId).toBeLessThanOrEqual(2)
    expect(entry.stale).toBe(false)
    expect(entry.fetchedAt).toBeGreaterThan(0)
    const surah = refOf(await fixtures.index(), 4000).surah
    const items = state.packs.value.items['tafsir.en.ibn_kathir'] ?? []
    expect(items.map((i) => i.item)).toContain(surah)
    // Every ayah of the range answers with the same entry.
    const again = data(await contentHandlers.tafsirGet('tafsir.en.ibn_kathir', entry.toAyahId))
    expect([again.fromAyahId, again.toAyahId]).toEqual([entry.fromAyahId, entry.toAyahId])
  })

  it('is offline for an uncached chapter, and stale for one cached on an earlier run', async () => {
    state.settings.set({ ...defaultSettings(), networkAllowed: false })
    expect(kind(await contentHandlers.tafsirGet('tafsir.en.ibn_kathir', 4000))).toBe('offline')
    // A chapter in the pack's items from before this session: 9 days old, stale while offline.
    const surah = refOf(await fixtures.index(), 4000).surah
    state.packs.update((v) => {
      v.items['tafsir.en.ibn_kathir'] = [{ item: surah, pinned: false, queued: false, kib: 40 }]
    })
    const entry = data(await contentHandlers.tafsirGet('tafsir.en.ibn_kathir', 4000))
    expect(entry.stale).toBe(true)
    const age = Date.now() / 1000 - (entry.fetchedAt ?? 0)
    expect(Math.round(age / 86_400)).toBe(PREVIOUS_RUN_AGE_DAYS)
    // Online again: revalidated on the spot.
    state.settings.set({ ...defaultSettings(), networkAllowed: true })
    const fresh = data(await contentHandlers.tafsirGet('tafsir.en.ibn_kathir', 4000))
    expect(fresh.stale).toBe(false)
    expect(Date.now() / 1000 - (fresh.fetchedAt ?? 0)).toBeLessThan(60)
  })
})

describe('wbw_get_range', () => {
  it('validates the word range and the pack kind', async () => {
    expect(kind(await contentHandlers.wbwGetRange('wbw.en', 0, 1))).toBe('invalid_argument')
    expect(kind(await contentHandlers.wbwGetRange('wbw.en', 5, 4))).toBe('invalid_argument')
    expect(kind(await contentHandlers.wbwGetRange('wbw.en', 1, 2001))).toBe('invalid_argument')
    expect(kind(await contentHandlers.wbwGetRange('tr.en.rwwad', 1, 2))).toBe('invalid_argument')
    expect(kind(await contentHandlers.wbwGetRange('wbw.xx', 1, 2))).toBe('not_found')
  })

  it('answers every word but the end markers, in order, with a gloss and a transliteration', async () => {
    const index = await fixtures.index()
    const first = index.ayahFirstWord[0] ?? 1
    const nextAyah = index.ayahFirstWord[1] ?? 6
    const entries = data(await contentHandlers.wbwGetRange('wbw.en', first, nextAyah + 2))
    const ids = entries.map((e) => e.wordId)
    expect(ids).not.toContain(nextAyah - 1) // 1:1's end marker
    expect(ids).toEqual([...ids].sort((x, y) => x - y))
    expect(entries.every((e) => e.text !== '' && e.translation !== null && e.transliteration !== null)).toBe(
      true,
    )
    expect(entries[0]?.wordId).toBe(first)
  })

  it('is offline for chapters that are not cached', async () => {
    state.settings.set({ ...defaultSettings(), networkAllowed: false })
    expect(kind(await contentHandlers.wbwGetRange('wbw.ur', 1, 5))).toBe('offline')
  })
})

describe('quran_get_ayahs', () => {
  it('answers the requested window in the requested layout', async () => {
    const rows = data(await contentHandlers.quranGetAyahs('v1', 255, 262))
    expect(rows.map((r) => r.id)).toEqual([255, 256, 257, 258, 259, 260, 261, 262])
    expect(rows.every((r) => r.page > 0 && r.textHafs.length > 0)).toBe(true)
    expect(kind(await contentHandlers.quranGetAyahs('v2', 1, 301))).toBe('invalid_argument')
  })
})
