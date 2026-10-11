<!--
  ContinueCard (§7.8 step 5): "Continue reading" over "Al-Kahf 18:45 · p 297 · 3 days ago" (accessible name "Continue
  from reading bookmark, …"), shown at the top of the Index panel while the reading bookmark is more than two pages
  from the pages on screen. Clicking it jumps to the bookmarked ayah (focus moves there, §7.4); the × hides it until
  the bookmark moves again. Takes no props: it reads the `library` (reading bookmark) and `reader` stores.
  Owner: WP10a.
-->
<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import X from '@lucide/svelte/icons/x'
  import { IconButton } from '$components/ui'
  import { i18n, library, quran, reader } from '$lib/stores'
  import { listSeparator } from '$lib/text/refparse'
  import { openTarget } from './navigate'
  import { indexView } from './state.svelte'

  /** The card shows when the bookmark is more than this many pages away from every page on screen (§7.8). */
  const NEAR_PAGES = 2

  const bookmark = $derived(library.readingBookmark)
  const page = $derived.by(() => {
    const b = bookmark
    if (!b || !quran.isAyahId(b.ayahId)) return 0
    return b.layout === reader.layout ? b.page : quran.pageOfAyah(reader.layout, b.ayahId)
  })
  const shown = $derived(
    bookmark !== null &&
      page > 0 &&
      indexView.continueHiddenAt !== bookmark.updatedAt &&
      reader.visiblePages.every((p) => Math.abs(p - page) > NEAR_PAGES),
  )
  const detail = $derived(
    bookmark === null
      ? ''
      : [
          quran.refLabel(bookmark.ayahId, 'long'),
          i18n.t('navigation.pageShort', { page }),
          i18n.relTime(bookmark.updatedAt),
        ].join(listSeparator()),
  )

  function resume(): void {
    if (!bookmark) return
    const { surah, ayah } = quran.ayahRef(bookmark.ayahId)
    openTarget({ type: 'ayah', surah, ayah }, { focus: true })
  }

  function hide(): void {
    if (bookmark) indexView.continueHiddenAt = bookmark.updatedAt
  }
</script>

{#if shown}
  <div class="continue">
    <button
      type="button"
      class="main"
      aria-label={i18n.t('navigation.continue.label', { detail })}
      onclick={resume}
    >
      <svg class="ribbon" viewBox="0 0 12 18" aria-hidden="true" focusable="false">
        <path d="M1 0h10v17l-5-4.2L1 17Z" />
      </svg>
      <span class="text">
        <span class="title">{i18n.t('navigation.continue.title')}</span>
        <span class="detail">{detail}</span>
      </span>
      <ChevronRight class="icon-dir chevron" size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
    <IconButton
      class="dismiss"
      label={i18n.t('navigation.continue.dismiss')}
      icon={X}
      size="sm"
      onclick={hide}
    />
  </div>
{/if}

<style>
  .continue {
    position: relative;
    margin-block: var(--space-2) var(--space-1);
    margin-inline: var(--space-2);
  }

  .main {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr) 16px;
    align-items: center;
    column-gap: var(--space-3);
    inline-size: 100%;
    min-block-size: 56px;
    padding-block: var(--space-2);
    padding-inline: var(--space-3) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      box-shadow var(--dur-quick) var(--ease-standard),
      border-color var(--dur-quick) var(--ease-standard);
  }

  .main:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-2);
  }

  .ribbon {
    inline-size: 12px;
    block-size: 18px;
    align-self: start;
    margin-block-start: 1px;
    fill: var(--ribbon);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .title {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.35;
  }

  .detail {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.35;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .continue :global(.chevron) {
    color: var(--text-muted);
  }

  /* Hide: takes the chevron's place on hover and keyboard focus. */
  .continue :global(.dismiss) {
    position: absolute;
    inset-block-start: 50%;
    inset-inline-end: 6px;
    translate: 0 -50%;
    opacity: 0;
    transition: opacity var(--dur-quick) var(--ease-standard);
  }

  .continue:hover :global(.dismiss),
  .continue:focus-within :global(.dismiss) {
    opacity: 1;
  }

  .continue:hover :global(.chevron),
  .continue:focus-within :global(.chevron) {
    visibility: hidden;
  }

  @media (forced-colors: active) {
    .main {
      border-color: CanvasText;
    }

    .ribbon {
      fill: CanvasText;
    }
  }
</style>
