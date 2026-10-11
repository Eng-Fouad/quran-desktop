/**
 * Shared set-up of the WP11b browser tests: every store booted from the browser mock's bootstrap, the way `main.ts`
 * does, with content packs marked installed (or chapters marked cached) in the mock catalogue first. Never imported by
 * the app. ESLint keeps the mock out of non-test files (D29), so the mock state is reached through
 * `window.__QD_MOCK__`, which the mock runtime installs.
 */
import { flushSync } from 'svelte'
import { page } from 'vitest/browser'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, PackInfo, PackItemState, Settings } from '$lib/ipc/bindings'
import { initStores, resetStores } from '$lib/stores'
import { pane } from '../pane.svelte'

interface Slice<T> {
  value: T
  set(value: T): T
  update(mutate: (draft: T) => void): T
}

interface MockHandle {
  state: {
    resetAll(): void
    loadAll(): void
    settings: Slice<Settings>
    packs: Slice<{ list: PackInfo[]; items: Record<string, PackItemState[]> }>
  }
}

export function mock(): MockHandle['state'] {
  const handle = (window as unknown as { __QD_MOCK__?: MockHandle }).__QD_MOCK__
  if (!handle) throw new Error('the IPC mock is not installed (initIpc() in a mock build)')
  return handle.state
}

/** 2:255 (Ayat al-Kursi): ayah id 262, page 42 of the V2 layout. */
export const KURSI = 262
export const SAHEEH = 'tr.en.saheeh'
export const URDU = 'tr.ur.junagarhi'
export const MUYASSAR = 'tafsir.ar.muyassar'
/** Quran.com tafsir (on demand); its fixture entry for 2:255 covers 2:253–255. */
export const IBN_KATHIR = 'tafsir.en.ibn_kathir'
export const MAARIF = 'tafsir.en.maarif'
export const WBW_EN = 'wbw.en'

export interface BootOptions {
  settings?: Partial<Settings>
  /** Whole packs marked installed. */
  installed?: string[]
  /** On-demand chapters marked cached before the boot ("fetched on an earlier run", 9 days ago in the mock). */
  cached?: Record<string, number[]>
  lang?: 'en' | 'ar'
  viewport?: [number, number]
}

/** Boots every store on the mock's bootstrap with the side pane open (Mushaf mode by default). */
export async function boot(options: BootOptions = {}): Promise<Bootstrap> {
  const [w, h] = options.viewport ?? [1600, 1000]
  await page.viewport(w, h)
  localStorage.clear()
  await initIpc()
  const state = mock()
  state.resetAll()
  state.loadAll()
  const installed = options.installed ?? [SAHEEH, MUYASSAR]
  state.packs.update((v) => {
    for (const p of v.list) {
      if (!installed.includes(p.id)) continue
      p.state = { type: 'installed', data: { version: p.version } }
      p.installedKib = p.sizeKib
    }
    for (const [id, chapters] of Object.entries(options.cached ?? {})) {
      v.items[id] = chapters.map((item) => ({ item, pinned: false, queued: false, kib: 40 }))
    }
  })
  const defaults = defaultSettings()
  state.settings.set({
    ...defaults,
    mushafStyle: 'hafs',
    translations: [SAHEEH],
    tafsirPackId: MUYASSAR,
    wbwPackId: WBW_EN,
    uiLanguage: options.lang ?? 'en',
    theme: 'paper',
    motion: 'reduce',
    sidePane: { ...defaults.sidePane, open: true },
    ...options.settings,
  })
  const b = await call(api.appBootstrap())
  await initStores(b)
  flushSync()
  return b
}

/** Every store back to its pre-`init` state, the pane's pin forgotten, and the document clean. */
export function resetAll(): void {
  pane.reset()
  resetStores()
  document.documentElement.removeAttribute('style')
  for (const host of document.querySelectorAll('[data-test-host]')) host.remove()
}

/** Two frames plus `ms`: effects, measurements and the mock's delays have settled. */
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

export const $ = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel)
export const $$ = <T extends Element = HTMLElement>(sel: string): T[] => [
  ...document.querySelectorAll<T>(sel),
]

/** Text without the bidi isolates that wrap references (§11.3), whitespace collapsed. */
export const plain = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/[⁦-⁩]/gu, '').replace(/\s+/g, ' ').trim()

/** The pane's tab of that label (English UI). */
export function tab(label: string): HTMLElement {
  const el = $$<HTMLElement>('[data-qd-pane] [role="tab"]').find((t) => plain(t).startsWith(label))
  if (!el) throw new Error(`no "${label}" tab`)
  return el
}
