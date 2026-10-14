<!--
  FilterPicker: limits the search to one surah or one juz. A compact button showing the current limit ("All surahs",
  "Al-Kahf", "Juz 15") opens a popover with a field and a listbox: "All surahs", the 30 juz as a grid, then the 114
  surahs (rosette, name, Arabic name). Typing filters by surah name in either script (aliases and spelling variants,
  `parseReference`), by number ("18" offers surah 18 and juz 18) and by juz ("j 15"). ↑/↓ (and ←/→ in the juz grid)
  move, Enter picks, Escape closes. The filters are ayah-id ranges the engine applies in SQL. Used only inside
  `SearchPanel`.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Funnel from '@lucide/svelte/icons/funnel'
  import { tick } from 'svelte'
  import Rosette from '$components/index/Rosette.svelte'
  import { Popover, SearchInput } from '$components/ui'
  import { i18n, quran, search } from '$lib/stores'
  import { asciiDigits } from '$lib/text/normalize'
  import { listSeparator, parseReference } from '$lib/text/refparse'

  interface Props {
    open?: boolean
  }

  let { open = $bindable(false) }: Props = $props()

  /** Juz cells per row of the grid. */
  const JUZ_COLUMNS = 6

  interface Option {
    id: string
    kind: 'all' | 'surah' | 'juz'
    n: number
  }

  let query = $state('')
  let active = $state(0)
  let listEl: HTMLElement | null = $state(null)

  const trimmed = $derived(query.trim())
  const ALL: Option = { id: 'all', kind: 'all', n: 0 }

  const options: Option[] = $derived.by(() => {
    const surahs = quran.index.surahs
    if (trimmed === '') {
      return [
        ALL,
        ...Array.from({ length: 30 }, (_, i): Option => ({ id: `j${i + 1}`, kind: 'juz', n: i + 1 })),
        ...surahs.map((s): Option => ({ id: `s${s.id}`, kind: 'surah', n: s.id })),
      ]
    }
    const out: Option[] = []
    const add = (kind: 'surah' | 'juz', n: number) => {
      const id = `${kind === 'surah' ? 's' : 'j'}${n}`
      if (!out.some((o) => o.id === id)) out.push({ id, kind, n })
    }
    const digits = asciiDigits(trimmed)
    if (/^\d+$/u.test(digits)) {
      const n = Number(digits)
      if (n >= 1 && n <= surahs.length) add('surah', n)
      if (n >= 1 && n <= 30) add('juz', n)
      return out
    }
    for (const r of parseReference(trimmed, { nameLimit: 8 })) {
      if (r.issue !== undefined) continue
      const t = r.target
      if (t.type === 'juz') add('juz', t.juz)
      else if (t.type === 'surah' || t.type === 'ayah') add('surah', t.surah)
    }
    return out
  })

  const grid = $derived(trimmed === '')
  const activeOption = $derived(options[Math.min(active, options.length - 1)] ?? null)

  /** The button's text: what the search is limited to. */
  const current = $derived.by(() => {
    const s = search.surahFilter
    const j = search.juzFilter
    const surah = s === null ? '' : quran.surahName(s)
    const juz = j === null ? '' : i18n.t('search.filter.juzItem', { juz: j })
    if (s !== null && j !== null) return i18n.t('search.filter.both', { surah, juz, sep: listSeparator() })
    return s !== null ? surah : j !== null ? juz : i18n.t('search.filter.everywhere')
  })

  function isCurrent(o: Option): boolean {
    if (o.kind === 'all') return search.surahFilter === null && search.juzFilter === null
    if (o.kind === 'surah') return search.surahFilter === o.n && search.juzFilter === null
    return search.juzFilter === o.n && search.surahFilter === null
  }

  function label(o: Option): string {
    if (o.kind === 'all') return i18n.t('search.filter.everywhere')
    if (o.kind === 'juz') return i18n.t('search.filter.juzItem', { juz: o.n })
    return quran.surahName(o.n)
  }

  function pick(o: Option): void {
    if (o.kind === 'all') search.clearFilters()
    else if (o.kind === 'surah') search.setFilters({ surah: o.n, juz: null })
    else search.setFilters({ surah: null, juz: o.n })
    open = false
  }

  function onOpenChange(next: boolean): void {
    if (!next) return
    query = ''
    const at = options.findIndex(isCurrent)
    active = Math.max(0, at)
    void tick().then(() => scrollActive('center'))
  }

  function scrollActive(block: ScrollLogicalPosition = 'nearest'): void {
    const el = listEl?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block, inline: 'nearest' })
  }

  function moveTo(i: number): void {
    if (options.length === 0) return
    active = Math.max(0, Math.min(options.length - 1, i))
    void tick().then(() => scrollActive())
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
    const o = activeOption
    const inGrid = grid && o?.kind === 'juz'
    const rtl = i18n.dir === 'rtl'
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        if (inGrid && o) {
          const below = active + JUZ_COLUMNS
          // Below the last row of the grid: the first surah.
          moveTo(below <= 30 ? below : 31)
        } else moveTo(active + 1)
        return
      }
      case 'ArrowUp': {
        e.preventDefault()
        if (inGrid && o) moveTo(o.n <= JUZ_COLUMNS ? 0 : active - JUZ_COLUMNS)
        else if (grid && o?.kind === 'surah' && o.n === 1) moveTo(30 - ((30 - 1) % JUZ_COLUMNS))
        else moveTo(active - 1)
        return
      }
      case 'ArrowRight':
      case 'ArrowLeft': {
        if (!inGrid) return
        e.preventDefault()
        const forward = (e.key === 'ArrowLeft') === rtl
        moveTo(Math.min(30, Math.max(1, active + (forward ? 1 : -1))))
        return
      }
      case 'Home':
      case 'End':
        if (trimmed !== '') return
        e.preventDefault()
        moveTo(e.key === 'Home' ? 0 : options.length - 1)
        return
      case 'Enter':
        e.preventDefault()
        if (o) pick(o)
        return
    }
  }

  function onQuery(value: string): void {
    query = value
    active = 0
  }

  const optionId = (o: Option) => `qd-search-filter-${o.id}`
