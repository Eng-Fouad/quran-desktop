<!--
  HistoryPanel (§7.5, §9.8): the History sidebar panel. Owner: WP11c. The shell's `Sidebar` draws the heading; this is
  the body. Takes no props: it reads stores (§7.9).

  - Loads the newest entries when it first shows (`history.load()`), and older ones as the list scrolls to its end.
  - Entries grouped by day (Today, Yesterday, the weekday, then the date). Each row: the mode (read, listened,
    memorized) as its mark, "Al-Kahf 18:45", "Read · page 297 · 4 min" and the time of day; the page being read now
    carries the accent bar.
  - Click returns to the place (§7.4: the page in its layout, else the ayah); a middle click opens the side pane on
    the ayah.
  - "Clear history" asks first (ConfirmDialog) and keeps bookmarks, highlights and notes.
  - Empty state: "Pages you read appear here" (§9.8).
-->
<script lang="ts">
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Brain from '@lucide/svelte/icons/brain'
  import Headphones from '@lucide/svelte/icons/headphones'
  import type { LucideIcon } from '@lucide/svelte'
  import { rovingKeydown } from '$components/index/roving'
  import Button from '$components/ui/Button.svelte'
  import EmptyState from '$components/ui/EmptyState.svelte'
  import Skeleton from '$components/ui/Skeleton.svelte'
  import Spinner from '$components/ui/Spinner.svelte'
  import type { HistoryEntry, HistoryMode } from '$lib/ipc/bindings'
  import { openPaneFor } from '$lib/shortcuts/study'
  import { history, i18n, quran, reader, ui } from '$lib/stores'
  import LibraryItem from './LibraryItem.svelte'
  import {
    clockTime,
    dayLabel,
    groupByDay,
    metaLine,
    openPage,
    openSpan,
    stripIsolates,
  } from './library.svelte'

  const MODE_ICON: Record<HistoryMode, LucideIcon> = { read: BookOpen, listen: Headphones, memorize: Brain }

  let list: HTMLElement | null = $state(null)
  let sentinel: HTMLElement | null = $state(null)
  let tabStop = $state<number | null>(null)

  $effect(() => {
    if (history.status === 'idle') void history.load()
  })

  // Older entries load as the end of the list scrolls into view.
  $effect(() => {
    const el = sentinel
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void history.loadMore()
      },
      { rootMargin: '240px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  })

  const groups = $derived(groupByDay(history.entries, (e) => e.at))
  const stopId = $derived(
    history.entries.some((e) => e.id === tabStop) ? tabStop : (history.entries[0]?.id ?? null),
  )

  function refOf(e: HistoryEntry): string {
    return quran.refLabel(e.ayahId, 'long')
  }

  function dwell(secs: number): string {
    const minutes = Math.round(secs / 60)
    return minutes < 1 ? i18n.t('library.history.lessThanMinute') : i18n.tp('library.history.dwell', minutes)
  }

  function metaOf(e: HistoryEntry): string {
    const parts = [i18n.t(`library.history.${e.mode}`)]
    if (e.page !== null) parts.push(i18n.t('common.pageNumber', { page: e.page }))
    if (e.dwellS > 0) parts.push(dwell(e.dwellS))
    return metaLine(parts)
  }

  /** The page shown in the reader now (its newest entry is "current"). */
  function isCurrent(e: HistoryEntry): boolean {
    return (
      e.mode === 'read' &&
      e.page !== null &&
      e.layout === reader.layout &&
      reader.visiblePages.includes(e.page)
    )
  }

  const currentId = $derived(history.entries.find((e) => isCurrent(e))?.id ?? null)

  function open(e: HistoryEntry): void {
    if (e.page !== null && e.layout === reader.layout) openPage(e.page)
    else openSpan({ from: e.ayahId, to: e.ayahId })
  }

  function onListKeydown(e: KeyboardEvent): void {
    if (list) rovingKeydown(e, list)
  }

  function onFocusIn(e: FocusEvent): void {
    const id = Number((e.target as HTMLElement | null)?.dataset.entry)
    if (Number.isInteger(id) && id > 0) tabStop = id
  }

  async function clear(): Promise<void> {
    const ok = await ui.confirm({
      title: i18n.t('library.history.clearTitle'),
      body: i18n.t('library.history.clearBody'),
      confirmLabel: i18n.t('library.history.clear'),
      danger: true,
    })
    if (ok) await history.clear()
  }
</script>

<div class="panel">
  <div class="scroll" aria-busy={history.status === 'loading'}>
    {#if history.status === 'loading' || history.status === 'idle'}
      <div class="skeletons" aria-hidden="true">
        <Skeleton w="30%" h={10} />
        {#each [0, 1, 2, 3, 4] as i (i)}
          <div class="skeleton-row">
            <Skeleton w={28} h={28} radius="full" />
            <div class="skeleton-lines">
              <Skeleton w="50%" h={12} />
              <Skeleton w="70%" h={10} />
            </div>
          </div>
        {/each}
      </div>
    {:else if history.status === 'error'}
      <EmptyState
        compact
        title={i18n.t('library.panel.loadError')}
        body={i18n.t('library.panel.loadErrorBody')}
      >
        {#snippet action()}
          <Button size="sm" onclick={() => void history.load()}>{i18n.t('library.panel.retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if history.entries.length > 0}
      <div
        class="list"
        data-qd-roving-list
        bind:this={list}
        role="presentation"
        onkeydown={onListKeydown}
        onfocusin={onFocusIn}
      >
        {#each groups as g (g.day)}
          <section class="day" aria-label={dayLabel(g.day / 1000)}>
            <h3 class="day-head">{dayLabel(g.day / 1000)}</h3>
            <ul class="rows">
              {#each g.items as e (e.id)}
                {@const Icon = MODE_ICON[e.mode]}
                <LibraryItem
                  title={refOf(e)}
                  meta={metaOf(e)}
                  aside={clockTime(e.at)}
                  current={e.id === currentId}
                  label={i18n.t('library.history.entryLabel', {
                    mode: i18n.t(`library.history.${e.mode}`),
                    ref: stripIsolates(refOf(e)),
                    page: e.page === null ? '' : i18n.t('common.pageNumber', { page: e.page }),
                    time: clockTime(e.at),
                  })}
                  tabStop={e.id === stopId}
                  data={{ entry: e.id }}
                  onopen={() => open(e)}
                  onaux={() => openPaneFor(e.ayahId)}
                >
                  {#snippet lead()}
                    <span class={['mark', `m-${e.mode}`]}><Icon size={15} strokeWidth={1.75} /></span>
                  {/snippet}
                </LibraryItem>
              {/each}
            </ul>
          </section>
        {/each}
        {#if history.hasMore}
          <div class="more" bind:this={sentinel}>
            {#if history.loadingMore}
              <Spinner size={16} />
            {:else}
              <Button size="sm" variant="ghost" onclick={() => void history.loadMore()}>
                {i18n.t('library.history.loadMore')}
              </Button>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <EmptyState title={i18n.t('library.history.emptyTitle')} body={i18n.t('library.history.emptyBody')} />
    {/if}
  </div>

  {#if history.entries.length > 0}
    <div class="foot">
      <Button size="sm" variant="ghost" onclick={() => void clear()}>{i18n.t('library.history.clear')}</Button
      >
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }

  .scroll {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding-block: 0 var(--space-3);
    padding-inline: var(--space-1);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .day + .day {
    margin-block-start: var(--space-2);
  }

  .day-head {
    padding-block: var(--space-2) var(--space-1);
    padding-inline: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .day-head:lang(ar) {
    letter-spacing: 0;
    text-transform: none;
  }

  .rows {
    margin: 0;
    padding: 0;
  }

  .mark {
    display: grid;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--text-muted) 12%, transparent);
    color: var(--text-muted);
  }

  .m-listen {
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .m-memorize {
    background-color: color-mix(in srgb, var(--frame-gold) 16%, transparent);
    color: var(--text);
  }

  .more {
    display: flex;
    justify-content: center;
    padding-block: var(--space-2);
  }

  .foot {
    display: flex;
    flex: none;
    justify-content: center;
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border-block-start: 1px solid var(--border);
  }

  .skeletons {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-3);
  }

  .skeleton-row {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: var(--space-3);
  }

  .skeleton-lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
</style>
