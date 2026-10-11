<!--
  ResultGroup (§9.7): the 32 px header of a surah's hits: the surah number in a rosette, the surah's name, a count
  chip (every match in the surah within the filters, also when the list was cut at the limit), the Arabic name in
  Naskh at the inline end (English UI, when there is room) and a filter button, "Only in Al-Baqarah", that limits the
  search to the surah (shown on hover and focus; hidden once a surah filter applies). The list renders it in place and,
  `stuck`, as the sticky header over the scrolled list. Owner: WP10b. Used only inside `SearchResults`.
-->
<script lang="ts">
  import Funnel from '@lucide/svelte/icons/funnel'
  import Rosette from '$components/index/Rosette.svelte'
  import { IconButton } from '$components/ui'
  import type { SearchGroup } from '$lib/ipc/bindings'
  import { i18n, quran } from '$lib/stores'

  interface Props {
    group: SearchGroup
    /** Offer "Only in this surah". */
    canFilter: boolean
    onfilter: (surah: number) => void
    /** Rendered as the sticky header (a rule under it, not a heading for assistive tech: the in-list one is). */
    stuck?: boolean
  }

  let { group, canFilter, onfilter, stuck = false }: Props = $props()

  const name = $derived(quran.surahName(group.surah))
  const nameAr = $derived(quran.surah(group.surah)?.nameAr ?? '')
  const arabicUi = $derived(i18n.locale === 'ar')
  const label = $derived(
    i18n.t('search.group.label', { name, results: i18n.tp('search.summary.results', group.count) }),
  )
</script>

<div class={['group', { stuck, filterable: canFilter }]} data-group={group.surah}>
  <svelte:element
    this={stuck ? 'div' : 'h3'}
    class="title"
    aria-label={stuck ? undefined : label}
    aria-hidden={stuck ? 'true' : undefined}
  >
    <Rosette n={group.surah} size={22} />
    <span class="name">{name}</span>
    <span class="count tabular-nums">{i18n.num(group.count)}</span>
    {#if !arabicUi && nameAr !== ''}
      <!-- The wrapper takes the auto margin: on the dir=rtl name itself "inline-start" would be its right side. -->
      <span class="ar"><bdi lang="ar" dir="rtl">{nameAr}</bdi></span>
    {/if}
  </svelte:element>
  {#if canFilter}
    <span class="filter">
      <IconButton
        label={i18n.t('search.filter.onlyThis', { name })}
        icon={Funnel}
        size="sm"
        tabindex={-1}
        tooltipSide="bottom"
        onclick={() => onfilter(group.surah)}
      />
    </span>
  {/if}
</div>

<style>
  .group {
    position: relative;
    display: flex;
    align-items: center;
    block-size: 32px;
    padding-inline: var(--qd-search-pad-group, 6px) var(--space-2);
    container-type: inline-size;
  }

  .title {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--space-2);
    min-inline-size: 0;
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    line-height: 1;
  }

  .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-inline-size: 20px;
    block-size: 18px;
    padding-inline: 6px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--text) 8%, transparent);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
  }

  .ar {
    flex: none;
    margin-inline-start: auto;
    color: var(--text-muted);
    font-family: var(--font-naskh);
    font-size: 15px;
    font-weight: 400;
    line-height: 1;
    white-space: nowrap;
  }

  @container (max-width: 230px) {
    .ar {
      display: none;
    }
  }

  /*
   * The filter button sits over the Arabic name at the inline end and shows while the header is hovered or holds focus
   * (the name fades out under it), so the header never changes its layout.
   */
  .filter {
    position: absolute;
    inset-block: 0;
    inset-inline-end: var(--space-1);
    display: flex;
    align-items: center;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-standard);
  }

  .ar {
    transition: opacity var(--dur-fast) var(--ease-standard);
  }

  .group:hover .filter,
  .filter:focus-within {
    opacity: 1;
  }

  .filterable:hover .ar,
  .filterable:focus-within .ar {
    opacity: 0;
  }

  .stuck {
    border-block-end: 1px solid var(--border);
  }

  @media (hover: none) {
    .filter {
      opacity: 1;
    }

    .filterable .ar {
      opacity: 0;
    }
  }
</style>
