<!--
  ProgressHeatmap: the Mushaf map of the Memorize panel, one square per page of the current layout, one row per juz,
  shaded by how much of the page is memorised.

  - **Shade**: (memorized + due for review + 0.4 × learning) ÷ ayahs on the page, in four steps of the accent; a page
    with nothing started is an empty well. A page with ayahs due carries a warning dot; the pages on screen are ringed.
  - **Pointer**: hovering a square shows "Page 50 · Al-Baqarah 2:283 – Al-Imran 3:9" and its counts; a click opens the
    page (`onopen`).
  - **Keyboard**: one tab stop (`role="grid"`, `aria-activedescendant`); arrows move by page and by juz (mirrored in
    RTL), Home/End go to the row's ends, Enter or Space opens the page. Every square has its spoken label.
  - Rows follow the UI direction (page 1 at the right in the Arabic UI, like the book).

  Props: `progress` (the memo store's sparse map), `now` (Unix seconds, for "due"), `layout`, `current` (pages on
  screen) and `onopen`.
-->
<script lang="ts">
  import type { MemoProgress, MushafLayout } from '$lib/ipc/bindings'
  import { summarize, type ProgressSummary } from '$lib/stores/memo.svelte'
  import { i18n, quran } from '$lib/stores'

  interface Props {
    progress: ReadonlyMap<number, MemoProgress>
    now: number
    layout: MushafLayout
    current?: readonly number[]
    onopen?: (page: number) => void
  }

  let { progress, now, layout, current = [], onopen }: Props = $props()

  const uid = $props.id()

  interface Cell {
    page: number
    from: number
    to: number
    level: 0 | 1 | 2 | 3 | 4
    due: boolean
    summary: ProgressSummary
  }

  interface Row {
    juz: number
    cells: Cell[]
  }

  /** The juz rows: each juz's pages, from the page its first ayah is on to the page before the next juz starts. */
  const frame = $derived.by(() => {
    const pages = quran.pageCount(layout)
    const juz = quran.index.juz
    if (pages <= 0 || juz.length === 0)
      return { rows: [] as { juz: number; first: number; last: number }[], cols: 0 }
    const starts = juz.map((j) => quran.pageOfAyah(layout, j.firstAyahId))
    const rows = juz.map((j, i) => {
      const first = starts[i] ?? 1
      const nextStart = starts[i + 1]
      const last = nextStart === undefined ? pages : Math.max(first, nextStart - 1)
      return { juz: j.id, first, last }
    })
    const cols = Math.max(1, ...rows.map((r) => r.last - r.first + 1))
    return { rows, cols }
  })

  function levelOf(s: ProgressSummary): Cell['level'] {
    if (s.total <= 0) return 0
    const started = s.memorized + s.review + s.learning
    if (started === 0) return 0
    const score = (s.memorized + s.review + 0.4 * s.learning) / s.total
    return score >= 0.85 ? 4 : score >= 0.5 ? 3 : score >= 0.2 ? 2 : 1
  }

  const rows: Row[] = $derived(
    frame.rows.map((r) => {
      const cells: Cell[] = []
      for (let page = r.first; page <= r.last; page++) {
        const range = quran.pageRange(layout, page)
        const summary = summarize(progress, range.from, range.to, now)
        cells.push({
          page,
          from: range.from,
          to: range.to,
          level: levelOf(summary),
          due: summary.due > 0,
          summary,
        })
      }
      return { juz: r.juz, cells }
    }),
  )

  const cellsByPage = $derived(new Map(rows.flatMap((r) => r.cells.map((c) => [c.page, c] as const))))
  const currentSet = $derived(new Set(current))

  /** The keyboard-active page (`aria-activedescendant`), and the one under the pointer. */
  let active = $state<number | null>(null)
  let hovered = $state<number | null>(null)
  let focused = $state(false)
  let grid: HTMLElement | null = $state(null)
  let wrap: HTMLElement | null = $state(null)

  const activePage = $derived(active !== null && cellsByPage.has(active) ? active : (current[0] ?? 1))
  const shown = $derived(hovered ?? (focused ? activePage : null))
  const shownCell = $derived(shown === null ? null : (cellsByPage.get(shown) ?? null))

  function cellId(page: number): string {
    return `${uid}-p${page}`
  }

  function rangeText(c: Cell): string {
    return c.from > 0 ? quran.refLabel(c.from, 'long', c.to) : ''
  }

  function countsText(s: ProgressSummary): string {
    const parts: string[] = []
    if (s.memorized + s.review > 0) parts.push(i18n.tp('memo.count.memorized', s.memorized + s.review))
    if (s.learning > 0) parts.push(i18n.tp('memo.count.learning', s.learning))
    if (s.new > 0) parts.push(i18n.tp('memo.count.new', s.new))
    if (s.due > 0) parts.push(i18n.tp('memo.count.due', s.due))
    return parts.join(' · ')
  }

  function labelOf(c: Cell): string {
    return `${i18n.t('memo.panel.map.page', { page: c.page })}, ${countsText(c.summary)}`
  }

  /** Where the tooltip sits: above the cell, kept inside the map. */
  let tip = $state<{ x: number; y: number; below: boolean } | null>(null)
  $effect(() => {
    const page = shown
    if (page === null || !wrap) {
      tip = null
      return
    }
    const el = document.getElementById(cellId(page))
    if (!el) return
    const w = wrap.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    tip = { x: r.left + r.width / 2 - w.left, y: r.top - w.top, below: r.top - w.top < 64 }
  })

  function pageAt(e: Event): number | null {
    const el = (e.target as Element | null)?.closest<HTMLElement>('[data-page]')
    const n = Number(el?.dataset.page)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  function onpointermove(e: PointerEvent): void {
    const page = pageAt(e)
    if (page !== hovered) hovered = page
  }

  function onclick(e: MouseEvent): void {
    const page = pageAt(e)
    if (page === null) return
    active = page
    onopen?.(page)
  }

  /** Arrow keys over the ragged rows: by page within a row, by juz (same column, clamped) across rows. */
  function onkeydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const page = activePage
    const r = rows.findIndex((row) => row.cells.some((c) => c.page === page))
    const row = rows[r]
    if (!row) return
    const col = row.cells.findIndex((c) => c.page === page)
    const rtl = grid ? getComputedStyle(grid).direction === 'rtl' : false
    let next: number | null = null
    switch (e.key) {
      case 'ArrowRight':
        next = page + (rtl ? -1 : 1)
        break
      case 'ArrowLeft':
        next = page + (rtl ? 1 : -1)
        break
      case 'ArrowDown':
      case 'ArrowUp': {
        const target = rows[r + (e.key === 'ArrowDown' ? 1 : -1)]
        if (target) next = target.cells[Math.min(col, target.cells.length - 1)]?.page ?? null
        break
      }
      case 'Home':
        next = row.cells[0]?.page ?? null
        break
      case 'End':
        next = row.cells.at(-1)?.page ?? null
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        onopen?.(page)
        return
      default:
        return
    }
    e.preventDefault()
    if (next !== null && cellsByPage.has(next)) {
      active = next
      document.getElementById(cellId(next))?.scrollIntoView({ block: 'nearest' })
    }
  }
