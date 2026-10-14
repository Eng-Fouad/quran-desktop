/**
 * The search mock: `search_query` validation, the Quran search over the exported corpus and over the synthetic one (so
 * the suite means something with and without fixtures), fixture answers, typo fallback, phrases, modes and filters,
 * word mapping, translation and notes snippets, `search_suggest`, and the history commands.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Note, SearchRequest, SearchResults } from '../../bindings'
import { fixtures } from '../fixtures'
import type { Result } from '../result'
import { state } from '../state'
import { pageOfAyah, refOf, syntheticAyahs } from '../synthetic'
import { contentMock } from './content'
import { packsMock } from './packs'
import {
  buildSnippet,
  groupTokens,
  htmlText,
  levenshteinBounded,
  markdownText,
  parseQuery,
  searchHandlers,
  searchMock,
  tokenize,
} from './search'

function data<T>(r: Result<T>): T {
  if (r.status !== 'ok') throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`)
  return r.data
}

function kind<T>(r: Result<T>): string {
  return r.status === 'ok' ? 'ok' : r.error.kind
}

function request(query: string, extra: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query,
    scope: { type: 'quran' },
    mode: 'smart',
    surah: null,
    juz: null,
    limit: 500,
    layout: 'v2',
    ...extra,
  }
}

const query = async (q: string, extra: Partial<SearchRequest> = {}) =>
  data(await searchHandlers.searchQuery(request(q, extra)))

const hits = (r: SearchResults) => r.groups.flatMap((g) => g.hits)
const ids = (r: SearchResults) => hits(r).map((h) => h.ayahId)

function install(...packIds: string[]): void {
  state.packs.update((v) => {
    for (const p of v.list) {
      if (!packIds.includes(p.id)) continue
      p.state = { type: 'installed', data: { version: p.version } }
      p.installedKib = p.sizeKib
    }
  })
}

/** Hides the exported search corpus, words and answers: the mock searches its synthetic text. */
function synthetic(): void {
  const json = fixtures.json.bind(fixtures)
  vi.spyOn(fixtures, 'json').mockImplementation(async (rel: string) =>
    rel.startsWith('search/') || rel === 'manifest.json' ? undefined : json(rel),
  )
  vi.spyOn(fixtures, 'hasPage').mockReturnValue(false)
  vi.spyOn(fixtures, 'ayahs').mockImplementation(async (layout, from, to) =>
    syntheticAyahs(await fixtures.index(), layout, from, to),
  )
}

beforeAll(async () => {
  await fixtures.preload()
})

beforeEach(() => {
  state.resetAll()
  state.loadAll()
  searchMock.reset()
  contentMock.reset()
  packsMock.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  state.resetAll()
})

describe('search_query: validation and empty queries', () => {
  it('rejects what the command rejects', async () => {
    const q = searchHandlers.searchQuery
    expect(kind(await q(request('x', { limit: 0 })))).toBe('invalid_argument')
    expect(kind(await q(request('x', { limit: 2001 })))).toBe('invalid_argument')
    expect(kind(await q(request('x', { surah: 115 })))).toBe('invalid_argument')
    expect(kind(await q(request('x', { juz: 0 })))).toBe('invalid_argument')
    expect(kind(await q(request('ا'.repeat(2001))))).toBe('invalid_argument')
    expect(kind(await q(request(Array.from({ length: 201 }, () => 'ab').join(' '))))).toBe('invalid_argument')
    expect(kind(await q(request('x', { scope: { type: 'translation', data: { packId: '  ' } } })))).toBe(
      'invalid_argument',
    )
  })

  it('answers a query that folds to nothing with an empty result', async () => {
    for (const q of ['', '   ', '؟!', 'ً ٌ ٍ', '""']) {
      const r = await query(q)
      expect(r.total).toBe(0)
      expect(r.groups).toEqual([])
      expect(r.truncated).toBe(false)
    }
  })

  it('answers filters that do not intersect with no hits', async () => {
    // Al-Baqarah lies in juz 1–3.
    const r = await query('الله', { surah: 2, juz: 30 })
    expect(r.total).toBe(0)
  })

  it('reports a translation pack that is not installed as not found', async () => {
    const r = await searchHandlers.searchQuery(
      request('mercy', { scope: { type: 'translation', data: { packId: 'tr.en.saheeh' } } }),
    )
    expect(kind(r)).toBe('not_found')
  })
})

