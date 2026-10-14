/**
 * The history store against the browser mock: positions from the bootstrap and `setPosition`,
 * paging the entries, following `user-data-changed`, recording and clearing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, HistoryEntry } from '$lib/ipc/bindings'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { history, HISTORY_PAGE } from './history.svelte'
import { i18n } from './i18n.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function entries(n: number): HistoryEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    at: 1_700_000_000 + i,
    mode: 'read' as const,
    layout: 'v2' as const,
    page: (i % 604) + 1,
    ayahId: 1,
    dwellS: 10,
  }))
}

async function boot(seed?: (b: Bootstrap) => void): Promise<Bootstrap> {
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  const b = await call(api.appBootstrap())
  seed?.(b)
  app.init(b)
  settings.init(b)
  i18n.init(b)
  quran.init(b)
  ui.init(b)
  history.init(b)
  return b
}

beforeEach(() => stubMatchMedia())

afterEach(() => {
  history.reset()
  ui.reset()
  quran.reset()
  settings.reset()
  app.reset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('positions', () => {
  it('starts from the bootstrap positions and stores new ones locally and in the backend', async () => {
    await boot((b) => {
      b.positions = [
        { context: 'audio', layout: null, page: null, ayahId: 2185, scrollPx: null, updatedAt: 5 },
        { context: 'mushaf', layout: 'v2', page: 297, ayahId: 2185, scrollPx: null, updatedAt: 5 },
      ]
    })
    expect(history.positions.map((p) => p.context)).toEqual(['mushaf', 'audio'])
    expect(history.last('mushaf')?.page).toBe(297)
    expect(history.last('translation')).toBeUndefined()

    await history.setPosition({
      context: 'translation',
      layout: null,
      page: null,
      ayahId: 262,
      scrollPx: 120,
      updatedAt: 0,
    })
    expect(history.last('translation')?.scrollPx).toBe(120)
    expect(history.last('translation')?.updatedAt).toBeGreaterThan(0)
    expect(state.user.value.positions.find((p) => p.context === 'translation')?.ayahId).toBe(262)
  })
})

describe('entries', () => {
  it('loads on demand, pages backwards and stops at the end', async () => {
    await boot()
    state.user.update((u) => {
      u.history = entries(HISTORY_PAGE + 30)
      u.nextHistoryId = HISTORY_PAGE + 31
    })
    expect(history.status).toBe('idle')
    await history.load()
    expect(history.status).toBe('ready')
    expect(history.entries).toHaveLength(HISTORY_PAGE)
    expect(history.entries[0]?.id).toBe(HISTORY_PAGE + 30)
    expect(history.hasMore).toBe(true)
    await history.loadMore()
    expect(history.entries).toHaveLength(HISTORY_PAGE + 30)
    expect(history.entries.at(-1)?.id).toBe(1)
    expect(history.hasMore).toBe(false)
  })

  it('records visits and follows user-data-changed once loaded', async () => {
    await boot()
    await history.load()
    expect(history.entries).toEqual([])
    await history.record({ mode: 'read', layout: 'v2', page: 297, ayahId: 2185, dwellS: 12 })
    await wait(150)
    expect(history.entries.map((e) => e.page)).toEqual([297])
    // A record from elsewhere (the audio glue) arrives through the event as well.
    await call(api.historyRecord({ mode: 'listen', layout: null, page: null, ayahId: 262, dwellS: 30 }))
    await wait(150)
    expect(history.entries.map((e) => e.mode)).toEqual(['listen', 'read'])
  })

  it('clears the history with a toast', async () => {
    await boot()
    await history.record({ mode: 'read', layout: 'v2', page: 1, ayahId: 1, dwellS: 5 })
    await history.load()
    expect(history.entries).toHaveLength(1)
    expect(await history.clear()).toBe(true)
    expect(history.entries).toEqual([])
    expect(state.user.value.history).toEqual([])
    expect(ui.toasts.at(-1)?.message).toBe('History cleared')
  })

  it('logs a failed record instead of throwing', async () => {
    await boot()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await history.record({ mode: 'read', layout: 'v2', page: 999, ayahId: 1, dwellS: 5 })
    expect(warn).toHaveBeenCalled()
  })
})
