<!--
  VerseRow: one verse of translation mode, an `<article>` of the verse feed.
  - Head: `KeyBadge` (28 px rosette and "1:2") at the inline start with the verse's marks (bookmark, note, highlight
    colour); `VerseActions` at the inline end, shown on hover, focus or selection.
  - The Arabic in `qd-hafs` (`.quran-text`), `28 px × translationFontPct`, leading 2.25, right-aligned (`dir=rtl`),
    unless `translationArabic` is off; then one `TranslationBlock` per active translation, in the user's order.
  - States: playing (`--hl-audio` and a 3 px accent bar at the inline start), selected (`--hl-selection` and the
    selection ring), a flash after a jump, skeleton lines sized from the verse's word count while loading, and an inline
    error with Retry (plain text: the view says it once, politely, instead of an alert per mounted row).
  - Pointer: click selects (Shift extends), double-click also opens the study pane, Mod+click plays from here,
    right-click selects the verse (unless the selection holds it) and opens the ayah menu (`openAyahMenu`). Clicks on
    controls, links and footnotes, or that end a text selection, do nothing.
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import StickyNote from '@lucide/svelte/icons/sticky-note'
  import type { HighlightColor } from '$lib/ipc/bindings'
  import Button from '$components/ui/Button.svelte'
  import Skeleton from '$components/ui/Skeleton.svelte'
  import { openAyahMenu } from '$lib/mushaf/interactions'
  import { app, i18n, player, quran, reader, settings, translations, ui } from '$lib/stores'
  import type { PackMeta } from '$lib/stores/translations.svelte'
  import { isModPressed } from '$lib/util/platform'
  import KeyBadge from './KeyBadge.svelte'
  import TranslationBlock from './TranslationBlock.svelte'
  import VerseActions from './VerseActions.svelte'
  import { bindEndMark } from '$lib/text/endmark'

  interface Props {
    ayahId: number
    surah: number
    ayah: number
    /** The roving tab stop of the feed. */
    focusable: boolean
    /** `aria-posinset` / `aria-setsize` of the feed. */
    position: number
    setSize: number
    /** Packs to show, with their metadata and translator labels. */
    packs: readonly { meta: PackMeta; title: string }[]
    highlight: HighlightColor | null
    bookmarked: boolean
    noteId: string | null
    nastaliq: boolean
    onref: (ref: string) => void
  }

  let {
    ayahId,
    surah,
    ayah,
    focusable,
    position,
    setSize,
    packs,
    highlight,
    bookmarked,
    noteId,
    nastaliq,
    onref,
  }: Props = $props()

  const row = $derived(translations.row(ayahId))
  const load = $derived(translations.state(ayahId))
  const showArabic = $derived(settings.value.translationArabic)
  const inline = $derived(settings.value.footnotesInline)
  const selection = $derived(reader.selection)
  const selected = $derived(
    selection !== null && ayahId >= selection.fromAyahId && ayahId <= selection.toAyahId,
  )
  /** A selection over several verses reads as one block: neighbours inside it join (no rounded edge, no ring). */
  const joinPrev = $derived(selected && selection !== null && ayahId > selection.fromAyahId && ayah > 1)
  const joinNext = $derived(
    selected &&
      selection !== null &&
      ayahId < selection.toAyahId &&
      ayah < (quran.surah(surah)?.ayahCount ?? 0),
  )
  const playing = $derived(player.isActive && player.currentAyahId === ayahId)
  const flashing = $derived(reader.flash?.ayahId === ayahId)
  const items = $derived(new Map((row?.tr ?? []).map((t) => [t.packId, t] as const)))
  /** Skeleton lines from the word count (placeholders near the final size, so little shifts on arrival). */
  const words = $derived(Math.max(1, quran.firstWordOf(ayahId + 1) - quran.firstWordOf(ayahId) - 1))
  const arabicLines = $derived(Math.min(8, Math.max(1, Math.ceil(words / 8))))
  const trLines = $derived(Math.min(10, Math.max(1, Math.ceil((words * 1.7) / 11))))
  /** The colour name inside a sentence ("Highlighted yellow"): the swatch labels are capitalised, Arabic has no case. */
  const highlightLabel = $derived(
    highlight ? i18n.t(`content.highlight.${highlight}`).toLocaleLowerCase(i18n.locale) : '',
  )

  /** Whether a pointer event started on something with its own behaviour (controls, links, footnotes). */
  function ownTarget(e: Event): boolean {
    return (
      e.target instanceof Element && e.target.closest('button, a, [role="button"], input, .actions') !== null
    )
  }

  function selectingText(): boolean {
    const s = window.getSelection()
    return s !== null && !s.isCollapsed && s.toString().trim() !== ''
  }

  function onclick(e: MouseEvent): void {
    if (ownTarget(e) || selectingText()) return
    if (isModPressed(e, app.platform) || (e.altKey && !app.isLinux)) {
      void player.playFrom({ ayahId })
      return
    }
    reader.select(ayahId, e.shiftKey)
  }

  function ondblclick(e: MouseEvent): void {
    if (ownTarget(e)) return
    reader.select(ayahId)
    ui.openSidePane('tafsir')
  }

  function oncontextmenu(e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest('a, input')) return
    e.preventDefault()
    openAyahMenu({ x: e.clientX, y: e.clientY, ayahId })
  }

  function onmousedown(e: MouseEvent): void {
    // A double-click selects the verse; keep the browser from selecting a word of it too.
    if (e.detail >= 2 && !ownTarget(e)) e.preventDefault()
  }