describe('search_query: the synthetic corpus (no fixtures)', () => {
  beforeEach(() => synthetic())

  it('finds the placeholder word everywhere, cuts at the limit and counts every match per surah', async () => {
    const r = await query('كلمة', { limit: 200 })
    expect(r.total).toBe(6236)
    expect(r.truncated).toBe(true)
    expect(hits(r)).toHaveLength(200)
    expect(r.groups[0]?.surah).toBe(1)
    expect(r.groups[0]?.count).toBe(7)
    // Al-Baqarah is cut at the limit; its count is still every match in the surah.
    expect(r.groups[1]?.surah).toBe(2)
    expect(r.groups[1]?.count).toBe(286)
    expect(r.groups[1]?.hits).toHaveLength(193)
    expect(r.groups).toHaveLength(2)
  })

  it('maps matched words into each hit: whole words, the end marker last', async () => {
    const index = await fixtures.index()
    const r = await query('كلمه', { surah: 112 })
    expect(r.total).toBe(4)
    for (const h of hits(r)) {
      expect(h.firstWordId).toBe(index.ayahFirstWord[h.ayahId - 1])
      expect(h.words.at(-1)?.startsWith('۝')).toBe(true)
      // Every word but the end marker matches.
      expect(h.matchedWordIds).toEqual(h.words.slice(0, -1).map((_, i) => h.firstWordId + i))
      expect(refOf(index, h.ayahId).surah).toBe(112)
    }
  })

  it('fixes a typo against the vocabulary and names the term', async () => {
    const r = await query('كلمو', { surah: 1 })
    expect(r.suggestions).toEqual(['كلمه'])
    expect(r.total).toBe(7)
  })

  it('pages hits in the requested layout', async () => {
    const index = await fixtures.index()
    const v4 = await query('كلمه', { surah: 18, layout: 'v4' })
    const v2 = await query('كلمه', { surah: 18, layout: 'v2' })
    expect(hits(v4).map((h) => h.page)).toEqual(hits(v4).map((h) => pageOfAyah(index, 'v4', h.ayahId)))
    expect(hits(v2).map((h) => h.page)).toEqual(hits(v2).map((h) => pageOfAyah(index, 'v2', h.ayahId)))
    expect(hits(v2).map((h) => h.ayahId)).toEqual(hits(v4).map((h) => h.ayahId))
  })
})

describe.skipIf(!fixtures.available)('search_query: the exported corpus', () => {
  it('answers a fixture query with the real engine’s results, cut to the limit', async () => {
    const r = await query('الرحمن')
    const fixture = (await fixtures.json<SearchResults>('search/results/rahman.json')) as SearchResults
    expect(r.total).toBe(fixture.total)
    expect(r.groups).toEqual(fixture.groups)
    const cut = await query('الرحمن', { limit: 3 })
    expect(hits(cut)).toHaveLength(3)
    expect(cut.truncated).toBe(true)
    expect(cut.groups[0]?.count).toBe(fixture.groups[0]?.count)
  })

  it('searches other queries ad hoc: prefix on the last word, Uthmani words, matched ids', async () => {
    const r = await query('الرحي')
    expect(ids(r).slice(0, 2)).toEqual([1, 3])
    const first = hits(r)[0]
    // The exported page's words (the same Hafs text; mark order aside).
    expect(first?.words.map((w) => w.normalize('NFC'))).toEqual(
      ['بِسۡمِ', 'ٱللَّهِ', 'ٱلرَّحۡمَٰنِ', 'ٱلرَّحِيمِ', '۝١'].map((w) => w.normalize('NFC')),
    )
    expect(first?.matchedWordIds).toEqual([4])
  })

  it('matches every token (implicit AND) and quoted phrases as adjacent words', async () => {
    const and = await query('الرحمن الرحيم')
    expect(ids(and)).toEqual(expect.arrayContaining([1, 3]))
    const phrase = await query('"الرحيم الرحمن"')
    expect(phrase.total).toBe(0)
    const ordered = await query('"الرحمن الرحيم"')
    expect(ids(ordered)).toEqual(expect.arrayContaining([1, 3]))
    for (const id of ids(ordered)) expect(ids(and)).toContain(id)
  })

  it('corrects a typo with the nearest Quran word only', async () => {
    const r = await query('الرحمان')
    expect(r.suggestions).toEqual(['الرحمن'])
    expect(r.total).toBe(45)
    // A query with a short token is never corrected.
    expect((await query('رب العلمين')).suggestions).toEqual([])
  })

  it('exact mode has no prefix and no typo fallback; substring mode crosses words', async () => {
    expect((await query('الرح', { mode: 'exact' })).total).toBe(0)
    expect((await query('الرحمان', { mode: 'exact' })).total).toBe(0)
    const sub = await query('رحمن الرح', { mode: 'substring', surah: 1 })
    expect(ids(sub)).toEqual([1, 3])
    expect(hits(sub)[0]?.matchedWordIds).toEqual([3, 4])
  })

  it('applies the surah and juz filters', async () => {
    const r = await query('الرحمن', { surah: 19 })
    expect(r.groups.map((g) => g.surah)).toEqual([19])
    // 2:163 lies in juz 2.
    expect(ids(await query('الرحمن', { juz: 1 }))).toEqual([1, 3])
    expect(ids(await query('الرحمن', { juz: 2 }))).toEqual([170])
  })

  it('joins vocative particles to their word (يا ايها → one Uthmani word)', async () => {
    const r = await query('ايها الناس', { surah: 2 })
    const h = hits(r).find((x) => x.ayahId === 28)
    if (!h) throw new Error('2:21 not found')
    // يَٰٓأَيُّهَا ٱلنَّاسُ … تَتَّقُونَ: eleven words and the end marker; the first two match.
    expect(h.words).toHaveLength(12)
    expect(h.matchedWordIds).toEqual([h.firstWordId, h.firstWordId + 1])
  })
})

