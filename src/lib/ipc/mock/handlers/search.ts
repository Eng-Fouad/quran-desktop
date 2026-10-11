/**
 * Mock handlers: search, suggestions and search history (§5.17). Owner: WP10b.
 *
 * `search_query` behaves like `SearchEngine` (§2.2.5) with WP1b's refinements (docs/deviations/WP1b.md), over the data
 * the browser mock has:
 * - **Validation** first, like the command: `limit` 1..=2000, at most 2,000 characters and 200 tokens, `surah`
 *   1..=114, `juz` 1..=30, a blank translation pack id (`invalid_argument`). A query that folds to nothing is an empty
 *   result, never an error. Surah and juz filters are one ayah-id range each; both give their intersection (empty ⇒ no
 *   hits).
 * - **Fixture answers.** A request matching one of `fixtures/manifest.json`'s queries (§4.6: `الرحمن`, `العالمين`,
 *   `الصلاه`, `الرح`, `يا ايها`, `mercy`, `light`) answers with the real engine's `search/results/{slug}.json`, cut to
 *   the request's limit and re-paged for its layout.
 * - **Quran scope** otherwise searches `search/ayahs.json` (every ayah's `norm_loose`; synthetic text without fixtures):
 *   - `smart`: whole tokens, the last one a prefix (also inside an unterminated quote), quoted phrases adjacent;
 *     with no hits and every token at least 3 letters, typos are fixed against the Quran vocabulary (WP1b: only tokens
 *     that are not words, the nearest edit distance only, at most 8 terms by frequency) and `suggestions` names them;
 *   - `exact`: whole tokens, no prefix (the mock has no strict column, so hamza seats and teh marbuta fold like
 *     `smart`; the real engine compares the strict column);
 *   - `substring`: the folded needle anywhere in the ayah's loose text, across words.
 *   `words` come from the exported pages and ayah windows where they exist (real Hafs text), else from the loose text
 *   (`يا`/`ها` particles joined to the next word, as the Uthmani script writes them); `matchedWordIds` follow WP1b's
 *   rule (a word matches when one of its loose tokens matches a query token).
 * - **Translation scope** searches the text `translation_get` serves for the pack (fixtures or WP11a's synthetic
 *   text), so a pack that is not installed answers `not_found` like `PackManager::translation_db`; snippets are built
 *   from the text (±12 words around the first match, `<mark>` on whole words, `…` at the cuts, HTML-escaped).
 * - **Notes scope** searches the live notes of the `user` slice (read only) folded like `body_search`; a note is a hit
 *   at its first ayah inside the filter range; snippets come from the body with its Markdown reduced to text, or from
 *   the title when only the title matches.
 * - Groups are in Mushaf order; a group's `count` is every match in that surah within the filters, even when the hit
 *   list was cut at `limit` (`truncated`). `tookMs` is measured.
 *
 * `search_suggest` completes the last token of the folded prefix from the Quran vocabulary (term and ayah count, most
 * frequent first). The history commands follow `user_db/search_history.rs`: queries are stored trimmed with spaces
 * collapsed, re-adding bumps the entry, at most 200 entries are kept, most recently used first.
 */
import type {
  MushafLayout,
  Note,
  QuranIndex,
  SearchGroup,
  SearchHit,
  SearchMode,
  SearchRequest,
  SearchResults,
  SearchScope,
  SearchSuggestion,
} from '../../bindings'
import { foldLatin, normalizeAr } from '$lib/text/normalize'
import { fixtures } from '../fixtures'
import { assertRange, type Handlers, handle, jitter, MockError, nowSecs } from '../result'
import { state } from '../state'
import {
  AYAH_COUNT,
  arabicIndic,
  END_OF_AYAH,
  lastWordOf,
  pageOfAyah,
  PLACEHOLDER_WORD,
  refOf,
  syntheticAyahs,
} from '../synthetic'
import { contentHandlers } from './content'

/** `quran_core::search` limits (WP1b). */
export const MAX_LIMIT = 2000
export const MAX_QUERY_CHARS = 2000
export const MAX_QUERY_TOKENS = 200
export const MAX_SUGGEST_LIMIT = 100
/** Pack queries whose folded form is shorter than this run as `LIKE` (FTS5 needs three characters). */
export const MIN_FTS_QUERY_CHARS = 3
/** `user_db/search_history.rs`. */
export const HISTORY_MAX_ENTRIES = 200
export const HISTORY_QUERY_MAX_CHARS = 500
/** Typo fallback (§2.2.5 step 5): tokens shorter than this disable it; at most this many replacement terms. */
const TYPO_MIN_CHARS = 3
const TYPO_MAX_TERMS = 8
/** Snippet window: words on each side of the first match. */
const SNIPPET_RADIUS = 12
/** `translation_get` takes at most this many ayahs. */
const TRANSLATION_CHUNK = 300

