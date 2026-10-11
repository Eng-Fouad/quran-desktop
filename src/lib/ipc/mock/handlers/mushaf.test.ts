import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopyOptions, PageData, PageWord } from '../../bindings'
import { isSyntheticPage, SYNTHETIC_PAGE } from '$lib/mushaf/geometry'
import { fixtures } from '../fixtures'
import type { Result } from '../result'
import { state } from '../state'
import { arabicSource, copyText, mushafHandlers, plainText, reference, resetMushafMock } from './mushaf'

/** `crates/quran-core/tests/data/copy_vectors.json` (§5.5, §12.3), shared with the Rust tests. */
interface CopyVectors {
  surahs: Record<string, { nameSimple: string; nameAr: string }>
  cases: {
    name: string
    fromAyahId: number
    toAyahId: number
    options: CopyOptions
    words: PageWord[]
    reference: string
    expected: string
  }[]
}
const vectors = JSON.parse(
  readFileSync(resolve('crates/quran-core/tests/data/copy_vectors.json'), 'utf8'),
) as CopyVectors

function unwrap<T>(r: Result<T>): T {
  if (r.status !== 'ok') throw new Error(`${r.error.kind}: ${r.error.message}`)
  return r.data
}

function errorKind<T>(r: Result<T>): string | null {
  return r.status === 'error' ? r.error.kind : null
}

const OPTIONS: CopyOptions = {
  includeReference: true,
  referenceStyle: 'short',
  ayahNumbers: true,
  translationPackId: null,
}

beforeAll(async () => {
  await fixtures.preload()
})

