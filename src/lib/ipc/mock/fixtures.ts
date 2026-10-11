/**
 * Fixture loader (§4.6, §5.17; WP0C, frozen). `cargo xtask export-fixtures` writes `./fixtures/**` (gitignored, never
 * committed, D10): every file is the serde JSON of the DTO the real command returns. Files are imported lazily, one chunk
 * each, and only in the browser mock (`__MOCK_IPC__`), so none can reach `dist/`. Whatever is missing falls back to the
 * synthetic generator, so the mock works on a fresh clone.
 */
import type {
  AyahText,
  MushafLayout,
  MushafStyle,
  PackInfo,
  PageData,
  QuranIndex,
  SearchRequest,
  SurahTimings,
} from '../bindings'
import {
  AYAH_COUNT,
  layoutOf,
  pageOfAyah,
  syntheticAyahs,
  syntheticIndex,
  syntheticPacks,
  syntheticPage,
  syntheticTimings,
} from './synthetic'

/** `fixtures/manifest.json` (§4.6). */
export interface FixtureManifest {
  builtAt: string
  source: string
  pages?: number[]
  ayahWindows?: [number, number][]
  packs?: string[]
  timings?: unknown[]
  /** The exported search answers: `search/<slug>.json` holds the result of `request` (WP1b's exporter). */
  queries?: { slug: string; request: SearchRequest }[]
}

type Loader = () => Promise<unknown>

/** `./fixtures/<rel>` → lazy JSON import. Empty when no fixtures were exported. */
const FILES: Record<string, Loader> = import.meta.glob('./fixtures/**/*.json', { import: 'default' })
const PREFIX = './fixtures/'

const cache = new Map<string, Promise<unknown>>()
let indexValue: QuranIndex | null = null
let packsValue: PackInfo[] | null = null
let ayahRows: Map<number, AyahText> | null = null

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

/** The paths (relative to `fixtures/`) of every exported fixture. */
function list(): string[] {
  return Object.keys(FILES).map((k) => k.slice(PREFIX.length))
}

function has(rel: string): boolean {
  return PREFIX + rel in FILES
}

/** The parsed JSON of `fixtures/<rel>`, or `undefined` when that fixture was not exported. Cached. */
async function json<T>(rel: string): Promise<T | undefined> {
  const load = FILES[PREFIX + rel]
  if (!load) return undefined
  let p = cache.get(rel)
  if (!p) {
    p = load()
    cache.set(rel, p)
  }
  return (await p) as T
}

/** The index: `fixtures/index.json` (real core.db ids) or the synthetic index. Memoised. */
async function index(): Promise<QuranIndex> {
  if (!indexValue) indexValue = (await json<QuranIndex>('index.json')) ?? syntheticIndex()
  return indexValue
}

/** The page: `fixtures/pages/{style}/p{NNN}.json`, else a synthetic page with the real numbering of the index. */
async function page(style: MushafStyle, n: number): Promise<PageData> {
  const fixture = await json<PageData>(`pages/${style}/p${pad3(n)}.json`)
  if (fixture) return fixture
  return syntheticPage(await index(), style, n)
}

/** Whether `page()` would serve a fixture (the mock marks the other pages as synthetic). */
function hasPage(style: MushafStyle, n: number): boolean {
  return has(`pages/${style}/p${pad3(n)}.json`)
}

/** Every exported ayah window (`ayahs/{from}-{to}.json`, layout v2), merged by id. */
async function fixtureAyahs(): Promise<Map<number, AyahText>> {
  if (ayahRows) return ayahRows
  const rows = new Map<number, AyahText>()
  for (const rel of list()) {
    if (!/^ayahs\/\d+-\d+\.json$/.test(rel)) continue
    for (const row of (await json<AyahText[]>(rel)) ?? []) rows.set(row.id, row)
  }
  ayahRows = rows
  return rows
}

/** `quran_get_ayahs`: fixture rows where exported (page recomputed for `layout`), synthetic rows elsewhere. */
async function ayahs(layout: MushafLayout, from: number, to: number): Promise<AyahText[]> {
  const idx = await index()
  const rows = await fixtureAyahs()
  const out: AyahText[] = []
  for (let a = from; a <= Math.min(to, AYAH_COUNT); a++) {
    const row = rows.get(a)
    if (row) out.push(layout === 'v2' ? row : { ...row, page: pageOfAyah(idx, layout, a) })
    else out.push(...syntheticAyahs(idx, layout, a, a))
  }
  return out
}

/** `audio_get_timings`: `timings/{reciterId}/{surah}.json`, else synthetic timings (§4.6). */
async function timings(reciterId: number, surah: number): Promise<SurahTimings> {
  const fixture = await json<SurahTimings>(`timings/${reciterId}/${surah}.json`)
  if (fixture) return { ...fixture, reciterId }
  return syntheticTimings(await index(), reciterId, surah)
}

/** The catalogue: `packs/list.json` (from catalog.json, every pack not installed) or the synthetic seed. */
async function packs(): Promise<PackInfo[]> {
  if (!packsValue) packsValue = (await json<PackInfo[]>('packs/list.json')) ?? syntheticPacks()
  return packsValue
}

export const fixtures = {
  /** Whether any fixture was exported. */
  get available(): boolean {
    return Object.keys(FILES).length > 0
  },
  list,
  has,
  json,
  index,
  page,
  hasPage,
  ayahs,
  timings,
  packs,
  async manifest(): Promise<FixtureManifest | null> {
    return (await json<FixtureManifest>('manifest.json')) ?? null
  },
  /** The index once `preload()` ran (synchronous access for slices and bootstrap). */
  cachedIndex(): QuranIndex | null {
    return indexValue
  },
  /** The catalogue once `preload()` ran. */
  cachedPacks(): PackInfo[] | null {
    return packsValue
  },
  /** Loads the small files every session needs (index, catalogue) before the first command. */
  async preload(): Promise<void> {
    await Promise.all([index(), packs()])
  },
  /** The layout of a style (re-exported for handlers). */
  layoutOf,
}