// --- folding and tokens --------------------------------------------------------------------------------------------

/** Splits where FTS5's `unicode61` splits: every character that is not a letter, number, mark or private-use. */
const SEPARATORS = /[^\p{L}\p{N}\p{M}\p{Co}]+/u
const QUOTE = /["“”„«»]/u

export function tokenize(folded: string): string[] {
  return folded.split(SEPARATORS).filter((t) => t !== '')
}

type Fold = (text: string) => string

/** The Quran's loose column (the mock folds `exact` the same way, see above). */
const foldQuran: Fold = (text) => normalizeAr(text, 'loose')
/** Translations and notes: `fold_latin(normalize_ar(text, Loose))`, the `body_search` fold. */
const foldText: Fold = (text) => foldLatin(normalizeAr(text, 'loose'))

interface Term {
  tokens: string[]
  /** Adjacent tokens (a quoted phrase of two or more tokens). */
  phrase: boolean
  /** Its last token may be completed: a bare token, or the last token of an unterminated quote. */
  open: boolean
}

export interface ParsedQuery {
  terms: Term[]
  /** Smart mode: the last term's last token matches as a prefix. */
  prefix: boolean
  /** Every token, in order. */
  tokens: string[]
  /** Substring needle: the folded query without quote marks, tokens joined by one space. */
  needle: string
}

/** Phrase groups (`"…"`, also typographic quotes and guillemets) and bare words, before folding. */
function splitTerms(raw: string): { text: string; quoted: boolean; open: boolean }[] {
  const out: { text: string; quoted: boolean; open: boolean }[] = []
  let buffer = ''
  let quoted = false
  const flushBare = () => {
    for (const word of buffer.split(/\s+/u))
      if (word !== '') out.push({ text: word, quoted: false, open: true })
    buffer = ''
  }
  for (const ch of raw) {
    if (!QUOTE.test(ch)) {
      buffer += ch
    } else if (quoted) {
      out.push({ text: buffer, quoted: true, open: false })
      buffer = ''
      quoted = false
    } else {
      flushBare()
      quoted = true
    }
  }
  if (quoted) out.push({ text: buffer, quoted: true, open: true })
  else flushBare()
  return out
}

/** Parses and folds a query (§2.2.5 step 1); `null` when nothing is left to search. */
export function parseQuery(raw: string, fold: Fold, mode: SearchMode): ParsedQuery | null {
  const terms: Term[] = []
  for (const part of splitTerms(raw)) {
    const tokens = tokenize(fold(part.text))
    if (tokens.length === 0) continue
    if (part.quoted) terms.push({ tokens, phrase: tokens.length > 1, open: part.open })
    // A bare word can fold into several tokens (`الله♥رب`): each is a term of its own.
    else for (const t of tokens) terms.push({ tokens: [t], phrase: false, open: true })
  }
  const last = terms.at(-1)
  if (!last) return null
  const tokens = terms.flatMap((t) => t.tokens)
  if (tokens.length > MAX_QUERY_TOKENS) {
    throw new MockError('invalid_argument', `the query has more than ${MAX_QUERY_TOKENS} tokens`)
  }
  return { terms, prefix: mode === 'smart' && last.open, tokens, needle: tokens.join(' ') }
}

// --- matching --------------------------------------------------------------------------------------------------------

/** Alternatives of a mistyped token (the typo fallback): the token matches any of them, exactly. */
type Alternatives = ReadonlyMap<string, readonly string[]>

interface Matcher {
  /** Whether a document (its tokens) matches every term. */
  doc(tokens: readonly string[]): boolean
  /** Whether one token of a document is a query token (phrase tokens individually), for highlighting. */
  token(token: string): boolean
}

function makeMatcher(q: ParsedQuery, alternatives: Alternatives = new Map()): Matcher {
  const lastTerm = q.terms.length - 1
  const isPrefix = (termIndex: number, tokenIndex: number) =>
    q.prefix && termIndex === lastTerm && tokenIndex === (q.terms[termIndex]?.tokens.length ?? 0) - 1
  const eq = (doc: string, query: string, prefix: boolean) => {
    const alts = alternatives.get(query)
    if (alts) return alts.includes(doc)
    return prefix ? doc.startsWith(query) : doc === query
  }
  const prefixToken = q.prefix ? (q.terms[lastTerm]?.tokens.at(-1) ?? null) : null
  const exact = new Set(q.tokens)
  const altTokens = new Set([...alternatives.values()].flat())
  return {
    doc(tokens) {
      return q.terms.every((term, ti) => {
        if (!term.phrase) {
          const qt = term.tokens[0] ?? ''
          return tokens.some((t) => eq(t, qt, isPrefix(ti, 0)))
        }
        for (let start = 0; start + term.tokens.length <= tokens.length; start++) {
          if (term.tokens.every((qt, k) => eq(tokens[start + k] ?? '', qt, isPrefix(ti, k)))) return true
        }
        return false
      })
    },
    token(token) {
      if (altTokens.has(token)) return true
      if (exact.has(token) && !alternatives.has(token)) return true
      return prefixToken !== null && !alternatives.has(prefixToken) && token.startsWith(prefixToken)
    },
  }
}

/** Char-level Levenshtein distance with an upper bound: `null` once it must exceed `max` (§2.2.5). */
export function levenshteinBounded(a: string, b: string, max: number): number | null {
  const x = [...a]
  const y = [...b]
  if (Math.abs(x.length - y.length) > max) return null
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      const v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      row.push(v)
      best = Math.min(best, v)
    }
    if (best > max) return null
    prev = row
  }
  const d = prev[y.length] ?? max + 1
  return d <= max ? d : null
}

