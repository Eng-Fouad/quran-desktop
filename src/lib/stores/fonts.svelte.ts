/**
 * `fonts` store: page-font availability, FontFace loading by URL or by bytes, the LRU of loaded faces, prefetch,
 * decor, the shared V4 palette rule and the COLR support probe. Layer L1 (imports the L0 stores `app`, `settings`,
 * `i18n` and `ui`).
 *
 * - `status` maps a CSS family (`qcf-v2-p262`, `qd-surah-header`, …) to `loading`, `ready` (the face is loaded and usable
 *   now), `failed` (download, integrity or decode failure; `retry` asks again) or `unavailable` (offline or network not
 *   allowed, and not on disk). A family missing from the map was never asked for (or was evicted). Style `hafs` is
 *   always ready: the bundled `qd-hafs` face is loaded before the app mounts.
 * - `printLabelsReady`: the bundled print-labels face (`qd-print-labels`, the 1441H print's running heads and margin
 *   labels) is loaded. `main.ts` loads it before the app mounts, and `init` reads the outcome from
 *   `document.fonts`, so it never changes after the first paint (CLS 0); false, the furniture keeps its Hafs text.
 *   `settleBundledFaces` loads and reads it again once every store is initialised: WebKit drops a loaded CSS face back
 *   to "unloaded" when the root's `lang` or `dir` changes, as settings' `init` does for the Arabic UI.
 * - `ensure(style, pages, priority)` resolves once every page is final. Requests are batched (≤ 12 pages, the command's
 *   limit) and deduplicated per family; an interactive request overtakes a prefetch already in flight. `Ready` pages
 *   are loaded into `document.fonts` (`fontRegistry`), prefetched ones too (a local file load is cheap).
 * - LRU: at most 24 faces per style; the least recently displayed faces that are not within ±2 pages of a displayed
 *   page (`track`) are unloaded, and their status is forgotten. A style the reader has left (the `mushafStyle` setting
 *   moved away from it) keeps no faces: each one is unloaded as soon as no rendition draws it (a style change
 *   cross-fades, so the old style's page stays drawn until the new one is in), and a late answer for it is not loaded
 *   at all; returning to a style loads its faces again on demand.
 * - V4: every loaded V4 family is named in the `@font-palette-values --qd-v4` rule, regenerated whenever the family set,
 *   the resolved theme, `tajweedColors`, `inkBrightnessPct` or the contrast preference changes. The rule carries
 *   no `override-colors` (two or more entries crash Chromium's renderer later): the theme ink is an SVG colour map on
 *   the V4 lines (palettes.ts). The first V4 page shown runs the COLR probe (`probeV4`); `false` switches the style to
 *   QCF V2 with a one-time toast, and the result is cached per webview version.
 * - Decor (`qd-surah-header`, `qd-quran-common`, `qd-sura-names`) loads when `DecorStatus.installed`, whatever the
 *   `ornateHeaders` setting says (the setting gates the fetching and the page's drawing, not the loading: the
 *   onboarding's preview shows the ornaments before the choice is saved). While `ornateHeaders` is on, a QCF style asks for decor once per session while online (it ships
 *   with the Mushaf packs); `hafs` never does by itself (no silent network use), but turning
 *   `ornateHeaders` on asks for it in any style (an explicit choice). Off, nothing asks.
 * - Connectivity and packs: when the app comes online, `unavailable` fonts are forgotten and the displayed pages are
 *   ensured again; `PacksChanged` for `mushaf.v*` does the same for that style. For `decor` it loads the pack when the
 *   packs list shows it installed and unloads it otherwise, never fetching: removing it in Downloads is the user's
 *   choice, whatever `ornateHeaders` says.
 * - `faceEpoch` is bumped whenever a face joins or leaves `document.fonts`: the shaping warm-up warms the neighbours
 *   again after such a change (warmup.ts: Chromium drops the words it shaped before it, not the glyph metrics).
 */
