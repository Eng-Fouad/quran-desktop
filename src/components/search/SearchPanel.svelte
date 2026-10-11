<!--
  SearchPanel (§9.7, §9.8, §1.5): the Search sidebar panel. Takes no props: it reads the `search` store (§7.9). The
  shell's Sidebar draws the heading; this is the body. Owner: WP10b.

  - **Controls**: the `SearchInput` (`dir="auto"`, `data-qd-focus="search"`: `Mod+F` focuses and selects it), the scope
    (`ScopePicker`: Quran | Translation | Notes), the mode menu (Smart / Exact letters / Contains) and the surah or juz
    limit (`FilterPicker`), then a count line with plurals and locale digits ("45 results in 17 surahs · 2 ms").
  - **Completions** of the word being typed (Quran vocabulary, with ayah counts) as chips under the field.
  - **The field's keys**: Enter opens the next hit and Shift+Enter the previous one, keeping focus in the field (the
    reader follows, the list too); `Mod+Enter` opens the active (or first) hit in the side pane; ↓ enters the list;
    F3 / Shift+F3 step like Enter; Escape clears the text.
  - **References**: a query such as "2:255", "p 262" or "255" offers the jump ("Go to Al-Baqarah 2:255") above the
    results; Enter opens it when there are no text hits.
  - **States** (§9.8): empty query (recent searches and examples), the translation install card, no matches (with
    the ways out: Smart mode, translations or the Quran text, all surahs), a failed search (Retry), the typo banner
    ("Showing results for الرحمن · No exact match for الرحمان") and the truncated notice ("Showing 500 of 1,234 ·
    Filter by surah").
  - The module script installs the reader-backed hit opener (`open.ts`) for the store; the shell imports this panel
    statically, so F3 works from the start, whichever sidebar tab is open.
-->
<script lang="ts" module>
  import { installHitOpener } from './open'

  installHitOpener()
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import TextSearch from '@lucide/svelte/icons/text-search'
  import WholeWord from '@lucide/svelte/icons/whole-word'
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles'
  import X from '@lucide/svelte/icons/x'
  import { tick } from 'svelte'
  import { openTarget } from '$components/index/navigate'
  import { Button, EmptyState, IconButton, Menu, type MenuEntry, SearchInput } from '$components/ui'
  import type { SearchMode } from '$lib/ipc/bindings'
  import { i18n, search, shortcuts } from '$lib/stores'
  import { SEARCH_MODES } from '$lib/stores/search.svelte'
  import { normalizeAr } from '$lib/text/normalize'
  import { describeTarget, listSeparator, type ParseResult } from '$lib/text/refparse'
  import FilterPicker from './FilterPicker.svelte'
  import IdleState from './IdleState.svelte'
  import InstallCard from './InstallCard.svelte'
  import ScopePicker from './ScopePicker.svelte'
  import SearchResults from './SearchResults.svelte'

  /** The field shows a spinner once a search takes longer than this. */
  const SLOW_MS = 150
  /** First-strong isolates around user or Quran words inside a message (§11.3), written as code points. */
  const FSI = String.fromCodePoint(0x2068)
  const PDI = String.fromCodePoint(0x2069)
  const isolate = (text: string) => `${FSI}${text}${PDI}`

  let input: HTMLInputElement | null = $state(null)
  let list: SearchResults | undefined = $state()
  let filterOpen = $state(false)

  const results = $derived(search.results)
  const hits = $derived(results?.total ?? 0)
  const sep = $derived(listSeparator())
  const hasFilter = $derived(search.surahFilter !== null || search.juzFilter !== null)

  const searchKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'app.search')
    return def ? shortcuts.format(def) : undefined
  })

  const placeholder = $derived(i18n.t(`search.field.${search.scope.type}`))

  // --- status ---------------------------------------------------------------------------------------------------------

  let slow = $state(false)
  $effect(() => {
    if (search.status !== 'loading') {
      slow = false
      return
    }
    const timer = setTimeout(() => (slow = true), SLOW_MS)
    return () => clearTimeout(timer)
  })

  const msFormat = $derived(
    new Intl.NumberFormat(i18n.intlLocale, {
      style: 'unit',
      unit: 'millisecond',
      unitDisplay: i18n.unitDisplay,
    }),
  )

  /** "45 results in 17 surahs · 2 ms" (the surah count only when every hit is listed). */
  const summary = $derived.by(() => {
    if (search.request === null) return ''
    if (!results) return search.status === 'loading' ? i18n.t('search.summary.searching') : ''
    if (results.total === 0) return ''
    const count = i18n.tp('search.summary.results', results.total)
    const where = results.truncated ? '' : ` ${i18n.tp('search.summary.inSurahs', results.groups.length)}`
    return `${count}${where}${sep}${msFormat.format(results.tookMs)}`
  })

  // --- mode -----------------------------------------------------------------------------------------------------------

  const MODE_ICONS = { smart: Sparkles, exact: WholeWord, substring: TextSearch } as const
  /** The no-results advice per scope; in Smart mode it no longer suggests Smart mode (its button is hidden too). */
  const NONE_BODY = {
    quran: 'search.none.bodyQuran',
    translation: 'search.none.bodyTranslation',
    notes: 'search.none.bodyNotes',
  } as const
  const NONE_BODY_SMART = {
    quran: 'search.none.bodyQuranSmart',
    translation: 'search.none.bodyTranslationSmart',
    notes: 'search.none.bodyNotesSmart',
  } as const
  const ModeIcon = $derived(MODE_ICONS[search.mode])

  const modeItems: MenuEntry[] = $derived([
    {
      type: 'radio',
      id: 'mode',
      label: i18n.t('search.mode.label'),
      value: search.mode,
      onValueChange: (v: string) => search.setMode(v as SearchMode),
      options: SEARCH_MODES.map((m) => ({ value: m, label: i18n.t(`search.mode.${m}`) })),
    },
  ])

  // --- completions ----------------------------------------------------------------------------------------------------

  /** Completions of the word being typed, without the word itself. */
  const completions = $derived.by(() => {
    if (search.scope.type !== 'quran' || /\s$/u.test(search.query)) return []
    const last = normalizeAr(search.query.split(/\s+/u).at(-1) ?? '', 'loose')
    if (last === '') return []
    return search.suggestions.filter((s) => s.term !== last)
  })

  function complete(term: string): void {
    search.useSuggestion(term)
    input?.focus()
  }

  // --- references -----------------------------------------------------------------------------------------------------

  const jumps = $derived(
    search.references.map((r) => ({
      r,
      d: describeTarget(r.target, search.layout),
      key: JSON.stringify(r.target),
    })),
  )
  const firstJump = $derived(jumps.find((j) => j.r.issue === undefined)?.r ?? null)

  function openJump(r: ParseResult): void {
    if (r.issue !== undefined) return
    openTarget(r.target, { focus: true })
  }

  // --- the field ------------------------------------------------------------------------------------------------------

  function onFieldKeydown(e: KeyboardEvent): void {
    if (e.isComposing || e.altKey) return
    const mod = e.ctrlKey || e.metaKey
    switch (e.key) {
      case 'Enter': {
        e.preventDefault()
        if (mod) {
          const hit = search.activeHit ?? search.flatHits[0]
          if (hit) search.openInPane(hit)
          return
        }
        if (firstJump && (search.request === null || (hits === 0 && !search.stale))) {
          openJump(firstJump)
          return
        }
        void search.submit(e.shiftKey ? -1 : 1)
        return
      }
      case 'ArrowDown':
        if (mod || e.shiftKey) return
        if (search.flatHits.length > 0 && list) {
          e.preventDefault()
          list.focusList()
        }
        return
      case 'F3':
        if (mod) return
        e.preventDefault()
        if (search.flatHits.length > 0) search.move(e.shiftKey ? -1 : 1, { focus: false })
        return
    }
  }

  /** Back to the field from the list (↑ on the first hit, or typing there). */
  async function focusField(append?: string): Promise<void> {
    if (append) search.setQuery(search.query + append)
    await tick()
    if (!input) return
    input.focus()
    const end = input.value.length
    input.setSelectionRange(end, end)
  }

  function focusFieldSoon(): void {
    void tick().then(() => input?.focus())
  }