// --- the Quran corpus ------------------------------------------------------------------------------------------------

interface Corpus {
  /** Loose tokens per ayah (index = ayah id − 1). */
  tokens: string[][]
  /** Ayahs containing each term (the `vocab_loose` table), most frequent first, then by term. */
  vocab: SearchSuggestion[]
  vocabSet: ReadonlySet<string>
}

let corpusPromise: Promise<Corpus> | null = null

/** Every ayah's `norm_loose` (`search/ayahs.json`, else the synthetic text) and the vocabulary built from it. */
function corpus(): Promise<Corpus> {
  corpusPromise ??= (async () => {
    const index = await fixtures.index()
    const texts: string[] = Array.from({ length: AYAH_COUNT }, () => '')
    const rows = await fixtures.json<[number, string][]>('search/ayahs.json')
    if (rows) {
      for (const [id, text] of rows) if (id >= 1 && id <= AYAH_COUNT) texts[id - 1] = text
    } else {
      // `norm_loose` leaves the end marker out (it is a word of its own, last).
      for (const row of syntheticAyahs(index, 'v2', 1, AYAH_COUNT)) {
        texts[row.id - 1] = foldQuran(row.textHafs.split(' ').slice(0, -1).join(' '))
      }
    }
    const tokens = texts.map((t) => tokenize(t))
    const counts = new Map<string, number>()
    for (const ayah of tokens) for (const t of new Set(ayah)) counts.set(t, (counts.get(t) ?? 0) + 1)
    const vocab = [...counts]
      .map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    return { tokens, vocab, vocabSet: new Set(counts.keys()) }
  })()
  return corpusPromise
}

/** Particles the Uthmani script writes joined to the next word (`يا ايها` → `يَٰٓأَيُّهَا`, `ها انتم` → `هَٰٓأَنتُمۡ`). */
const JOINED_TO_NEXT = new Set(['يا', 'ويا', 'فيا', 'ها', 'وها', 'فها'])
/** Particles joined to the previous word (`بعد ما` → `بَعۡدَمَا`). */
const JOINED_TO_PREVIOUS = new Set(['ما'])

/**
 * Groups an ayah's loose tokens (Imlaei spelling) into its `words` Uthmani words: joined particles first, then an even
 * split when the counts still differ.
 */
export function groupTokens(tokens: readonly string[], words: number): string[][] {
  if (words <= 0) return []
  const groups = tokens.map((t) => [t])
  for (let i = 0; groups.length > words && i < groups.length - 1; i++) {
    const g = groups[i]
    const next = groups[i + 1]
    if (g && next && g.length === 1 && JOINED_TO_NEXT.has(g[0] ?? '')) groups.splice(i, 2, [...g, ...next])
  }
  for (let i = groups.length - 1; groups.length > words && i > 0; i--) {
    const g = groups[i]
    const before = groups[i - 1]
    if (g && before && g.length === 1 && JOINED_TO_PREVIOUS.has(g[0] ?? '')) {
      groups.splice(i - 1, 2, [...before, ...g])
    }
  }
  if (groups.length === words) return groups
  const even: string[][] = Array.from({ length: words }, () => [])
  tokens.forEach((t, i) => even[Math.min(words - 1, Math.floor((i * words) / tokens.length))]?.push(t))
  return even
}

