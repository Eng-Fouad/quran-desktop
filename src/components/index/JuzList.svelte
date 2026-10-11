<!--
  JuzList (§9.7 style, BRIEF §1.1 #4): the 30 juz as 48 px rows: the number in a rosette, "Juz 15" with the surah and
  ayah it starts at beneath, and its page span at the inline end. The juz of the page on screen is marked like the
  current surah (accent bar, filled rosette). One Tab stop; arrows, Home/End and PageUp/PageDown move inside the list.
  Owner: WP10a. Used only inside `IndexPanel`.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { Division } from '$lib/ipc/bindings'
  import { i18n, quran, reader } from '$lib/stores'
  import { numRange } from './format'
  import { openTarget } from './navigate'
  import Rosette from './Rosette.svelte'
  import { centerInView, keepInView, rovingKeydown } from './roving'

  let list: HTMLElement | null = $state(null)
  let tabStop = $state<number | null>(null)

  const layout = $derived(reader.layout)
  const current = $derived(reader.juz)
  const stopId = $derived(tabStop ?? (current > 0 ? current : 1))

  interface JuzRow {
    juz: Division
    start: string
    from: number
    to: number
  }

  const rows: JuzRow[] = $derived(
    quran.index.juz.map((juz) => {
      const from = quran.pageOfAyah(layout, juz.firstAyahId)
      return {
        juz,
        start: quran.refLabel(juz.firstAyahId, 'long'),
        from,
        to: Math.max(from, quran.pageOfAyah(layout, juz.lastAyahId)),
      }
    }),
  )

  function rowOf(id: number): HTMLElement | null {
    return list?.querySelector<HTMLElement>(`[data-juz="${id}"]`) ?? null
  }

  let placed = false
  $effect(() => {
    const id = current
    if (!list) return
    untrack(() => {
      const row = rowOf(id)
      if (!row || !list) return
      if (!placed) {
        placed = true
        centerInView(list, row)
      } else if (!list.contains(document.activeElement) && !list.matches(':hover')) {
        keepInView(list, row)
      }
    })
  })

  /** Shows the current juz (the panel's "Show where I am"). */
  export function locate(): void {
    const row = rowOf(current)
    if (row && list) {
      centerInView(list, row)
      row.focus({ preventScroll: true })
    }
  }

  function onFocusIn(e: FocusEvent): void {
    const id = Number((e.target as HTMLElement | null)?.dataset.juz)
    if (Number.isInteger(id) && id > 0) tabStop = id
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ol
  class="rows"
  bind:this={list}
  aria-label={i18n.t('navigation.juz.listLabel')}
  onkeydown={(e) => list && rovingKeydown(e, list)}
  onfocusin={onFocusIn}
>
  {#each rows as row (row.juz.id)}
    {@const id = row.juz.id}
    {@const isCurrent = id === current}
    <li>
      <button
        type="button"
        class={['row', { current: isCurrent }]}
        data-roving
        data-juz={id}
        tabindex={id === stopId ? 0 : -1}
        aria-current={isCurrent ? 'true' : undefined}
        aria-label={i18n.t('navigation.juz.rowLabel', { juz: id, start: row.start, page: row.from })}
        onclick={() => openTarget({ type: 'juz', juz: id })}
      >
        <Rosette n={id} active={isCurrent} />
        <span class="names">
          <span class="name">{i18n.t('common.juzNumber', { juz: id })}</span>
          <span class="sub">{row.start}</span>
        </span>
        <span class="meta">{i18n.t('navigation.pageRangeShort', { range: numRange(row.from, row.to) })}</span>
      </button>
    </li>
  {/each}
</ol>

<style>
  .rows {
    flex: 1 1 auto;
    min-block-size: 0;
    margin: 0;
    padding-block: var(--space-2) var(--space-3);
    padding-inline: var(--space-1);
    overflow-y: auto;
    list-style: none;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .row {
    position: relative;
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--space-3);
    inline-size: 100%;
    min-block-size: 48px;
    padding-block: var(--space-1);
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

  .row:hover {
    background-color: var(--surface-hover);
  }

  .row:focus-visible {
    outline-offset: -2px;
  }

  .row.current::before {
    content: '';
    position: absolute;
    inset-block: 10px;
    inset-inline-start: 0;
    inline-size: 3px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
  }

  .name,
  .sub {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 1.35;
  }

  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .sub {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .meta {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  @media (forced-colors: active) {
    .row.current::before {
      background-color: Highlight;
    }
  }
</style>
