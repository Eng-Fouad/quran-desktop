/**
 * Shared set-up of the WP11a browser tests: every store booted from the browser mock's bootstrap, the way `main.ts`
 * does, with translation packs marked installed in the mock catalogue; helpers to wait for the feed and measure it.
 * Never imported by the app. ESLint keeps the mock out of non-test files (D29), so the mock state is reached through
 * `window.__QD_MOCK__`, which the mock runtime installs.
 */
import { flushSync } from 'svelte'
import { page } from 'vitest/browser'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, PackInfo, Settings } from '$lib/ipc/bindings'
import { initStores, resetStores } from '$lib/stores'

interface Slice<T> {
  value: T
  set(value: T): T
  update(mutate: (draft: T) => void): T
}

/** The part of `window.__QD_MOCK__` these helpers use. */
interface MockHandle {
  state: {
    resetAll(): void
    loadAll(): void
    settings: Slice<Settings>
    packs: Slice<{ list: PackInfo[] }>
  }
}

function mock(): MockHandle['state'] {
  const handle = (window as unknown as { __QD_MOCK__?: MockHandle }).__QD_MOCK__
  if (!handle) throw new Error('the IPC mock is not installed (initIpc() in a mock build)')
  return handle.state
}

export const EN = 'tr.en.rwwad'
export const UR = 'tr.ur.junagarhi'

export interface BootOptions {
  settings?: Partial<Settings>
  /** Translation packs marked installed (default: the English and the Urdu pack). */
  installed?: string[]
  lang?: 'en' | 'ar'
}

/** Boots every store on the mock's bootstrap in translation mode. */
export async function boot(options: BootOptions = {}): Promise<Bootstrap> {
  await page.viewport(1280, 900)
  localStorage.clear()
  await initIpc()
  const state = mock()
  state.resetAll()
  state.loadAll()
  const installed = options.installed ?? [EN, UR]
  state.packs.update((v) => {
    for (const p of v.list) {
      if (!installed.includes(p.id)) continue
      p.state = { type: 'installed', data: { version: p.version } }
      p.installedKib = p.sizeKib
    }
  })
  state.settings.set({
    ...defaultSettings(),
    readingMode: 'translation',
    translations: [EN, UR],
    uiLanguage: options.lang ?? 'en',
    theme: 'paper',
    motion: 'reduce',
    ...options.settings,
  })
  const b = await call(api.appBootstrap())
  await initStores(b)
  flushSync()
  return b
}

/** Every store back to its pre-`init` state, and the document clean. */
export function resetAll(): void {
  resetStores()
  document.documentElement.removeAttribute('style')
  for (const host of document.querySelectorAll('[data-test-host]')) host.remove()
}

/** Two frames plus `ms`: effects, measurements, the mock's delays and short debounces have settled. */
export async function settle(ms = 60): Promise<void> {
  flushSync()
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
  flushSync()
}

/** Polls until `probe` is truthy (or fails after `timeout` ms with `what`). */
export async function until<T>(probe: () => T, what: string, timeout = 4000): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout
  for (;;) {
    const value = probe()
    if (value) return value as NonNullable<T>
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await settle(20)
  }
}

/** The feed's scroller. */
export function scroller(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.qd-virtual-list')
  if (!el) throw new Error('no verse feed')
  return el
}

/** The top of a row (verse `tv-a{id}` or surah card) relative to the feed's top edge, px. */
export function topOf(el: Element): number {
  return el.getBoundingClientRect().top - scroller().getBoundingClientRect().top
}

/** The verse article of an ayah id, if mounted. */
export function verse(ayahId: number): HTMLElement | null {
  return document.getElementById(`tv-a${ayahId}`)
}

/** The feed's scroll offset and height and the boxes of the rows on screen, to the pixel. */
function feedLayout(): string {
  const s = scroller()
  const box = s.getBoundingClientRect()
  const rows = [...s.querySelectorAll('article')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.bottom > box.top && r.top < box.bottom)
    .map((r) => `${Math.round(r.top)}+${Math.round(r.height)}`)
  return `${Math.round(s.scrollTop)}/${s.scrollHeight}:${rows.join(',')}`
}

/** The feed holds still this long before it counts as at rest: longer than the view's 150 ms position report. */
const REST_MS = 250

/**
 * Waits until the feed is at rest: its offset, its height and the rows on screen unchanged for `REST_MS`. The rows a
 * jump, a scroll or a reflow brings in render at estimated heights and are placed again once measured (virtua), and
 * the view reports the verse at the top 150 ms after the last scroll. How long that takes is the engine's: Chromium
 * lays out a screen of new verses in a frame or two, headless WebKitGTK (CI, no GPU) up to half a second a frame.
 */
export async function feedAtRest(timeout = 5000): Promise<void> {
  const deadline = performance.now() + timeout
  let last = feedLayout()
  let since = performance.now()
  for (;;) {
    await settle(40)
    const now = feedLayout()
    if (now !== last) {
      last = now
      since = performance.now()
    } else if (performance.now() - since >= REST_MS) {
      return
    }
    if (performance.now() > deadline) throw new Error(`the feed did not come to rest within ${timeout} ms`)
  }
}

/** Scrolls the feed by script (not the user) and waits for the view to catch up. */
export async function scrollFeedTo(offset: number): Promise<void> {
  scroller().scrollTop = offset
  await feedAtRest()
}