/** Word texts (`text_hafs`, end marker last) from the exported Hafs pages, by word id. */
const pageWords = new Map<number, Promise<Map<number, string>>>()

function wordsOfPage(page: number): Promise<Map<number, string>> {
  let p = pageWords.get(page)
  if (!p) {
    p = fixtures.page('hafs', page).then((data) => {
      const out = new Map<number, string>()
      for (const line of data.lines) for (const w of line.words) out.set(w.id, w.text)
      return out
    })
    pageWords.set(page, p)
  }
  return p
}

/** The real words of an ayah from the fixtures (pages first, then the ayah windows), or `null`. */
async function fixtureWords(index: QuranIndex, ayahId: number, count: number): Promise<string[] | null> {
  const first = index.ayahFirstWord[ayahId - 1] ?? 0
  const last = lastWordOf(index, ayahId)
  const startPage = pageOfAyah(index, 'v2', ayahId)
  const fromPages = new Map<number, string>()
  for (const page of [startPage, startPage + 1]) {
    if (!fixtures.hasPage('hafs', page)) continue
    for (const [id, text] of await wordsOfPage(page)) if (id >= first && id <= last) fromPages.set(id, text)
  }
  if (fromPages.size === count) {
    return Array.from({ length: count }, (_, i) => fromPages.get(first + i) ?? '')
  }
  const [row] = await fixtures.ayahs('v2', ayahId, ayahId)
  if (!row || row.textHafs.includes(PLACEHOLDER_WORD)) return null
  // A word's own text can hold a space before ۩ (§3.1.1): a piece without letters belongs to the word before it.
  const pieces: string[] = []
  for (const piece of row.textHafs.split(' ')) {
    const prev = pieces.length - 1
    if (prev >= 0 && !/\p{L}/u.test(piece) && !piece.startsWith(END_OF_AYAH)) pieces[prev] += ` ${piece}`
    else if (piece !== '') pieces.push(piece)
  }
  return pieces.length === count ? pieces : null
}

interface AyahWords {
  /** `SearchHit.words`: one text per word, the end marker last. */
  texts: string[]
  /** Loose tokens of each word but the end marker. */
  groups: string[][]
}

async function ayahWords(index: QuranIndex, ayahId: number, tokens: readonly string[]): Promise<AyahWords> {
  const first = index.ayahFirstWord[ayahId - 1] ?? 0
  const count = lastWordOf(index, ayahId) - first + 1
  const groups = groupTokens(tokens, count - 1)
  const texts = await fixtureWords(index, ayahId, count)
  if (texts) return { texts, groups }
  const { ayah } = refOf(index, ayahId)
  return { texts: [...groups.map((g) => g.join(' ')), END_OF_AYAH + arabicIndic(ayah)], groups }
}

// --- results ---------------------------------------------------------------------------------------------------------

/** The ayah-id range of the filters, `null` when they do not intersect (§2.2.5 step 4). */
function filterRange(index: QuranIndex, surah: number | null, juz: number | null): [number, number] | null {
  let lo = 1
  let hi = AYAH_COUNT
  if (surah !== null) {
    const s = index.surahs[surah - 1]
    if (s) {
      lo = Math.max(lo, s.firstAyahId)
      hi = Math.min(hi, s.firstAyahId + s.ayahCount - 1)
    }
  }
  if (juz !== null) {
    const j = index.juz[juz - 1]
    if (j) {
      lo = Math.max(lo, j.firstAyahId)
      hi = Math.min(hi, j.lastAyahId)
    }
  }
  return lo <= hi ? [lo, hi] : null
}