</script>

<div class="search-panel" data-scope={search.scope.type}>
  <div class="controls">
    <SearchInput
      bind:value={() => search.query, (v) => search.setQuery(v)}
      bind:ref={input}
      {placeholder}
      aria-label={placeholder}
      loading={slow}
      shortcut={searchKey}
      data-qd-focus="search"
      onkeydown={onFieldKeydown}
    />
    <ScopePicker />
    <div class="options">
      <Menu items={modeItems} label={i18n.t('search.mode.label')} minWidth={200}>
        {#snippet trigger({ props })}
          <button
            {...props}
            type="button"
            class="chip-button"
            title={i18n.t(`search.mode.${search.mode}Hint`)}
            data-mode={search.mode}
          >
            <ModeIcon size={14} strokeWidth={2} aria-hidden="true" />
            <span class="chip-text">{i18n.t(`search.mode.${search.mode}`)}</span>
            <ChevronDown size={12} strokeWidth={2.25} aria-hidden="true" />
          </button>
        {/snippet}
      </Menu>
      <span class="filter">
        <FilterPicker bind:open={filterOpen} />
        {#if hasFilter}
          <IconButton
            label={i18n.t('search.filter.clear')}
            icon={X}
            size="sm"
            onclick={() => search.clearFilters()}
          />
        {/if}
      </span>
    </div>
    {#if completions.length > 0}
      <div class="completions" role="group" aria-label={i18n.t('search.complete.label')}>
        {#each completions as s (s.term)}
          <button
            type="button"
            class="completion"
            lang="ar"
            dir="rtl"
            aria-label={i18n.t('search.complete.chip', {
              term: s.term,
              ayahs: i18n.tp('common.ayahCount', s.count),
            })}
            onclick={() => complete(s.term)}
          >
            <span class="term">{s.term}</span>
            <span class="term-count tabular-nums" aria-hidden="true">{i18n.num(s.count)}</span>
          </button>
        {/each}
      </div>
    {/if}
    <!-- Always present, so screen readers announce the count as results change (visually hidden while empty). -->
    <p class={['summary', 'tabular-nums', { 'sr-only': summary === '' }]} role="status">{summary}</p>
  </div>

  <div class={['body', { dim: slow && search.stale }]}>
    {#if jumps.length > 0}
      <div class="jumps">
        {#each jumps as j (j.key)}
          <button
            type="button"
            class="jump"
            aria-disabled={j.r.issue !== undefined}
            onclick={() => openJump(j.r)}
          >
            <span class="jump-icon" aria-hidden="true">
              <CornerDownRight size={16} strokeWidth={1.75} class="icon-dir" />
            </span>
            <span class="jump-text">
              <span class="jump-title">{i18n.t('search.jump.goTo', { target: j.d.title })}</span>
              <span class={['jump-detail', { reason: j.r.issue !== undefined }]}
                >{j.r.disabledReason ?? j.d.detail}</span
              >
            </span>
          </button>
        {/each}
      </div>
    {/if}

    {#if search.trimmed === ''}
      <div class="scroll"><IdleState onpick={focusFieldSoon} /></div>
    {:else if search.needsPack}
      <div class="scroll"><InstallCard /></div>
    {:else if search.status === 'error' && search.error}
      <EmptyState compact title={i18n.t('search.failed.title')} body={i18n.t(`errors.${search.error.kind}`)}>
        {#snippet action()}
          <Button size="sm" variant="secondary" onclick={() => void search.run()}
            >{i18n.t('common.retry')}</Button
          >
        {/snippet}
      </EmptyState>
    {:else if results && hits > 0}
      {#if results.suggestions.length > 0}
        <div class="notice typo">
          <WandSparkles size={14} strokeWidth={2} aria-hidden="true" />
          <p>
            <span class="notice-main"
              >{i18n.t('search.typo.showing', { terms: isolate(results.suggestions.join(sep)) })}</span
            >
            <span class="notice-sub">{i18n.t('search.typo.noExact', { query: isolate(results.query) })}</span>
          </p>
        </div>
      {/if}
      {#if results.truncated}
        <div class="notice truncated">
          <p>
            {i18n.t('search.truncated.showing', {
              shown: i18n.num(search.flatHits.length),
              total: i18n.num(results.total),
            })}
          </p>
          {#if search.surahFilter === null}
            <Button size="sm" variant="link" onclick={() => (filterOpen = true)}
              >{i18n.t('search.truncated.filter')}</Button
            >
          {/if}
        </div>
      {/if}
      <SearchResults bind:this={list} {results} onfield={focusField} />
    {:else if results && hits === 0 && !search.stale}
      <EmptyState
        compact
        title={i18n.t('search.none.title', { query: isolate(results.query) })}
        body={i18n.t((search.mode === 'smart' ? NONE_BODY_SMART : NONE_BODY)[search.scope.type])}
      >
        {#snippet action()}
          <div class="ways">
            {#if search.mode !== 'smart'}
              <Button size="sm" variant="secondary" onclick={() => search.setMode('smart')}>
                {i18n.t('search.none.trySmart')}
              </Button>
            {/if}
            {#if search.scope.type === 'quran'}
              <Button
                size="sm"
                variant="secondary"
                onclick={() => search.setScope({ type: 'translation', data: { packId: '' } })}
              >
                {i18n.t('search.none.translations')}
              </Button>
            {:else}
              <Button size="sm" variant="secondary" onclick={() => search.setScope({ type: 'quran' })}>
                {i18n.t('search.none.quran')}
              </Button>
            {/if}
            {#if hasFilter}
              <Button size="sm" variant="secondary" onclick={() => search.clearFilters()}>
                {i18n.t('search.none.everywhere')}
              </Button>
            {/if}
          </div>
        {/snippet}
      </EmptyState>
    {/if}
  </div>
</div>

<style>
  .search-panel {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
  }

  .controls {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-1) var(--space-2);
    padding-inline: var(--space-2);
  }

  .options {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-inline-size: 0;
    margin-inline: calc(-1 * var(--space-1));
  }

  .filter {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-inline-size: 0;
  }

  /* The mode and filter buttons (the filter's trigger is rendered by FilterPicker inside this panel). */
  .search-panel :global(.chip-button) {
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
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .search-panel :global(.chip-button:hover),
  .search-panel :global(.chip-button[data-state='open']) {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .search-panel :global(.chip-button.on) {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .search-panel :global(.chip-text) {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  /* Word completions: one row of chips that scrolls sideways, fading at its end. */
  .completions {
    display: flex;
    gap: var(--space-1);
    margin-block-start: -2px;
    overflow-x: auto;
    scrollbar-width: none;
    mask-image: linear-gradient(to var(--_end, right), #000 calc(100% - 24px), transparent);
  }

  :global(:root[dir='rtl']) .completions {
    --_end: left;
  }

  .completion {
    display: inline-flex;
    flex: none;
    align-items: baseline;
    gap: 5px;
    block-size: 26px;
    padding-inline: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background-color: var(--surface-raised);
    color: var(--text);
    font: inherit;
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease-standard);
  }

  .completion:hover {
    border-color: var(--border-input);
  }

  .term {
    font-family: var(--font-naskh);
    font-size: 15px;
    line-height: 24px;
  }

  .term-count {
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
  }

  .summary {
    padding-inline: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.3;
  }

  .body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-block-size: 0;
    border-block-start: 1px solid var(--border);
    transition: opacity var(--dur-quick) var(--ease-standard);
  }

  .body.dim {
    opacity: 0.6;
  }

  .scroll {
    flex: 1 1 auto;
    min-block-size: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .jumps {
    flex: none;
    padding: var(--space-1);
  }

  .jump {
    display: flex;
    align-items: center;
    gap: var(--space-3);
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
  }

  .jump:hover:not([aria-disabled='true']) {
    background-color: var(--surface-hover);
  }

  .jump:focus-visible {
    outline-offset: -2px;
  }

  .jump[aria-disabled='true'] {
    cursor: default;
  }

  .jump-icon {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    border-radius: var(--radius-xs);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .jump[aria-disabled='true'] .jump-icon {
    background-color: var(--surface-hover);
    color: var(--text-muted);
  }

  .jump-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
  }

  .jump-title {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .jump[aria-disabled='true'] .jump-title {
    color: var(--text-muted);
  }

  .jump-detail {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .jump-detail.reason {
    color: var(--danger-text);
  }

  .notice {
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: var(--space-2);
    margin-block: var(--space-2) 0;
    margin-inline: var(--space-2);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .typo {
    background-color: color-mix(in srgb, var(--hl-search-solid) 10%, transparent);
    color: var(--text);
  }

  .typo :global(svg) {
    flex: none;
    margin-block-start: 2px;
    color: var(--warning-text);
  }

  .typo p {
    display: flex;
    flex-direction: column;
  }

  .notice-main {
    font-weight: var(--weight-label);
  }

  .notice-sub {
    color: var(--text-muted);
  }

  .truncated {
    align-items: center;
    justify-content: space-between;
    padding-block: var(--space-1);
    background-color: var(--surface-hover);
    color: var(--text-muted);
  }

  .ways {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
  }
</style>
