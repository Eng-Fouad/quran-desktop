<!--
  OpenSourceList: the open-source licences of the About screen. Collapsed by default; opening it loads
  `thirdparty.json` lazily and lists every shipped package, Rust crates first, with the licence the app uses it under.
  A filter narrows the list by name, licence or author. Each package expands to its authors, its declared licence, a
  link to its repository and the full licence text (plain text; packages that ship no licence file say so).
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Scale from '@lucide/svelte/icons/scale'
  import { Badge, Button, SearchInput, Skeleton } from '$components/ui'
  import { isOpenableUrl } from '$lib/about/attributions'
  import { i18n } from '$lib/stores'
  import { onExternalClick, siteLabel } from './links'
  import {
    licenceText,
    loadThirdParty,
    matchesPackage,
    packageKey,
    type ThirdParty,
    type ThirdPartyPackage,
  } from './thirdparty'

  const uid = $props.id()

  let expanded = $state(false)
  let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle')
  let data = $state.raw<ThirdParty | null>(null)
  let query = $state('')
  /** Expanded package rows. */
  let open = $state<Record<string, true>>({})

  const filtered = $derived(data ? data.packages.filter((p) => matchesPackage(p, query)) : [])

  async function load(): Promise<void> {
    if (status === 'loading' || status === 'ready') return
    status = 'loading'
    try {
      data = await loadThirdParty()
      status = 'ready'
    } catch (e) {
      console.warn('[qd] about: thirdparty.json could not be loaded', e)
      status = 'error'
    }
  }

  function toggle(): void {
    expanded = !expanded
    if (expanded) void load()
  }

  function togglePackage(p: ThirdPartyPackage): void {
    const key = packageKey(p)
    if (open[key]) delete open[key]
    else open[key] = true
  }
</script>

