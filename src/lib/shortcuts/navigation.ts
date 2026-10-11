/**
 * Navigation shortcuts of §10.1: page turns and flipping, surah and ayah steps, first/last page and ayah, the page rail,
 * navigation history, Go to and search hits, plus the reader's own Escape (§7.7). Owner: WP8e. Registered by the
 * reader store in `init`.
 *
 * - Page turns keep book semantics in both UI languages (§11.3): ← and Page Down are the next page. They are
 *   `repeat: true`: a held key flips (`reader.flip`, §8.11).
 * - ↓/↑ and j/k move the reading cursor (and select), Shift extends the selection (§8.15).
 * - The reader-scoped Escape runs in the capture phase after the layers (§7.7): it clears the selection and the search
 *   hit, else dismisses the "Return to recitation" chip; otherwise the app Escape (zen, views) takes over.
 *
 * The reader store imports this file, so the store is read only inside the handlers (never at module load). Handlers
 * read stores, never `e.target` (the palette runs them with a synthetic event, WP10c).
 */
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import { reader } from '$lib/stores/reader.svelte'
import { search } from '$lib/stores/search.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** A page-turn key: the first press turns with the animation, auto-repeat flips (§8.11). */
function turn(dir: 'next' | 'prev') {
  return (e: KeyboardEvent): void => {
    if (e.repeat) reader.flip(dir)
    else if (dir === 'next') reader.next()
    else reader.prev()
  }
}

/** The focused "Return to recitation" chip takes Escape for itself. */
function followChipFocused(): boolean {
  return document.activeElement?.closest('[data-qd-follow-chip]') != null
}

export const navigationShortcuts: readonly ShortcutDef[] = [
  {
    id: 'nav.nextPage',
    keys: ['ArrowLeft', 'PageDown'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.nextPage',
    scope: 'mushaf',
    repeat: true,
    run: turn('next'),
  },
  {
    id: 'nav.prevPage',
    keys: ['ArrowRight', 'PageUp'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.prevPage',
    scope: 'mushaf',
    repeat: true,
    run: turn('prev'),
  },
  {
    id: 'nav.nextSurah',
    keys: ['Shift+ArrowLeft'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.nextSurah',
    scope: 'reader',
    run: () => reader.surahStep(1),
  },
  {
    id: 'nav.prevSurah',
    keys: ['Shift+ArrowRight'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.prevSurah',
    scope: 'reader',
    run: () => reader.surahStep(-1),
  },
  {
    id: 'nav.firstPage',
    keys: ['Mod+Home'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.firstPage',
    scope: 'reader',
    run: () => reader.edgePage('first'),
  },
  {
    id: 'nav.lastPage',
    keys: ['Mod+End'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.lastPage',
    scope: 'reader',
    run: () => reader.edgePage('last'),
  },
  {
    id: 'nav.nextAyah',
    keys: ['ArrowDown', 'j'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.nextAyah',
    scope: 'reader',
    repeat: true,
    run: () => reader.moveCursor(1),
  },
  {
    id: 'nav.prevAyah',
    keys: ['ArrowUp', 'k'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.prevAyah',
    scope: 'reader',
    repeat: true,
    run: () => reader.moveCursor(-1),
  },
  {
    id: 'nav.extendNext',
    keys: ['Shift+ArrowDown', 'Shift+j'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.extendNext',
    scope: 'reader',
    repeat: true,
    run: () => reader.moveCursor(1, { extend: true }),
  },
  {
    id: 'nav.extendPrev',
    keys: ['Shift+ArrowUp', 'Shift+k'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.extendPrev',
    scope: 'reader',
    repeat: true,
    run: () => reader.moveCursor(-1, { extend: true }),
  },
  {
    id: 'nav.firstAyahOnPage',
    keys: ['Home'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.firstAyahOnPage',
    scope: 'mushaf',
    run: () => reader.cursorToEdge('first'),
  },
  {
    id: 'nav.lastAyahOnPage',
    keys: ['End'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.lastAyahOnPage',
    scope: 'mushaf',
    run: () => reader.cursorToEdge('last'),
  },
  {
    id: 'nav.pageRail',
    keys: ['p'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.pageRail',
    scope: 'mushaf',
    run: () => reader.revealRail(),
  },
  {
    id: 'nav.back',
    keys: ['Alt+ArrowLeft'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.back',
    scope: 'reader',
    // Always handled (a no-op with no history), so the webview's own Alt+← never navigates the app page.
    run: () => reader.back(),
  },
  {
    id: 'nav.forward',
    keys: ['Alt+ArrowRight'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.forward',
    scope: 'reader',
    run: () => reader.forward(),
  },
  {
    id: 'nav.goTo',
    keys: ['Mod+g'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.goTo',
    scope: 'global',
    capture: true,
    run: () => ui.open('goto', {}),
  },
  {
    id: 'nav.nextHit',
    keys: ['F3'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.nextHit',
    scope: 'reader',
    // Always handled (nothing happens without results), so F3 never opens the webview's find bar.
    run: () => {
      if (search.flatHits.length > 0) search.move(1)
    },
  },
  {
    id: 'nav.prevHit',
    keys: ['Shift+F3'],
    group: 'navigation',
    labelKey: 'shortcuts.nav.prevHit',
    scope: 'reader',
    run: () => {
      if (search.flatHits.length > 0) search.move(-1)
    },
  },
  {
    // §7.7, §10.1: after the layers, Escape clears what the reader shows (the app Escape handles zen and views).
    id: 'nav.escape',
    keys: ['Escape'],
    group: 'app',
    labelKey: 'shortcuts.app.escape',
    scope: 'reader',
    capture: true,
    when: () => reader.selection !== null || reader.searchHit !== null || reader.followChip,
    run: () => {
      if (followChipFocused()) reader.dismissFollowChip()
      else reader.escape()
    },
  },
]