function emptyResults(query: string, normalized: string, started: number): SearchResults {
  return {
    query,
    normalized,
    total: 0,
    truncated: false,
    tookMs: elapsed(started),
    groups: [],
    suggestions: [],
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

/**
 * Mushaf-order groups of the returned hits; each group's `count` is the number of matches in that surah within the
 * filters (`surahOf` maps every match, returned or not).
 */
function groupHits(hits: readonly SearchHit[], matches: readonly number[], surahOf: (id: number) => number) {
  const counts = new Map<number, number>()
  for (const id of matches) {
    const s = surahOf(id)
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  const groups: SearchGroup[] = []
  for (const hit of hits) {
    const g = groups.at(-1)
    if (g && g.surah === hit.surah) g.hits.push(hit)
    else groups.push({ surah: hit.surah, count: counts.get(hit.surah) ?? 1, hits: [hit] })
  }
  return groups
}

// --- fixture answers ---------------------------------------------------------------------------------------------------

interface FixtureQuery {
  slug: string
  request: SearchRequest
}

function isFixtureQuery(v: unknown): v is FixtureQuery {
  if (typeof v !== 'object' || v === null) return false
  const q = v as Record<string, unknown>
  const r = q.request as Record<string, unknown> | undefined
  return typeof q.slug === 'string' && typeof r === 'object' && r !== null && typeof r.query === 'string'
}

/**
 * The manifest's query list (§4.6; `FixtureManifest.queries`, `{ slug, request }` objects written by WP1b's exporter).
 * Entries are still checked at runtime: the file is generated outside this build and may come from an older exporter.
 */
async function fixtureQueries(): Promise<FixtureQuery[]> {
  const manifest = await fixtures.manifest()
  const queries: unknown = manifest?.queries
  return Array.isArray(queries) ? queries.filter(isFixtureQuery) : []
}

const sameScope = (a: SearchScope, b: SearchScope) => JSON.stringify(a) === JSON.stringify(b)

/** The real engine's answer for this request when the fixtures hold one that covers it. */
async function fixtureAnswer(req: SearchRequest, index: QuranIndex): Promise<SearchResults | null> {
  const query = req.query.trim()
  for (const fq of await fixtureQueries()) {
    const r = fq.request
    if (r.query.trim() !== query || r.mode !== req.mode || !sameScope(r.scope, req.scope)) continue
    if (r.surah !== req.surah || r.juz !== req.juz) continue
    const fixture = await fixtures.json<SearchResults>(`search/results/${fq.slug}.json`)
    if (!fixture) continue
    const returned = fixture.groups.reduce((n, g) => n + g.hits.length, 0)
    // A cut fixture cannot answer a larger limit.
    if (fixture.truncated && req.limit > returned) return null
    let left = req.limit
    const groups: SearchGroup[] = []
    for (const g of fixture.groups) {
      if (left <= 0) break
      const hits = g.hits.slice(0, left).map((h) => ({
        ...h,
        page: req.layout === 'v2' ? h.page : pageOfAyah(index, req.layout, h.ayahId),
      }))
      left -= hits.length
      groups.push({ ...g, hits })
    }
    return { ...fixture, truncated: fixture.total > req.limit, groups }
  }
  return null
}

// --- Quran scope ---------------------------------------------------------------------------------------------------------

async function searchQuran(req: SearchRequest, index: QuranIndex, started: number): Promise<SearchResults> {
  const query = req.query
  const q = parseQuery(query, foldQuran, req.mode)
  if (!q) return emptyResults(query, '', started)
  const range = filterRange(index, req.surah, req.juz)
  if (!range) return emptyResults(query, q.needle, started)
  const fixture = await fixtureAnswer(req, index)
  if (fixture) return { ...fixture, tookMs: elapsed(started) }

  const { tokens: docs, vocab, vocabSet } = await corpus()
  const [lo, hi] = range
  const find = (matcher: Matcher): number[] => {
    const out: number[] = []
    for (let id = lo; id <= hi; id++) {
      const doc = docs[id - 1] ?? []
      if (req.mode === 'substring' ? doc.join(' ').includes(q.needle) : matcher.doc(doc)) out.push(id)
    }
    return out
  }

  let matcher = makeMatcher(q)
  let matches = find(matcher)
  let suggestions: string[] = []
  if (
    matches.length === 0 &&
    req.mode === 'smart' &&
    q.tokens.every((t) => [...t].length >= TYPO_MIN_CHARS)
  ) {
    const alternatives = typoAlternatives(q, vocab, vocabSet)
    if (alternatives.size > 0) {
      matcher = makeMatcher(q, alternatives)
      matches = find(matcher)
      if (matches.length > 0) suggestions = [...alternatives.values()].flat()
    }
  }

  const ids = matches.slice(0, req.limit)
  const hits: SearchHit[] = []
  for (const id of ids) {
    const words = await ayahWords(index, id, docs[id - 1] ?? [])
    const matched =
      req.mode === 'substring'
        ? substringWords(words.groups, q.needle)
        : words.groups.flatMap((g, i) => (g.some((t) => matcher.token(t)) ? [i] : []))
    const first = index.ayahFirstWord[id - 1] ?? 0
    const { surah, ayah } = refOf(index, id)
    hits.push({
      ayahId: id,
      surah,
      ayah,
      page: pageOfAyah(index, req.layout, id),
      firstWordId: first,
      words: words.texts,
      matchedWordIds: matched.map((i) => first + i),
      snippet: null,
      noteId: null,
    })
  }
  return {
    query,
    normalized: q.needle,
    total: matches.length,
    truncated: matches.length > req.limit,
    tookMs: elapsed(started),
    groups: groupHits(hits, matches, (id) => refOf(index, id).surah),
    suggestions,
  }
}

/**
 * Typo fallback (§2.2.5 step 5, WP1b): every bare token that is not a Quran word (the completed last token: not the
 * start of one) gets the vocabulary terms of its nearest edit distance (≤ 1, or ≤ 2 from 6 letters), at most 8, most
 * frequent first. Empty when nothing needs fixing or a token has no candidate.
 */
function typoAlternatives(
  q: ParsedQuery,
  vocab: readonly SearchSuggestion[],
  vocabSet: ReadonlySet<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const last = q.terms.length - 1
  for (const [ti, term] of q.terms.entries()) {
    if (term.phrase) continue
    const token = term.tokens[0] ?? ''
    const known = q.prefix && ti === last ? vocab.some((v) => v.term.startsWith(token)) : vocabSet.has(token)
    if (known || out.has(token)) continue
    const max = [...token].length >= 6 ? 2 : 1
    let best = max + 1
    let found: SearchSuggestion[] = []
    for (const v of vocab) {
      const d = levenshteinBounded(token, v.term, Math.min(max, best))
      if (d === null || d > best) continue
      if (d < best) {
        best = d
        found = []
      }
      found.push(v)
    }
    if (found.length === 0) return new Map()
    out.set(
      token,
      found.slice(0, TYPO_MAX_TERMS).map((v) => v.term),
    )
  }
  return out
}

/** Words overlapping an occurrence of the needle in the ayah's joined loose text (WP1b item 10). */
function substringWords(groups: readonly string[][], needle: string): number[] {
  const spans: [number, number][] = []
  let at = 0
  for (const g of groups) {
    const text = g.join(' ')
    spans.push([at, at + text.length])
    at += text.length + 1
  }
  const joined = groups.map((g) => g.join(' ')).join(' ')
  const hit = new Set<number>()
  for (let i = joined.indexOf(needle); i >= 0; i = joined.indexOf(needle, i + 1)) {
    const end = i + needle.length
    spans.forEach(([a, b], w) => {
      if (a < end && b > i) hit.add(w)
    })
  }
  return [...hit].sort((a, b) => a - b)
}

// --- snippets (translation and notes) --------------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** Text of an HTML fragment (translation text): footnote markers dropped, entities decoded, spaces collapsed. */
export function htmlText(html: string): string {
  return html
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/giu, '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** A note body's Markdown subset reduced to text (headings, quotes, lists, task boxes, emphasis, links). */
export function markdownText(md: string): string {
  return md
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s{0,3}>\s?/gmu, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gmu, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gmu, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/(\*\*|__|~~|`)/gu, '')
    .replace(/(^|[\s([{"'“‘«])[*_]+(?=\S)/gu, '$1')
    .replace(/(\S)[*_]+(?=[\s.,;:!?)\]}"'”’»،؛؟]|$)/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Snippet HTML (§2.2.5 step 7): ±12 words around the first matching word, the matching part of each word in
 * `<mark>` (never its punctuation), `…` at the cuts, everything escaped. The start of the text when nothing matches.
 */
export function buildSnippet(text: string, wordMatches: (folded: string) => boolean): string {
  const words = text.split(/\s+/u).filter((w) => w !== '')
  const marks = words.map((w) => tokenize(foldText(w)).some(wordMatches))
  const first = Math.max(0, marks.indexOf(true))
  const start = Math.max(0, first - SNIPPET_RADIUS)
  const end = Math.min(words.length, first + SNIPPET_RADIUS + 1)
  const body = words.slice(start, end).map((w, i) => {
    if (!marks[start + i]) return escapeHtml(w)
    const m = /^(\P{L}*)(.*?)(\P{L}*)$/u.exec(w)
    const [lead, core, trail] = [m?.[1] ?? '', m?.[2] ?? w, m?.[3] ?? '']
    return `${escapeHtml(lead)}<mark>${escapeHtml(core)}</mark>${escapeHtml(trail)}`
  })
  return `${start > 0 ? '… ' : ''}${body.join(' ')}${end < words.length ? ' …' : ''}`
}

interface TextDoc {
  ayahId: number
  text: string
  tokens: string[]
  noteId: string | null
  /** Notes: the title and the body text, snippeted separately. */
  note?: { title: string; body: string }
}

/** Matches text documents (translation rows or notes) and builds their hits. */
function searchTexts(
  req: SearchRequest,
  index: QuranIndex,
  docs: readonly TextDoc[],
  started: number,
  snippetText: (doc: TextDoc, matches: (token: string) => boolean) => string,
): SearchResults {
  const query = req.query
  const q = parseQuery(query, foldText, req.mode)
  if (!q) return emptyResults(query, '', started)
  // Packs answer queries under three characters (and substring mode) with LIKE, across words.
  const like = req.mode === 'substring' || [...q.needle].length < MIN_FTS_QUERY_CHARS
  const matcher = makeMatcher(q)
  const found = docs.filter((d) => (like ? d.tokens.join(' ').includes(q.needle) : matcher.doc(d.tokens)))
  const wordMatches = like
    ? (token: string) => q.tokens.some((t) => token.includes(t))
    : (token: string) => matcher.token(token)
  const hits = found.slice(0, req.limit).map((d): SearchHit => {
    const { surah, ayah } = refOf(index, d.ayahId)
    return {
      ayahId: d.ayahId,
      surah,
      ayah,
      page: pageOfAyah(index, req.layout, d.ayahId),
      firstWordId: index.ayahFirstWord[d.ayahId - 1] ?? 0,
      words: [],
      matchedWordIds: [],
      snippet: snippetText(d, wordMatches),
      noteId: d.noteId,
    }
  })
  return {
    query,
    normalized: q.needle,
    total: found.length,
    truncated: found.length > req.limit,
    tookMs: elapsed(started),
    groups: groupHits(
      hits,
      found.map((d) => d.ayahId),
      (id) => refOf(index, id).surah,
    ),
    suggestions: [],
  }
}

// --- translation scope ---------------------------------------------------------------------------------------------------

const translationTexts = new Map<string, Promise<string[]>>()

/** Fails like `translation_get` (`not_found`, …) when the pack cannot be read; checked on every search. */
async function assertPackReadable(packId: string): Promise<void> {
  const probe = await contentHandlers.translationGet([packId], 1, 1)
  if (probe.status === 'error') throw new MockError(probe.error.kind, probe.error.message)
}

/** The plain text of every ayah of a pack, as `translation_get` serves it. */
function packTexts(packId: string): Promise<string[]> {
  let p = translationTexts.get(packId)
  if (!p) {
    p = (async () => {
      const chunks: Promise<string[]>[] = []
      for (let from = 1; from <= AYAH_COUNT; from += TRANSLATION_CHUNK) {
        const to = Math.min(AYAH_COUNT, from + TRANSLATION_CHUNK - 1)
        chunks.push(
          contentHandlers.translationGet([packId], from, to).then((r) => {
            if (r.status === 'error') throw new MockError(r.error.kind, r.error.message)
            return r.data.map((row) => htmlText(row.items[0]?.html ?? ''))
          }),
        )
      }
      return (await Promise.all(chunks)).flat()
    })()
    p.catch(() => translationTexts.delete(packId))
    translationTexts.set(packId, p)
  }
  return p
}

async function searchTranslation(
  req: SearchRequest,
  packId: string,
  index: QuranIndex,
  started: number,
): Promise<SearchResults> {
  await assertPackReadable(packId)
  if (!parseQuery(req.query, foldText, req.mode)) return emptyResults(req.query, '', started)
  const range = filterRange(index, req.surah, req.juz)
  if (!range) return emptyResults(req.query, foldText(req.query), started)
  const fixture = await fixtureAnswer(req, index)
  if (fixture) return { ...fixture, tookMs: elapsed(started) }
  const texts = await packTexts(packId)
  const docs: TextDoc[] = []
  for (let id = range[0]; id <= range[1]; id++) {
    const text = texts[id - 1] ?? ''
    docs.push({ ayahId: id, text, tokens: tokenize(foldText(text)), noteId: null })
  }
  return searchTexts(req, index, docs, started, (d, matches) => buildSnippet(d.text, matches))
}

// --- notes scope ---------------------------------------------------------------------------------------------------------

function searchNotes(req: SearchRequest, index: QuranIndex, started: number): SearchResults {
  if (!parseQuery(req.query, foldText, req.mode)) return emptyResults(req.query, '', started)
  const range = filterRange(index, req.surah, req.juz)
  if (!range) return emptyResults(req.query, foldText(req.query), started)
  const [lo, hi] = range
  const notes: Note[] = state.user.value.notes
    .filter((n) => n.fromAyahId <= hi && n.toAyahId >= lo)
    .sort((a, b) => a.fromAyahId - b.fromAyahId || a.toAyahId - b.toAyahId || a.createdAt - b.createdAt)
  const docs = notes.map((n): TextDoc => {
    const title = n.title?.trim() ?? ''
    const body = markdownText(n.body)
    const text = `${title} ${body}`.trim()
    return {
      ayahId: Math.max(n.fromAyahId, lo),
      text,
      tokens: tokenize(foldText(text)),
      noteId: n.id,
      note: { title, body },
    }
  })
  return searchTexts(req, index, docs, started, (d, matches) => {
    const { title, body } = d.note ?? { title: '', body: d.text }
    const inBody = tokenize(foldText(body)).some(matches)
    return buildSnippet(inBody || title === '' ? body : title, matches)
  })
}

// --- history -----------------------------------------------------------------------------------------------------------

function cleanQuery(query: string): string {
  return query
    .split(/\s+/u)
    .filter((w) => w !== '')
    .join(' ')
}

// --- handlers ----------------------------------------------------------------------------------------------------------

export const searchHandlers: Handlers<
  'searchQuery' | 'searchSuggest' | 'searchHistoryAdd' | 'searchHistoryList' | 'searchHistoryClear'
> = {
  searchQuery: handle(async (request: SearchRequest): Promise<SearchResults> => {
    const started = performance.now()
    assertRange('limit', request.limit, 1, MAX_LIMIT)
    if ([...request.query].length > MAX_QUERY_CHARS) {
      throw new MockError('invalid_argument', `the query is longer than ${MAX_QUERY_CHARS} characters`)
    }
    if (request.surah !== null) assertRange('surah', request.surah, 1, 114)
    if (request.juz !== null) assertRange('juz', request.juz, 1, 30)
    await jitter()
    const index = await fixtures.index()
    const layout: MushafLayout = request.layout
    const req = { ...request, layout }
    switch (req.scope.type) {
      case 'quran':
        return searchQuran(req, index, started)
      case 'translation': {
        const packId = req.scope.data.packId.trim()
        if (packId === '') throw new MockError('invalid_argument', 'translation scope without a pack id')
        return searchTranslation(
          { ...req, scope: { type: 'translation', data: { packId } } },
          packId,
          index,
          started,
        )
      }
      case 'notes':
        return searchNotes(req, index, started)
    }
  }),

  searchSuggest: handle(async (prefix: string, limit: number): Promise<SearchSuggestion[]> => {
    assertRange('limit', limit, 1, MAX_SUGGEST_LIMIT)
    // Nothing is being typed after whitespace, punctuation or a quote mark.
    if (prefix.trim() === '' || /[\s\p{P}\p{S}]$/u.test(prefix)) return []
    const last = tokenize(foldQuran(prefix)).at(-1)
    if (last === undefined) return []
    const { vocab } = await corpus()
    const out: SearchSuggestion[] = []
    for (const v of vocab) {
      if (!v.term.startsWith(last)) continue
      out.push({ ...v })
      if (out.length >= limit) break
    }
    return out
  }),

  searchHistoryAdd: handle((query: string, scope: SearchScope) => {
    const q = cleanQuery(query)
    if (q === '') throw new MockError('invalid_argument', 'search query is empty')
    if ([...q].length > HISTORY_QUERY_MAX_CHARS) {
      throw new MockError(
        'invalid_argument',
        `search query is longer than ${HISTORY_QUERY_MAX_CHARS} characters`,
      )
    }
    if (scope.type === 'translation' && scope.data.packId.trim() === '') {
      throw new MockError('invalid_argument', 'translation scope without a pack id')
    }
    state.search.update((s) => {
      const i = s.history.findIndex((h) => h.query === q && sameScope(h.scope, scope))
      const existing = i >= 0 ? s.history.splice(i, 1)[0] : undefined
      // The array's order breaks ties within a second: the latest use is last.
      s.history.push({
        query: q,
        scope: structuredClone(scope),
        lastUsedAt: nowSecs(),
        useCount: (existing?.useCount ?? 0) + 1,
      })
      if (s.history.length > HISTORY_MAX_ENTRIES) s.history.splice(0, s.history.length - HISTORY_MAX_ENTRIES)
    })
    return null
  }),

  searchHistoryList: handle((limit: number) => {
    const n = Math.max(0, Math.min(limit, HISTORY_MAX_ENTRIES))
    return structuredClone(
      state.search.value.history
        .map((h, i) => ({ h, i }))
        .sort((a, b) => b.h.lastUsedAt - a.h.lastUsedAt || b.i - a.i)
        .slice(0, n)
        .map(({ h }) => h),
    )
  }),

  searchHistoryClear: handle(() => {
    state.search.update((s) => {
      s.history = []
    })
    return null
  }),
}

/** Test controls: forget the cached corpus, page words and pack texts (a new page session). */
export const searchMock = {
  reset(): void {
    corpusPromise = null
    pageWords.clear()
    translationTexts.clear()
  },
}