describe('search_query: translations and notes', () => {
  it('searches an installed translation and builds marked snippets', async () => {
    install('tr.en.saheeh')
    const r = await query('patience', {
      scope: { type: 'translation', data: { packId: 'tr.en.saheeh' } },
      juz: 30,
    })
    expect(r.total).toBeGreaterThan(0)
    for (const h of hits(r)) {
      expect(h.words).toEqual([])
      expect(h.matchedWordIds).toEqual([])
      expect(h.snippet).toMatch(/<mark>patience<\/mark>/u)
      expect(h.surah).toBeGreaterThanOrEqual(78)
    }
  })

  it('searches the live notes at their first ayah inside the filter, title or body', async () => {
    const now = 1_700_000_000
    const note = (id: string, from: number, to: number, title: string | null, body: string): Note => ({
      id,
      fromAyahId: from,
      toAyahId: to,
      title,
      body,
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    })
    state.user.update((u) => {
      u.notes = [
        note('a', 5, 10, 'Mercy', 'A note about **ease** after hardship.'),
        note('b', 1, 7, null, '# Opening\nThe *mercy* of the opening, with [a link](x).'),
        note('c', 8, 8, null, 'Nothing to see.'),
      ]
    })
    const r = await query('mercy', { scope: { type: 'notes' } })
    expect(hits(r).map((h) => [h.ayahId, h.noteId])).toEqual([
      [1, 'b'],
      [5, 'a'],
    ])
    expect(hits(r)[0]?.snippet).toBe('Opening The <mark>mercy</mark> of the opening, with a link.')
    // Only the title matched: its snippet is the title.
    expect(hits(r)[1]?.snippet).toBe('<mark>Mercy</mark>')
    // A note across the filter's start is a hit at the range's first ayah (2:1 = 8).
    const inSurah2 = await query('mercy', { scope: { type: 'notes' }, surah: 2 })
    expect(hits(inSurah2).map((h) => [h.ayahId, h.noteId])).toEqual([[8, 'a']])
  })
})

describe('search_suggest', () => {
  it('validates the limit and completes nothing after a finished word', async () => {
    const s = searchHandlers.searchSuggest
    expect(kind(await s('x', 0))).toBe('invalid_argument')
    expect(kind(await s('x', 101))).toBe('invalid_argument')
    expect(data(await s('', 5))).toEqual([])
    expect(data(await s('الله ', 5))).toEqual([])
    expect(data(await s('الله،', 5))).toEqual([])
    expect(data(await s('"الله', 5)).length).toBeGreaterThanOrEqual(0)
  })

  it('completes from the synthetic vocabulary without fixtures', async () => {
    synthetic()
    expect(data(await searchHandlers.searchSuggest('كل', 5))).toEqual([{ term: 'كلمه', count: 6236 }])
  })

  it.skipIf(!fixtures.available)('completes the word being typed, most frequent first', async () => {
    const s = searchHandlers.searchSuggest
    const out = data(await s('في الرَّح', 4))
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(4)
    for (const v of out) expect(v.term.startsWith(tokenize('الرح')[0] ?? '')).toBe(true)
    const counts = out.map((v) => v.count)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })
})