import { untrack } from 'svelte'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { Store } from '$lib/contracts/stores'
import { api, call, events, fontBytes, toIpcError } from '$lib/ipc'
import type {
  Bootstrap,
  DecorStatus,
  FetchPriority,
  MushafStyle,
  PageData,
  PageFontStatus,
} from '$lib/ipc/bindings'
import { firstEndGlyph, probeColr, readCachedSupport, writeCachedSupport } from '$lib/mushaf/colrProbe'
import {
  clearFaces,
  deleteFace,
  evictFaces,
  FACES_PER_STYLE,
  type FaceSource,
  faceGroup,
  hasFace,
  loadFace,
  onFaceSetChange,
  touchFace,
} from '$lib/mushaf/fontRegistry'
import { PAGE_COUNT } from '$lib/mushaf/geometry'
import { PRINT_LABELS_FAMILY } from '$lib/mushaf/printLabels'
import {
  inkFilterValues,
  paletteCss,
  parseCssColor,
  planPalette,
  readInkColor,
  readPageColor,
  removePaletteStyle,
  writeInkFilter,
  writePaletteStyle,
} from '$lib/mushaf/palettes'
import { app, listenEvent } from './app.svelte'
import { i18n } from './i18n.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

export type FontState = 'loading' | 'ready' | 'failed' | 'unavailable'

/** The bundled Unicode Quran face (the hafs style and every fallback rendition). */
export const HAFS_FAMILY = 'qd-hafs'
/** Pages per `mushaf_ensure_page_fonts` call. */
export const ENSURE_BATCH = 12
/** Prefetch windows: P−2..P+2 for a single page, P−4..P+5 for a spread, and ±8 in the flip direction. */
export const PREFETCH_SINGLE = { before: 2, after: 2 } as const
export const PREFETCH_SPREAD = { before: 4, after: 5 } as const
export const FLIP_PREFETCH = 8
/** Faces within this many pages of a displayed page are never evicted. */
export const KEEP_AROUND = 2

type QcfStyle = Exclude<MushafStyle, 'hafs'>

/** The style of an LRU group (`qcf-v2` → `qcf_v2`). */
const STYLE_OF_GROUP: Readonly<Record<string, QcfStyle>> = {
  'qcf-v1': 'qcf_v1',
  'qcf-v2': 'qcf_v2',
  'qcf-v4': 'qcf_v4',
}

/** The decor faces and where their URL and bytes-transport path come from. */
export const DECOR_FACES = [
  { family: 'qd-surah-header', rel: 'decor/qcf-surah-header.woff2', key: 'surahHeaderUrl' },
  { family: 'qd-quran-common', rel: 'decor/quran-common.ttf', key: 'quranCommonUrl' },
  { family: 'qd-sura-names', rel: 'decor/sura-names.woff2', key: 'suraNamesUrl' },
] as const satisfies readonly { family: string; rel: string; key: keyof DecorStatus }[]

const NO_DECOR: DecorStatus = {
  installed: false,
  surahHeaderUrl: null,
  quranCommonUrl: null,
  suraNamesUrl: null,
}

const isPage = (p: number) => Number.isInteger(p) && p >= 1 && p <= PAGE_COUNT

/**
 * Loads the bundled faces and waits for them: the Hafs font, so the first paint never shows a system-font flash,
 * and the print's furniture labels, so the running heads and margin labels never change after it (CLS 0). A
 * face that fails is left out (`printLabelsLoaded` then reads false and the furniture keeps its Hafs text).
 */
export async function loadBundledFaces(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  const faces = [
    [HAFS_FAMILY, 'بسم'],
    [PRINT_LABELS_FAMILY, String.fromCodePoint(0xf800 + 1)],
  ] as const
  await Promise.all(
    faces.map(async ([family, text]) => {
      try {
        await document.fonts.load(`32px "${family}"`, text)
      } catch (e) {
        console.warn(`${family} did not load before the first paint`, e)
      }
    }),
  )
}

/**
 * Whether the bundled `qd-print-labels` face (`src/styles/fonts.css`) is loaded in this document: `main.ts` awaited it
 * before the app mounted. A face that failed (a missing file) stays out, and the furniture keeps its Hafs text.
 */
