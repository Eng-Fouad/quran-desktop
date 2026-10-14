/**
 * How search hits open: the reader-backed `HitOpener` of the `search` store.
 *
 * The store is an L1 store and must not import the reader, so the search components install this opener when
 * they load: `SearchPanel.svelte` (statically imported by the shell's `Sidebar`) calls `installHitOpener()` from its
 * module script, so F3 works from the first page even while the Search tab is closed.
 *
 * - **Open** shows the reader, then `reader.goToAyah(id, { select, highlightWords, flash, focus })`: the ayah is
 *   selected (the action target and the side pane follow it), its matched words go on the search-hit layer, which
 *   pulses twice on arrival. A hit without words (translation, notes) flashes the ayah instead, so the arrival still
 *   shows. With `focus` the ayah's roving item (in translation mode, its verse) takes focus and is announced.
 * - **Open in side pane** (`Mod+Enter`, middle click) selects the ayah without turning the page and opens the pane on
 *   its tab: Notes for a note hit, else the pane's current tab.
 */
import type { SearchHit } from '$lib/ipc/bindings'
import { openPaneFor } from '$lib/shortcuts/study'
import { reader } from '$lib/stores/reader.svelte'
import { type HitOpener, search } from '$lib/stores/search.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** Frames the verse of a hit may take to show in translation mode's virtual list (as `TranslationView` waits). */
const VERSE_FOCUS_FRAMES = 36

export const hitOpener: HitOpener = {
  open(hit: SearchHit, { highlightWords, focus }): void {
    ui.setView('reader')
    reader.goToAyah(hit.ayahId, {
      select: true,
      highlightWords,
      flash: highlightWords.length === 0,
      focus,
    })
    // Translation mode: the reader announces the hit but leaves focus where it is (the Mushaf moves it to the ayah's
    // item). Move it to the verse, which the feed brings to the top; a far row takes a few frames to show.
    if (focus && settings.value.readingMode === 'translation') {
      void ui.focusWhenRendered(`#tv-a${hit.ayahId}`, VERSE_FOCUS_FRAMES)
    }
  },
  openInPane(hit: SearchHit): void {
    openPaneFor(hit.ayahId, hit.noteId !== null ? 'notes' : undefined)
  },
}

let installed = false

/** Installs `hitOpener` in the store (once; later calls do nothing). */
export function installHitOpener(): void {
  if (installed) return
  installed = true
  search.setOpener(hitOpener)
}
