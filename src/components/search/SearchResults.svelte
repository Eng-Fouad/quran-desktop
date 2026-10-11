<!--
  SearchResults (§9.7): the grouped, virtualised list of hits (`VirtualList`, so 2,000 hits scroll like 20). Owner:
  WP10b. Used only inside `SearchPanel`.

  - Rows: a 32 px `ResultGroup` header per surah, then its `ResultItem` hits. The header of the group at the top of the
    viewport sticks over the list (an overlay that the next header pushes up), with the filter button "Only in …".
  - Quran hits fit their word window to three lines of the list's measured width (`hitWindow`, canvas-measured words
    in the Quran font, re-measured when fonts load).
  - Keyboard: one Tab stop (the active hit, else the first); ↑/↓ move between hits (↑ on the first goes back to the
    field), Home/End, PageUp/PageDown; Enter opens the hit (focus moves to the ayah), `Mod+Enter` opens it in the side
    pane, F3 / Shift+F3 step through the hits, Shift+F10 or the Menu key opens the hit menu, and typing a character
    continues in the field. Middle click opens the side pane; right click the menu (§10.3: Open · Open in side pane ·
    Copy · Bookmark).
  - The list follows `search.activeIndex` (F3 from the reader, Enter in the field): the active hit scrolls into view,
    clear of the sticky header. A remounted list (switching sidebar tabs) returns to where it was.
-->
<script lang="ts" module>
  import type { SearchResults as Results } from '$lib/ipc/bindings'

  /** Scroll offsets of results lists that unmounted (the Search tab was left), per results object. */
  const savedOffsets = new WeakMap<Results, number>()
</script>