</script>

<!--
  A feed article (ARIA feed pattern): focusable, labelled by its reference. Pointer gestures here have keyboard
  equivalents in the reader shortcuts (↑/↓ select, Enter opens the study pane, Space plays, Shift+F10 menu).
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article
  id="tv-a{ayahId}"
  class="verse"
  class:selected
  class:join-prev={joinPrev}
  class:join-next={joinNext}
  class:playing
  class:flashing
  data-qd-ayah={ayahId}
  aria-labelledby="tv-k{ayahId}"
  aria-describedby={playing ? `tv-p${ayahId}` : undefined}
  aria-posinset={position}
  aria-setsize={setSize}
  aria-busy={load.text === 'loading' || load.tr === 'loading' ? 'true' : undefined}
  tabindex={focusable ? 0 : -1}
  {onclick}
  {ondblclick}
  {oncontextmenu}
  {onmousedown}
>
  <header class="head">
    <KeyBadge {surah} {ayah} id="tv-k{ayahId}" active={playing || selected} />
    <span class="marks">
      {#if bookmarked}
        <span class="mark bookmark" title={i18n.t('content.verse.bookmarked')}>
          <Bookmark size={14} strokeWidth={2} aria-hidden="true" />
          <span class="sr-only">{i18n.t('content.verse.bookmarked')}</span>
        </span>
      {/if}
      {#if noteId}
        <span class="mark" title={i18n.t('content.verse.noted')}>
          <StickyNote size={14} strokeWidth={1.75} aria-hidden="true" />
          <span class="sr-only">{i18n.t('content.verse.noted')}</span>
        </span>
      {/if}
      {#if highlight}
        <span
          class="mark dot"
          style:--_dot="var(--user-hl-{highlight}-solid)"
          title={i18n.t('content.verse.highlighted', { color: highlightLabel })}
        >
          <span class="sr-only">{i18n.t('content.verse.highlighted', { color: highlightLabel })}</span>
        </span>
      {/if}
      {#if playing}
        <span class="sr-only" id="tv-p{ayahId}">{i18n.t('content.verse.playing')}</span>
      {/if}
    </span>
    <VerseActions {ayahId} {highlight} {bookmarked} {noteId} />
  </header>

  {#if showArabic}
    {#if row}
      <p class="arabic quran-text" lang="ar" dir="rtl">{bindEndMark(row.ayah.textHafs)}</p>
    {:else if load.text === 'error'}
      <p class="error">
        {i18n.t('content.verse.loadError')}
        <Button size="sm" variant="link" onclick={() => void translations.retry(ayahId)}
          >{i18n.t('common.retry')}</Button
        >
      </p>
    {:else}
      <div class="skeleton arabic-skeleton" dir="rtl" aria-hidden="true">
        {#each { length: arabicLines }, i (i)}
          <Skeleton h={22} w={i === arabicLines - 1 && arabicLines > 1 ? '55%' : '100%'} radius="sm" />
        {/each}
      </div>
    {/if}
  {/if}

  {#each packs as { meta, title } (meta.id)}
    {@const item = items.get(meta.id)}
    {#if item}
      <TranslationBlock {item} {meta} {title} {inline} {nastaliq} {onref} />
    {:else if load.tr === 'error'}
      <p class="error">
        {i18n.t('content.verse.translationError')}
        <Button size="sm" variant="link" onclick={() => void translations.retry(ayahId)}
          >{i18n.t('common.retry')}</Button
        >
      </p>
    {:else if row && load.tr === 'ready'}
      <!-- The pack has no text for this verse (rare in QuranEnc exports): nothing to show. -->
    {:else}
      <div class="skeleton tr-skeleton" dir={meta.dir} aria-hidden="true">
        <Skeleton h={10} w={120} radius="xs" />
        {#each { length: trLines }, i (i)}
          <Skeleton h={14} w={i === trLines - 1 && trLines > 1 ? '62%' : '100%'} radius="xs" />
        {/each}
      </div>
    {/if}
  {/each}
</article>

<style>
  .verse {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-block: 20px;
    padding-inline: var(--space-4);
    border-radius: var(--radius-md);
    outline: none;
    transition: background-color var(--dur-normal) var(--ease-standard);
  }

  .verse:focus-visible {
    box-shadow: inset 0 0 0 var(--focus-ring-w) var(--focus-ring);
  }

  .selected {
    background-color: var(--hl-selection);
  }

  /* The selection ring. Verses selected together share one outline: joined edges lose their side of it and their
     corners (the separator between them carries the ring's sides, see TranslationView). */
  .selected::after {
    position: absolute;
    inset: 0;
    border: 1px solid var(--hl-selection-ring);
    border-radius: inherit;
    pointer-events: none;
    content: '';
  }

  .join-prev {
    border-start-start-radius: 0;
    border-start-end-radius: 0;
  }

  .join-prev::after {
    border-block-start: none;
  }

  .join-next {
    border-end-start-radius: 0;
    border-end-end-radius: 0;
  }

  .join-next::after {
    border-block-end: none;
  }

  .selected:focus-visible::after {
    border: var(--focus-ring-w) solid var(--focus-ring);
  }

  .playing {
    background-color: var(--hl-audio);
  }

  /* The playing verse's 3 px accent bar at the inline start. */
  .playing::before {
    position: absolute;
    inset-block: 14px;
    inset-inline-start: 0;
    inline-size: 3px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    content: '';
  }

  .flashing {
    animation: flash 1.8s var(--ease-standard);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 30px;
  }

  .marks {
    display: inline-flex;
    flex: 1;
    align-items: center;
    gap: var(--space-1);
    min-inline-size: 0;
    color: var(--text-muted);
  }

  .mark {
    display: inline-flex;
    align-items: center;
  }

  .bookmark {
    color: var(--ribbon);
  }

  .dot::before {
    inline-size: 8px;
    block-size: 8px;
    margin-inline: 3px;
    border-radius: var(--radius-full);
    background-color: var(--_dot);
    content: '';
  }

  /* Hover or focus shows the actions; they keep their room so nothing moves. */
  .head :global(.actions) {
    opacity: 0;
    transition: opacity var(--dur-quick) var(--ease-standard);
  }

  .verse:hover .head :global(.actions),
  .verse:focus-within .head :global(.actions),
  .selected .head :global(.actions) {
    opacity: 1;
  }

  /* The Quran line box is 2.25× its size; half of that leading is pulled back so the verse reads as one block. */
  .arabic {
    margin-block: -0.3em -0.2em;
    margin-inline: 0;
    color: var(--ink);
    font-family: var(--font-quran);
    font-size: calc(var(--text-quran-reading) * var(--tv-scale, 1));
    line-height: var(--leading-quran);
    text-align: start;
    overflow-wrap: break-word;
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .arabic-skeleton {
    gap: calc(63px * var(--tv-scale, 1) - 22px);
    padding-block: calc(20px * var(--tv-scale, 1));
  }

  .tr-skeleton {
    gap: calc(30px * var(--tv-scale, 1) - 14px);
    padding-block-start: 3px;
  }

  .error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--danger-text);
    font-size: var(--text-sm);
  }

  @keyframes flash {
    0%,
    30% {
      background-color: var(--accent-soft);
    }
  }

  @media (forced-colors: active) {
    .selected::after {
      border-color: Highlight;
    }

    .playing::before {
      background-color: Highlight;
    }
  }
</style>