describe('search history', () => {
  it('stores trimmed queries per scope, bumps repeats and lists the most recent first', async () => {
    const add = searchHandlers.searchHistoryAdd
    expect(kind(await add('   ', { type: 'quran' }))).toBe('invalid_argument')
    expect(kind(await add('x'.repeat(501), { type: 'quran' }))).toBe('invalid_argument')
    expect(kind(await add('x', { type: 'translation', data: { packId: '' } }))).toBe('invalid_argument')
    data(await add('  الرحمن  الرحيم ', { type: 'quran' }))
    data(await add('mercy', { type: 'translation', data: { packId: 'tr.en.saheeh' } }))
    data(await add('الرحمن الرحيم', { type: 'quran' }))
    data(await add('الرحمن الرحيم', { type: 'notes' }))
    const list = data(await searchHandlers.searchHistoryList(10))
    expect(list.map((h) => [h.query, h.scope.type, h.useCount])).toEqual([
      ['الرحمن الرحيم', 'notes', 1],
      ['الرحمن الرحيم', 'quran', 2],
      ['mercy', 'translation', 1],
    ])
    expect(data(await searchHandlers.searchHistoryList(1))).toHaveLength(1)
    data(await searchHandlers.searchHistoryClear())
    expect(data(await searchHandlers.searchHistoryList(10))).toEqual([])
  })
})

describe('helpers', () => {
  it('parses phrases, prefixes and folded tokens', () => {
    const fold = (s: string) => s.toLowerCase()
    expect(parseQuery('a b', fold, 'smart')).toMatchObject({
      prefix: true,
      tokens: ['a', 'b'],
      needle: 'a b',
    })
    expect(parseQuery('"a b"', fold, 'smart')).toMatchObject({ prefix: false })
    expect(parseQuery('"a b', fold, 'smart')).toMatchObject({ prefix: true })
    expect(parseQuery('«a» b', fold, 'exact')).toMatchObject({ prefix: false, tokens: ['a', 'b'] })
    expect(parseQuery('a♥b', fold, 'smart')?.terms).toHaveLength(2)
    expect(parseQuery('!!', fold, 'smart')).toBeNull()
  })

  it('bounds the edit distance', () => {
    expect(levenshteinBounded('الرحمان', 'الرحمن', 2)).toBe(1)
    expect(levenshteinBounded('abc', 'xyz', 2)).toBeNull()
    expect(levenshteinBounded('kitten', 'sitting', 3)).toBe(3)
    expect(levenshteinBounded('a', 'abcd', 2)).toBeNull()
  })

  it('groups Imlaei tokens into Uthmani words', () => {
    expect(groupTokens(['يا', 'ايها', 'الناس'], 2)).toEqual([['يا', 'ايها'], ['الناس']])
    expect(groupTokens(['من', 'بعد', 'ما', 'جاء'], 3)).toEqual([['من'], ['بعد', 'ما'], ['جاء']])
    expect(groupTokens(['a', 'b', 'c', 'd'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(groupTokens(['a'], 0)).toEqual([])
  })

  it('builds snippets: a window around the first match, marks on whole words, escaped', () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`)
    words[20] = 'target,'
    const s = buildSnippet(words.join(' '), (t) => t === 'target')
    expect(s.startsWith('… w8 ')).toBe(true)
    expect(s).toContain('<mark>target</mark>,')
    expect(s.endsWith('w32 …')).toBe(true)
    expect(buildSnippet('<b> & "q"', () => false)).toBe('&lt;b&gt; &amp; &quot;q&quot;')
  })

  it('reduces translation HTML and note Markdown to text', () => {
    expect(htmlText('In the name<sup class="fn" data-fn="1:1:1">1</sup> of &amp; <i>God</i>')).toBe(
      'In the name of & God',
    )
    expect(markdownText('## Title\n> quote\n- [x] done\n1. *one*, **two** and `three` [link](u)')).toBe(
      'Title quote done one, two and three link',
    )
  })
})
