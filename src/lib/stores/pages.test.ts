import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, initIpc, IpcError } from '$lib/ipc'
import type { MushafStyle, PageData } from '$lib/ipc/bindings'
import { mockCommands } from '$lib/ipc/mock'
import { err } from '$lib/ipc/mock/result'
import { FLIP_PREFETCH, MAX_BATCH, PAGE_CACHE_SIZE, pages, prefetchSet } from './pages.svelte'

/** The live mock command, spied per test (the store reads `api.mushafGetPages` at call time). */
function spyGetPages() {
  expect(api).toBe(mockCommands)
  return vi.spyOn(mockCommands, 'mushafGetPages')
}

/** Every page number requested through `mushaf_get_pages`, call by call. */
function requested(spy: ReturnType<typeof spyGetPages>): number[][] {
  return spy.mock.calls.map(([, p]) => [...p])
}

beforeAll(async () => {
  await initIpc()
})

beforeEach(() => {
  pages.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
  pages.reset()
})

describe('pages.ensure', () => {
  it('fetches missing pages and serves them from the cache', async () => {
    const spy = spyGetPages()
    const v0 = pages.version
    await pages.ensure('hafs', [261, 262])
    expect(requested(spy)).toEqual([[261, 262]])
    expect(pages.version).toBe(v0 + 1)
    expect(pages.get('hafs', 261)?.page).toBe(261)
    expect(pages.get('hafs', 262)?.style).toBe('hafs')
    expect(pages.has('hafs', 262)).toBe(true)
    expect(pages.has('qcf_v2', 262)).toBe(false)

    await pages.ensure('hafs', [262, 261])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('splits large requests into batches of at most 8 pages', async () => {
    const spy = spyGetPages()
    const wanted = Array.from({ length: 19 }, (_, i) => 100 + i)
    await pages.ensure('qcf_v2', wanted)
    const calls = requested(spy)
    expect(calls.map((c) => c.length)).toEqual([MAX_BATCH, MAX_BATCH, 3])
    expect(calls.flat().sort((a, b) => a - b)).toEqual(wanted)
    expect(wanted.every((p) => pages.has('qcf_v2', p))).toBe(true)
  })

  it('shares one request between concurrent callers (in-flight dedupe)', async () => {
    const spy = spyGetPages()
    await Promise.all([pages.ensure('hafs', [1, 2]), pages.ensure('hafs', [2, 1]), pages.ensure('hafs', [2])])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(pages.pending('hafs', 1)).toBe(false)
  })

  it('fetches only what is neither cached nor in flight', async () => {
    const spy = spyGetPages()
    await pages.ensure('hafs', [3])
    const a = pages.ensure('hafs', [4, 5])
    const b = pages.ensure('hafs', [3, 4, 5, 6])
    await Promise.all([a, b])
    expect(requested(spy)).toEqual([[3], [4, 5], [6]])
  })

  it('ignores page numbers outside 1..=604 and duplicates', async () => {
    const spy = spyGetPages()
    await pages.ensure('hafs', [0, -1, 605, 1.5, Number.NaN, 7, 7])
    expect(requested(spy)).toEqual([[7]])
    await pages.ensure('hafs', [0])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by style', async () => {
    await pages.ensure('hafs', [50])
    await pages.ensure('qcf_v4', [50])
    expect(pages.get('hafs', 50)?.style).toBe('hafs')
    expect(pages.get('qcf_v4', 50)?.style).toBe('qcf_v4')
    expect(pages.get('qcf_v4', 50)?.layout).toBe('v4')
  })

  it('rejects with the IpcError of a failed batch and retries on the next call', async () => {
    const spy = spyGetPages().mockResolvedValueOnce(err('not_found', 'core.db missing'))
    const failure = await pages.ensure('hafs', [10]).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(IpcError)
    expect((failure as IpcError).kind).toBe('not_found')
    expect(pages.has('hafs', 10)).toBe(false)
    expect(pages.pending('hafs', 10)).toBe(false)
    await pages.ensure('hafs', [10])
    expect(pages.has('hafs', 10)).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('pages LRU (at most 48 pages)', () => {
  it('evicts the least recently used page beyond 48', async () => {
    // Filled batch by batch, so the insertion order is 1, 2, …, 48 (parallel batches arrive in any order).
    for (let p = 1; p <= PAGE_CACHE_SIZE; p += MAX_BATCH) {
      await pages.ensure(
        'hafs',
        Array.from({ length: MAX_BATCH }, (_, i) => p + i),
      )
    }
    expect(pages.size).toBe(PAGE_CACHE_SIZE)
    // Touch page 1: page 2 becomes the oldest.
    expect(pages.get('hafs', 1)).toBeDefined()
    await pages.ensure('hafs', [200])
    expect(pages.size).toBe(PAGE_CACHE_SIZE)
    expect(pages.has('hafs', 1)).toBe(true)
    expect(pages.has('hafs', 2)).toBe(false)
    expect(pages.has('hafs', 200)).toBe(true)
  })
})

describe('pages.reset', () => {
  it('drops the cache and discards results still in flight', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = mockCommands.mushafGetPages
    vi.spyOn(mockCommands, 'mushafGetPages').mockImplementation(
      async (style: MushafStyle, list: number[]) => {
        await gate
        return original(style, list)
      },
    )
    const pending = pages.ensure('hafs', [20])
    pages.reset()
    release()
    await pending
    expect(pages.has('hafs', 20)).toBe(false)
    expect(pages.version).toBe(0)
  })
})

describe('pages.prefetch', () => {
  it('builds the prefetch set: valid unique pages, plus 8 in the flip direction, nearest first', () => {
    expect(prefetchSet([5, 3, 4, 4, 0, 700])).toEqual([5, 3, 4])
    expect(prefetchSet([262, 263], 'next')).toEqual([262, 263, 264, 265, 266, 267, 268, 269, 270, 271])
    expect(prefetchSet([262, 263], 'prev')).toEqual([263, 262, 261, 260, 259, 258, 257, 256, 255, 254])
    expect(prefetchSet([600], 'next')).toEqual([600, 601, 602, 603, 604])
    expect(prefetchSet([2], 'prev')).toEqual([2, 1])
    expect(prefetchSet([], 'next')).toEqual([])
    expect(prefetchSet([262], 'next')).toHaveLength(1 + FLIP_PREFETCH)
  })

  it('warms the cache in the background when idle', async () => {
    const spy = spyGetPages()
    pages.prefetch('hafs', [30, 31, 32])
    expect(spy).not.toHaveBeenCalled()
    await vi.waitFor(() => expect([30, 31, 32].every((p) => pages.has('hafs', p))).toBe(true))
    expect(requested(spy)).toEqual([[30, 31, 32]])
  })

  it('starts at once while flipping and extends in the flip direction', async () => {
    const spy = spyGetPages()
    pages.prefetch('qcf_v2', [100, 101], 'prev')
    await Promise.resolve()
    await Promise.resolve()
    expect(spy).toHaveBeenCalled()
    await vi.waitFor(() => expect(pages.has('qcf_v2', 92)).toBe(true))
    expect(requested(spy).flat()).toEqual([101, 100, 99, 98, 97, 96, 95, 94, 93, 92])
  })

  it('replaces a prefetch that has not started yet', async () => {
    const spy = spyGetPages()
    pages.prefetch('hafs', [40])
    pages.prefetch('hafs', [41])
    await vi.waitFor(() => expect(pages.has('hafs', 41)).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(requested(spy)).toEqual([[41]])
    expect(pages.has('hafs', 40)).toBe(false)
  })

  it('skips cached pages and never surfaces a failure', async () => {
    await pages.ensure('hafs', [60])
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const spy = spyGetPages().mockResolvedValue(err('internal', 'boom'))
    pages.prefetch('hafs', [60, 61], 'next')
    await vi.waitFor(() => expect(debug).toHaveBeenCalled())
    expect(requested(spy)[0]).toEqual([61, 62, 63, 64, 65, 66, 67, 68])
    expect(pages.has('hafs', 61)).toBe(false)
  })

  it('is cancelled by reset()', async () => {
    const spy = spyGetPages()
    pages.prefetch('hafs', [70])
    pages.reset()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('page data', () => {
  it('keeps the PageData objects it received (never proxied or copied)', async () => {
    const seen: PageData[] = []
    const original = mockCommands.mushafGetPages
    vi.spyOn(mockCommands, 'mushafGetPages').mockImplementation(async (style, list) => {
      const r = await original(style, list)
      if (r.status === 'ok') seen.push(...r.data)
      return r
    })
    await pages.ensure('hafs', [90])
    expect(pages.get('hafs', 90)).toBe(seen[0])
  })
})
