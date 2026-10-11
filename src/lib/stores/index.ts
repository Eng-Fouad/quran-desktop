/**
 * Store bootstrap (§7.2; WP0C, frozen). Every store implements `init(b)` and `reset()` (§7.9), so this file never
 * changes when a store grows. Layering, which keeps imports acyclic:
 * - L0 `app, settings, i18n, quran, ui, shortcuts`
 * - L1 `pages, fonts, library, history, packs, translations, search`
 * - L2 `player` (never imports reader or memo), `reader` (may import player), `memo` (may import reader and player)
 *
 * Components may import stores from this barrel; stores import each other by file, never through it.
 */
import type { Store } from '$lib/contracts/stores'
import type { Bootstrap } from '$lib/ipc/bindings'
import { app } from './app.svelte'
import { fonts } from './fonts.svelte'
import { history } from './history.svelte'
import { i18n } from './i18n.svelte'
import { library } from './library.svelte'
import { memo } from './memo.svelte'
import { packs } from './packs.svelte'
import { pages } from './pages.svelte'
import { player } from './player.svelte'
import { quran } from './quran.svelte'
import { reader } from './reader.svelte'
import { search } from './search.svelte'
import { settings } from './settings.svelte'
import { shortcuts } from './shortcuts.svelte'
import { translations } from './translations.svelte'
import { ui } from './ui.svelte'

/** The `init` order (§7.2). `reset` runs in reverse. */
export const STORE_ORDER = [
  app,
  settings,
  i18n,
  quran,
  ui,
  shortcuts,
  library,
  history,
  packs,
  fonts,
  pages,
  translations,
  search,
  player,
  reader,
  memo,
] as const satisfies readonly Store[]

/** Initialises every store from the bootstrap, in order, awaiting each (`main.ts`, after `appBootstrap`). */
export async function initStores(b: Bootstrap): Promise<void> {
  for (const store of STORE_ORDER) await store.init(b)
}

/** Returns every store to its pre-`init` state, in reverse order (tests). */
export function resetStores(): void {
  for (const store of [...STORE_ORDER].reverse()) store.reset()
}

export {
  app,
  fonts,
  history,
  i18n,
  library,
  memo,
  packs,
  pages,
  player,
  quran,
  reader,
  search,
  settings,
  shortcuts,
  translations,
  ui,
}
