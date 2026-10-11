<!--
  DownloadsView (§7.5, §9.7): the Downloads manager, shown in the canvas (`ui.view === 'downloads'`). Takes no props:
  it reads the `packs` store (§7.9).

  `DiskUsageBar` (with Open folder and Clear streaming cache) · banners (offline, Work offline, updates) · filters
  (kind tabs, language select, search; sticky while scrolling) · `PackSection`s: Mushaf and fonts, recitations
  (`ReciterRow` with its `SurahGrid`), translations, tafsir and word by word, language packs ordered with the UI
  language first. The column keeps clear of the player dock, which stays visible in every view.

  Opening the view refreshes the catalogue and the disk usage, loads the items of on-demand packs (page and surah
  counts, the grids) and checks for updates when online (at most every 6 hours).
-->
<script lang="ts">
  import CircleArrowUp from '@lucide/svelte/icons/circle-arrow-up'
  import CloudOff from '@lucide/svelte/icons/cloud-off'
  import Eraser from '@lucide/svelte/icons/eraser'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import WifiOff from '@lucide/svelte/icons/wifi-off'
  import type { LucideIcon } from '@lucide/svelte'
  import { onMount, untrack } from 'svelte'
  import { Button, EmptyState, ScrollArea, SearchInput, Select, Skeleton, Tabs } from '$components/ui'
  import type { SelectItem, TabItem } from '$components/ui'
  import { foldForMatch } from '$components/ui'
  import type { PackInfo, PackKind } from '$lib/ipc/bindings'
  import { app, i18n, packs, reader, settings, ui } from '$lib/stores'
  import { languageOf, reciterIdOf } from '$lib/stores/packs.svelte'
  import { canDownload, openFolder, update } from './actions'
  import DiskUsageBar from './DiskUsageBar.svelte'
  import { languageName } from './format'
  import PackRow from './PackRow.svelte'
  import PackSection from './PackSection.svelte'
  import ReciterRow from './ReciterRow.svelte'
  import { downloadsView } from './view.svelte'

  type Tab = PackKind | 'all'
  type SectionId = 'mushaf' | 'recitation' | 'translation' | 'tafsir' | 'wbw'

  const SECTIONS: readonly { id: SectionId; tab: Tab; kinds: readonly PackKind[] }[] = [
    { id: 'mushaf', tab: 'mushaf_fonts', kinds: ['mushaf_fonts', 'decor'] },
    { id: 'recitation', tab: 'recitation', kinds: ['recitation'] },
    { id: 'translation', tab: 'translation', kinds: ['translation'] },
    { id: 'tafsir', tab: 'tafsir', kinds: ['tafsir'] },
    { id: 'wbw', tab: 'wbw', kinds: ['wbw'] },
  ]
  const TAB_LABEL: Record<Tab, Parameters<typeof i18n.t>[0]> = {
    all: 'downloads.filters.kinds.all',
    mushaf_fonts: 'downloads.filters.kinds.mushaf',
    decor: 'downloads.filters.kinds.mushaf',
    recitation: 'downloads.filters.kinds.recitation',
    translation: 'downloads.filters.kinds.translation',
    tafsir: 'downloads.filters.kinds.tafsir',
    wbw: 'downloads.filters.kinds.wbw',
  }

  /** Space kept free under the column for the player dock: the side card (120 px) or the bar, plus its margin. */
  const dockReserve = $derived(
    reader.dock === 'side' ? 120 + 34 : reader.dock === 'compact' ? 56 + 34 : 64 + 34,
  )
  const online = $derived(canDownload())

  /** The language of a pack for filtering: text packs only (a recitation's "ar" is the Quran's own language). */
  function filterLanguage(p: PackInfo): string | null {
    return p.kind === 'recitation' || p.kind === 'mushaf_fonts' ? null : languageOf(p)
  }

  const tokens = $derived(foldForMatch(packs.query).split(/\s+/u).filter(Boolean))

  function matchesQuery(p: PackInfo): boolean {
    if (tokens.length === 0) return true
    const lang = filterLanguage(p)
    const haystack = foldForMatch(
      [
        p.title.en,
        p.title.ar,
        p.description[i18n.locale],
        lang ?? '',
        lang ? languageName(lang) : '',
        i18n.t(`downloads.kinds.${p.kind}`),
      ].join(' '),
    )
    return tokens.every((t) => haystack.includes(t))
  }

  function matchesLanguage(p: PackInfo): boolean {
    return packs.language === 'all' || filterLanguage(p) === packs.language
  }

  /** Packs that pass the language and search filters (the kind tab applies per section). */
  const filtered = $derived(packs.list.filter((p) => matchesLanguage(p) && matchesQuery(p)))

  /** Language packs: the UI language first, then by language name; catalogue order within a language. */
  function byLanguage(list: PackInfo[]): PackInfo[] {
    const order = new Map(packs.list.map((p, i) => [p.id, i] as const))
    const key = (p: PackInfo) => {
      const lang = languageOf(p)
      return lang === i18n.locale ? '' : `1${lang ? languageName(lang) : '~'}`
    }
    return [...list].sort(
      (a, b) => key(a).localeCompare(key(b), i18n.locale) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    )
  }

  /** The current reciter first; the rest in catalogue order. */
  function byReciter(list: PackInfo[]): PackInfo[] {
    const current = settings.value.reciterId
    return [...list].sort(
      (a, b) => Number(reciterIdOf(b.id) === current) - Number(reciterIdOf(a.id) === current),
    )
  }

  const sections = $derived(
    SECTIONS.filter((s) => packs.filter === 'all' || s.tab === packs.filter)
      .map((s) => {
        const list = filtered.filter((p) => s.kinds.includes(p.kind))
        const packsOf = s.id === 'recitation' ? byReciter(list) : s.id === 'mushaf' ? list : byLanguage(list)
        return { ...s, packs: packsOf }
      })
      .filter((s) => s.packs.length > 0),
  )

  const filtering = $derived(packs.filter !== 'all' || packs.language !== 'all' || tokens.length > 0)

  /** Kind tabs (the section headings count what each holds). */
  const tabs: TabItem[] = $derived(
    (['all', ...SECTIONS.map((s) => s.tab)] as Tab[]).map((tab) => ({
      value: tab,
      label: i18n.t(TAB_LABEL[tab]),
    })),
  )

  const languages: SelectItem[] = $derived.by(() => {
    const codes: string[] = []
    for (const p of packs.list) {
      const lang = filterLanguage(p)
      if (lang && !codes.includes(lang)) codes.push(lang)
    }
    const named = codes.map((code) => ({ value: code, label: languageName(code) }))
    named.sort(
      (a, b) =>
        Number(b.value === i18n.locale) - Number(a.value === i18n.locale) ||
        a.label.localeCompare(b.label, i18n.locale),
    )
    return [{ value: 'all', label: i18n.t('downloads.filters.allLanguages') }, ...named]
  })

  const streamKib = $derived(packs.usage?.audioStreamKib ?? 0)
  let clearing = $state(false)

  function clearFilters(): void {
    packs.filter = 'all'
    packs.language = 'all'
    packs.query = ''
  }

  async function clearStream(): Promise<void> {
    clearing = true
    try {
      const freed = await packs.clearStreamCache()
      ui.toast({
        message:
          freed > 0
            ? i18n.t('downloads.toast.streamCleared', { size: i18n.bytes(freed) })
            : i18n.t('downloads.toast.streamEmpty'),
        tone: freed > 0 ? 'success' : 'neutral',
      })
    } catch (e) {
      ui.toastError(e)
    } finally {
      clearing = false
    }
  }

  function updateAll(): void {
    for (const p of packs.updatable) update(p)
  }

  // --- loading -------------------------------------------------------------------------------------------------------

  /** Item lists asked for during this visit (a failed load is not retried in a loop). Not reactive on purpose. */
  const asked: Record<string, true> = {}

  onMount(() => {
    void packs.refresh()
    packs.loadUsage().catch((e: unknown) => console.warn('[qd] downloads: disk usage', e))
    if (canDownload()) {
      packs.checkUpdates({ ifStale: true }).catch((e: unknown) => console.warn('[qd] downloads: updates', e))
    }
  })

  $effect(() => {
    for (const p of packs.list) {
      if (p.installMode !== 'on_demand' || asked[p.id] || packs.items.has(p.id)) continue
      asked[p.id] = true
      untrack(() => packs.loadItems(p.id).catch((e: unknown) => console.warn('[qd] downloads: items', e)))
    }
  })

  $effect(() => {
    const current = packs.reciterPack(settings.value.reciterId)?.id
    if (current) untrack(() => downloadsView.openFirst(current))
  })

  // --- sticky filters --------------------------------------------------------------------------------------------------

  let sentinel: HTMLElement | null = $state(null)
  let stuck = $state(false)

  $effect(() => {
    const el = sentinel
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => (stuck = entry ? !entry.isIntersecting : false))
    observer.observe(el)
    return () => observer.disconnect()
  })