<section class="oss" aria-labelledby="{uid}-title" data-section="open-source">
  <header class="head">
    <span class="head-icon"><Scale size={18} strokeWidth={1.75} aria-hidden="true" /></span>
    <div class="head-text">
      <h2 class="title" id="{uid}-title">{i18n.t('about.openSource.title')}</h2>
      <p class="lede">{i18n.t('about.openSource.lede')}</p>
    </div>
    <Button
      variant="secondary"
      size="sm"
      aria-expanded={expanded}
      aria-controls="{uid}-body"
      onclick={toggle}
      data-action="toggle-licences"
    >
      {expanded ? i18n.t('about.openSource.hide') : i18n.t('about.openSource.show')}
      {#snippet iconEnd()}
        <ChevronDown class={['chevron', { open: expanded }]} size={16} aria-hidden="true" />
      {/snippet}
    </Button>
  </header>

  {#if expanded}
    <div class="body" id="{uid}-body">
      {#if status === 'loading' || status === 'idle'}
        <div class="loading" aria-busy="true" aria-label={i18n.t('about.openSource.loading')}>
          {#each [0, 1, 2, 3] as i (i)}
            <Skeleton h={36} radius="sm" />
          {/each}
        </div>
      {:else if status === 'error' || data === null}
        <div class="failed" role="alert">
          <p>{i18n.t('about.openSource.failed')}</p>
          <Button
            size="sm"
            variant="secondary"
            onclick={() => {
              status = 'idle'
              void load()
            }}>{i18n.t('common.retry')}</Button
          >
        </div>
      {:else}
        <div class="toolbar">
          <SearchInput
            size="sm"
            bind:value={query}
            placeholder={i18n.t('about.openSource.filterPlaceholder')}
            aria-label={i18n.t('about.openSource.filter')}
            fullWidth={false}
            class="filter"
          />
          <span class="count" role="status">
            {query.trim()
              ? i18n.tp('about.openSource.matches', filtered.length)
              : i18n.tp('about.openSource.count', data.packages.length)}
          </span>
        </div>
        {#if filtered.length === 0}
          <p class="none">{i18n.t('about.openSource.empty', { query: query.trim() })}</p>
        {:else}
          <ul class="list">
            {#each filtered as p (packageKey(p))}
              {@const key = packageKey(p)}
              {@const isOpen = open[key] === true}
              <li class={['pkg', { open: isOpen }]} data-package={p.name}>
                <button
                  type="button"
                  class="pkg-head"
                  aria-expanded={isOpen}
                  aria-controls="{uid}-{key}"
                  onclick={() => togglePackage(p)}
                >
                  <span class="pkg-name" dir="ltr">{p.name}</span>
                  <span class="pkg-version" dir="ltr">{p.version}</span>
                  <span class="pkg-eco">{i18n.t(`about.openSource.ecosystems.${p.ecosystem}`)}</span>
                  <span class="pkg-licence"><Badge size="sm">{p.used}</Badge></span>
                  <ChevronDown class="pkg-chevron" size={16} aria-hidden="true" />
                </button>
                {#if isOpen}
                  {@const text = licenceText(data, p)}
                  <div class="pkg-body" id="{uid}-{key}">
                    <div class="pkg-facts">
                      {#if p.authors.length > 0}
                        <span>{i18n.t('about.openSource.by', { authors: p.authors.join(', ') })}</span>
                      {/if}
                      {#if p.licence !== p.used}
                        <span dir="auto">{i18n.t('about.openSource.declared', { licence: p.licence })}</span>
                      {/if}
                      {#if isOpenableUrl(p.url)}
                        {@const url = p.url}
                        <a class="link" href={url} onclick={(e) => onExternalClick(e, url)}
                          ><bdi dir="ltr">{siteLabel(url)}</bdi><ExternalLink
                            size={12}
                            strokeWidth={2}
                            aria-hidden="true"
                          /></a
                        >
                      {/if}
                    </div>
                    {#if text}
                      <!-- A scrollable region must be reachable by keyboard (it scrolls with the arrow keys). -->
                      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                      <pre class="pkg-text" dir="ltr" lang="en" tabindex="0">{text}</pre>
                    {:else}
                      <p class="pkg-none">{i18n.t('about.openSource.noText', { licence: p.used })}</p>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .oss {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .head-icon {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 36px;
    block-size: 36px;
    border-radius: var(--radius-md);
    background-color: var(--accent-soft);
    color: var(--accent-text);
  }

  .head-text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
  }

  .lede {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .head :global(.chevron) {
    transition: rotate var(--dur-quick) var(--ease-standard);
  }

  .head :global(.chevron.open) {
    rotate: 180deg;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-block-start: var(--space-3);
    border-block-start: 1px solid var(--border);
  }

  .loading {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .failed {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    color: var(--danger-text);
    font-size: var(--text-sm);
  }

  .failed p {
    margin: 0;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
  }

  .toolbar :global(.filter) {
    inline-size: min(320px, 100%);
  }

  .count {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .none {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .pkg + .pkg {
    border-block-start: 1px solid var(--border);
  }

  .pkg-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto auto;
    align-items: center;
    gap: var(--space-3);
    inline-size: 100%;
    min-block-size: 36px;
    padding-block: var(--space-1);
    padding-inline: var(--space-3) var(--space-2);
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
    text-align: start;
    cursor: pointer;
  }

  .pkg-head:hover {
    background-color: var(--surface-hover);
  }

  .pkg-name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-weight: var(--weight-label);
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pkg-version {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .pkg-eco {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .pkg-head :global(.pkg-chevron) {
    color: var(--text-muted);
    transition: rotate var(--dur-quick) var(--ease-standard);
  }

  .open .pkg-head :global(.pkg-chevron) {
    rotate: 180deg;
  }

  .pkg-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: 0 var(--space-3);
    padding-inline: var(--space-3);
  }

  .pkg-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent-text);
    text-decoration: none;
  }

  .link:hover {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .pkg-text {
    max-block-size: 240px;
    margin: 0;
    padding: var(--space-3);
    overflow: auto;
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.6;
    text-align: start;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .pkg-none {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