<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import BookmarkMinus from '@lucide/svelte/icons/bookmark-minus'
  import Copy from '@lucide/svelte/icons/copy'
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right'
  import PanelRight from '@lucide/svelte/icons/panel-right'
  import { onMount, tick, untrack } from 'svelte'
  import { ContextMenu, type MenuEntry, type Point, VirtualList } from '$components/ui'
  import type { SearchGroup, SearchHit } from '$lib/ipc/bindings'
  import { copySpan, toggleBookmarkAt } from '$lib/shortcuts/study'
  import { app, i18n, library, packs, quran, search } from '$lib/stores'
  import { hitKey } from '$lib/stores/search.svelte'
  import ResultGroup from './ResultGroup.svelte'
  import ResultItem from './ResultItem.svelte'
  import { canvasMeasurer, forgetWidths, type LineFit, MAX_LINES } from './window'

  interface Props {
    results: Results
    /** Moves focus to the search field, appending a typed character. */
    onfield: (append?: string) => void
  }

  let { results, onfield }: Props = $props()

  /** Layout constants, also handed to the rows as CSS variables (the line width is derived from them). */
  const CELL_PAD = 4
  const PAD_START = 12
  const PAD_END = 10
  const GROUP_H = 32
  const GROUP_GAP = 8
  /** Hit rows moved by PageUp/PageDown. */
  const PAGE_STEP = 6
  /** Frames a far row may take to mount after a jump. */
  const MOUNT_FRAMES = 8
  /** Quran text size of a hit (§9.7). */
  const QURAN_PX = 22

  type Row =
    | { type: 'group'; key: string; group: SearchGroup; first: boolean }
    | { type: 'hit'; key: string; hit: SearchHit; index: number }

  const model = $derived.by(() => {
    const rows: Row[] = []
    const hitRow: number[] = []
    const groupRow: number[] = []
    let index = 0
    for (const [gi, group] of results.groups.entries()) {
      groupRow.push(rows.length)
      rows.push({ type: 'group', key: `g${group.surah}`, group, first: gi === 0 })
      for (const hit of group.hits) {
        hitRow.push(rows.length)
        rows.push({ type: 'hit', key: hitKey(hit), hit, index: index++ })
      }
    }
    return { rows, hitRow, groupRow }
  })

  const hitCount = $derived(model.hitRow.length)
  const canFilter = $derived(search.surahFilter === null && results.groups.length > 1)

  let host: HTMLDivElement | null = $state(null)
  let list: VirtualList<Row> | undefined = $state()
  let scrollTop = $state(0)
  /** The list's inner width (no scrollbar) and the scrollbar's width. */
  let width = $state(0)
  let scrollbar = $state(0)
  /** The hit that holds (or last held) focus inside the list, for the Tab stop. */
  let focusIndex = $state<number | null>(null)

  const tabStop = $derived(
    focusIndex !== null && focusIndex < hitCount
      ? focusIndex
      : search.activeIndex >= 0 && search.activeIndex < hitCount
        ? search.activeIndex
        : 0,
  )
  const keepMounted = $derived.by(() => {
    const row = model.hitRow[tabStop]
    return row === undefined ? undefined : [row]
  })

  // --- fitting Quran words to the width -----------------------------------------------------------------------------

  let fontVersion = $state(0)
  let quranFont = $state(`${QURAN_PX}px qd-hafs`)

  const fit: LineFit | null = $derived.by(() => {
    void fontVersion
    const measure = canvasMeasurer(quranFont)
    const lineWidth = width - 2 * CELL_PAD - PAD_START - PAD_END - 1
    if (!measure || lineWidth <= 0) return null
    return { measure, space: measure(' '), lineWidth, maxLines: MAX_LINES }
  })

  onMount(() => {
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-quran').trim()
    if (family !== '') quranFont = `${QURAN_PX}px ${family}`
    const fonts = document.fonts
    if (!fonts) return
    let ready = fonts.check(quranFont)
    const onDone = () => {
      const now = fonts.check(quranFont)
      if (now === ready) return
      ready = now
      forgetWidths()
      fontVersion++
    }
    fonts.addEventListener('loadingdone', onDone)
    return () => fonts.removeEventListener('loadingdone', onDone)
  })

  $effect(() => {
    const scroller = host?.querySelector<HTMLElement>('.qd-virtual-list')
    if (!scroller) return
    const measure = () => {
      width = scroller.clientWidth
      scrollbar = Math.max(0, scroller.offsetWidth - scroller.clientWidth)
    }
    measure()
    // A new width re-fits the hits (their heights change): apply it in the next frame, outside the observer's
    // delivery, so the rows' own observers never see a resize loop.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(scroller)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  })

  // --- the sticky group header --------------------------------------------------------------------------------------

  /** The index of the last element ≤ `value` in an ascending array (0 when none). */
  function floorIndex(arr: readonly number[], value: number): number {
    let lo = 0
    let hi = arr.length - 1
    let found = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((arr[mid] ?? 0) <= value) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found
  }

  const sticky = $derived.by(() => {
    if (!list || scrollTop <= 0.5) return null
    const { groupRow, rows } = model
    const g = floorIndex(groupRow, list.findItemIndex(scrollTop))
    const row = rows[groupRow[g] ?? -1]
    if (row?.type !== 'group') return null
    let push = 0
    const next = groupRow[g + 1]
    if (next !== undefined) {
      const nextTop = list.getItemOffset(next) + GROUP_GAP - scrollTop
      push = Math.min(0, nextTop - GROUP_H)
    }
    return { group: row.group, push }
  })

  // --- following the active hit and keeping the place -----------------------------------------------------------------

  /** Scrolls a hit into view (below the sticky header); a group's first hit brings its header along. */
  function reveal(i: number): void {
    const row = model.hitRow[i]
    if (row === undefined || !list) return
    const top = list.getItemOffset(row)
    const bottom = row + 1 < model.rows.length ? list.getItemOffset(row + 1) : list.getScrollSize()
    const offset = list.getScrollOffset()
    const view = list.getViewportSize()
    const firstOfGroup = model.rows[row - 1]?.type === 'group'
    if (top < offset + GROUP_H) {
      if (firstOfGroup) list.scrollToIndex(row - 1, { align: 'start' })
      else list.scrollToIndex(row, { align: 'start', offset: -GROUP_H })
    } else if (bottom > offset + view) {
      list.scrollToIndex(row, { align: 'end' })
    }
  }

  /** A focus move still waiting for its row to mount: keys pressed meanwhile count from it. */
  let pending: number | null = null
  /** Bumped by every focus move, so an older one waiting for its row gives up. */
  let focusSeq = 0

  async function focusHit(i: number): Promise<void> {
    if (hitCount === 0) return
    const target = Math.max(0, Math.min(hitCount - 1, i))
    const seq = ++focusSeq
    pending = null
    focusIndex = target
    reveal(target)
    const row = () => host?.querySelector<HTMLElement>(`[data-hit="${target}"]`) ?? null
    const now = row()
    if (now) {
      now.focus({ preventScroll: true })
      return
    }
    // Far away: the row mounts within a few frames (kept mounted as the Tab stop) and virtua may render it again
    // once the scroll settles, so focus follows the row until it is the one in the list.
    pending = target
    await tick()
    for (let frame = 0; frame < MOUNT_FRAMES; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (seq !== focusSeq) return
      const el = row()
      const active = document.activeElement
      // Never take focus back from somewhere else the user went meanwhile.
      const ours = active === null || active === document.body || (host?.contains(active) ?? false)
      if (el && active !== el && ours) el.focus({ preventScroll: true })
    }
    if (seq === focusSeq) pending = null
  }

  /** Focuses the list's Tab stop (ArrowDown from the field). */
  export function focusList(): void {
    void focusHit(tabStop)
  }

  // A new set of results starts at the top, or at the active hit; a remount returns to the saved place.
  let shown: Results | null = null
  $effect(() => {
    const r = results
    if (!list) return
    untrack(() => {
      if (r === shown) return
      const first = shown === null
      shown = r
      focusIndex = null
      const saved = first ? savedOffsets.get(r) : undefined
      if (saved !== undefined) list?.scrollTo(saved)
      else if (search.activeIndex >= 0) reveal(search.activeIndex)
      else if (!first) {
        // Directly on the scroller: virtua's scrollTo keeps correcting until the rows are measured, which would
        // pull the list back if the user scrolled meanwhile. A fresh list starts at the top anyway.
        const scroller = host?.querySelector<HTMLElement>('.qd-virtual-list')
        if (scroller) scroller.scrollTop = 0
      }
    })
  })

  $effect(() => {
    const r = results
    return () => {
      if (list) savedOffsets.set(r, list.getScrollOffset())
    }
  })

  // F3, Enter in the field and clicks move the active hit: keep it in view (and focus it when the list has focus).
  $effect(() => {
    const i = search.activeIndex
    if (i < 0 || !list) return
    untrack(() => {
      if (host?.contains(document.activeElement)) void focusHit(i)
      else reveal(i)
    })
  })

  // --- opening and the menu -------------------------------------------------------------------------------------------

  function open(hit: SearchHit): void {
    search.openHit(hit, { focus: true })
  }

  let menuAt = $state<Point | null>(null)
  let menuHit = $state<SearchHit | null>(null)

  function openMenu(hit: SearchHit, e: MouseEvent): void {
    e.preventDefault()
    menuHit = hit
    menuAt = { x: e.clientX, y: e.clientY }
  }

  function openMenuAt(hit: SearchHit, button: HTMLElement): void {
    const r = button.getBoundingClientRect()
    menuHit = hit
    menuAt = { x: i18n.dir === 'rtl' ? r.right - 24 : r.left + 24, y: r.top + 28 }
  }

  const paneKbd = $derived(app.isMac ? '⌘↩' : 'Ctrl+Enter')

  const menuItems: MenuEntry[] = $derived.by(() => {
    const hit = menuHit
    if (hit === null) return []
    const marked = library.bookmarkedAyahs.has(hit.ayahId)
    return [
      {
        id: 'open',
        label: i18n.t('common.open'),
        icon: CornerDownRight,
        kbd: 'Enter',
        onSelect: () => open(hit),
      },
      {
        id: 'pane',
        label: i18n.t('search.menu.openPane'),
        icon: PanelRight,
        kbd: paneKbd,
        onSelect: () => search.openInPane(hit),
      },
      { type: 'separator', id: 'sep' },
      {
        id: 'copy',
        label: i18n.t('common.copy'),
        icon: Copy,
        onSelect: () => void copySpan({ from: hit.ayahId, to: hit.ayahId }, 'format'),
      },
      {
        id: 'bookmark',
        label: i18n.t(marked ? 'search.menu.unbookmark' : 'search.menu.bookmark'),
        icon: marked ? BookmarkMinus : Bookmark,
        onSelect: () => toggleBookmarkAt(hit.ayahId),
      },
    ]
  })

  // --- keyboard -------------------------------------------------------------------------------------------------------

  function onkeydown(e: KeyboardEvent): void {
    if (e.isComposing) return
    const button = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-hit]')
    if (!button) return
    const i = pending ?? Number(button.dataset.hit)
    const hit = search.flatHits[i]
    if (!hit) return
    const mod = e.ctrlKey || e.metaKey
    const plain = !mod && !e.altKey && !e.shiftKey
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (!plain) return
        e.preventDefault()
        if (e.key === 'ArrowUp' && i === 0) onfield()
        else void focusHit(i + (e.key === 'ArrowDown' ? 1 : -1))
        return
      case 'Home':
      case 'End':
        if (!plain) return
        e.preventDefault()
        void focusHit(e.key === 'Home' ? 0 : hitCount - 1)
        return
      case 'PageDown':
      case 'PageUp':
        if (!plain) return
        e.preventDefault()
        void focusHit(i + (e.key === 'PageDown' ? PAGE_STEP : -PAGE_STEP))
        return
      case 'Enter':
        if (mod && !e.altKey) {
          e.preventDefault()
          search.openInPane(hit)
        }
        return
      case 'F3':
        if (mod || e.altKey) return
        e.preventDefault()
        search.move(e.shiftKey ? -1 : 1, { focus: false })
        return
      case 'F10':
        if (!e.shiftKey || mod || e.altKey) return
        e.preventDefault()
        openMenuAt(hit, button)
        return
      case 'ContextMenu':
        e.preventDefault()
        openMenuAt(hit, button)
        return
    }
    // Type to search: a printable character continues in the field (Space still activates the hit).
    if (!mod && !e.altKey && [...e.key].length === 1 && !/\s/u.test(e.key)) {
      e.preventDefault()
      onfield(e.key)
    }
  }

  function onfocusin(e: FocusEvent): void {
    const i = Number((e.target as HTMLElement | null)?.closest<HTMLElement>('[data-hit]')?.dataset.hit)
    if (Number.isInteger(i) && i >= 0) focusIndex = i
  }

  /** Direction and language of a translation snippet; notes follow their own text. */
  const snippetText = $derived.by((): { lang: string | null; dir: 'ltr' | 'rtl' | 'auto' } => {
    if (search.scope.type !== 'translation') return { lang: null, dir: 'auto' }
    const pack = packs.pack(search.scope.data.packId)
    return { lang: pack?.language ?? null, dir: pack?.direction ?? 'auto' }
  })

  /** Titles of the user's notes, for note hits (the hit carries the snippet only). */
  const noteTitles: ReadonlyMap<string, string> = $derived(
    search.scope.type === 'notes'
      ? new Map(library.notes.flatMap((n) => (n.title?.trim() ? [[n.id, n.title.trim()] as const] : [])))
      : new Map(),
  )

  function onfilter(surah: number): void {
    search.setFilters({ surah, juz: null })
  }
