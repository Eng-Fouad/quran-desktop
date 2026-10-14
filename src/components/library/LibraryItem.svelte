<!--
  LibraryItem: one row of a library panel (bookmark, highlight, note, history entry). Used by the four library panels
  only.

  Layout: a 28 px leading mark (`lead`), then a column with the title (text-sm 500), an optional line of Quran text (the
  ayah's opening in qd-hafs, one line, faded at its end — never cut inside a word with an ellipsis; tinted like
  the page when `tint` is given), an optional excerpt (notes, two lines), and the meta line (text-xs muted) with
  optional chips (collections, tags). A "More" button appears at the inline end on hover or focus.

  Interaction: the row is a button and one stop of its list's roving focus (`data-roving`). Click or Enter opens it,
  a middle click calls `onaux` (open in the side pane), right-click / Shift+F10 / the Menu key and the More
  button call `onmenu` with the point to open the item menu at, Delete calls `ondelete` (focus then moves to the next row,
  else the previous one, else the panel's filter: `focusAfterRemoval`).
-->
<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import type { Snippet } from 'svelte'
  import IconButton from '$components/ui/IconButton.svelte'
  import Skeleton from '$components/ui/Skeleton.svelte'
  import { i18n } from '$lib/stores'
  import { focusAfterRemoval, type ItemChip, previews, wantPreview } from './library.svelte'

  interface Props {
    title: string
    /** The accessible name (defaults to the title and meta). */
    label?: string
    /**
     * The title is user text (a label, a note title): isolated in a `<bdi>`, so it reads in its own script's direction
     * while the line stays aligned with the UI.
     */
    userText?: boolean
    meta?: string
    /** A short note at the row's inline end (the time of a history entry). */
    aside?: string
    /** Show the opening of this ayah in Quran text. */
    ayahId?: number
    /** Tint the Quran line like a highlight on the page (`var(--user-hl-yellow)`). */
    tint?: string
    excerpt?: string
    chips?: readonly ItemChip[]
    /** The current entry (accent bar on the inline-start edge). */
    current?: boolean
    lead: Snippet
    onopen: (e: MouseEvent | KeyboardEvent) => void
    onaux?: (e: MouseEvent) => void
    onmenu?: (point: { x: number; y: number }) => void
    ondelete?: () => void
    /** The row's roving tab stop (one per list). */
    tabStop?: boolean
    /** Extra `data-*` hooks on the row (tests, scroll-into-view). */
    data?: Record<string, string | number>
  }

  let {
    title,
    label,
    userText = false,
    meta,
    aside,
    ayahId,
    tint,
    excerpt,
    chips = [],
    current = false,
    lead,
    onopen,
    onaux,
    onmenu,
    ondelete,
    tabStop = false,
    data = {},
  }: Props = $props()

  let row: HTMLButtonElement | null = $state(null)
  const text = $derived(ayahId === undefined ? undefined : previews.text(ayahId))
  const dataAttrs = $derived(
    Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, String(v)])),
  )

  function oncontextmenu(e: MouseEvent): void {
    if (!onmenu) return
    e.preventDefault()
    // The Menu key and Shift+F10 report no pointer position: open under the row's inline start.
    if (e.button !== 2 || (e.clientX === 0 && e.clientY === 0)) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      onmenu({ x: Math.round(i18n.dir === 'rtl' ? r.right - 28 : r.left + 28), y: Math.round(r.bottom - 4) })
    } else {
      onmenu({ x: e.clientX, y: e.clientY })
    }
  }

  function onmore(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    onmenu?.({ x: Math.round(i18n.dir === 'rtl' ? r.left : r.right), y: Math.round(r.bottom + 2) })
  }

  function onkeydown(e: KeyboardEvent): void {
    if ((e.key === 'Delete' || e.key === 'Backspace') && ondelete && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      focusAfterRemoval(row)
      ondelete()
    }
  }

  /** A middle press would start the browser's autoscroll on Windows: the row takes it as "open in the side pane". */
  function onmousedown(e: MouseEvent): void {
    if (e.button === 1 && onaux) e.preventDefault()
  }

  function onauxclick(e: MouseEvent): void {
    if (e.button === 1 && onaux) {
      e.preventDefault()
      onaux(e)
    }
  }
</script>