beforeEach(() => {
  localStorage.clear()
  state.resetAll()
  resetMushafMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mushaf_get_pages (mock)', () => {
  it('validates like CoreDb::pages: 1..=8 pages, each in 1..=604, a known style', async () => {
    const get = mushafHandlers.mushafGetPages
    expect(errorKind(await get('hafs', []))).toBe('invalid_argument')
    expect(errorKind(await get('hafs', [1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe('invalid_argument')
    expect(errorKind(await get('hafs', [0]))).toBe('invalid_argument')
    expect(errorKind(await get('hafs', [605]))).toBe('invalid_argument')
    expect(errorKind(await get('hafs', [1.5]))).toBe('invalid_argument')
    expect(errorKind(await get('qcf_v3' as never, [1]))).toBe('invalid_argument')
  })

  it('answers asynchronously, in the requested order, with fresh objects per call', async () => {
    const pending = mushafHandlers.mushafGetPages('qcf_v2', [262, 261, 604])
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    const first = unwrap(await pending)
    expect(first.map((p) => p.page)).toEqual([262, 261, 604])
    expect(first.every((p) => p.style === 'qcf_v2' && p.layout === 'v2')).toBe(true)
    const again = unwrap(await mushafHandlers.mushafGetPages('qcf_v2', [262]))
    expect(again[0]).toEqual(first[0])
    expect(again[0]).not.toBe(first[0])
  })

  it.skipIf(!fixtures.available)('serves the exported fixture pages unmarked (§4.6)', async () => {
    const [p604] = unwrap(await mushafHandlers.mushafGetPages('qcf_v2', [604]))
    expect(p604).toBeDefined()
    const page = p604 as PageData
    expect(isSyntheticPage(page)).toBe(false)
    expect(page.info.surahIds).toEqual([112, 113, 114])
    expect(page.lines.filter((l) => l.kind === 'ayah' && l.centered).map((l) => l.line)).toEqual([
      4, 9, 14, 15,
    ])
  })

  it('marks pages outside the fixture list as synthetic, with the real numbering', async () => {
    const page = 300
    expect(fixtures.hasPage('hafs', page)).toBe(false)
    const [data] = unwrap(await mushafHandlers.mushafGetPages('hafs', [page]))
    expect(data).toBeDefined()
    const p = data as PageData
    expect(isSyntheticPage(p)).toBe(true)
    // The marker is invisible to serialisation and enumeration, like a real IPC object.
    expect(Object.getOwnPropertyDescriptor(p, SYNTHETIC_PAGE)?.enumerable).toBe(false)
    expect(structuredClone(p)).toEqual(p)
    expect(isSyntheticPage(structuredClone(p))).toBe(false)
    expect(p.page).toBe(page)
    const index = await fixtures.index()
    const v2 = index.layouts.find((l) => l.layout === 'v2')
    const firstWord = p.lines.flatMap((l) => l.words)[0]
    expect(firstWord?.id).toBe(v2?.pageFirstWord[page - 1])
    expect(p.lines.length).toBe(15)
  })
})

describe('copy text (§5.5)', () => {
  it('formats references exactly like the Rust reference()', () => {
    const b255 = { surah: 2, ayah: 255, nameSimple: 'Al-Baqarah', nameAr: 'البقرة' }
    const b257 = { ...b255, ayah: 257 }
    const f7 = { surah: 1, ayah: 7, nameSimple: 'Al-Fatihah', nameAr: 'الفاتحة' }
    const b2 = { ...b255, ayah: 2 }
    expect(reference('short', b255, b255)).toBe('(2:255)')
    expect(reference('long', b255, b255)).toBe('— Al-Baqarah 2:255')
    expect(reference('arabic', b255, b255)).toBe('[البقرة: ٢٥٥]')
    expect(reference('short', b255, b257)).toBe('(2:255–257)')
    expect(reference('long', b255, b257)).toBe('— Al-Baqarah 2:255–257')
    expect(reference('arabic', b255, b257)).toBe('[البقرة: ٢٥٥–٢٥٧]')
    expect(reference('short', f7, b2)).toBe('(1:7–2:2)')
    expect(reference('long', f7, b2)).toBe('— Al-Fatihah 1:7 – Al-Baqarah 2:2')
    expect(reference('arabic', f7, b2)).toBe('[الفاتحة: ٧ – البقرة: ٢]')
  })

  it.skipIf(!fixtures.available)('reproduces every shared copy vector backed by fixture text', async () => {
    const index = await fixtures.index()
    let checked = 0
    for (const c of vectors.cases) {
      const sources = await Promise.all(
        Array.from({ length: c.toAyahId - c.fromAyahId + 1 }, (_, i) =>
          arabicSource(index, c.fromAyahId + i),
        ),
      )
      if (sources.includes('synthetic')) continue
      expect(await copyText(c.fromAyahId, c.toAyahId, c.options), c.name).toBe(c.expected)
      checked++
    }
    // 1:1–7 (×2), 2:255, 2:255–257, 1:7–2:2, 1:6–2:1, 38:24 and 112–114 are all exported; 22:77 (page 341) is not.
    expect(checked).toBeGreaterThanOrEqual(8)
  })

  it('validates the range before reading anything', async () => {
    for (const [from, to] of [
      [0, 1],
      [7, 1],
      [1, 6237],
      [1.5, 2],
    ] as const) {
      const r = await mushafHandlers.quranCopyText(from, to, OPTIONS)
      expect(errorKind(r), `${from}..=${to}`).toBe('invalid_argument')
    }
  })

  it('drops end markers without numbers and appends no reference when asked not to', async () => {
    const text = unwrap(
      await mushafHandlers.quranCopyText(1, 2, { ...OPTIONS, ayahNumbers: false, includeReference: false }),
    )
    expect(text).not.toMatch(/[۝﴾﴿\n]/)
    expect(text.split(' ').length).toBeGreaterThan(4)
    const numbered = unwrap(await mushafHandlers.quranCopyText(1, 2, OPTIONS))
    expect(numbered).toMatch(/ ﴿١﴾ .* ﴿٢﴾\n\(1:1–2\)$/)
  })

  it('copies a synthetic ayah as placeholder words (no Quran text is invented)', async () => {
    const index = await fixtures.index()
    const ayah = 3000
    expect(await arabicSource(index, ayah)).toBe('synthetic')
    const text = unwrap(
      await mushafHandlers.quranCopyText(ayah, ayah, { ...OPTIONS, includeReference: false }),
    )
    expect(text).toMatch(/^(كلمة )+﴿[٠-٩]+﴾$/)
  })

  it('appends an installed translation as plain text, and copies the Arabic alone otherwise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const packId = 'tr.en.saheeh'
    const withPack = { ...OPTIONS, translationPackId: packId }
    const arabicOnly = unwrap(await mushafHandlers.quranCopyText(1, 2, OPTIONS))

    // Not installed: the Arabic part only, with a warning (as the real command logs).
    expect(unwrap(await mushafHandlers.quranCopyText(1, 2, withPack))).toBe(arabicOnly)
    expect(warn).toHaveBeenCalledOnce()

    state.packs.update((s) => {
      const pack = s.list.find((p) => p.id === packId)
      if (pack) pack.state = { type: 'installed', data: { version: '1' } }
    })
    const text = unwrap(await mushafHandlers.quranCopyText(1, 2, withPack))
    expect(text.startsWith(`${arabicOnly}\n\n`)).toBe(true)
    const translation = text.slice(arabicOnly.length + 2)
    expect(translation).not.toMatch(/[<>\n]/)
    expect(translation.length).toBeGreaterThan(10)
  })
})

describe('plainText', () => {
  it('drops footnote markers with their content and strips tags', () => {
    expect(
      plainText('In the name of Allah,<sup class="fn" data-fn="1:1:1">1</sup> the <b>Most</b> Merciful.'),
    ).toBe('In the name of Allah, the Most Merciful.')
  })

  it('separates block elements and collapses whitespace', () => {
    expect(plainText('<p>First.</p><p>Second</p>\n\n  third')).toBe('First. Second third')
    expect(plainText('a<br>b')).toBe('a b')
  })

  it('decodes named and numeric entities', () => {
    expect(plainText('&quot;Fear&quot; &amp; hope &#8211; &#x2014;&nbsp;x &unknown;')).toBe(
      '"Fear" & hope – — x &unknown;',
    )
  })
})
