<!--
  HighlightsPanel (§7.5, §9.8): the Highlights sidebar panel. Owner: WP11c. The shell's `Sidebar` draws the heading;
  this is the body. Takes no props: it reads stores (§7.9).

  - A filter field and colour chips (all colours, or one; with counts; remembered per viewer).
  - Highlights in Mushaf order, grouped by surah. Each row: a bar in the highlight's colour, the reference, the opening
    of its first ayah in Quran text tinted like the page, and "3 ayahs · p 42 · time" with its tags.
  - Click opens the range in the reader (its first ayah flashes and takes focus, §7.4); a middle click opens the side
    pane on it; the item menu offers Open · Open in side pane · Colour ▸ · Tags… · Remove highlight (undoable);
    Delete removes it too.
  - Empty state: "1–5 to highlight", with the five keys in their colours (§9.8).
-->
<script lang="ts">
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right'
  import Eraser from '@lucide/svelte/icons/eraser'
  import Palette from '@lucide/svelte/icons/palette'
  import PanelRightOpen from '@lucide/svelte/icons/panel-right-open'
  import Tags from '@lucide/svelte/icons/tags'
  import Rosette from '$components/index/Rosette.svelte'
  import { rovingKeydown, typeIntoFilter } from '$components/index/roving'
  import TagPicker from '$components/library/TagPicker.svelte'
  import Button from '$components/ui/Button.svelte'
  import ContextMenu from '$components/ui/ContextMenu.svelte'
  import EmptyState from '$components/ui/EmptyState.svelte'
  import Popover from '$components/ui/Popover.svelte'
  import SearchInput from '$components/ui/SearchInput.svelte'
  import Skeleton from '$components/ui/Skeleton.svelte'
  import type { MenuEntry, Point } from '$components/ui/types'
  import type { Highlight, HighlightColor, Tag } from '$lib/ipc/bindings'
  import { openPaneFor } from '$lib/shortcuts/study'
  import { i18n, library, quran, reader } from '$lib/stores'
  import { HIGHLIGHT_COLORS } from '$lib/stores/library.svelte'
  import LibraryItem from './LibraryItem.svelte'
  import {
    focusAfterRemoval,
    matches,
    metaLine,
    openSpan,
    panelPrefs,
    spanKeywords,
    stripIsolates,
    swatch,
  } from './library.svelte'

  let query = $state('')
  let filterInput: HTMLInputElement | null = $state(null)
  /** Nothing stored at all: the empty state alone, without tools that have nothing to work on. */
  const emptyLibrary = $derived(library.status === 'ready' && library.highlights.length === 0 && query === '')
  let list: HTMLElement | null = $state(null)
  /** An item's row in this panel's list. */
  const rowEl = (id: string) =>
    list?.querySelector<HTMLElement>(`[data-highlight="${CSS.escape(id)}"]`) ?? null
  let tabStop = $state<string | null>(null)

  const sep = $derived(i18n.t('library.sep'))
  const color = $derived(panelPrefs.highlightColor)

  const counts = $derived.by(() => {
    const out: Record<HighlightColor, number> = { yellow: 0, green: 0, blue: 0, red: 0, purple: 0 }
    for (const h of library.highlights) out[h.color] += 1
    return out
  })

  function refOf(h: Highlight, style: 'short' | 'long' = 'short'): string {
    return quran.refLabel(h.fromAyahId, style, h.toAyahId !== h.fromAyahId ? h.toAyahId : undefined)
  }

  function metaOf(h: Highlight): string {
    return metaLine([
      i18n.tp('common.ayahCount', h.toAyahId - h.fromAyahId + 1),
      i18n.t('library.pageShort', { page: quran.pageOfAyah(reader.layout, h.fromAyahId) }),
      i18n.relTime(h.updatedAt),
    ])
  }

  function chipsOf(h: Highlight) {
    return h.tagIds
      .map((id) => library.tag(id))
      .filter((t): t is Tag => t !== undefined)
      .map((t) => ({ id: t.id, label: t.name, color: t.color }))
  }

  const rows: Highlight[] = $derived.by(() => {
    let out = library.highlights
    if (color !== null) out = out.filter((h) => h.color === color)
    if (query.trim() !== '') {
      out = out.filter((h) =>
        matches(query, [
          stripIsolates(refOf(h, 'long')),
          ...spanKeywords({ from: h.fromAyahId, to: h.toAyahId }),
          i18n.t(`library.colors.${h.color}`),
          ...h.tagIds.map((id) => library.tag(id)?.name),
        ]),
      )
    }
    return out
  })

  /** Rows grouped by the surah of their first ayah (they are in Mushaf order already). */
  const groups = $derived.by(() => {
    const out: { surah: number; items: Highlight[] }[] = []
    for (const h of rows) {
      const surah = quran.ayahRef(h.fromAyahId).surah
      const last = out.at(-1)
      if (last && last.surah === surah) last.items.push(h)
      else out.push({ surah, items: [h] })
    }
    return out
  })

  const stopId = $derived(rows.some((h) => h.id === tabStop) ? tabStop : (rows[0]?.id ?? null))

  function open(h: Highlight): void {
    openSpan({ from: h.fromAyahId, to: h.toAyahId })
  }

  /** Arrows, Home/End and PageUp/PageDown move in the list; a typed character goes to the filter. */
  function onListKeydown(e: KeyboardEvent): void {
    if (!list) return
    if (typeIntoFilter(e, filterInput, (ch) => (query += ch))) return
    rovingKeydown(e, list)
  }

  function onFocusIn(e: FocusEvent): void {
    const id = (e.target as HTMLElement | null)?.dataset.highlight
    if (id) tabStop = id
  }

  // --- the item menu ------------------------------------------------------------------------------------------------------

  let menuAt = $state<Point | null>(null)
  let menuFor = $state.raw<Highlight | null>(null)
  let tagsFor = $state.raw<Highlight | null>(null)
  let tagsOpen = $state(false)
  let tagsAnchor: HTMLElement | null = $state(null)

  function editTags(h: Highlight): void {
    tagsFor = h
    tagsAnchor = list?.querySelector<HTMLElement>(`[data-highlight="${CSS.escape(h.id)}"]`) ?? null
    requestAnimationFrame(() => (tagsOpen = true))
  }

  const menuItems: MenuEntry[] = $derived.by(() => {
    const h = menuFor
    if (h === null) return []
    return [
      { id: 'open', label: i18n.t('library.panel.open'), icon: CornerDownRight, onSelect: () => open(h) },
      {
        id: 'pane',
        label: i18n.t('library.panel.openInPane'),
        icon: PanelRightOpen,
        onSelect: () => openPaneFor(h.fromAyahId),
      },
      { type: 'separator', id: 'sep-1' },
      {
        type: 'submenu',
        id: 'color',
        label: i18n.t('library.highlights.changeColor'),
        icon: Palette,
        items: [
          {
            type: 'radio',
            id: 'colors',
            value: h.color,
            onValueChange: (v: string) =>
              void library.setHighlight(h.fromAyahId, h.toAyahId, v as HighlightColor),
            options: HIGHLIGHT_COLORS.map((c) => ({
              value: c,
              label: i18n.t(`library.colors.${c}`),
              swatch: swatch(c),
            })),
          },
        ],
      },
      { id: 'tags', label: i18n.t('library.panel.tags'), icon: Tags, onSelect: () => editTags(h) },
      { type: 'separator', id: 'sep-2' },
      {
        id: 'remove',
        label: i18n.t('library.highlights.remove'),
        icon: Eraser,
        danger: true,
        kbd: i18n.t('library.panel.deleteKey'),
        onSelect: () => {
          focusAfterRemoval(rowEl(h.id))
          void library.deleteHighlight(h.id)
        },
      },
    ]
  })

  function selectColor(c: HighlightColor | null): void {
    panelPrefs.highlightColor = panelPrefs.highlightColor === c ? null : c
  }