export function printLabelsLoaded(): boolean {
  if (typeof document === 'undefined' || !('fonts' in document)) return false
  try {
    for (const face of document.fonts)
      if (face.family.replace(/^["']|["']$/g, '') === PRINT_LABELS_FAMILY && face.status === 'loaded')
        return true
  } catch {
    // A FontFaceSet that cannot be iterated (a test double): no face to find.
  }
  return false
}

/** The CSS family of a page in a style: `qcf-v2-p262` (`qcf-v1-…`, `qcf-v4-…`), or `qd-hafs` for hafs. */
export function pageFamily(style: MushafStyle, page: number): string {
  return style === 'hafs' ? HAFS_FAMILY : `qcf-${style.slice(4)}-p${page}`
}

/** The style and page of a page-font family, or `null` for any other family. */
export function parseFamily(family: string): { style: QcfStyle; page: number } | null {
  const group = faceGroup(family)
  const style = group ? STYLE_OF_GROUP[group] : undefined
  const page = Number(/-p(\d+)$/.exec(family)?.[1])
  return style && isPage(page) ? { style, page } : null
}

/**
 * The prefetch set around `page`, nearest first, clamped to 1..604: P−2..P+2 (single page) or P−4..P+5 (spread),
 * extended by 8 pages in the flip direction (`dir`: +1 towards higher pages, −1 towards lower ones).
 */
export function aroundPages(page: number, spread: boolean, dir?: 1 | -1): number[] {
  const { before, after } = spread ? PREFETCH_SPREAD : PREFETCH_SINGLE
  const from = page - before - (dir === -1 ? FLIP_PREFETCH : 0)
  const to = page + after + (dir === 1 ? FLIP_PREFETCH : 0)
  const pages: number[] = []
  for (let p = from; p <= to; p++) if (isPage(p)) pages.push(p)
  return pages.sort((a, b) => Math.abs(a - page) - Math.abs(b - page) || a - b)
}

interface InFlight {
  promise: Promise<void>
  priority: FetchPriority
}

class FontsStore implements Store {
  status = new SvelteMap<string, FontState>()
  decor = $state.raw<DecorStatus>(NO_DECOR)
  /** COLR/CPAL support of the webview, cached per webview version; `null` until probed. */
  v4Supported = $state<boolean | null>(null)
  /** `prefers-contrast: more` (V4 tajweed uses the high-contrast overrides in any theme). */
  contrastMore = $state(false)
  /** The loaded V4 families: the palette rule names every one of them. */
  readonly v4Families = new SvelteSet<string>()

  readonly transport = $derived(app.info.fontTransport)
  /** The bundled print-labels face is loaded (`printLabelsLoaded`): the furniture draws the print's calligraphy. */
  printLabelsReady = $state(false)
  /** All three decor faces are loaded (the Mushaf page draws the QCF header and basmala with them). */
  readonly decorReady = $derived(DECOR_FACES.every(({ family }) => this.status.get(family) === 'ready'))

  /** Bumped (once per task) whenever a face joins `document.fonts`, finishes loading there, or leaves it. */
  faceEpoch = $state(0)
  #faceEpochQueued = false

  /** Bumped by `reset()`: results of requests started before it are dropped. */
  #epoch = 0
  #inflight = new Map<string, InFlight>()
  /** Per family: the serial of the latest request, so an older answer never overrides a newer one. */
  #serial = new Map<string, number>()
  /** Displayed page families (`track`), with a use count: the LRU keeps them and their ±2 neighbours. */
  #tracked = new Map<string, number>()
  /** The `mushafStyle` setting as `init`'s effect last saw it (`null` before `init`). */
  #shownStyle: MushafStyle | null = null
  /** QCF styles the reader has left: their faces stay loaded only while a rendition draws them (budget 0). */
  #left = new Set<QcfStyle>()
  /** An eviction is queued for the next microtask (`#queueEvict`). */
  #evictQueued = false
  #probe: Promise<boolean | null> | null = null
  /** A QCF style asked for decor this session (asked again after `PacksChanged` or coming online). */
  #decorAsked = false
  /** The `ornateHeaders` setting as the decor effect last saw it (`null` before `init`). */
  #ornateSeen: boolean | null = null
  /** `ornateHeaders` was turned on this session: decor is asked for in any style, hafs included. */
  #decorWanted = false
  /** A `url` face failed but loaded as bytes: the rest of the session loads every face as bytes (`#loadFrom`). */
  #bytesFallback = false
  #online = true
  #disposers: (() => void)[] = []

  init(b: Bootstrap): void {
    this.dispose()
    this.#ornateSeen = null
    this.decor = b.decor
    this.printLabelsReady = printLabelsLoaded()
    this.v4Supported = readCachedSupport(b.app.webviewVersion)
    this.#online = b.online && b.settings.networkAllowed
    this.#watchContrast()
    this.#disposers.push(listenEvent(events.packsChanged, ({ packIds }) => this.#packsChanged(packIds)))
    this.#disposers.push(
      onFaceSetChange(() => {
        if (this.#faceEpochQueued) return
        this.#faceEpochQueued = true
        queueMicrotask(() => {
          this.#faceEpochQueued = false
          this.faceEpoch += 1
        })
      }),
    )
    this.#disposers.push(
      $effect.root(() => {
        // One palette rule for every loaded V4 family, rewritten on any input change.
        $effect(() => {
          void [...this.v4Families]
          void settings.resolvedTheme
          void settings.highContrastDark
          void settings.value.tajweedColors
          void settings.value.inkBrightnessPct
          void this.contrastMore
          untrack(() => this.regeneratePalettes())
        })
        // While the ornaments are on, a QCF style brings the decor fonts along (once per session, only while online);
        // turning them on asks for them in any style.
        $effect(() => {
          const ornate = settings.value.ornateHeaders
          const qcf = settings.value.mushafStyle !== 'hafs'
          const online = app.online && settings.value.networkAllowed
          untrack(() => this.#ornateChanged(ornate))
          if (ornate && (qcf || this.#decorWanted) && online && !this.decor.installed)
            untrack(() => this.#requestDecor())
        })
        // Coming online: retry what was unavailable.
        $effect(() => {
          const online = app.online && settings.value.networkAllowed
          untrack(() => this.#connectivity(online))
        })
        // The COLR probe failed (now or in an earlier session): QCF V4 cannot be drawn here.
        $effect(() => {
          if (this.v4Supported === false && settings.value.mushafStyle === 'qcf_v4')
            untrack(() => this.#leaveV4())
        })
        // Leaving a style unloads its faces once nothing draws them (LRU budget 0 for a left style).
        $effect(() => {
          const style = settings.value.mushafStyle
          untrack(() => this.#styleShown(style))
        })
      }),
    )
    if (b.decor.installed) void this.#loadDecor(b.decor)
  }

  /** CSS family of a page in a style: `qcf-v2-p262`, or `qd-hafs` for hafs. */
  family(style: MushafStyle, page: number): string {
    return pageFamily(style, page)
  }

  /** The font state of a page (reactive): always `ready` for hafs, `null` when never asked for. */
  state(style: MushafStyle, page: number): FontState | null {
    if (style === 'hafs') return 'ready'
    return this.status.get(pageFamily(style, page)) ?? null
  }

  /** Whether the page's face is loaded and usable now (reactive). */
  isReady(style: MushafStyle, page: number): boolean {
    return style === 'hafs' || this.status.get(pageFamily(style, page)) === 'ready'
  }

  /**
   * Makes the page fonts of `pages` available: asks Rust (`mushaf_ensure_page_fonts`, ≤ 12 pages per call) and loads
   * every `Ready` face. Resolves once each page is final (`ready`, `failed` or `unavailable`); never rejects. Pages
   * already loaded or in flight are not asked for again; a prefetch skips pages that failed or were unavailable, an
   * interactive request asks again.
   */
  async ensure(style: MushafStyle, pages: readonly number[], priority: FetchPriority): Promise<void> {
    if (style === 'hafs') return
    // Untracked: an effect that calls this (a prefetch on page change) must not subscribe to the states it writes.
    await Promise.all(untrack(() => this.#start(style, pages, priority)))
  }

  /** The synchronous part of `ensure`: joins requests in flight and starts the missing ones. */
  #start(style: QcfStyle, pages: readonly number[], priority: FetchPriority): Promise<void>[] {
    const epoch = this.#epoch
    const waits: Promise<void>[] = []
    const request: number[] = []
    for (const page of new Set(pages)) {
      if (!isPage(page)) continue
      const family = pageFamily(style, page)
      const inflight = this.#inflight.get(family)
      if (inflight && (inflight.priority === 'interactive' || priority === 'prefetch')) {
        waits.push(inflight.promise)
        continue
      }
      const state = this.status.get(family)
      if (state === 'ready' && hasFace(family)) continue
      if (priority === 'prefetch' && (state === 'failed' || state === 'unavailable')) continue
      request.push(page)
    }
    for (let i = 0; i < request.length; i += ENSURE_BATCH) {
      waits.push(...this.#request(style, request.slice(i, i + ENSURE_BATCH), priority, epoch))
    }
    return waits
  }

  /** Retry after `failed` (the footer dot's action): forgets the failure and asks again, interactively. */
  async retry(style: MushafStyle, page: number): Promise<void> {
    if (style === 'hafs' || !isPage(page)) return
    const family = pageFamily(style, page)
    const loaded = untrack(() => this.status.get(family) === 'ready') && hasFace(family)
    if (loaded) return
    this.status.delete(family)
    await this.ensure(style, [page], 'interactive')
  }

  /**
   * Prefetch, called by the reader at the first idle after a page settles: the fonts of P−2..P+2 (single page)
   * or P−4..P+5 (spread) in the background lane, and 8 more pages in the flip direction while flipping.
   */
  prefetchAround(style: MushafStyle, page: number, spread: boolean, dir?: 1 | -1): void {
    if (style === 'hafs' || !isPage(page)) return
    this.ensure(style, aroundPages(page, spread, dir), 'prefetch').catch((e: unknown) =>
      console.debug('[fonts] prefetch failed', e),
    )
  }

  /**
   * Marks a page as displayed (a rendition stack shows it) until the returned function is called: its face is touched
   * for the LRU, it and its ±2 neighbours are never evicted, and it is ensured again when the app comes online. The
   * face of a style the reader has left is unloaded once its last display is released.
   */
  track(style: MushafStyle, page: number): () => void {
    if (style === 'hafs' || !isPage(page)) return () => {}
    const family = pageFamily(style, page)
    this.#tracked.set(family, (this.#tracked.get(family) ?? 0) + 1)
    touchFace(family)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.#tracked.get(family) ?? 1) - 1
      if (count > 0) {
        this.#tracked.set(family, count)
        return
      }
      this.#tracked.delete(family)
      if (this.#left.has(style)) this.#queueEvict()
    }
  }

  /**
   * The COLR probe on the page's first ayah-end glyph, once per webview version. Resolves the cached or new result,
   * or `null` when it cannot run yet (not a V4 page, its face is not loaded, no end marker, no canvas). `false` also
   * switches the style to QCF V2 with a one-time toast.
   */
  probeV4(data: PageData): Promise<boolean | null> {
    const known = untrack(() => this.v4Supported)
    if (known !== null) return Promise.resolve(known)
    if (data.style !== 'qcf_v4') return Promise.resolve(null)
    const family = pageFamily('qcf_v4', data.page)
    const glyph = firstEndGlyph(data)
    if (!glyph || !hasFace(family)) return Promise.resolve(null)
    this.#probe ??= (async () => {
      const epoch = this.#epoch
      try {
        const supported = await probeColr(family, glyph)
        if (epoch !== this.#epoch) return null
        writeCachedSupport(app.info.webviewVersion, supported)
        this.v4Supported = supported
        if (!supported) console.warn(`[fonts] COLR probe on ${family}: no palette colour, QCF V4 is disabled`)
        return supported
      } catch (e) {
        console.warn('[fonts] the COLR probe could not run', e)
        return null
      } finally {
        this.#probe = null
      }
    })()
    return this.#probe
  }

  /** Asks Rust for the decor fonts (`decor_ensure`) and loads them when installed; unloads them when removed. */
  async ensureDecor(): Promise<void> {
    const epoch = this.#epoch
    let decor: DecorStatus
    try {
      decor = await call(api.decorEnsure())
    } catch (e) {
      console.warn('[fonts] decor_ensure failed', e)
      return
    }
    if (epoch !== this.#epoch) return
    this.decor = decor
    if (decor.installed) await this.#loadDecor(decor)
    else this.#unloadDecor()
  }

  /**
   * Rewrites `<style id="qd-v4-palettes">` and the lines' colour map from the loaded V4 families, the resolved theme,
   * tajweed, the opaque ink and page, the ink brightness and the contrast preference (palettes.ts). Runs
   * automatically; callable after anything else that changes the ink.
   */
  regeneratePalettes(): void {
    if (typeof document === 'undefined') return
    const families = [...this.v4Families]
    if (families.length === 0) {
      writePaletteStyle('')
      writeInkFilter(null)
      return
    }
    const plan = planPalette(
      settings.resolvedTheme,
      settings.value.tajweedColors,
      parseCssColor(readInkColor()),
      this.contrastMore,
      {
        page: parseCssColor(readPageColor()),
        inkLevel: this.contrastMore ? 1 : settings.value.inkBrightnessPct / 100,
      },
    )
    // The filter first: the rule references it.
    writeInkFilter(inkFilterValues(plan))
    writePaletteStyle(paletteCss(families, plan))
  }

  /** Stops the store's effects and listeners (tests). `init` calls it first. */
  /**
   * Once every store is initialised, before the first paint (`main.ts`): loads the bundled faces again and reads
   * `printLabelsReady` anew. WebKit (WKWebView, WebKitGTK) drops every CSS face back to "unloaded" when the root's `lang`
   * or `dir` changes, which settings' `init` does for the Arabic UI; the Hafs face is reloaded as soon as text uses it,
   * but nothing draws the print labels until they are known ready, so `init` read false and the furniture kept its Hafs
   * text. A face already loaded resolves at once.
   */
  async settleBundledFaces(): Promise<void> {
    await loadBundledFaces()
    this.printLabelsReady = printLabelsLoaded()
  }

  dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }

  reset(): void {
    this.dispose()
    this.#epoch++
    this.#inflight.clear()
    this.#serial.clear()
    this.#tracked.clear()
    this.#shownStyle = null
    this.#left.clear()
    this.#evictQueued = false
    this.#probe = null
    this.#decorAsked = false
    this.#ornateSeen = null
    this.#decorWanted = false
    this.#bytesFallback = false
    this.#online = true
    clearFaces()
    this.status.clear()
    this.v4Families.clear()
    this.decor = NO_DECOR
    this.v4Supported = null
    this.contrastMore = false
    if (typeof document !== 'undefined') removePaletteStyle()
  }

  // --- page fonts --------------------------------------------------------------------------------------------------

  /** One `mushaf_ensure_page_fonts` call; returns one promise per page that settles that page's state. */
  #request(style: QcfStyle, pages: number[], priority: FetchPriority, epoch: number): Promise<void>[] {
    const reply = call(api.mushafEnsurePageFonts(style, pages, priority))
    return pages.map((page) => {
      const family = pageFamily(style, page)
      const serial = (this.#serial.get(family) ?? 0) + 1
      this.#serial.set(family, serial)
      if (this.status.get(family) !== 'ready' || !hasFace(family)) this.status.set(family, 'loading')
      const promise: Promise<void> = reply
        .then(
          (list) => this.#settle(style, family, list.find((s) => s.page === page) ?? null, serial, epoch),
          (e: unknown) => this.#failed(family, e, serial, epoch),
        )
        .finally(() => {
          if (this.#inflight.get(family)?.promise === promise) this.#inflight.delete(family)
        })
      this.#inflight.set(family, { promise, priority })
      return promise
    })
  }

  async #settle(
    style: QcfStyle,
    family: string,
    status: PageFontStatus | null,
    serial: number,
    epoch: number,
  ): Promise<void> {
    if (epoch !== this.#epoch) return
    if (!status) {
      console.warn(`[fonts] mushaf_ensure_page_fonts returned nothing for ${family}`)
      this.#mark(family, 'failed', serial)
      return
    }
    if (status.availability !== 'ready') {
      this.#mark(family, status.availability, serial)
      return
    }
    if (this.#unwanted(style, family)) {
      // A late answer (a prefetch) for a style the reader has left: never added to document.fonts.
      if (this.#serial.get(family) === serial && !hasFace(family)) this.status.delete(family)
      return
    }
    const face = await this.#loadFrom(family, status.url, status.rel)
    if (epoch !== this.#epoch) return
    if (!face) {
      this.#mark(family, 'failed', serial)
      return
    }
    this.#faceReady(style, family)
  }

  #failed(family: string, e: unknown, serial: number, epoch: number): void {
    if (epoch !== this.#epoch) return
    const err = toIpcError(e)
    console.warn(`[fonts] mushaf_ensure_page_fonts failed for ${family}`, err)
    this.#mark(family, err.kind === 'offline' ? 'unavailable' : 'failed', serial)
  }

  /** A final non-ready state, unless a newer request owns the family or its face is already loaded. */
  #mark(family: string, state: 'failed' | 'unavailable', serial: number): void {
    if (this.#serial.get(family) !== serial) return
    if (this.status.get(family) === 'ready' && hasFace(family)) return
    this.status.set(family, state)
  }

  #faceReady(style: QcfStyle, family: string): void {
    if (this.#unwanted(style, family)) {
      // The reader left the style while the face loaded: unload it at once.
      deleteFace(family)
      this.status.delete(family)
      return
    }
    if (this.#tracked.has(family)) touchFace(family)
    if (style === 'qcf_v4' && !this.v4Families.has(family)) {
      this.v4Families.add(family)
      // Before the status flips: the first paint of the new rendition already has its palette.
      this.regeneratePalettes()
    }
    this.status.set(family, 'ready')
    this.#evict()
  }

  /** A face of a style the reader has left that no rendition draws: not worth keeping. */
  #unwanted(style: QcfStyle, family: string): boolean {
    return this.#left.has(style) && !this.#tracked.has(family)
  }

  /** `init`'s effect: the `mushafStyle` setting is `style`. The style it moved away from is left (`#left`). */
  #styleShown(style: MushafStyle): void {
    const previous = this.#shownStyle
    this.#shownStyle = style
    if (style !== 'hafs') this.#left.delete(style)
    if (previous === null || previous === style) return
    if (previous !== 'hafs') this.#left.add(previous)
    this.#evict()
  }

  /** Evicts after the current task's synchronous work (several renditions may let go of their faces at once). */
  #queueEvict(): void {
    if (this.#evictQueued) return
    this.#evictQueued = true
    const epoch = this.#epoch
    queueMicrotask(() => {
      if (epoch !== this.#epoch) return
      this.#evictQueued = false
      this.#evict()
    })
  }

  /**
   * The LRU: faces beyond 24 per style go, least recently displayed first, never near a displayed page. A style
   * the reader has left has a budget of 0 and keeps only the faces still drawn (a fading-out rendition's included).
   */
  #evict(): void {
    const keep: ReadonlySet<string> = new Set(
      [...this.#tracked.keys()].flatMap((family) => {
        const parsed = parseFamily(family)
        if (!parsed) return []
        // A left style keeps only what is drawn; the style on screen also keeps the ±2 neighbours.
        if (this.#left.has(parsed.style)) return [family]
        const near: string[] = []
        for (let d = -KEEP_AROUND; d <= KEEP_AROUND; d++) {
          if (isPage(parsed.page + d)) near.push(pageFamily(parsed.style, parsed.page + d))
        }
        return near
      }),
    )
    const budget = (group: string): number => {
      const style = STYLE_OF_GROUP[group]
      return style !== undefined && this.#left.has(style) ? 0 : FACES_PER_STYLE
    }
    let palettes = false
    for (const family of evictFaces(keep, budget)) {
      this.status.delete(family)
      if (this.v4Families.delete(family)) palettes = true
    }
    if (palettes) this.regeneratePalettes()
  }

  /**
   * Loads a face for the configured transport. A `url` face that fails to load is retried once through the bytes
   * of `rel` (`font_bytes`), and the session stays on bytes from then on: some platforms chose `url` by probe only, and
   * the bytes path always works. `null` when no source loads.
   */
  async #loadFrom(family: string, url: string | null, rel: string | null): Promise<FontFace | null> {
    const epoch = this.#epoch
    const source = await this.#source(url, rel)
    if (!source || epoch !== this.#epoch) return null
    const face = await loadFace(family, source)
    if (face || !('url' in source) || !rel || epoch !== this.#epoch) return face
    const bytes = await this.#bytes(rel)
    if (!bytes || epoch !== this.#epoch) return null
    const retried = await loadFace(family, { bytes })
    if (retried && !this.#bytesFallback) {
      this.#bytesFallback = true
      console.warn('[fonts] a font failed to load by URL but loaded as bytes: this session uses font_bytes')
    }
    return retried
  }

  /** The face source for the transport in use: the URL, or the raw bytes of `rel` through `font_bytes`. */
  async #source(url: string | null, rel: string | null): Promise<FaceSource | null> {
    if (this.transport === 'bytes' || this.#bytesFallback) {
      if (!rel) return null
      const bytes = await this.#bytes(rel)
      return bytes ? { bytes } : null
    }
    return url ? { url } : null
  }

  async #bytes(rel: string): Promise<ArrayBuffer | null> {
    try {
      return await fontBytes(rel)
    } catch (e) {
      console.warn(`[fonts] font_bytes ${rel} failed`, e)
      return null
    }
  }

  /** Ensures every displayed page that is not loaded again (optionally of one LRU group only). */
  #reensureTracked(group?: string): void {
    const byStyle: Partial<Record<QcfStyle, number[]>> = {}
    for (const family of this.#tracked.keys()) {
      const parsed = parseFamily(family)
      if (!parsed || (group !== undefined && faceGroup(family) !== group)) continue
      if (this.status.get(family) === 'ready') continue
      ;(byStyle[parsed.style] ??= []).push(parsed.page)
    }
    for (const [style, pages] of Object.entries(byStyle) as [QcfStyle, number[]][]) {
      void this.ensure(style, pages, 'interactive')
    }
  }

  #connectivity(online: boolean): void {
    const was = this.#online
    this.#online = online
    if (!online || was) return
    for (const [family, state] of this.status) if (state === 'unavailable') this.status.delete(family)
    this.#reensureTracked()
    this.#decorAsked = false
  }

  #packsChanged(packIds: readonly string[]): void {
    for (const id of packIds) {
      if (id === 'decor') {
        this.#decorAsked = false
        void this.#decorChanged()
        continue
      }
      const m = /^mushaf\.(v[124])$/.exec(id)
      if (!m) continue
      const group = `qcf-${m[1]}`
      for (const [family, state] of this.status) {
        if (faceGroup(family) === group && (state === 'failed' || state === 'unavailable'))
          this.status.delete(family)
      }
      this.#reensureTracked(group)
    }
  }

  #leaveV4(): void {
    if (settings.value.mushafStyle !== 'qcf_v4') return
    void settings.update({ mushafStyle: 'qcf_v2' })
    ui.toast({ message: i18n.t('mushaf.v4Unsupported'), tone: 'warning' })
  }

  #watchContrast(): void {
    if (typeof matchMedia !== 'function') return
    const list = matchMedia('(prefers-contrast: more)')
    this.contrastMore = list.matches
    const onChange = (e: MediaQueryListEvent) => (this.contrastMore = e.matches)
    list.addEventListener('change', onChange)
    this.#disposers.push(() => list.removeEventListener('change', onChange))
  }

  // --- decor -------------------------------------------------------------------------------------------------------

  /** The decor effect saw `ornateHeaders`: turning it on (false → true) wants decor in any style, asked afresh. */
  #ornateChanged(ornate: boolean): void {
    if (ornate && this.#ornateSeen === false) {
      this.#decorWanted = true
      this.#decorAsked = false
    }
    this.#ornateSeen = ornate
  }

  #requestDecor(): void {
    if (this.#decorAsked) return
    this.#decorAsked = true
    void this.ensureDecor()
  }

  /** Loads the three decor faces (each at most once at a time: `loadFace` shares a load in flight). */
  async #loadDecor(decor: DecorStatus): Promise<void> {
    const epoch = this.#epoch
    await Promise.all(
      DECOR_FACES.map(async ({ family, rel, key }) => {
        if (this.status.get(family) === 'ready' && hasFace(family)) return
        this.status.set(family, 'loading')
        const face = await this.#loadFrom(family, decor[key], rel)
        if (epoch !== this.#epoch) return
        this.status.set(family, face ? 'ready' : 'failed')
      }),
    )
  }

  /** `PacksChanged` for `decor`: load it if the packs list shows it installed, else unload it; never fetch it here. */
  async #decorChanged(): Promise<void> {
    const epoch = this.#epoch
    let installed: boolean
    try {
      const list = await call(api.packsList())
      installed = list.find((p) => p.id === 'decor')?.state.type === 'installed'
    } catch (e) {
      console.warn('[fonts] packs_list failed', e)
      return
    }
    if (epoch !== this.#epoch) return
    if (installed) {
      await this.ensureDecor()
      return
    }
    this.decor = NO_DECOR
    this.#unloadDecor()
  }

  #unloadDecor(): void {
    for (const { family } of DECOR_FACES) {
      deleteFace(family)
      this.status.delete(family)
    }
  }
}

export const fonts = new FontsStore()