<li class={['item', { current }]}>
  <button
    bind:this={row}
    type="button"
    class={['row', { 'with-menu': onmenu !== undefined, 'with-aside': aside !== undefined }]}
    data-roving
    tabindex={tabStop ? 0 : -1}
    aria-label={label}
    {...dataAttrs}
    onclick={onopen}
    {onauxclick}
    {onmousedown}
    {oncontextmenu}
    {onkeydown}
  >
    <span class="lead" aria-hidden="true">{@render lead()}</span>
    <span class="main">
      <span class="title"
        >{#if userText}<bdi>{title}</bdi>{:else}{title}{/if}</span
      >
      {#if ayahId !== undefined}
        <span class="ayah-line" use:wantPreview={ayahId} aria-hidden="true">
          {#if text !== undefined}
            <span
              class={['ayah', 'quran-text', { tinted: tint !== undefined }]}
              lang="ar"
              dir="rtl"
              style:--_tint={tint}>{text}</span
            >
          {:else}
            <Skeleton w="72%" h={10} radius="full" class="ayah-skeleton" />
          {/if}
        </span>
      {/if}
      {#if excerpt}<span class="excerpt user-text" dir="auto">{excerpt}</span>{/if}
      {#if meta || chips.length > 0}
        <span class="meta">
          {#if meta}<span class="meta-text">{meta}</span>{/if}
          {#each chips as chip (chip.id)}
            <span class="chip" dir="auto">
              {#if chip.color}<span class="dot" style:background-color={chip.color}></span>{/if}
              {chip.label}
            </span>
          {/each}
        </span>
      {/if}
    </span>
    {#if aside}<span class="aside" aria-hidden="true">{aside}</span>{/if}
  </button>
  {#if onmenu}
    <IconButton
      class="more"
      label={i18n.t('library.panel.more')}
      icon={Ellipsis}
      size="sm"
      tabindex={-1}
      tooltip={false}
      onclick={onmore}
    />
  {/if}
</li>

<style>
  .item {
    position: relative;
    list-style: none;
    content-visibility: auto;
    contain-intrinsic-size: auto 64px;
  }

  .row {
    position: relative;
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    align-items: start;
    column-gap: var(--space-3);
    inline-size: 100%;
    min-block-size: 52px;
    padding-block: var(--space-2);
    padding-inline: var(--space-2) var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .row.with-menu {
    padding-inline-end: var(--space-8);
  }

  .row.with-aside {
    grid-template-columns: 28px minmax(0, 1fr) auto;
  }

  .aside {
    padding-block-start: 2px;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.4;
    white-space: nowrap;
  }

  .row:hover,
  .item:has(:global(.more:hover)) .row {
    background-color: var(--surface-hover);
  }

  .row:focus-visible {
    outline-offset: -2px;
  }

  /* The current entry: an accent bar on the inline-start edge (as in the Index). */
  .current .row::before {
    content: '';
    position: absolute;
    inset-block: 10px;
    inset-inline-start: 0;
    inline-size: 3px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .lead {
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    margin-block-start: 1px;
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* One line of Quran text, cut by the box and faded over its last 24 px (the inline end of RTL text is the left). */
  .ayah-line {
    display: block;
    block-size: 34px;
    overflow: hidden;
    direction: rtl;
    text-align: start;
    mask-image: linear-gradient(to right, transparent 0, #000 24px);
  }

  .ayah {
    display: inline-block;
    max-inline-size: none;
    padding-inline: 2px;
    color: var(--text);
    font-family: var(--font-quran);
    font-size: 19px;
    line-height: 34px;
    white-space: nowrap;
  }

  .ayah.tinted {
    padding-inline: 6px;
    border-radius: 7px;
    background-color: var(--_tint);
    line-height: 30px;
    margin-block-start: 2px;
  }

  .ayah-line :global(.ayah-skeleton) {
    display: block;
    margin-block-start: 12px;
  }

  .excerpt {
    display: -webkit-box;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    min-inline-size: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.45;
  }

  /* Wraps rather than truncates: in a narrow sidebar the reference and the time both stay readable. */
  .meta-text {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-inline-size: 140px;
    padding-block: 0;
    padding-inline: 6px;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    flex: none;
    inline-size: 6px;
    block-size: 6px;
    border-radius: var(--radius-full);
  }

  .item :global(.more) {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-end: 4px;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-standard);
  }

  .item:hover :global(.more),
  .item:focus-within :global(.more),
  .item :global(.more[data-state='open']) {
    opacity: 1;
  }

  @media (forced-colors: active) {
    .ayah.tinted {
      outline: 1px solid CanvasText;
    }
  }
</style>