</script>

<div class="panel">
  {#if !emptyLibrary}
    <div class="tools">
      <SearchInput
        bind:value={query}
        bind:ref={filterInput}
        size="sm"
        placeholder={i18n.t('library.highlights.filter')}
        aria-label={i18n.t('library.highlights.filter')}
      />
    </div>
  {/if}

  {#if library.highlights.length > 0}
    <div class="colors" role="group" aria-label={i18n.t('library.highlights.colorFilter')}>
      <button type="button" class="chip" aria-pressed={color === null} onclick={() => selectColor(null)}>
        {i18n.t('library.highlights.all')}
        <span class="count">{i18n.num(library.highlights.length)}</span>
      </button>
      {#each HIGHLIGHT_COLORS as c (c)}
        <button
          type="button"
          class="chip swatch-chip"
          aria-pressed={color === c}
          aria-label={`${i18n.t(`library.colors.${c}`)}${sep}${i18n.num(counts[c])}`}
          title={i18n.t(`library.colors.${c}`)}
          disabled={counts[c] === 0 && color !== c}
          onclick={() => selectColor(c)}
        >
          <span class="dot" style:background-color={swatch(c)}></span>
          <span class="count">{i18n.num(counts[c])}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="scroll" aria-busy={library.status === 'loading'}>
    {#if library.status === 'loading' || library.status === 'idle'}
      <div class="skeletons" aria-hidden="true">
        {#each [0, 1, 2, 3] as i (i)}
          <div class="skeleton-row">
            <Skeleton w={4} h={40} radius="full" />
            <div class="skeleton-lines">
              <Skeleton w="40%" h={12} />
              <Skeleton w="90%" h={14} />
              <Skeleton w="50%" h={10} />
            </div>
          </div>
        {/each}
      </div>
    {:else if library.status === 'error'}
      <EmptyState
        compact
        title={i18n.t('library.panel.loadError')}
        body={i18n.t('library.panel.loadErrorBody')}
      >
        {#snippet action()}
          <Button size="sm" onclick={() => void library.loadAll()}>{i18n.t('library.panel.retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if rows.length > 0}
      <div
        class="groups"
        data-qd-roving-list
        bind:this={list}
        role="presentation"
        onkeydown={onListKeydown}
        onfocusin={onFocusIn}
      >
        {#each groups as g (g.surah + ':' + (g.items[0]?.id ?? ''))}
          <section class="group" aria-label={quran.surahName(g.surah)}>
            <h3 class="group-head">
              <Rosette n={g.surah} size={22} />
              <span class="group-name">{quran.surahName(g.surah)}</span>
              {#if i18n.locale !== 'ar'}
                <span class="group-ar" lang="ar" dir="rtl">{quran.surah(g.surah)?.nameAr ?? ''}</span>
              {/if}
            </h3>
            <ul class="rows">
              {#each g.items as h (h.id)}
                <LibraryItem
                  title={refOf(h)}
                  meta={metaOf(h)}
                  ayahId={h.fromAyahId}
                  tint={`var(--user-hl-${h.color})`}
                  chips={chipsOf(h)}
                  label={`${stripIsolates(refOf(h, 'long'))}${sep}${i18n.t(`library.colors.${h.color}`)}${sep}${stripIsolates(metaOf(h))}`}
                  tabStop={h.id === stopId}
                  data={{ highlight: h.id }}
                  onopen={() => open(h)}
                  onaux={() => openPaneFor(h.fromAyahId)}
                  onmenu={(p) => {
                    menuFor = h
                    menuAt = p
                  }}
                  ondelete={() => void library.deleteHighlight(h.id)}
                >
                  {#snippet lead()}
                    <span class="bar" style:background-color={swatch(h.color)}></span>
                  {/snippet}
                </LibraryItem>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {:else if query.trim() !== ''}
      <EmptyState
        compact
        title={i18n.t('library.panel.noMatches', { query: query.trim() })}
        body={i18n.t('library.panel.noMatchesBody', { ref: i18n.ref(2, 255) })}
      />
    {:else if color !== null}
      <EmptyState
        compact
        title={i18n.t('library.highlights.emptyColor', { color: i18n.t(`library.colorWords.${color}`) })}
      />
    {:else}
      <EmptyState
        title={i18n.t('library.highlights.emptyTitle')}
        body={i18n.t('library.highlights.emptyBody', {
          from: i18n.num(1),
          to: i18n.num(HIGHLIGHT_COLORS.length),
        })}
      >
        {#snippet action()}
          <span class="keys" aria-hidden="true">
            {#each HIGHLIGHT_COLORS as c, i (c)}
              <kbd class="key" style:--_c={swatch(c)}><span class="key-dot"></span>{i18n.num(i + 1)}</kbd>
            {/each}
          </span>
        {/snippet}
      </EmptyState>
    {/if}
  </div>
</div>

<ContextMenu
  at={menuAt}
  onClose={() => (menuAt = null)}
  items={menuItems}
  label={menuFor ? stripIsolates(refOf(menuFor, 'long')) : undefined}
/>

{#if tagsFor}
  {@const h = library.highlights.find((x) => x.id === tagsFor?.id) ?? tagsFor}
  <Popover
    bind:open={tagsOpen}
    anchor={tagsAnchor}
    side={i18n.dir === 'rtl' ? 'left' : 'right'}
    align="start"
    width={300}
    label={i18n.t('library.panel.tagsHeading')}
  >
    <TagPicker
      kind="highlight"
      itemId={h.id}
      selected={h.tagIds}
      onchange={(ids) => void library.setTags('highlight', h.id, ids)}
    />
  </Popover>
{/if}

<style>
  .panel {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }

  .tools {
    flex: none;
    padding-block: var(--space-1) var(--space-2);
    padding-inline: var(--space-3);
  }

  .colors {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding-block: 0 var(--space-2);
    padding-inline: var(--space-3);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    block-size: 26px;
    padding-inline: var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .chip:hover:not(:disabled) {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .chip:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .chip[aria-pressed='true'] {
    border-color: var(--accent);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .swatch-chip {
    padding-inline: 7px var(--space-2);
  }

  .count {
    font-variant-numeric: tabular-nums;
  }

  .dot {
    inline-size: 10px;
    block-size: 10px;
    border-radius: var(--radius-full);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent);
  }

  .scroll {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding-block: 0 var(--space-4);
    padding-inline: var(--space-1);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .group + .group {
    margin-block-start: var(--space-2);
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-block: var(--space-2) var(--space-1);
    padding-inline: var(--space-2) var(--space-3);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
  }

  .group-name {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-ar {
    flex: none;
    color: var(--text-muted);
    font-family: var(--font-naskh);
    font-size: 15px;
    font-weight: var(--weight-body);
    line-height: 1.2;
  }

  .rows {
    margin: 0;
    padding: 0;
  }

  .bar {
    display: block;
    inline-size: 4px;
    block-size: 40px;
    border-radius: var(--radius-full);
  }

  .keys {
    display: inline-flex;
    gap: 6px;
  }

  .key {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    block-size: 22px;
    padding-inline: 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xs);
    background-color: var(--surface-raised);
    box-shadow: inset 0 -1px 0 var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .key-dot {
    inline-size: 8px;
    block-size: 8px;
    border-radius: var(--radius-full);
    background-color: var(--_c);
  }

  .skeletons {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-2);
  }

  .skeleton-row {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: var(--space-3);
    justify-items: center;
  }

  .skeleton-lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
    justify-self: stretch;
  }

  @media (forced-colors: active) {
    .bar,
    .dot,
    .key-dot {
      forced-color-adjust: none;
    }

    .chip[aria-pressed='true'] {
      border-color: Highlight;
    }
  }
</style>