</script>

<Popover
  bind:open
  {onOpenChange}
  side="bottom"
  align="start"
  width={292}
  padding="none"
  label={i18n.t('search.filter.label')}
>
  {#snippet trigger({ props })}
    <button
      {...props}
      type="button"
      class={['chip-button', { on: search.surahFilter !== null || search.juzFilter !== null }]}
      title={i18n.t('search.filter.label')}
    >
      <Funnel size={14} strokeWidth={2} aria-hidden="true" />
      <span class="chip-text">{current}</span>
      <ChevronDown size={12} strokeWidth={2.25} aria-hidden="true" />
    </button>
  {/snippet}

  <div class="picker">
    <div class="field">
      <SearchInput
        bind:value={() => query, onQuery}
        size="sm"
        placeholder={i18n.t('search.filter.label')}
        role="combobox"
        aria-expanded="true"
        aria-controls="qd-search-filter-list"
        aria-activedescendant={activeOption ? optionId(activeOption) : undefined}
        aria-autocomplete="list"
        {onkeydown}
      />
    </div>
    <div
      class="list"
      id="qd-search-filter-list"
      role="listbox"
      bind:this={listEl}
      aria-label={i18n.t('search.filter.label')}
    >
      {#if options.length === 0}
        <p class="none">{i18n.t('search.filter.none')}</p>
      {/if}
      {#each options as o, i (o.id)}
        {#if grid && o.kind === 'juz' && o.n === 1}
          <p class="heading" aria-hidden="true">{i18n.t('search.filter.juz')}</p>
        {/if}
        {#if grid && o.kind === 'surah' && o.n === 1}
          <p class="heading" aria-hidden="true">{i18n.t('search.filter.surahs')}</p>
        {/if}
        {#if grid && o.kind === 'juz'}
          {#if o.n === 1}
            <div class="juz-grid" role="presentation">
              {#each options.slice(i, i + 30) as j, k (j.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                  id={optionId(j)}
                  role="option"
                  class={['juz', { current: isCurrent(j) }]}
                  aria-selected={active === i + k}
                  aria-label={label(j)}
                  data-active={active === i + k}
                  tabindex="-1"
                  onclick={() => pick(j)}
                  onpointermove={() => (active = i + k)}
                >
                  {i18n.num(j.n)}
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            id={optionId(o)}
            role="option"
            class={['option', o.kind, { current: isCurrent(o) }]}
            aria-selected={active === i}
            data-active={active === i}
            tabindex="-1"
            onclick={() => pick(o)}
            onpointermove={() => (active = i)}
          >
            {#if o.kind === 'surah'}
              <Rosette n={o.n} size={20} />
            {:else if o.kind === 'juz'}
              <span class="juz-badge tabular-nums" aria-hidden="true">{i18n.num(o.n)}</span>
            {:else}
              <span class="all-icon" aria-hidden="true"><Funnel size={14} strokeWidth={2} /></span>
            {/if}
            <span class="label">{label(o)}</span>
            {#if o.kind === 'surah' && i18n.locale !== 'ar'}
              <span class="ar" lang="ar" dir="rtl">{quran.surah(o.n)?.nameAr}</span>
            {/if}
            <span class="check" aria-hidden="true">
              {#if isCurrent(o)}<Check size={14} strokeWidth={2.25} />{/if}
            </span>
          </div>
        {/if}
      {/each}
    </div>
  </div>
</Popover>

<style>
  .chip-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-inline-size: 0;
    max-inline-size: 100%;
    block-size: 28px;
    padding-inline: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
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

  .chip-button:hover,
  .chip-button[data-state='open'] {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .chip-button.on {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .chip-text {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker {
    display: flex;
    flex-direction: column;
  }

  .field {
    padding: var(--space-2);
    border-block-end: 1px solid var(--border);
  }

  .list {
    max-block-size: min(340px, 50vh);
    overflow-y: auto;
    padding: var(--space-1);
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .heading {
    padding-block: var(--space-2) var(--space-1);
    padding-inline: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(html[lang='ar']) .heading {
    letter-spacing: 0;
    text-transform: none;
  }

  .none {
    padding: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }

  .option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-block-size: 32px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-xs);
    color: var(--text);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .option[data-active='true'],
  .juz[data-active='true'] {
    background-color: var(--surface-hover);
  }

  .option.current .label {
    color: var(--accent-text);
    font-weight: var(--weight-label);
  }

  .label {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ar {
    flex: none;
    color: var(--text-muted);
    font-family: var(--font-naskh);
    font-size: 15px;
    line-height: 1;
  }

  .check {
    display: inline-flex;
    flex: none;
    inline-size: 14px;
    color: var(--accent-text);
  }

  .all-icon,
  .juz-badge {
    display: inline-grid;
    flex: none;
    place-items: center;
    inline-size: 20px;
    block-size: 20px;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
  }

  .juz-badge {
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xs);
  }

  .juz-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 2px;
    padding-inline: var(--space-1);
  }

  .juz {
    display: grid;
    place-items: center;
    block-size: 30px;
    border-radius: var(--radius-xs);
    color: var(--text);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .juz.current {
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-weight: var(--weight-title);
  }

  .juz.current[data-active='true'] {
    background-color: color-mix(in srgb, var(--accent) 20%, transparent);
  }

  @media (forced-colors: active) {
    .option[data-active='true'],
    .juz[data-active='true'] {
      outline: 1px solid Highlight;
    }
  }
</style>
