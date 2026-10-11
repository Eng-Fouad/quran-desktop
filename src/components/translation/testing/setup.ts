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

/** Scrolls the feed by script (not the user) and waits for the view to catch up. */
export async function scrollFeedTo(offset: number): Promise<void> {
  scroller().scrollTop = offset
  await settle(260)
}