</script>

<div class="heatmap" bind:this={wrap}>
  <div
    bind:this={grid}
    class="grid"
    role="grid"
    tabindex="0"
    aria-label={i18n.t('memo.panel.map.label')}
    aria-describedby={`${uid}-hint`}
    aria-activedescendant={cellId(activePage)}
    data-qd-heatmap=""
    style:--cols={frame.cols}
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
    {onkeydown}
    {onpointermove}
    onpointerleave={() => (hovered = null)}
    {onclick}
  >
    {#each rows as row (row.juz)}
      <div class="row" role="row" aria-label={i18n.t('memo.panel.map.juz', { juz: row.juz })}>
        <span class="juz" aria-hidden="true"
          >{row.juz === 1 || row.juz % 5 === 0 ? i18n.num(row.juz) : ''}</span
        >
        {#each row.cells as c (c.page)}
          <span
            id={cellId(c.page)}
            class={[
              'cell',
              `l${c.level}`,
              { due: c.due, cur: currentSet.has(c.page), act: focused && c.page === activePage },
            ]}
            role="gridcell"
            aria-label={labelOf(c)}
            data-page={c.page}
          ></span>
        {/each}
      </div>
    {/each}
  </div>

  {#if shownCell && tip}
    <div
      class={['tip', { below: tip.below }]}
      style:--x={`${tip.x}px`}
      style:--y={`${tip.y}px`}
      aria-hidden="true"
      data-qd-heatmap-tip=""
    >
      <span class="tip-title">
        {i18n.t('memo.panel.map.page', { page: shownCell.page })}
        <span class="tip-range">{rangeText(shownCell)}</span>
      </span>
      <span class="tip-counts">{countsText(shownCell.summary)}</span>
    </div>
  {/if}

  <p class="hint" id={`${uid}-hint`}>{i18n.t('memo.panel.map.hint')}</p>
</div>

<style>
  .heatmap {
    position: relative;
    container-type: inline-size;
  }

  .grid {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-sm);
    outline: none;
    cursor: pointer;
  }

  .grid:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .row {
    display: grid;
    grid-template-columns: 18px repeat(var(--cols), minmax(0, 1fr));
    gap: 2px;
    align-items: center;
  }

  .juz {
    padding-inline-end: 4px;
    color: var(--text-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-align: end;
  }

  .cell {
    position: relative;
    aspect-ratio: 1;
    border-radius: 2px;
    background-color: color-mix(in srgb, var(--border-input) 20%, transparent);
  }

  .l1 {
    background-color: color-mix(in srgb, var(--accent) 24%, transparent);
  }

  .l2 {
    background-color: color-mix(in srgb, var(--accent) 46%, transparent);
  }

  .l3 {
    background-color: color-mix(in srgb, var(--accent) 72%, transparent);
  }

  .l4 {
    background-color: var(--accent);
  }

  .due::after {
    content: '';
    position: absolute;
    inset: 28%;
    border-radius: var(--radius-full);
    background-color: var(--warning);
    box-shadow: 0 0 0 1px var(--surface-raised);
  }

  .cur {
    box-shadow: 0 0 0 1.5px var(--text);
  }

  .cell:hover,
  .act {
    box-shadow: 0 0 0 2px var(--focus-ring);
    z-index: 1;
  }

  .tip {
    position: absolute;
    top: var(--y);
    left: 0; /* physical-ok: positioned in the map's own (physical) coordinates */
    z-index: var(--z-tooltip);
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-inline-size: min(280px, 100%);
    padding-block: 6px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    background-color: var(--surface-overlay);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
    pointer-events: none;
    translate: clamp(0px, calc(var(--x) - 50%), calc(100cqw - 100%)) calc(-100% - 6px); /* physical-ok: map coords */
    white-space: nowrap;
  }

  .tip.below {
    translate: clamp(0px, calc(var(--x) - 50%), calc(100cqw - 100%)) 18px; /* physical-ok: map coords */
  }

  .tip-title {
    font-weight: var(--weight-label);
  }

  .tip-range {
    margin-inline-start: var(--space-1);
    color: var(--text-muted);
    font-weight: var(--weight-body);
  }

  .tip-counts {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    margin: var(--space-2) 0 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  @media (forced-colors: active) {
    .cell {
      forced-color-adjust: none;
      outline: 1px solid CanvasText;
    }

    .l1,
    .l2,
    .l3,
    .l4 {
      background-color: Highlight;
    }

    .due::after {
      background-color: Mark;
    }
  }
</style>
