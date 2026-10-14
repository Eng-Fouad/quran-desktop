/**
 * Shared set-up of the Index browser tests: the stores booted on an index (the tests pass the synthetic one: real
 * Tanzil metadata, so surah names, divisions and the 604 page starts are the Mushaf's), the UI language on `<html>`,
 * and a clean slate afterwards. Only test files may import the IPC mock, so the index comes in as an argument.
 */
import { vi } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import type { Bootstrap, QuranIndex } from '$lib/ipc/bindings'
import { library } from '$lib/stores/library.svelte'
import { packs } from '$lib/stores/packs.svelte'
import { player } from '$lib/stores/player.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { ui } from '$lib/stores/ui.svelte'
import { indexView } from '../state.svelte'

export interface BootOptions {
  index: QuranIndex
  lang?: 'en' | 'ar'
  page?: number
  theme?: string
}

/** Boots the L0 stores the Index reads, in the given UI language, with the reader on `page`. */
export function bootIndex(options: BootOptions): void {
  const { index } = options
  const lang = options.lang ?? 'en'
  const html = document.documentElement
  html.lang = lang
  html.dir = lang === 'ar' ? 'rtl' : 'ltr'
  html.dataset.theme = options.theme ?? 'paper'
  html.dataset.accent = 'teal'
  settings.value = { ...defaultSettings(), uiLanguage: lang }
  quran.init({ index } as unknown as Bootstrap)
  reader.reset()
  reader.page = options.page ?? 1
}

/** Gives the current reciter (7) a recitation pack with these surahs downloaded (pinned) or cached. */
export function setRecitation(items: { item: number; pinned: boolean; queued?: boolean }[]): void {
  player.reciters = [
    {
      id: 7,
      packId: 'audio.qdc.7',
      name: { en: 'Mishary Rashid Alafasy', ar: 'مشاري راشد العفاسي' },
      style: null,
      wordLevel: true,
      sizeKib: 1_000_000,
      downloadedSurahs: 0,
      cachedSurahs: 0,
    },
  ]
  packs.items.set(
    'audio.qdc.7',
    items.map((i) => ({ item: i.item, pinned: i.pinned, queued: i.queued ?? false, kib: 100 })),
  )
}

/** Two frames plus `ms`: effects, bits-ui positioning and short transitions have settled. */
export async function settle(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Everything back to the pre-test state (stores, the Index view state, spies, rendered hosts). */
export function resetIndex(): void {
  vi.restoreAllMocks()
  indexView.reset()
  ui.reset()
  library.reset()
  packs.reset()
  player.reset()
  reader.reset()
  quran.reset()
  settings.reset()
  const html = document.documentElement
  html.lang = 'en'
  html.dir = 'ltr'
  for (const host of document.querySelectorAll('[data-test-host]')) host.remove()
}