</script>

<!-- Keyboard delegation for the hit buttons inside (they carry the semantics). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="results"
  bind:this={host}
  style:--qd-search-cell="{CELL_PAD}px"
  style:--qd-search-pad-start="{PAD_START}px"
  style:--qd-search-pad-end="{PAD_END}px"
  style:--qd-search-group-gap="{GROUP_GAP}px"
  {onkeydown}
  {onfocusin}
>
  <VirtualList
    bind:this={list}
    data={model.rows}
    getKey={(row) => row.key}
    itemSize={96}
    overscan={480}
    {keepMounted}
    role="list"
    label={i18n.t('search.results.label')}
    onscroll={(offset) => (scrollTop = offset)}
    class="search-list"
  >
    {#snippet children(row)}
      {#if row.type === 'group'}
        <div class={['cell', 'group-cell', { first: row.first }]} role="listitem">
          <ResultGroup group={row.group} {canFilter} {onfilter} />
        </div>
      {:else}
        <div class="cell" role="listitem">
          <ResultItem
            hit={row.hit}
            index={row.index}
            active={row.index === search.activeIndex}
            tabStop={row.index === tabStop}
            {fit}
            textLang={snippetText.lang}
            textDir={snippetText.dir}
            noteTitle={row.hit.noteId === null ? null : (noteTitles.get(row.hit.noteId) ?? null)}
            onopen={open}
            onpane={(h) => search.openInPane(h)}
            onmenu={openMenu}
          />
        </div>
      {/if}
    {/snippet}
  </VirtualList>

  {#if sticky}
    <div
      class="sticky"
      style:translate="0 {sticky.push}px"
      style:inset-inline-end="{scrollbar}px"
      data-sticky-group={sticky.group.surah}
    >
      <ResultGroup group={sticky.group} {canFilter} {onfilter} stuck />
    </div>
  {/if}
</div>

<ContextMenu
  at={menuAt}
  onClose={() => (menuAt = null)}
  items={menuItems}
  label={menuHit ? i18n.t('search.menu.label', { ref: quran.refLabel(menuHit.ayahId, 'long') }) : undefined}
/>

<style>
  .results {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-block-size: 0;
    overflow: hidden;
  }

  .results :global(.search-list) {
    flex: 1 1 auto;
    min-block-size: 0;
    padding-block-end: var(--space-3);
  }

  .cell {
    padding-block: 1px;
    padding-inline: var(--qd-search-cell);
  }

  .group-cell {
    padding-block: var(--qd-search-group-gap) 0;
  }

  .group-cell.first {
    padding-block-start: 0;
  }

  /* The header of the group at the top, over the list (pushed up by the next header). */
  .sticky {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    z-index: 1;
    padding-inline: var(--qd-search-cell);
    background-color: var(--surface-chrome);
  }

  :global(:root[data-chrome='vibrant']) .sticky {
    backdrop-filter: blur(20px) saturate(1.3);
  }

  @media (prefers-reduced-transparency: reduce) {
    .sticky {
      background-color: var(--surface-app);
      backdrop-filter: none;
    }
  }
</style>
