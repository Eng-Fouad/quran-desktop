/**
 * Mock handlers: page fonts and decor (§5.17). Owner: WP8b.
 *
 * The browser mock behaves like `quran-packs` (§2.5.5, §5.4), with `data/dev-packs/` (served at `/__packs/*` by
 * `vite/dev-packs.ts`) standing in for the font CDN and a per-session "disk":
 * - style `hafs` → `ready`, family `qd-hafs`, no url, no IO;
 * - a QCF page whose font is in the dev packs **and** whose page data is a real fixture (a synthetic page's glyph codes
 *   would draw garbage in the real font):
 *   - already "downloaded" this session → `ready` after a disk-like 2–8 ms;
 *   - network allowed → "downloaded" after a simulated latency plus size at 2 MB/s, then `ready`;
 *   - network not allowed (Settings › Work offline) → `unavailable`;
 * - any other page → `unavailable` (no font to serve), which renders the Hafs fallback with the offline dot;
 * - `ready` answers carry `url = /__packs/mushaf/{v}/p{N}.woff2?v=<sha8>` and `rel = mushaf/{v}/p{N}.woff2`, exactly the
 *   shapes Rust returns (`fontBytes(rel)` reads the same file in mock mode).
 *
 * Debug switches in the page URL (local development and QA only):
 * - `?mockFontLatency=<ms>`: the simulated download latency (default 150 ms, a little over the 120 ms the reader waits
 *   before it paints the fallback, so the D13 cross-fade is visible on a first visit; 0 makes every page instant);
 * - `?mockFontFail=262,263`: those pages fail (`failed`) on their first request, so Retry can be exercised.
 *
 * A page font downloaded on demand is recorded as a cached (unpinned) item of its `mushaf.v{1|2|4}` pack, as the real
 * page-font lane records it, so Downloads counts the pages read (`recordCachedItem`, WP12a).
 *
 * `decor_ensure` installs the three decor fonts when they are in the dev packs and the network is allowed (or they are
 * already installed), and persists the `DecorStatus` in the `fonts` slice so the next bootstrap reports it.
 */
import type { DecorStatus, FetchPriority, MushafStyle, PageFontStatus } from '../../bindings'
import { fixtures } from '../fixtures'
import { assertRange, delay, type Handlers, handle, jitter, MockError } from '../result'
import { state } from '../state'
import { recordCachedItem } from './packs'

/** Where the dev-packs plugin serves the files (§5.17). */
export const PACKS_BASE = '/__packs/'
/** `mushaf_ensure_page_fonts` accepts at most this many pages (§5.13). */
export const MAX_PAGES = 12
const DEFAULT_LATENCY_MS = 150
/** Simulated download throughput (the packs mock uses the same 2 MB/s, §5.17). */
const BYTES_PER_MS = 2_000

const STYLES: readonly MushafStyle[] = ['hafs', 'qcf_v2', 'qcf_v1', 'qcf_v4']
const VARIANT: Readonly<Record<Exclude<MushafStyle, 'hafs'>, 'v1' | 'v2' | 'v4'>> = {
  qcf_v1: 'v1',
  qcf_v2: 'v2',
  qcf_v4: 'v4',
}

const DECOR = {
  surahHeaderUrl: 'qcf-surah-header.woff2',
  quranCommonUrl: 'quran-common.ttf',
  suraNamesUrl: 'sura-names.woff2',
} as const satisfies Partial<Record<keyof DecorStatus, string>>

const NOT_INSTALLED: DecorStatus = {
  installed: false,
  surahHeaderUrl: null,
  quranCommonUrl: null,
  suraNamesUrl: null,
}

interface DevPackFile {
  bytes: number
  sha8: string
}

/** `GET /__packs/index.json` (see `vite/dev-packs.ts`). */
export interface DevPackIndex {
  mushaf: Record<'v1' | 'v2' | 'v4', Record<string, DevPackFile>>
  decor: Record<string, DevPackFile>
}

const EMPTY_INDEX: DevPackIndex = { mushaf: { v1: {}, v2: {}, v4: {} }, decor: {} }

function isFile(v: unknown): v is DevPackFile {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Record<string, unknown>
  return typeof f.bytes === 'number' && typeof f.sha8 === 'string' && /^[0-9a-f]{8}$/.test(f.sha8)
}

function files(v: unknown): Record<string, DevPackFile> {
  const out: Record<string, DevPackFile> = {}
  if (typeof v !== 'object' || v === null) return out
  for (const [k, f] of Object.entries(v)) if (isFile(f)) out[k] = f
  return out
}

/** Validates the plugin's index (anything malformed counts as "no dev packs"). */
export function parseIndex(raw: unknown): DevPackIndex {
  if (typeof raw !== 'object' || raw === null) return EMPTY_INDEX
  const r = raw as { mushaf?: Record<string, unknown>; decor?: unknown }
  return {
    mushaf: { v1: files(r.mushaf?.v1), v2: files(r.mushaf?.v2), v4: files(r.mushaf?.v4) },
    decor: files(r.decor),
  }
}

let indexRequest: Promise<DevPackIndex> | null = null

/** The dev-packs index, fetched once per session; no plugin (vitest, a fresh clone) means an empty index. */
function devPacks(): Promise<DevPackIndex> {
  indexRequest ??= (async () => {
    try {
      const res = await fetch(`${PACKS_BASE}index.json`, { cache: 'no-store' })
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return EMPTY_INDEX
      return parseIndex(await res.json())
    } catch {
      return EMPTY_INDEX
    }
  })()
  return indexRequest
}