</script>

{#snippet banner(
  tone: 'warning' | 'accent',
  Icon: LucideIcon,
  title: string,
  body: string,
  action: { label: string; run: () => void; disabled?: boolean } | null,
  id: string,
)}
  <div class="banner t-{tone}" role="status" data-banner={id}>
    <span class="banner-icon"><Icon size={18} strokeWidth={1.75} aria-hidden="true" /></span>
    <div class="banner-text">
      <p class="banner-title">{title}</p>
      <p class="banner-body">{body}</p>
    </div>
    {#if action}
      <Button size="sm" variant="secondary" disabled={action.disabled} onclick={action.run}
        >{action.label}</Button
      >
    {/if}
  </div>
{/snippet}

<div class="downloads" data-qd-view="downloads" style:--_reserve="{dockReserve}px">
  <ScrollArea class="scroll">
    <div class="column">
      <header class="page-head">
        <h1 class="title">{i18n.t('downloads.title')}</h1>
        <p class="lede">{i18n.t('downloads.lede')}</p>
      </header>

      <DiskUsageBar usage={packs.usage}>
        {#snippet actions()}
          <Button size="sm" variant="ghost" onclick={openFolder} data-action="open-folder">
            {#snippet icon()}<FolderOpen aria-hidden="true" />{/snippet}
            {i18n.t('downloads.header.openFolder')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={clearing}
            disabled={streamKib === 0}
            title={streamKib === 0
              ? i18n.t('downloads.header.clearStreamEmpty')
              : i18n.t('downloads.header.clearStreamHint')}
            onclick={() => void clearStream()}
            data-action="clear-stream"
          >
            {#snippet icon()}<Eraser aria-hidden="true" />{/snippet}
            {i18n.t('downloads.header.clearStream')}
          </Button>
        {/snippet}
      </DiskUsageBar>

      {#if !settings.value.networkAllowed}
        {@render banner(
          'warning',
          CloudOff,
          i18n.t('downloads.banner.networkOffTitle'),
          i18n.t('downloads.banner.networkOffBody'),
          {
            label: i18n.t('downloads.banner.allowNetwork'),
            run: () => settings.update({ networkAllowed: true }),
          },
          'network-off',
        )}
      {:else if !app.online}
        {@render banner(
          'warning',
          WifiOff,
          i18n.t('downloads.banner.offlineTitle'),
          i18n.t('downloads.banner.offlineBody'),
          null,
          'offline',
        )}
      {/if}
      {#if packs.updatable.length > 0}
        {@render banner(
          'accent',
          CircleArrowUp,
          i18n.tp('downloads.banner.updates', packs.updatable.length),
          i18n.t('downloads.banner.updatesBody'),
          { label: i18n.t('downloads.banner.updateAll'), run: updateAll, disabled: !online },
          'updates',
        )}
      {/if}

      <div class="sentinel" bind:this={sentinel} aria-hidden="true"></div>
      <div class={['filters', { stuck }]} role="search">
        <Tabs
          class="kinds"
          {tabs}
          value={packs.filter}
          onValueChange={(v) => (packs.filter = v as Tab)}
          label={i18n.t('downloads.filters.label')}
        />
        <div class="controls">
          <Select
            size="sm"
            items={languages}
            value={packs.language}
            onValueChange={(v) => (packs.language = v)}
            label={i18n.t('downloads.filters.language')}
          />
          <SearchInput
            size="sm"
            bind:value={packs.query}
            placeholder={i18n.t('downloads.filters.searchPlaceholder')}
            aria-label={i18n.t('downloads.filters.search')}
            fullWidth={false}
          />
        </div>
      </div>

      {#if packs.status === 'error' && packs.list.length === 0}
        <EmptyState
          title={i18n.t('downloads.state.errorTitle')}
          body={i18n.t(`errors.${packs.error?.kind ?? 'internal'}`)}
        >
          {#snippet action()}
            <Button variant="secondary" onclick={() => void packs.refresh()}>{i18n.t('common.retry')}</Button>
          {/snippet}
        </EmptyState>
      {:else if packs.list.length === 0}
        <div class="loading" aria-busy="true" aria-label={i18n.t('downloads.state.loading')}>
          {#each [0, 1, 2] as i (i)}
            <div class="skeleton-card">
              <Skeleton w="30%" h={14} />
              <Skeleton h={56} radius="md" />
              <Skeleton h={56} radius="md" />
            </div>
          {/each}
        </div>
      {:else if sections.length === 0}
        <EmptyState
          title={packs.query.trim()
            ? i18n.t('downloads.filters.emptyQuery', { query: packs.query.trim() })
            : i18n.t('downloads.filters.empty')}
          body={i18n.t('downloads.filters.emptyBody')}
        >
          {#snippet action()}
            {#if filtering}
              <Button variant="secondary" onclick={clearFilters}>{i18n.t('downloads.filters.clear')}</Button>
            {/if}
          {/snippet}
        </EmptyState>
      {:else}
        {#each sections as s (s.id)}
          <PackSection
            id={s.id}
            title={i18n.t(`downloads.sections.${s.id}`)}
            hint={i18n.t(`downloads.sections.${s.id}Hint`)}
            count={s.packs.length}
          >
            {#each s.packs as p (p.id)}
              {#if p.kind === 'recitation'}
                <ReciterRow pack={p} />
              {:else}
                <PackRow pack={p} />
              {/if}
            {/each}
          </PackSection>
        {/each}
      {/if}
    </div>
  </ScrollArea>
</div>

<style>
  .downloads {
    position: relative;
    block-size: 100%;
    min-block-size: 0;
    container-type: inline-size;
    background-color: var(--surface-app);
  }

  .downloads > :global(.scroll) {
    block-size: 100%;
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    inline-size: 100%;
    max-inline-size: 920px;
    margin-inline: auto;
    padding-block: var(--space-8) calc(var(--_reserve) + var(--space-6));
    padding-inline: var(--space-8);
  }

  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-inline: var(--space-1);
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-2xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title, 1.25);
  }

  .lede {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: var(--leading-ui);
  }

  .banner {
    --_tone: var(--warning);
    --_ink: var(--warning-text);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
    border: 1px solid color-mix(in srgb, var(--_tone) 30%, var(--border));
    border-radius: var(--radius-md);
    background-color: color-mix(in srgb, var(--_tone) 8%, var(--surface-raised));
  }

  .banner.t-accent {
    --_tone: var(--accent);
    --_ink: var(--accent-text);
  }

  .banner-icon {
    display: inline-grid;
    flex: none;
    place-items: center;
    color: var(--_ink);
  }

  .banner-text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 1px;
    min-inline-size: 0;
  }

  .banner-title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
  }

  .banner-body {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .sentinel {
    block-size: 0;
    margin-block-end: calc(-1 * var(--space-5));
  }

  .filters {
    position: sticky;
    inset-block-start: 0;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
    padding-block: var(--space-2) 0;
    border-block-end: 1px solid var(--border);
    background-color: var(--surface-app);
  }

  /* Stuck under the top edge: a soft edge over the rows scrolling beneath. */
  .filters.stuck::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    inset-block-start: 100%;
    block-size: 10px;
    background: linear-gradient(color-mix(in srgb, var(--surface-app) 90%, transparent), transparent);
    pointer-events: none;
  }

  .filters :global(.kinds) {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .filters :global(.kinds .list) {
    border-block-end: 0;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-block-end: 6px;
  }

  .controls :global(input[type='search']) {
    inline-size: 180px;
  }

  .loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  @container (max-width: 640px) {
    .column {
      padding-inline: var(--space-4);
    }

    .controls {
      inline-size: 100%;
    }

    .controls :global(input[type='search']) {
      inline-size: 100%;
    }
  }
</style>
