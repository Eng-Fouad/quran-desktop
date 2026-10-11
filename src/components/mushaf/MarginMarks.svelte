<!--
  MarginMarks (§8.9). Owner: WP8c. The user's marks on a page, shown while `highlightBookmarks` ("show bookmarks and
  notes in the margin") is on:

  - ayah bookmarks (a filled bookmark glyph, 0.55·qfs, --accent) and notes (a note glyph, 0.5·qfs, --text-muted),
    stacked in the outer margin after the markers of the ayah's first line (0.2·qfs gap), or centred on that line. A
    bookmark click selects its ayah; the note's tooltip shows its first 80 characters and a click opens the side pane
    on the Notes tab.
  - the reading bookmark: a silk ribbon hanging from the top paper edge on the spine side, down to the ayah's line
    + 0.6·qfs, ending in a V-notched tail (--ribbon, a 1 px darker edge, and a drop shadow equivalent to shadow-1
    that follows the notch). A click opens a popover ("Reading bookmark · 2:255 · moved 3 days ago · Move here
    (Shift+B)"); a move animates over 250 ms (--dur-gentle, instant under reduced motion).
  - page bookmark: a 1.2·qfs dog-ear at the outer top corner in --accent-soft.

  Data (§1.2 step 4): the page's `user_marks` through the library store's marks cache (`library.marksFor`, the same
  key as the highlight layer's, so one request serves both), reloaded whenever the store replaces its bookmark or note
  list (after its own mutations, optimistically, and after a `user-data-changed` from another surface); the reading
  bookmark from `library.readingBookmark`. Decorative thumbnails (`interactive = false`) load and draw no marks.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { Button, Kbd, Popover, Tooltip } from '$components/ui'
  import { mergeProps } from 'bits-ui'
  import MoveDown from '@lucide/svelte/icons/move-down'
  import type { PageFurnitureProps } from '$lib/contracts/components'
  import type { ShortcutDef } from '$lib/contracts/shortcuts'
  import type { MushafLayout, UserMarks } from '$lib/ipc/bindings'
  import { api, call } from '$lib/ipc'
  import { getPageContext, isOpeningPage } from '$lib/mushaf/geometry'
  import {
    marginLabelsVisible,
    notePreview,
    pageMarkers,
    pageMarks,
    placeMarkers,
    placeMarks,
    ribbonGeometry,
    round2,
    type MarginMark,
  } from '$lib/mushaf/ornaments'
  import { fonts, i18n, library, quran, reader, settings, shortcuts, ui } from '$lib/stores'

  let { data, qfs, side }: PageFurnitureProps = $props()

  /** How many note bodies one page asks for (a page holds at most a few dozen ayahs). */
  const NOTE_LIMIT = 200

  const page = getPageContext()
  const interactive = $derived(page?.interactive ?? false)
  const opening = $derived(isOpeningPage(data.page))
  const enabled = $derived(interactive && settings.value.highlightBookmarks)

  // ---- data -----------------------------------------------------------------------------------------------------

  let marks = $state.raw<UserMarks | null>(null)
  let bodies = $state.raw<ReadonlyMap<string, string>>(new Map())

  /**
   * The page's marks from the library store's cache (`marksFor`, WP11c), which empties itself before it replaces a
   * list; a store that keeps no cache (it resolves null) leaves the command to answer directly.
   */
  async function loadMarks(
    layout: MushafLayout,
    pageNo: number,
    from: number,
    to: number,
  ): Promise<UserMarks> {
    const stored = await library.marksFor(layout, [pageNo], from, to)
    return stored ?? (await call(api.userMarks(layout, from, to, [pageNo])))
  }

  $effect(() => {
    if (!enabled) {
      marks = null
      return
    }
    // The store replaces these lists on every change that can move a mark: its own mutations (at once, before the
    // command's event) and the re-read after a `user-data-changed` from another surface. A re-read that brings nothing
    // new keeps the old array, so the marks reload only when something did change.
    void library.bookmarks
    void library.notes
    const { layout, page: pageNo } = data
    const { firstAyahId, lastAyahId } = data.info
    let cancelled = false
    untrack(() => loadMarks(layout, pageNo, firstAyahId, lastAyahId)).then(
      (m) => {
        if (!cancelled) marks = m
      },
      (e: unknown) => {
        if (!cancelled) console.warn(`[qd] margin marks for page ${pageNo} could not be loaded`, e)
      },
    )
    return () => {
      cancelled = true
    }
  })

  // Note bodies for the tooltips: from the library store when it has them, else one `note_list` for the page.
  $effect(() => {
    const notes = marks?.notes ?? []
    if (notes.length === 0) {
      bodies = new Map()
      return
    }
    const known = new Map(library.notes.map((n) => [n.id, n.body] as const))
    if (notes.every((n) => known.has(n.id))) {
      bodies = new Map(notes.map((n) => [n.id, known.get(n.id) ?? ''] as const))
      return
    }
    const { firstAyahId, lastAyahId } = data.info
    let cancelled = false
    call(api.noteList({ fromAyahId: firstAyahId, toAyahId: lastAyahId, tagId: null, limit: NOTE_LIMIT }))
      .then((list) => {
        if (!cancelled) bodies = new Map(list.map((n) => [n.id, n.body] as const))
      })
      .catch((e: unknown) => {
        if (!cancelled) console.warn('[qd] note previews could not be loaded', e)
      })
    return () => {
      cancelled = true
    }
  })

  // ---- layout ---------------------------------------------------------------------------------------------------

  const markerBottoms = $derived(
    settings.value.showMarginMarkers
      ? placeMarkers(
          pageMarkers(data),
          qfs,
          marginLabelsVisible(qfs),
          // The markers' decor flag, exactly as MarginMarkers draws them (else the marks' stacking drifts).
          (page?.ornaments ?? settings.value.ornateHeaders) &&
            fonts.status.get('qd-quran-common') === 'ready',
        ).bottoms
      : new Map<number, number>(),
  )
  const placed = $derived(
    marks ? placeMarks(pageMarks(data, marks.bookmarks, marks.notes), qfs, markerBottoms, opening) : [],
  )
  const pageBookmarked = $derived(marks?.pageBookmarks.some((b) => b.page === data.page) ?? false)

  /** The reading bookmark on this page: in its own layout on its page, in another layout where its ayah starts. */
  const reading = $derived.by(() => {
    if (!enabled) return null
    const rb = library.readingBookmark
    if (!rb) return null
    const ayah = data.ayahs.find((a) => a.id === rb.ayahId)
    const here = rb.layout === data.layout ? rb.page === data.page : ayah?.startsOnPage === true
    if (!here) return null
    return { ...rb, line: ayah?.line ?? 1 }
  })
  const ribbon = $derived(reading ? ribbonGeometry(qfs, side, reading.line, opening) : null)

  // ---- actions --------------------------------------------------------------------------------------------------

  const tooltipSide = $derived(side === 'right' ? 'right' : 'left')

  function ref(ayahId: number): string {
    const { surah, ayah } = quran.ayahRef(ayahId)
    return surah > 0 ? i18n.ref(surah, ayah) : ''
  }

  function openMark(mark: MarginMark): void {
    reader.select(mark.ayahId)
    if (mark.kind === 'note') ui.openSidePane('notes')
  }

  function noteTip(mark: MarginMark): string {
    const body = bodies.get(mark.id)
    if (body === undefined) return ''
    const preview = notePreview(body, 80)
    return preview === '' ? i18n.t('furniture.marks.noteEmpty') : preview
  }

  let ribbonOpen = $state(false)
  /** "Move here": the visible selection, else the reading cursor, else the first visible ayah (§8.15). */
  const target = $derived(reader.actionTarget)
  const targetIsHere = $derived(reading !== null && target === reading.ayahId)
  /** The reading-bookmark shortcut's label, from the registry when it is registered, else Shift+B (§10.1). */
  const moveKeys = $derived.by(() => {
    const def =
      shortcuts.defs.find((d) => d.labelKey === 'shortcuts.study.readingBookmark') ??
      ({
        id: 'study.readingBookmark',
        keys: ['Shift+b'],
        group: 'study',
        labelKey: 'shortcuts.study.readingBookmark',
        scope: 'reader',
        run: () => {},
      } satisfies ShortcutDef)
    return shortcuts.format(def)
  })

  function moveHere(): void {
    const ayahId = target
    if (!quran.isAyahId(ayahId)) return
    ribbonOpen = false
    library
      .moveReadingBookmark(ayahId, reader.layout, quran.pageOfAyah(reader.layout, ayahId))
      .catch((e: unknown) => ui.toastError(e))
  }
</script>

{#if enabled && pageBookmarked}
  <Tooltip side={tooltipSide} delay={300}>
    {#snippet content()}
      <span class="mk-tip">
        <span class="mk-tip-text">{i18n.t('furniture.marks.pageBookmark', { page: data.page })}</span>
        <span class="mk-tip-hint">{i18n.t('furniture.marks.pageBookmarkOpen')}</span>
      </span>
    {/snippet}
    {#snippet children({ props })}
      <button
        {...mergeProps(props, { onclick: () => ui.openSidebar('bookmarks') })}
        type="button"
        tabindex={-1}
        class="mp-dogear"
        aria-hidden="true"
      >
        <span class="mp-dogear-cut"></span>
        <span class="mp-dogear-shadow"><span class="mp-dogear-flap"></span></span>
      </button>
    {/snippet}
  </Tooltip>
{/if}

{#if reading && ribbon}
  <!-- The ribbon is aria-hidden (keyboard users have Shift+B), so closing never returns focus to it. -->
  <Popover
    bind:open={ribbonOpen}
    side="bottom"
    align="center"
    arrow
    width={288}
    label={i18n.t('furniture.ribbon.title')}
    onCloseAutoFocus={(e) => e.preventDefault()}
  >
    {#snippet trigger({ props: popoverProps })}
      <Tooltip side="bottom" delay={300} disabled={ribbonOpen}>
        {#snippet content()}
          <span class="mk-tip">
            <span class="mk-tip-text">{i18n.t('furniture.ribbon.tooltip', { ref: ref(reading.ayahId) })}</span
            >
          </span>
        {/snippet}
        {#snippet children({ props: tooltipProps })}
          <button
            {...mergeProps(popoverProps, tooltipProps)}
            type="button"
            tabindex={-1}
            class="mp-ribbon"
            aria-hidden="true"
            data-ayah={reading.ayahId}
            style:translate="{round2(ribbon.x)}px 0"
            style:width="{round2(ribbon.w)}px"
            style:height="{round2(ribbon.h)}px"
            style:--notch="{round2(ribbon.notch)}px"
          >
            <span class="mp-ribbon-edge"></span>
            <span class="mp-ribbon-silk"></span>
          </button>
        {/snippet}
      </Tooltip>
    {/snippet}
    <div class="rb" dir={i18n.dir}>
      <p class="rb-title">{i18n.t('furniture.ribbon.title')}</p>
      <p class="rb-ref">{quran.refLabel(reading.ayahId, 'long')}</p>
      <p class="rb-time">{i18n.t('furniture.ribbon.moved', { time: i18n.relTime(reading.updatedAt) })}</p>
      <div class="rb-actions">
        <Button
          variant="secondary"
          size="sm"
          onclick={moveHere}
          disabled={targetIsHere || !quran.isAyahId(target)}
        >
          {#snippet icon()}<MoveDown size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
          {i18n.t('furniture.ribbon.moveHere')}
        </Button>
        {#if moveKeys}<Kbd chord={moveKeys} size="sm" />{/if}
      </div>
      <p class="rb-hint">
        {targetIsHere
          ? i18n.t('furniture.ribbon.alreadyHere')
          : i18n.t('furniture.ribbon.moveTarget', { ref: quran.refLabel(target, 'long') })}
      </p>
    </div>
  </Popover>
{/if}

{#if placed.length > 0}
  <div class="mp-margin mp-marks" aria-hidden="true">
    <!-- Keyed by their top: marks restacked under late-loading marker glyphs are re-created, never moved (CLS 0). -->
    {#each placed as { item, top, height } (`${item.key}|${Math.round(top)}`)}
      <Tooltip side={tooltipSide} delay={300}>
        {#snippet content()}
          <span class="mk-tip">
            {#if item.kind === 'bookmark'}
              <span class="mk-tip-text">{i18n.t('furniture.marks.bookmark', { ref: ref(item.ayahId) })}</span>
            {:else}
              <span class="mk-tip-text">{i18n.t('furniture.marks.note', { ref: ref(item.ayahId) })}</span>
              {#if noteTip(item)}
                <span class="mk-tip-quote" dir="auto">{noteTip(item)}</span>
              {/if}
              <span class="mk-tip-hint">{i18n.t('furniture.marks.noteOpen')}</span>
            {/if}
          </span>
        {/snippet}
        {#snippet children({ props })}
          <button
            {...mergeProps(props, { onclick: () => openMark(item) })}
            type="button"
            tabindex={-1}
            class="mm"
            data-kind={item.kind}
            data-ayah={item.ayahId}
            style:top="{round2(top)}px"
            style:height="{round2(height)}px"
          >
            {#if item.kind === 'bookmark'}
              <svg viewBox="0 0 12 16" focusable="false" aria-hidden="true">
                <path d="M2.4 1h7.2c.77 0 1.4.63 1.4 1.4V15L6 11.6 1 15V2.4C1 1.63 1.63 1 2.4 1Z" />
              </svg>
            {:else}
              <svg viewBox="0 0 14 16" focusable="false" aria-hidden="true">
                <path
                  class="sheet"
                  d="M2.2 1h6.6L12.8 5v8.8c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2V2.2C1 1.54 1.54 1 2.2 1Z"
                />
                <path class="fold" d="M8.8 1v3.1c0 .5.4.9.9.9h3.1" />
                <path class="lines" d="M3.8 8.2h6.4M3.8 11h4.4" />
              </svg>
            {/if}
          </button>
        {/snippet}
      </Tooltip>
    {/each}
  </div>
{/if}

<style>
  .rb {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-family: var(--font-ui);
  }

  .rb-title {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
  }

  .rb-ref {
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .rb-time {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .rb-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-block-start: var(--space-2);
  }

  .rb-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    line-height: var(--leading-ui);
  }
</style>