/** The session's simulated disk: `v2:262`, … */
const disk = new Set<string>()
/** Downloads in flight, shared by concurrent requests (Rust dedupes them too). */
const downloads = new Map<string, Promise<void>>()
/** `?mockFontFail` pages that already failed once. */
const failedOnce = new Set<string>()

function params(): URLSearchParams {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '')
  } catch {
    return new URLSearchParams()
  }
}

function latencyMs(): number {
  const raw = params().get('mockFontLatency')
  const n = raw === null ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 30_000) : DEFAULT_LATENCY_MS
}

function failingPages(): Set<number> {
  const raw = params().get('mockFontFail') ?? ''
  return new Set(
    raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 604),
  )
}

function networkAllowed(): boolean {
  return state.settings.value.networkAllowed && (globalThis.navigator?.onLine ?? true)
}

function familyOf(style: MushafStyle, page: number): string {
  return style === 'hafs' ? 'qd-hafs' : `qcf-${VARIANT[style]}-p${page}`
}

function status(
  style: MushafStyle,
  page: number,
  availability: PageFontStatus['availability'],
): PageFontStatus {
  return { style, page, availability, family: familyOf(style, page), url: null, rel: null, bytes: 0 }
}

async function download(key: string, bytes: number, priority: FetchPriority): Promise<void> {
  let job = downloads.get(key)
  if (!job) {
    // The background lane is slower than the interactive one.
    const scale = priority === 'prefetch' ? 2 : 1
    job = delay((latencyMs() + bytes / BYTES_PER_MS) * scale).then(() => {
      disk.add(key)
      downloads.delete(key)
    })
    downloads.set(key, job)
  }
  await job
}

async function pageFont(
  index: DevPackIndex,
  style: Exclude<MushafStyle, 'hafs'>,
  page: number,
  priority: FetchPriority,
): Promise<PageFontStatus> {
  const variant = VARIANT[style]
  const file = index.mushaf[variant][String(page)]
  if (!file || !fixtures.hasPage(style, page)) return status(style, page, 'unavailable')
  const key = `${variant}:${page}`
  if (failingPages().has(page) && !failedOnce.has(key)) {
    failedOnce.add(key)
    await delay(latencyMs())
    return status(style, page, 'failed')
  }
  if (!disk.has(key)) {
    if (!networkAllowed()) return status(style, page, 'unavailable')
    await download(key, file.bytes, priority)
    recordCachedItem(`mushaf.${variant}`, page)
  } else {
    await jitter()
  }
  const rel = `mushaf/${variant}/p${page}.woff2`
  return {
    ...status(style, page, 'ready'),
    url: `${PACKS_BASE}${rel}?v=${file.sha8}`,
    rel,
    bytes: file.bytes,
  }
}

function decorStatus(index: DevPackIndex): DecorStatus | null {
  const out: DecorStatus = { ...NOT_INSTALLED, installed: true }
  for (const [key, name] of Object.entries(DECOR) as [keyof typeof DECOR, string][]) {
    const file = index.decor[name]
    if (!file) return null
    out[key] = `${PACKS_BASE}decor/${name}?v=${file.sha8}`
  }
  return out
}

/** Forgets the simulated disk and the cached index (tests). */
export function resetFontsMock(): void {
  disk.clear()
  downloads.clear()
  failedOnce.clear()
  indexRequest = null
}

export const fontsHandlers: Handlers<'mushafEnsurePageFonts' | 'decorEnsure'> = {
  mushafEnsurePageFonts: handle(async (style: MushafStyle, pages: number[], priority: FetchPriority) => {
    if (!STYLES.includes(style))
      throw new MockError('invalid_argument', `unknown mushaf style ${String(style)}`)
    if (priority !== 'interactive' && priority !== 'prefetch')
      throw new MockError('invalid_argument', `unknown priority ${String(priority)}`)
    if (pages.length === 0) throw new MockError('invalid_argument', 'no pages')
    if (pages.length > MAX_PAGES)
      throw new MockError('invalid_argument', `at most ${MAX_PAGES} pages, got ${pages.length}`)
    for (const page of pages) assertRange('page', page, 1, 604)
    // Hafs has no page fonts: ready without IO (§5.4).
    if (style === 'hafs') return pages.map((page) => status(style, page, 'ready'))
    const index = await devPacks()
    return Promise.all(pages.map((page) => pageFont(index, style, page, priority)))
  }),

  decorEnsure: handle(async (): Promise<DecorStatus> => {
    const current = state.fonts.value.decor
    const index = await devPacks()
    const available = decorStatus(index)
    if (!available) {
      // The files are gone (or were never fetched): nothing is installed, whatever an older session stored.
      if (current.installed) state.fonts.set({ decor: { ...NOT_INSTALLED } })
      return { ...NOT_INSTALLED }
    }
    if (!current.installed) {
      if (!networkAllowed()) return structuredClone(current)
      // The decor pack (≈ 0.3 MB) downloads once.
      const bytes = Object.values(DECOR).reduce((sum, name) => sum + (index.decor[name]?.bytes ?? 0), 0)
      await delay(latencyMs() + bytes / BYTES_PER_MS)
    }
    state.fonts.set({ decor: available })
    return structuredClone(available)
  }),
}
