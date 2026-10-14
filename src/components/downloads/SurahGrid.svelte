<!--
  SurahGrid: the 114 surahs of a recitation pack, driven by `packs_items`, as 28 px cells (19 × 6 when there is
  room). Filled accent when downloaded (pinned), half-tone when cached while streaming, an outline ring when queued
  (part of the pack's job, or waiting for it). Activating a cell downloads that surah (`packs_install(id, Items[n])`)
  or removes it (`packs_remove_items`). The first download of any surah also pins surah 1, whose file holds every
  other surah's basmala; it cannot be removed while other surahs stay downloaded.

  - Keyboard: one tab stop; arrow keys move (mirrored in RTL), Home/End go to the first and last surah, Enter/Space
    activate, Shift+F10 or the menu key opens the cell's menu (Download · Remove · Play surah).
  - The line under the grid describes the hovered or focused surah ("18. Al-Kahf · Downloaded · 34 MB").
  - Beside the grid: the legend with counts, "Download all (1.6 GB)" / "Download the rest" and "Remove all".
-->
<script lang="ts">
  import Download from '@lucide/svelte/icons/download'
  import Play from '@lucide/svelte/icons/play'
  import Trash from '@lucide/svelte/icons/trash'
  import { Button, ContextMenu } from '$components/ui'
  import type { MenuEntry, Point } from '$components/ui'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { i18n, packs, quran } from '$lib/stores'
  import { isActivePhase, reciterIdOf } from '$lib/stores/packs.svelte'
  import { canDownload, download, playSurah, removeAllSurahs, removeSurah } from './actions'

  interface Props {
    pack: PackInfo
  }

  let { pack }: Props = $props()

  const SURAHS = 114
  type CellState = 'pinned' | 'cached' | 'queued' | 'none'
  interface Cell {
    n: number
    state: CellState
    /** Cached while streaming (also when queued for a download). */
    cached: boolean
    kib: number
  }

  const reciterId = $derived(reciterIdOf(pack.id) ?? 0)
  const name = $derived(packs.title(pack))
  const job = $derived(packs.jobs.get(pack.id))
  const running = $derived(job !== undefined && isActivePhase(job.phase))
  const online = $derived(canDownload())

  const cells: Cell[] = $derived.by(() => {
    const byItem = new Map((packs.items.get(pack.id) ?? []).map((i) => [i.item, i] as const))
    // Waiting for the running job, or for a connection ("Download when online"): both show as queued.
    const scopes = [packs.pending.get(pack.id), packs.waiting.get(pack.id)]
    const waiting = new Set(scopes.flatMap((s) => (s?.type === 'items' ? s.data.items : [])))
    const all = scopes.some((s) => s?.type === 'all')
    return Array.from({ length: SURAHS }, (_, i): Cell => {
      const n = i + 1
      const item = byItem.get(n)
      const pinned = item?.pinned ?? false
      const cached = !pinned && item !== undefined && item.kib > 0
      const queued = !pinned && ((item?.queued ?? false) || waiting.has(n) || all)
      return {
        n,
        state: pinned ? 'pinned' : queued ? 'queued' : cached ? 'cached' : 'none',
        cached,
        kib: item?.kib ?? 0,
      }
    })
  })

  const counts = $derived.by(() => {
    const out = { pinned: 0, cached: 0, queued: 0 }
    for (const c of cells) {
      if (c.state === 'pinned') out.pinned++
      else if (c.state === 'queued') out.queued++
      if (c.cached) out.cached++
    }
    return out
  })

  /** Surah 1 holds the basmala of the other downloaded surahs (it stays while they do). */
  const basmalaLocked = $derived(cells[0]?.state === 'pinned' && counts.pinned > 1)
  const rest = $derived(packs.remainingKib(pack))

  let active = $state(1)
  let described: number | null = $state(null)
  let menu: { n: number; at: Point } | null = $state(null)
  let grid: HTMLElement | null = $state(null)

  function cellSize(c: Cell): string {
    if (c.kib > 0) return i18n.bytes(c.kib)
    return i18n.t('downloads.grid.about', { size: i18n.bytes(packs.itemKib(pack, c.n)) })
  }

  function stateLabel(c: Cell): string {
    return i18n.t(`downloads.grid.state.${c.state}`)
  }

  function cellLabel(c: Cell): string {
    const base = {
      number: i18n.num(c.n),
      surah: quran.surahName(c.n),
      state: stateLabel(c),
    }
    const label = i18n.t('downloads.grid.cellSize', { ...base, size: cellSize(c) })
    return c.n === 1 && basmalaLocked ? `${label}. ${i18n.t('downloads.grid.basmala')}` : label
  }

  /** Whether activating the cell does something now. */
  function actionable(c: Cell): boolean {
    if (c.state === 'queued') return false
    if (c.state === 'pinned') return !(c.n === 1 && basmalaLocked)
    return online
  }

  function activate(c: Cell): void {
    active = c.n
    if (!actionable(c)) return
    if (c.state === 'pinned') void removeSurah(pack, c.n)
    else download(pack, { type: 'items', data: { items: [c.n] } })
  }

  const status = $derived.by(() => {
    const c = described === null ? undefined : cells[described - 1]
    if (!c) return i18n.t(online ? 'downloads.grid.hint' : 'downloads.grid.offlineHint')
    const sep = i18n.t('downloads.sep')
    const parts = [`${i18n.num(c.n)}. ${quran.surahName(c.n)}`, stateLabel(c), cellSize(c)]
    if (c.n === 1 && basmalaLocked) parts.push(i18n.t('downloads.grid.basmala'))
    return parts.join(sep)
  })

  // --- keyboard ------------------------------------------------------------------------------------------------------

  /** Columns as laid out now (cells sharing the first cell's row). */
  function columns(): number {
    const buttons = grid?.querySelectorAll<HTMLElement>('.cell') ?? []
    const top = buttons[0]?.offsetTop
    let n = 0
    for (const b of buttons) {
      if (b.offsetTop !== top) break
      n++
    }
    return Math.max(1, n)
  }

  function focusCell(n: number): void {
    active = Math.min(SURAHS, Math.max(1, n))
    grid?.querySelector<HTMLElement>(`[data-surah="${active}"]`)?.focus()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const rtl = i18n.dir === 'rtl'
    let next: number | null = null
    switch (e.key) {
      case 'ArrowRight':
        next = active + (rtl ? -1 : 1)
        break
      case 'ArrowLeft':
        next = active + (rtl ? 1 : -1)
        break
      case 'ArrowDown':
        next = active + columns()
        break
      case 'ArrowUp':
        next = active - columns()
        break
      case 'Home':
        next = 1
        break
      case 'End':
        next = SURAHS
        break
    }
    if (next === null) return
    e.preventDefault()
    if (next >= 1 && next <= SURAHS) focusCell(next)
  }

  // --- menu ----------------------------------------------------------------------------------------------------------

  function openMenu(e: MouseEvent, c: Cell): void {
    e.preventDefault()
    e.stopPropagation() // the row's own menu must not open too
    active = c.n
    let at: Point = { x: e.clientX, y: e.clientY }
    if (e.clientX === 0 && e.clientY === 0 && e.currentTarget instanceof HTMLElement) {
      const r = e.currentTarget.getBoundingClientRect()
      at = { x: i18n.dir === 'rtl' ? r.right : r.left, y: r.bottom }
    }
    menu = { n: c.n, at }
  }

  const menuItems: MenuEntry[] = $derived.by(() => {
    const c = menu === null ? undefined : cells[menu.n - 1]
    if (!c) return []
    const entries: MenuEntry[] = []
    if (c.state === 'pinned') {
      entries.push({
        id: 'remove',
        label: i18n.t('downloads.grid.remove'),
        icon: Trash,
        danger: true,
        disabled: c.n === 1 && basmalaLocked,
        onSelect: () => void removeSurah(pack, c.n),
      })
    } else {
      entries.push({
        id: 'download',
        label: i18n.t('downloads.grid.download'),
        icon: Download,
        disabled: !online || c.state === 'queued',
        onSelect: () => download(pack, { type: 'items', data: { items: [c.n] } }),
      })
    }
    entries.push({ type: 'separator', id: 'sep' })
    entries.push({
      id: 'play',
      label: i18n.t('downloads.grid.play'),
      icon: Play,
      onSelect: () => void playSurah(reciterId, c.n),
    })
    return entries
  })
</script>

<div class="surah-grid">
  <!-- A composite of buttons with one tab stop: the arrow keys move between them (roving tabindex). -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={grid}
    class={['grid', { running }]}
    role="group"
    aria-label={i18n.t('downloads.grid.label', { name })}
    data-qd-keys="own"
    onkeydown={onKeydown}
    onpointerleave={() => (described = null)}
    onfocusout={(e) => {
      if (!grid?.contains(e.relatedTarget as Node | null)) described = null
    }}
  >
    {#each cells as c (c.n)}
      <button
        type="button"
        class="cell"
        data-surah={c.n}
        data-state={c.state}
        data-cached={c.cached ? '' : undefined}
        tabindex={c.n === active ? 0 : -1}
        aria-label={cellLabel(c)}
        aria-pressed={c.state === 'pinned'}
        aria-disabled={actionable(c) ? undefined : 'true'}
        onclick={() => activate(c)}
        onfocus={() => {
          active = c.n
          described = c.n
        }}
        onpointerenter={() => (described = c.n)}
        oncontextmenu={(e) => openMenu(e, c)}
      >
        {i18n.num(c.n)}
      </button>
    {/each}
  </div>
  <p class="status">{status}</p>

  <div class="foot">
    <ul class="legend">
      <li>
        <span class="swatch pinned" aria-hidden="true"></span>{i18n.t('downloads.grid.legend.pinned')}
        <span class="n">{i18n.num(counts.pinned)}</span>
      </li>
      <li>
        <span class="swatch cached" aria-hidden="true"></span>{i18n.t('downloads.grid.legend.cached')}
        <span class="n">{i18n.num(counts.cached)}</span>
      </li>
      {#if counts.queued > 0}
        <li>
          <span class="swatch queued" aria-hidden="true"></span>{i18n.t('downloads.grid.legend.queued')}
          <span class="n">{i18n.num(counts.queued)}</span>
        </li>
      {/if}
    </ul>
    <div class="bulk">
      {#if counts.pinned > 0}
        <Button size="sm" variant="ghost" onclick={() => void removeAllSurahs(pack)} data-action="remove-all">
          {#snippet icon()}<Trash aria-hidden="true" />{/snippet}
          {i18n.t('downloads.actions.removeAll')}
        </Button>
      {/if}
      {#if rest > 0 && counts.queued < SURAHS - counts.pinned}
        <Button
          size="sm"
          variant="secondary"
          disabled={!online}
          title={online ? undefined : i18n.t('downloads.actions.needsNetwork')}
          onclick={() => download(pack)}
          data-action="download-all"
        >
          {#snippet icon()}<Download aria-hidden="true" />{/snippet}
          {i18n.t(
            counts.pinned > 0 ? 'downloads.actions.downloadRestSize' : 'downloads.actions.downloadAllSize',
            {
              size: i18n.bytes(rest),
            },
          )}
        </Button>
      {/if}
    </div>
  </div>
</div>

<ContextMenu
  at={menu?.at ?? null}
  items={menuItems}
  label={menu ? i18n.t('downloads.grid.menuLabel', { surah: quran.surahName(menu.n) }) : undefined}
  onClose={() => (menu = null)}
/>

<style>
  .surah-grid {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .grid {
    --_cell: 28px;
    --_gap: 5px;
    display: grid;
    grid-template-columns: repeat(auto-fill, var(--_cell));
    gap: var(--_gap);
    /* 19 × 6 = 114: a full rectangle when there is room. */
    inline-size: calc(19 * var(--_cell) + 18 * var(--_gap));
    max-inline-size: 100%;
  }

  .cell {
    --_fill: color-mix(in srgb, var(--text) 5%, var(--surface-raised));
    --_ink: var(--text-muted);
    display: inline-grid;
    place-items: center;
    inline-size: var(--_cell);
    block-size: var(--_cell);
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background-color: var(--_fill);
    color: var(--_ink);
    font-family: inherit;
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard),
      box-shadow var(--dur-fast) var(--ease-standard);
  }

  .cell:hover:not([aria-disabled='true']) {
    --_fill: color-mix(in srgb, var(--text) 11%, var(--surface-raised));
    --_ink: var(--text);
  }

  .cell[data-cached] {
    --_fill: color-mix(in srgb, var(--accent) 22%, var(--surface-raised));
    --_ink: var(--text);
  }

  .cell[data-cached]:hover:not([aria-disabled='true']) {
    --_fill: color-mix(in srgb, var(--accent) 32%, var(--surface-raised));
  }

  .cell[data-state='pinned'] {
    --_fill: var(--accent);
    --_ink: var(--accent-ink);
    font-weight: var(--weight-title);
  }

  .cell[data-state='pinned']:hover:not([aria-disabled='true']) {
    --_fill: color-mix(in srgb, var(--accent) 86%, var(--text));
    --_ink: var(--accent-ink);
  }

  .cell[data-state='queued'] {
    --_ink: var(--accent-text);
    box-shadow: inset 0 0 0 1.5px var(--accent);
    cursor: default;
  }

  .cell[aria-disabled='true'] {
    cursor: default;
  }

  .cell[data-state='none'][aria-disabled='true'] {
    --_ink: var(--text-faint);
  }

  .cell:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* While the pack's job runs, its queued cells breathe (not under reduced motion). */
  .running .cell[data-state='queued'] {
    animation: breathe 1.6s var(--ease-standard) infinite;
  }

  @keyframes breathe {
    50% {
      box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 35%, transparent);
    }
  }

  :global(:root[data-motion='reduce']) .running .cell[data-state='queued'] {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .running .cell[data-state='queued'] {
      animation: none;
    }
  }

  .status {
    min-block-size: 1.45em;
    margin: 0;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.45;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
    padding-block-start: var(--space-3);
    border-block-start: 1px solid var(--border);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-5);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text);
    font-size: var(--text-xs);
  }

  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .swatch {
    flex: none;
    inline-size: 12px;
    block-size: 12px;
    border-radius: 3px;
  }

  .swatch.pinned {
    background-color: var(--accent);
  }

  .swatch.cached {
    background-color: color-mix(in srgb, var(--accent) 22%, var(--surface-raised));
  }

  .swatch.queued {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }

  .n {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .bulk {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  @media (forced-colors: active) {
    .cell {
      border: 1px solid ButtonText;
    }

    .cell[data-state='pinned'] {
      forced-color-adjust: none;
      background-color: Highlight;
      color: HighlightText;
    }

    .cell[data-cached] {
      border-style: dashed;
    }

    .cell[data-state='queued'] {
      border: 2px solid Highlight;
    }
  }
</style>
