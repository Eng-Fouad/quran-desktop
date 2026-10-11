/**
 * `pages` store (§7.3, layer L1): the `PageData` cache behind the Mushaf. Owner: WP8a.
 *
 * - A non-reactive LRU of 48 pages (§8.18 memory budget), keyed by style and page. `version` is the only reactive
 *   state: it bumps once per arriving batch, and `get()`/`has()` read it, so templates re-render when a page arrives.
 *   `PageData` objects are never proxied (§7.2).
 * - `ensure(style, pages)`: fetches what is neither cached nor in flight, in batches of ≤ 8 pages (the command's
 *   limit), and resolves once every requested page is cached. Concurrent requests for a page share one IPC call.
 * - `prefetch(style, pages, dir?)`: background warming. Without `dir` it waits for an idle period; while flipping
 *   (`dir` given) it starts at once and extends the set by 8 pages in the flip direction, nearest first (§8.5, §8.11).
 *   A newer prefetch replaces a pending one, so a fast flip never queues stale work. Failures are logged, never shown.
 * - `reset()` drops everything; results of requests still in flight are discarded.
 */
import type { Store } from '$lib/contracts/stores'
import { api, call } from '$lib/ipc'
import type { Bootstrap, MushafStyle, PageData } from '$lib/ipc/bindings'
import { PAGE_COUNT } from '$lib/mushaf/geometry'
import { LRU } from '$lib/util/lru'

/** Pages kept in memory (§8.18: PageCache ≤ 48 pages). */
export const PAGE_CACHE_SIZE = 48
/** `mushaf_get_pages` takes 1..=8 pages per call (§5.13). */
export const MAX_BATCH = 8
/** While flipping, prefetch this many pages beyond the visible ones in the flip direction (§8.11). */
export const FLIP_PREFETCH = 8
/** An idle prefetch runs at the latest after this long, even if the main thread never goes idle. */
const IDLE_TIMEOUT_MS = 1000

export type FlipDirection = 'next' | 'prev'

type Cancel = () => void

/** Runs `fn` when the main thread is idle (`requestIdleCallback`, with a timeout), else after a short timer. */
function whenIdle(fn: () => void): Cancel {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(() => fn(), { timeout: IDLE_TIMEOUT_MS })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(fn, 50)
  return () => clearTimeout(handle)
}

const isPage = (p: number) => Number.isInteger(p) && p >= 1 && p <= PAGE_COUNT

/** The valid page numbers of a list, each once, in their first order. */
function validPages(pages: readonly number[]): number[] {
  return pages.filter((p, i) => isPage(p) && pages.indexOf(p) === i)
}

/** The prefetch set: valid, unique pages; with a flip direction, extended by `FLIP_PREFETCH` pages nearest-first. */
export function prefetchSet(pages: readonly number[], dir?: FlipDirection): number[] {
  const base = validPages(pages)
  if (!dir || base.length === 0) return base
  const out = dir === 'next' ? base.sort((a, b) => a - b) : base.sort((a, b) => b - a)
  const edge = dir === 'next' ? Math.max(...base) : Math.min(...base)
  for (let i = 1; i <= FLIP_PREFETCH; i++) {
    const p = dir === 'next' ? edge + i : edge - i
    if (isPage(p) && !out.includes(p)) out.push(p)
  }
  return out
}

class PagesStore implements Store {
  /** Bumped whenever pages arrive (or the cache is cleared): read it to make lookups reactive. */
  version = $state(0)

  #cache = new LRU<string, PageData>(PAGE_CACHE_SIZE)
  #inflight = new Map<string, Promise<void>>()
  /** Bumped by `reset()`: requests started before it never write into the new cache. */
  #generation = 0
  #pendingPrefetch: Cancel | null = null

  init(_b: Bootstrap): void {
    // Pages are fetched on demand by the reader (and prefetched around it); nothing comes with the bootstrap.
  }

  #key(style: MushafStyle, page: number): string {
    return `${style}:${page}`
  }

  /** The cached page, or `undefined`. Reactive (reads `version`) and marks the page as recently used. */
  get(style: MushafStyle, page: number): PageData | undefined {
    void this.version
    return this.#cache.get(this.#key(style, page))
  }

  /** Whether the page is cached (reactive; does not change the LRU order). */
  has(style: MushafStyle, page: number): boolean {
    void this.version
    return this.#cache.has(this.#key(style, page))
  }

  /** Whether the page is being fetched right now. */
  pending(style: MushafStyle, page: number): boolean {
    return this.#inflight.has(this.#key(style, page))
  }

  /** How many pages are cached (diagnostics, tests). */
  get size(): number {
    void this.version
    return this.#cache.size
  }

  /**
   * Resolves once every valid page of `pages` is cached; rejects with the `IpcError` of a failed batch. Pages outside
   * 1..=604 are ignored. Already cached pages cost nothing; pages in flight are awaited, not fetched again.
   */
  async ensure(style: MushafStyle, pages: readonly number[]): Promise<void> {
    const waits: Promise<void>[] = []
    const missing: number[] = []
    for (const p of validPages(pages)) {
      const key = this.#key(style, p)
      const inflight = this.#inflight.get(key)
      if (inflight) waits.push(inflight)
      else if (!this.#cache.has(key)) missing.push(p)
    }
    for (let i = 0; i < missing.length; i += MAX_BATCH)
      waits.push(this.#fetch(style, missing.slice(i, i + MAX_BATCH)))
    await Promise.all(waits)
  }

  /** One `mushaf_get_pages` call; registered as in flight for each page until it settles. */
  #fetch(style: MushafStyle, batch: readonly number[]): Promise<void> {
    const generation = this.#generation
    const keys = batch.map((p) => this.#key(style, p))
    const request = call(api.mushafGetPages(style, [...batch])).then((data) => {
      if (generation !== this.#generation) return
      for (const page of data) this.#cache.set(this.#key(style, page.page), page)
      this.version += 1
    })
    const settled = request.finally(() => {
      if (generation !== this.#generation) return
      for (const key of keys) if (this.#inflight.get(key) === settled) this.#inflight.delete(key)
    })
    for (const key of keys) this.#inflight.set(key, settled)
    return settled
  }

  /**
   * Warms the cache in the background (§8.5): the given pages, plus 8 pages in the flip direction when `dir` is set.
   * Without `dir` the work waits for an idle period; with it, it starts at once. Replaces a prefetch still waiting.
   */
  prefetch(style: MushafStyle, pages: readonly number[], dir?: FlipDirection): void {
    this.#pendingPrefetch?.()
    this.#pendingPrefetch = null
    const wanted = prefetchSet(pages, dir)
    if (wanted.length === 0) return
    const run = () => {
      this.#pendingPrefetch = null
      const todo = wanted.filter((p) => !this.#cache.has(this.#key(style, p)))
      if (todo.length === 0) return
      this.ensure(style, todo).catch((e: unknown) => console.debug('[pages] prefetch failed', e))
    }
    if (dir) {
      // Flipping: the next pages are needed within a turn (70 ms), so do not wait for idle time.
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) run()
      })
      this.#pendingPrefetch = () => {
        cancelled = true
      }
    } else {
      this.#pendingPrefetch = whenIdle(run)
    }
  }

  /** A prefetch is scheduled and has not started yet (QA's `waitIdle`). */
  get prefetchPending(): boolean {
    return this.#pendingPrefetch !== null
  }

  reset(): void {
    this.#pendingPrefetch?.()
    this.#pendingPrefetch = null
    this.#generation += 1
    this.#cache.clear()
    this.#inflight.clear()
    this.version = 0
  }
}

export const pages = new PagesStore()
