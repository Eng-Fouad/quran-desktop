<!--
  PageGrid: the 604 pages of the current layout as a grid, in one section per juz ("Juz 15 · p 282–301").
  The pages on screen are filled with the accent; a gold corner fold marks a page where a surah begins and a ribbon
  the reading bookmark's page. The finder above takes a page number (or any reference: "2:255" finds page 42), highlights
  its cell and opens it on Enter.

  Keyboard: one Tab stop; the arrows move through the grid (Left/Right follow the reading direction of the UI),
  Home/End jump to the ends, PageUp/PageDown move eight rows. Used only inside `IndexPanel`.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { SearchInput } from '$components/ui'
  import { i18n, library, quran, reader } from '$lib/stores'
  import { DEFAULT_LIMITS, listSeparator, parseReference, targetPage } from '$lib/text/refparse'
  import { numRange } from './format'
  import { openTarget } from './navigate'
  import { centerInView, keepInView, rovingKeydown, typeIntoFilter } from './roving'
  import { indexView } from './state.svelte'

  const uid = $props.id()
  const reasonId = `${uid}-reason`

  let grid: HTMLElement | null = $state(null)
  let finder: HTMLInputElement | null = $state(null)
  let tabStop = $state<number | null>(null)

  const layout = $derived(reader.layout)
  const pageCount = $derived(quran.pageCount(layout) || DEFAULT_LIMITS.pages)
  const visible = $derived(new Set(reader.visiblePages))
  const stopPage = $derived(tabStop ?? reader.page)

  const bookmarkPage = $derived.by(() => {
    const b = library.readingBookmark
    if (!b || !quran.isAyahId(b.ayahId)) return 0
    return b.layout === layout ? b.page : quran.pageOfAyah(layout, b.ayahId)
  })

  interface PageCell {
    page: number
    /** Surahs beginning on this page (names in the UI language). */
    starts: string[]
    label: string
  }

  interface Section {
    juz: number
    range: string
    cells: PageCell[]
  }

  const sections: Section[] = $derived.by(() => {
    /** Surah names by the page they begin on (sparse). */
    const starts: string[][] = []
    for (const s of quran.index.surahs) {
      const p = quran.pageOfAyah(layout, s.firstAyahId)
      starts[p] = [...(starts[p] ?? []), quran.surahName(s.id)]
    }
    const firstPages = quran.index.juz.map((j) => quran.pageOfAyah(layout, j.firstAyahId))
    const out: Section[] = []
    quran.index.juz.forEach((j, i) => {
      const from = firstPages[i] ?? 1
      const to = Math.max(from, (firstPages[i + 1] ?? pageCount + 1) - 1)
      const cells: PageCell[] = []
      for (let page = from; page <= to; page++) {
        const head = quran.ayahRef(quran.pageRange(layout, page).from).surah
        const begin = starts[page] ?? []
        const parts = [i18n.t('navigation.pages.cellLabel', { page, surah: quran.surahName(head) })]
        for (const name of begin) parts.push(i18n.t('navigation.pages.surahStarts', { surah: name }))
        cells.push({ page, starts: begin, label: parts.join(i18n.t('navigation.labelSep')) })
      }
      out.push({ juz: j.id, range: numRange(from, to), cells })
    })
    return out
  })

  // --- the page finder -----------------------------------------------------------------------------------------------

  const query = $derived(indexView.pageQuery.trim())
  const found = $derived.by(() => {
    if (query === '') return { page: 0, reason: '' }
    const results = parseReference(query, { names: true, nameLimit: 1 })
    const pageResult = results.find((r) => r.target.type === 'page') ?? results[0]
    if (!pageResult) return { page: 0, reason: '' }
    if (pageResult.issue !== undefined) return { page: 0, reason: pageResult.disabledReason ?? '' }
    return { page: targetPage(pageResult.target, layout), reason: '' }
  })

  $effect(() => {
    const page = found.page
    if (page <= 0) return
    untrack(() => {
      const cell = cellOf(page)
      if (cell && grid) centerInView(grid, cell)
    })
  })

  function onFinderKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' && !e.isComposing) {
      e.preventDefault()
      ;(cellOf(found.page) ?? cellOf(stopPage))?.focus()
    }
  }

  function onSubmit(): void {
    if (found.page > 0) open(found.page)
  }

  // --- cells ---------------------------------------------------------------------------------------------------------

  function cellOf(page: number): HTMLElement | null {
    return grid?.querySelector<HTMLElement>(`[data-page="${page}"]`) ?? null
  }

  function open(page: number): void {
    openTarget({ type: 'page', page })
  }

  let placed = false
  $effect(() => {
    const page = reader.page
    if (!grid) return
    untrack(() => {
      const cell = cellOf(page)
      if (!cell || !grid || found.page > 0) return
      if (!placed) {
        placed = true
        centerInView(grid, cell)
      } else if (!grid.contains(document.activeElement) && !grid.matches(':hover')) {
        keepInView(grid, cell)
      }
    })
  })

  /** Shows the current page (the panel's "Show where I am"). */
  export function locate(): void {
    indexView.pageQuery = ''
    void tick().then(() => {
      const cell = cellOf(reader.page)
      if (cell && grid) {
        centerInView(grid, cell)
        cell.focus({ preventScroll: true })
      }
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!grid) return
    if (typeIntoFilter(e, finder, (ch) => (indexView.pageQuery += ch))) return
    rovingKeydown(e, grid, { grid: true, dir: i18n.dir, onBeforeFirst: () => finder?.focus() })
  }

  function onFocusIn(e: FocusEvent): void {
    const page = Number((e.target as HTMLElement | null)?.dataset.page)
    if (Number.isInteger(page) && page > 0) tabStop = page
  }
</script>

<div class="pages">
  <div class="finder">
    <SearchInput
      bind:value={indexView.pageQuery}
      bind:ref={finder}
      size="sm"
      inputmode="numeric"
      placeholder={i18n.t('navigation.pages.findPlaceholder')}
      aria-label={i18n.t('navigation.pages.findLabel')}
      aria-invalid={found.reason !== '' || undefined}
      aria-describedby={found.reason !== '' ? reasonId : undefined}
      onkeydown={onFinderKeydown}
      {onSubmit}
    />
    {#if found.reason !== ''}
      <p class="reason" id={reasonId} role="status">{found.reason}</p>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scroll" bind:this={grid} onkeydown={onKeydown} onfocusin={onFocusIn}>
    {#each sections as s (s.juz)}
      <section class="juz" aria-labelledby="{uid}-juz-{s.juz}">
        <h3 class="head" id="{uid}-juz-{s.juz}">
          <span>{i18n.t('common.juzNumber', { juz: s.juz })}</span>
          <span class="head-pages">{i18n.t('navigation.pageRangeShort', { range: s.range })}</span>
        </h3>
        <ol class="cells">
          {#each s.cells as c (c.page)}
            {@const shown = visible.has(c.page)}
            <li class="cell-wrap">
              <button
                type="button"
                class={['cell', { shown, found: c.page === found.page, start: c.starts.length > 0 }]}
                data-roving
                data-page={c.page}
                tabindex={c.page === stopPage ? 0 : -1}
                aria-current={shown ? 'page' : undefined}
                aria-label={c.page === bookmarkPage
                  ? `${c.label}${i18n.t('navigation.labelSep')}${i18n.t('navigation.pages.bookmark')}`
                  : c.label}
                title={c.starts.length > 0 ? c.starts.join(listSeparator()) : undefined}
                onclick={() => open(c.page)}
              >
                {#if c.page === bookmarkPage}<span class="ribbon" aria-hidden="true"></span>{/if}
                {i18n.num(c.page)}
              </button>
            </li>
          {/each}
        </ol>
      </section>
    {/each}
  </div>
</div>

<style>
  .pages {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    block-size: 100%;
  }

  .finder {
    flex: none;
    padding-block: var(--space-3) var(--space-1);
    padding-inline: var(--space-2);
  }

  .reason {
    margin-block-start: var(--space-1);
    padding-inline: var(--space-1);
    color: var(--danger-text);
    font-size: var(--text-xs);
  }

  .scroll {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-y: auto;
    padding-block: 0 var(--space-3);
    padding-inline: var(--space-2);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    padding-block: var(--space-4) var(--space-2);
    padding-inline: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(html[lang='ar']) .head {
    letter-spacing: 0;
    text-transform: none;
  }

  .head-pages {
    font-weight: var(--weight-body);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
  }

  .cells {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
    grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
    gap: 4px;
  }

  .cell-wrap {
    display: contents;
  }

  .cell {
    position: relative;
    display: grid;
    place-items: center;
    block-size: 30px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .cell:hover {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .cell:focus-visible {
    outline-offset: 0;
  }

  /*
   * A surah begins on this page: a gold corner fold at the inline-end top (a dot would read as the Arabic-Indic zero
   * next to the digits).
   */
  .cell.start::after {
    content: '';
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 0;
    inline-size: 7px;
    block-size: 7px;
    border-start-end-radius: var(--radius-xs);
    background-color: var(--frame-gold);
    clip-path: polygon(0 0, 100% 0, 100% 100%); /* physical-ok: mirrored below for RTL */
  }

  :global([dir='rtl']) .cell.start::after {
    clip-path: polygon(0 0, 100% 0, 0 100%); /* physical-ok */
  }

  .cell.shown {
    background-color: var(--accent);
    color: var(--accent-ink);
    font-weight: var(--weight-title);
  }

  .cell.shown.start::after {
    background-color: var(--accent-ink);
  }

  .cell.found:not(.shown) {
    box-shadow: inset 0 0 0 1.5px var(--accent);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-weight: var(--weight-title);
  }

  /* The reading bookmark's page: a ribbon hanging from the top edge, with a notched tail. */
  .ribbon {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 5px;
    inline-size: 5px;
    block-size: 10px;
    background-color: var(--ribbon);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%);
  }

  @media (forced-colors: active) {
    .cell.shown {
      background-color: Highlight;
      color: HighlightText;
    }

    .cell.found:not(.shown) {
      box-shadow: inset 0 0 0 2px Highlight;
    }

    .cell.start::after,
    .ribbon {
      background-color: CanvasText;
    }
  }
</style>
