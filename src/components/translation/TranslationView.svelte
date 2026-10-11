<!--
  TranslationView (§9.7, §7.4, §9.8): translation mode, the reader's second body. Takes no props (§7.9).

  The whole Quran is one virtualised feed (`VirtualList`, rows from `rows.ts`): a `SurahCard` before each surah and a
  `VerseRow` per verse, in a centred reading column (760 px, 32 px inline padding) on a fixed paper sheet. Text loads
  through the `translations` store in blocks around the viewport.

  Position, kept by ayah (§7.4):
  - On entry it restores the last pixel position when the reader has not moved since (the store's `anchor`), else
    shows the reading cursor's verse, else the first verse of the reader's pages.
  - While scrolling it reports the page of the verse at the top to the reader (`reader.goToPage`, no history, no
    animation), so the title bar, the saved position and the Mushaf follow; `translations.topAyahId` names the verse.
  - It follows the reader: a jump with a flash (palette, Go to, the Index) brings that verse to the top and focuses it;
    so does a jump that moves the cursor and the page together to a verse off screen (search hits with their words,
    the study pane, memorisation, back/forward), never the page's first verse instead; a cursor move (↑/↓, j/k)
    scrolls the cursor's verse into view; another page change shows that page's first verse unless the page is
    already on screen. A jump made while the feed is still opening is applied once it has opened.
  - With the side card (`reader.dock === 'side'`, §8.2), the column and its paper move toward the inline start just
    enough to keep clear of the card (narrowing only when the canvas is too small), as the Mushaf keeps its pages clear.
  - Recitation (§9.7): the playing verse is kept at 30 % from the top. A manual scroll pauses that for 4 s and offers
    "Return to recitation" while the verse is off screen.
  States (§9.8): no translation to show → `AddTranslationCard`; a selected pack that cannot be shown → `PackNotice`.
  The "Aa" display button (`DisplayControl`, WP8e; owner request 2026-10-11) sits in the top inline-end corner, in the
  gutter beside the column, and opens the reading-display popover (theme, ink, text size), live on the feed.
  Owner: WP11a.
-->
<script lang="ts">
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line'
  import ArrowUpToLine from '@lucide/svelte/icons/arrow-up-to-line'
  import X from '@lucide/svelte/icons/x'
  import { onMount, untrack } from 'svelte'
  import type { HighlightColor } from '$lib/ipc/bindings'
  import VirtualList from '$components/ui/VirtualList.svelte'
  import DisplayControl from '$components/mushaf/DisplayControl.svelte'
  import { overlayReach } from '$components/shell/overlayReach'
  import { i18n, library, player, quran, reader, settings, translations, ui } from '$lib/stores'
  import { parseRef } from '$lib/text/html'
  import { debounce } from '$lib/util/debounce'
  import { nextFrame, rafThrottle } from '$lib/util/raf'
  import star8 from '../../assets/star8.svg'
  import AddTranslationCard from './AddTranslationCard.svelte'
  import PackNotice from './PackNotice.svelte'
  import { buildRows, estimateVerseHeight, type Row } from './rows'
  import SurahCard from './SurahCard.svelte'
  import VerseRow from './VerseRow.svelte'

  /** The reading column (§9.7): max inline size and inline padding, split between the row and the verse box. */
  const COLUMN = 760
  const COLUMN_PADDING = 32
  /** The column never narrows below this to clear the side card (a narrower canvas lets the card overlap instead). */
  const MIN_COLUMN = 520
  /** Room kept above a verse the view jumps to. */
  const TOP_GAP = 12
  /** The playing verse sits this far down the viewport (§9.7). */
  const FOLLOW_AT = 0.3
  /** A manual scroll pauses following the recitation this long (§9.7). */
  const MANUAL_PAUSE_MS = 4000
  /** A scroll this soon after wheel, touch, key or scrollbar input is the user's. */
  const INPUT_WINDOW_MS = 600
  /** Verses loaded above and below the viewport. */
  const PREFETCH_BEFORE = 10
  const PREFETCH_AFTER = 40
  /** The side card's footprint at the canvas's inline end (§8.2): 24 px inset, 272 px card, 16 px of air. */
  const SIDE_CARD_RESERVE = 24 + 272 + 16

  let list: VirtualList<Row> | undefined = $state()
  let root: HTMLDivElement | undefined = $state()
  let width = $state(0)

  /** Rows on screen (first and last index), kept current while scrolling. */
  let visible = $state({ first: -1, last: -1 })
  /** Following the recitation is paused by a manual scroll. */
  let followPaused = $state(false)

  let ready = false
  let ownPage: number | null = null
  let lastInputAt = Number.NEGATIVE_INFINITY
  let lastManualAt = Number.NEGATIVE_INFINITY
  /** What the reader showed when this view last caught up with it. */
  interface ReaderState {
    page: number
    cursor: number | null
    flash: typeof reader.flash
  }
  const readerState = (): ReaderState => ({
    page: reader.page,
    cursor: reader.cursorAyahId,
    flash: reader.flash,
  })
  let seen: ReaderState = untrack(readerState)

  const model = $derived(buildRows(quran.index))
  const rows = $derived(model.rows)
  const setSize = $derived(Math.max(0, rows.length - 1))
  const scale = $derived(settings.value.translationFontPct / 100)
  const empty = $derived(translations.activePacks.length === 0)
  const nastaliq = $derived(translations.packMeta('decor.nastaliq').availability === 'installed')
  const packList = $derived(
    translations.activePacks.map((id) => ({
      meta: translations.packMeta(id),
      title: translations.packTitle(id),
    })),
  )
  const itemSize = $derived(estimateVerseHeight(13, packList.length, scale, settings.value.translationArabic))
  /** Room kept for the side card at the inline end (none in zen, where the card only shows on demand). */
  const reserveEnd = $derived(reader.dock === 'side' && !ui.zen ? SIDE_CARD_RESERVE : 0)
  /** Inner width of the reading column (for the surah card's cartouche); the CSS twin is `--_cw`. */
  const columnWidth = $derived(
    Math.max(240, Math.min(COLUMN, width, Math.max(MIN_COLUMN, width - reserveEnd)) - 2 * COLUMN_PADDING),
  )

  /** Highlight colour, note and bookmark per ayah, from the library (ranges expanded once per change). */
  const highlightOf: ReadonlyMap<number, HighlightColor> = $derived(
    new Map(library.highlights.flatMap((h) => spread(h.fromAyahId, h.toAyahId, h.color))),
  )
  /** The first note on each ayah (a later entry for the same key would win, so the list is reversed). */
  const noteOf: ReadonlyMap<number, string> = $derived(
    new Map([...library.notes].reverse().flatMap((n) => spread(n.fromAyahId, n.toAyahId, n.id))),
  )
  const bookmarked = $derived(library.bookmarkedAyahs)

  /** The verse that holds the roving tab stop: the cursor's when it is on screen, else the first verse on screen. */
  const tabStop = $derived.by(() => {
    const cursor = reader.cursorAyahId
    if (cursor !== null) {
      const row = model.rowOfAyah(cursor)
      if (row >= visible.first && row <= visible.last) return cursor
    }
    for (let r = Math.max(0, visible.first); r <= visible.last; r++) {
      const item = model.at(r)
      if (item?.kind === 'ayah') return item.ayahId
    }
    return cursor ?? model.rows.find((r) => r.kind === 'ayah')?.ayahId ?? 1
  })

  const playingId = $derived(player.isActive && settings.value.followAlong ? player.currentAyahId : null)
  const playingRow = $derived(playingId === null ? -1 : model.rowOfAyah(playingId))
  const showFollowChip = $derived(
    followPaused && playingRow >= 0 && (playingRow < visible.first || playingRow > visible.last),
  )
  /** A verse on screen failed to load: said once, politely, for the view (each row shows its Retry silently). */
  const loadFailed = $derived.by(() => {
    for (let r = Math.max(0, visible.first); r <= visible.last; r++) {
      const item = model.at(r)
      if (item?.kind !== 'ayah') continue
      const st = translations.state(item.ayahId)
      if (st.text === 'error' || st.tr === 'error') return true
    }
    return false
  })
  /** Keep the playing and the cursor's rows mounted, so focus and the follow target survive scrolling. */
  const keepMounted = $derived(
    [...new Set([playingRow, reader.cursorAyahId === null ? -1 : model.rowOfAyah(reader.cursorAyahId)])]
      .filter((r) => r >= 0)
      .sort((a, b) => a - b),
  )

  /** Whether the reader's selection covers both ayahs. */
  function selectionCovers(a: number, b: number): boolean {
    const s = reader.selection
    return s !== null && a >= s.fromAyahId && b <= s.toAyahId
  }

  /** `[ayahId, value]` for every ayah of a range (bounded to the Quran). */
  function spread<T>(from: number, to: number, value: T): [number, T][] {
    const out: [number, T][] = []
    for (let a = Math.max(1, from); a <= Math.min(6236, to); a++) out.push([a, value])
    return out
  }

  // --- geometry ------------------------------------------------------------------------------------------------------

  function view(): { first: number; last: number; offset: number; height: number } | null {
    if (!list) return null
    const height = list.getViewportSize()
    if (height <= 0 || rows.length === 0) return null
    const offset = list.getScrollOffset()
    return {
      first: list.findItemIndex(offset),
      last: list.findItemIndex(offset + height - 1),
      offset,
      height,
    }
  }

  /** Whether any verse of `page` (current layout) is on screen. */
  function pageOnScreen(page: number): boolean {
    const v = view()
    if (!v) return false
    for (let r = v.first; r <= v.last; r++) {
      const item = model.at(r)
      if (item?.kind === 'ayah' && quran.pageOfAyah(reader.layout, item.ayahId) === page) return true
    }
    return false
  }

  function rowOnScreen(row: number): boolean {
    const v = view()
    return v !== null && row >= v.first && row <= v.last
  }

  // --- scrolling -----------------------------------------------------------------------------------------------------

  function prefetch(fromAyah: number, toAyah: number): Promise<void> {
    return translations.ensureWindow(fromAyah - PREFETCH_BEFORE, toAyah + PREFETCH_AFTER)
  }

  /** Brings a verse to the top (its surah card for ayah 1), and with `focus` moves focus to it when focus is free. */
  function jumpTo(ayahId: number, focus: boolean): void {
    const row = model.targetRow(ayahId)
    if (!list || row < 0) return
    void prefetch(ayahId, ayahId)
    ownPage = quran.pageOfAyah(reader.layout, ayahId)
    list.scrollToIndex(row, { align: 'start', offset: -TOP_GAP })
    if (focus) void focusVerse(ayahId, false)
  }

  /** Scrolls a verse into view with the least movement (the cursor moved). */
  function reveal(ayahId: number): void {
    const row = model.rowOfAyah(ayahId)
    if (!list || row < 0) return
    void prefetch(ayahId, ayahId)
    list.scrollToIndex(row, { align: 'nearest' })
    void focusVerse(ayahId, false)
  }

  /** Puts the playing verse 30 % down the viewport, smoothly when it is near. */
  function follow(ayahId: number): void {
    const row = model.rowOfAyah(ayahId)
    const v = view()
    if (!list || !v || row < 0) return
    void prefetch(ayahId, ayahId)
    const top = list.getItemOffset(row) - v.offset
    if (top >= v.height * 0.12 && top <= v.height * 0.45) return
    const near = Math.abs(top) < 3 * v.height
    list.scrollToIndex(row, {
      align: 'start',
      offset: -Math.round(v.height * FOLLOW_AT),
      smooth: near && !settings.reducedMotion,
    })
  }

  /**
   * Focuses a verse once it renders, if focus is in the view, on the canvas or nowhere (never stealing it from the
   * sidebar or a field). `force` focuses it regardless.
   */
  async function focusVerse(ayahId: number, force: boolean): Promise<void> {
    // The jump renders the verse within a few frames, and virtua keeps a row hidden (unfocusable) until it is measured:
    // try each frame, for up to ~0.6 s.
    for (let i = 0; i < 36; i++) {
      await nextFrame()
      const el = document.getElementById(`tv-a${ayahId}`)
      if (!el) continue
      const active = document.activeElement
      if (active === el) return
      const free =
        active === null ||
        active === document.body ||
        active.id === 'qd-main' ||
        (root?.contains(active) ?? false)
      if (!force && !free) return
      el.focus({ preventScroll: true })
      if (document.activeElement === el) return
    }
  }

  const onScrollFrame = rafThrottle(() => {
    const v = view()
    if (!v || !list) return
    if (visible.first !== v.first || visible.last !== v.last) visible = { first: v.first, last: v.last }
    // The verse being read: the one just below the top edge (a verse scrolled almost out reads as the next one).
    const reading = model.ayahAt(list.findItemIndex(v.offset + Math.min(120, v.height * 0.15)))
    // The anchor is measured from the row that opens the top verse (its surah card for ayah 1), so it is never negative.
    const topAyah = model.ayahAt(v.first)
    const anchorRow = model.targetRow(topAyah)
    if (anchorRow >= 0 && reading > 0) {
      translations.anchor = {
        ayahId: topAyah,
        delta: Math.max(0, v.offset - list.getItemOffset(anchorRow)),
        page: quran.pageOfAyah(reader.layout, reading),
      }
    }
    void prefetch(model.ayahAt(v.first), model.ayahAt(v.last))
    if (ready) reportPosition(reading)
  })

  /** The verse being read → `translations.topAyahId`, and its page → the reader (title bar, saved position, Mushaf). */
  const reportPosition = debounce((ayahId: number) => {
    if (ayahId <= 0 || !ready) return
    if (translations.topAyahId !== ayahId) translations.topAyahId = ayahId
    const page = quran.pageOfAyah(reader.layout, ayahId)
    if (page > 0 && page !== reader.page) {
      ownPage = page
      reader.goToPage(page, { push: false, transition: false })
    }
  }, 150)

  function onscroll(): void {
    if (performance.now() - lastInputAt < INPUT_WINDOW_MS) {
      lastManualAt = performance.now()
      if (playingRow >= 0) followPaused = true
    }
    onScrollFrame()
  }

  function noteInput(): void {
    lastInputAt = performance.now()
  }

  // Input that scrolls (wheel, touch, keys, the scroll bar) marks the next scroll events as the user's. Passive
  // listeners: they never delay scrolling.
  $effect(() => {
    const el = root
    if (!el) return
    const onPointerDown = (e: PointerEvent) => {
      // The scroll bar belongs to the scroller itself: a press there is a manual scroll.
      if (e.target instanceof Element && e.target.classList.contains('qd-virtual-list')) noteInput()
    }
    const options = { passive: true, capture: true } as const
    el.addEventListener('wheel', noteInput, options)
    el.addEventListener('touchstart', noteInput, options)
    el.addEventListener('keydown', noteInput, options)
    el.addEventListener('pointerdown', onPointerDown, options)
    return () => {
      el.removeEventListener('wheel', noteInput, options)
      el.removeEventListener('touchstart', noteInput, options)
      el.removeEventListener('keydown', noteInput, options)
      el.removeEventListener('pointerdown', onPointerDown, options)
    }
  })

  // --- following the reader and the recitation -----------------------------------------------------------------------

  /** Catches up with what changed in the reader between `prev` and `next` (see the header). */
  function followReader(prev: ReaderState, next: ReaderState): void {
    if (next.flash !== null && next.flash !== prev.flash) {
      jumpTo(next.flash.ayahId, true)
      return
    }
    const pageMoved = next.page !== prev.page && next.page !== ownPage
    if (next.cursor !== null && next.cursor !== prev.cursor) {
      // A jump without a flash (`goToAyah`: a search hit, a word card, the study pane, back/forward) moves the cursor,
      // usually with the page: an off-screen target comes to the top, never the page's first verse instead. A step to
      // the next or previous verse (↑/↓, j/k) scrolls the least.
      const onNewPage = pageMoved && quran.pageOfAyah(reader.layout, next.cursor) === next.page
      const step = prev.cursor === null ? Number.POSITIVE_INFINITY : Math.abs(next.cursor - prev.cursor)
      if (!rowOnScreen(model.rowOfAyah(next.cursor)) && (onNewPage || step > 1)) jumpTo(next.cursor, true)
      else reveal(next.cursor)
      return
    }
    if (pageMoved && !pageOnScreen(next.page)) jumpTo(quran.pageRange(reader.layout, next.page).from, false)
  }

  $effect(() => {
    const next = readerState()
    untrack(() => {
      // While the feed opens, `seen` keeps the state it opens at: the open sequence catches up once it is ready.
      if (!ready) return
      const prev = seen
      seen = next
      followReader(prev, next)
    })
  })

  $effect(() => {
    const id = playingId
    untrack(() => {
      if (id === null) {
        followPaused = false
        return
      }
      if (!ready) return
      if (performance.now() - lastManualAt < MANUAL_PAUSE_MS) {
        followPaused = !rowOnScreen(model.rowOfAyah(id))
        return
      }
      followPaused = false
      follow(id)
    })
  })

  function returnToRecitation(): void {
    lastManualAt = Number.NEGATIVE_INFINITY
    followPaused = false
    if (playingId !== null) follow(playingId)
  }

  // The text size, the Arabic line, the footnote style or the column width changed (verses reflow): keep the verse at
  // the top where it was.
  $effect(() => {
    void settings.value.translationFontPct
    void settings.value.translationArabic
    void settings.value.footnotesInline
    void columnWidth
    untrack(() => {
      const anchor = translations.anchor
      if (!ready || !list || !anchor) return
      const row = model.targetRow(anchor.ayahId)
      if (row >= 0)
        void nextFrame().then(() => list?.scrollToIndex(row, { align: 'start', offset: anchor.delta }))
    })
  })

  // --- entry ---------------------------------------------------------------------------------------------------------

  /** Where to open: the saved pixel position if the reader is still there, else the cursor, else the pages' start. */
  function entry(): { row: number; offset: number; ayahId: number } | null {
    const layout = reader.layout
    const pages = reader.visiblePages
    const anchor = translations.anchor
    if (anchor && (pages.includes(anchor.page) || anchor.page === reader.page)) {
      const row = model.targetRow(anchor.ayahId)
      if (row >= 0) return { row, offset: anchor.delta, ayahId: anchor.ayahId }
    }
    const cursor = reader.cursorAyahId
    const ayahId =
      cursor !== null && pages.includes(quran.pageOfAyah(layout, cursor))
        ? cursor
        : quran.pageRange(layout, Math.min(...pages)).from
    const row = model.targetRow(ayahId)
    return row >= 0 ? { row, offset: -TOP_GAP, ayahId } : null
  }

  onMount(() => {
    void translations.loadCatalog()
    return () => {
      onScrollFrame.cancel()
      reportPosition.cancel()
      translations.topAyahId = null
    }
  })

  // The list exists (on mount, or when the first translation arrives): open at the entry position, then follow.
  $effect(() => {
    const l = list
    if (!l) return
    let cancelled = false
    untrack(() => {
      ready = false
      void (async () => {
        const start = entry()
        // The reader as the feed opens at it: a jump that arrives meanwhile is applied once the feed is ready.
        const opened = readerState()
        if (start) {
          // Text first (briefly), so the verses at the target render at their final height.
          await Promise.race([prefetch(start.ayahId, start.ayahId), new Promise((r) => setTimeout(r, 200))])
        }
        await nextFrame()
        if (cancelled) return
        if (playingId !== null) follow(playingId)
        else if (start) l.scrollToIndex(start.row, { align: 'start', offset: start.offset })
        await nextFrame()
        await nextFrame()
        if (cancelled) return
        const live = readerState()
        seen = live
        ready = true
        followReader(opened, live)
        onScrollFrame()
      })()
    })
    return () => {
      cancelled = true
      ready = false
    }
  })

  // --- references ----------------------------------------------------------------------------------------------------

  /** A reference in a translation or note (`2:255`, `2:255-257`) opens that verse (§7.6). */
  function onref(ref: string): void {
    const parsed = parseRef(ref)
    if (!parsed) return
    const ayahId = quran.ayahId(parsed.surah, parsed.fromAyah)
    if (ayahId > 0) reader.goToAyah(ayahId, { flash: true, focus: true })
  }

  function dismissFollow(): void {
    followPaused = false
    lastManualAt = performance.now()
  }
</script>

<div
  class="tv"
  bind:this={root}
  bind:clientWidth={width}
  style:--tv-scale={scale}
  style:--tv-reserve-end="{reserveEnd}px"
  data-dock={reader.dock}
  data-qd-view="translation"
>
  {#if empty}
    <div class="empty">
      <AddTranslationCard />
    </div>
  {:else}
    <div class="sheet" aria-hidden="true"></div>
    <div class="stack">
      <div class="column notice-slot"><PackNotice /></div>
      <p class="sr-only" role="status">{loadFailed ? i18n.t('content.verse.translationError') : ''}</p>
      <div class="list">
        <VirtualList
          bind:this={list}
          data={rows}
          getKey={(r) => r.key}
          {itemSize}
          overscan={800}
          {keepMounted}
          role="feed"
          label={i18n.t('content.view.label')}
          {onscroll}
        >
          {#snippet children(row, index)}
            <div class="column">
              {#if row.kind === 'surah'}
                <SurahCard
                  surah={row.surah}
                  {columnWidth}
                  page={quran.pageOfAyah(reader.layout, row.ayahId)}
                  first={index === 0}
                  position={index + 1}
                  {setSize}
                />
              {:else if row.kind === 'ayah'}
                <VerseRow
                  ayahId={row.ayahId}
                  surah={row.surah}
                  ayah={row.ayah}
                  focusable={row.ayahId === tabStop}
                  position={index + 1}
                  {setSize}
                  packs={packList}
                  highlight={highlightOf.get(row.ayahId) ?? null}
                  bookmarked={bookmarked.has(row.ayahId)}
                  noteId={noteOf.get(row.ayahId) ?? null}
                  {nastaliq}
                  {onref}
                />
                {#if model.at(index + 1)?.kind === 'ayah'}
                  <div
                    class="separator"
                    class:joined={selectionCovers(row.ayahId, row.ayahId + 1)}
                    aria-hidden="true"
                  ></div>
                {/if}
              {:else}
                <div class="end" aria-hidden="true">
                  <span class="star" style:--_star={`url("${star8}")`}></span>
                </div>
              {/if}
            </div>
          {/snippet}
        </VirtualList>
      </div>
    </div>
    {#if showFollowChip}
      <div class="follow" role="status" {@attach overlayReach('translation-follow')}>
        <button type="button" class="chip" onclick={returnToRecitation}>
          {#if playingRow < visible.first}
            <ArrowUpToLine size={16} strokeWidth={1.75} aria-hidden="true" />
          {:else}
            <ArrowDownToLine size={16} strokeWidth={1.75} aria-hidden="true" />
          {/if}
          {i18n.t('content.follow.back')}
        </button>
        <button type="button" class="dismiss" aria-label={i18n.t('common.dismiss')} onclick={dismissFollow}>
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    {/if}
  {/if}
  <!-- Outside the feed's scroller, after it in tab order. -->
  <DisplayControl />
</div>

<style>
  .tv {
    position: relative;
    block-size: 100%;
    min-block-size: 0;
    overflow: hidden;
    background-color: var(--surface-app);
  }

  /* The reading column's width and start offset, shared by the paper and every row (percentages of their container):
     centred, but moved toward the inline start just enough to clear the side card (`--tv-reserve-end`, §8.2), and
     narrowed for it down to 520 px. */
  .tv {
    --_cw: min(760px, 100%, max(520px, 100% - var(--tv-reserve-end, 0px)));
    --_cstart: max(0px, min((100% - var(--_cw)) / 2, 100% - var(--tv-reserve-end, 0px) - var(--_cw)));
  }

  /* The paper the column sits on: fixed, while the verses scroll over it. */
  .sheet {
    position: absolute;
    inset-block: 0;
    inset-inline-start: var(--_cstart);
    inline-size: var(--_cw);
    background-color: var(--surface-page);
    box-shadow: var(--shadow-page);
    pointer-events: none;
  }

  .stack {
    position: relative;
    display: flex;
    flex-direction: column;
    block-size: 100%;
  }

  .list {
    flex: 1;
    min-block-size: 0;
  }

  .column {
    box-sizing: border-box;
    inline-size: var(--_cw);
    margin-inline-start: var(--_cstart);
    padding-inline: var(--space-4);
  }

  .notice-slot:empty {
    display: none;
  }

  .separator {
    block-size: 1px;
    margin-inline: var(--space-4);
    background-color: var(--border);
  }

  /* Between two selected verses: part of the selection block, carrying the ring's sides. */
  .separator.joined {
    margin-inline: 0;
    background-color: var(--hl-selection);
    box-shadow:
      inset 1px 0 0 var(--hl-selection-ring),
      inset -1px 0 0 var(--hl-selection-ring);
  }

  /* After An-Nas: a closing star, and room for the dock to float over without covering the last verse. */
  .end {
    display: flex;
    justify-content: center;
    padding-block: var(--space-10) 160px;
  }

  .end .star {
    inline-size: 28px;
    block-size: 28px;
    background-color: var(--frame-gold);
    mask: var(--_star) center / contain no-repeat;
    opacity: 0.8;
  }

  .empty {
    display: grid;
    place-items: center;
    block-size: 100%;
    padding: var(--space-6);
    overflow: auto;
  }

  /* "Return to recitation" (§9.7): bottom centre of the room left by the side card, above the dock bar. */
  .follow {
    position: absolute;
    inset-inline: 0 var(--tv-reserve-end, 0px);
    inset-block-end: 96px;
    z-index: var(--z-popover);
    display: flex;
    align-items: center;
    gap: 2px;
    inline-size: fit-content;
    margin-inline: auto;
    padding: 3px;
    border-radius: var(--radius-full);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
  }

  .tv[data-dock='side'] .follow {
    inset-block-end: var(--space-6);
  }

  .chip,
  .dismiss {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    border-radius: var(--radius-full);
    cursor: pointer;
  }

  .chip {
    block-size: 30px;
    padding-inline: var(--space-3) var(--space-4);
    background-color: var(--accent);
    color: var(--accent-ink);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .dismiss {
    justify-content: center;
    inline-size: 26px;
    block-size: 26px;
    color: var(--text-muted);
  }

  .chip:hover {
    background-color: var(--accent-strong);
  }

  .dismiss:hover {
    background-color: var(--surface-hover);
  }

  .chip:focus-visible,
  .dismiss:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (forced-colors: active) {
    .end .star {
      background-color: CanvasText;
    }

    .chip {
      border: 1px solid ButtonText;
    }
  }
</style>
