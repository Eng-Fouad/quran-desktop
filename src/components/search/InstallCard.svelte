<!--
  InstallCard: the Translation scope has no installed translation to search.
  "Search a translation" with up to three packs to install (the UI language's first, then English; recommended ones
  first), each with its language and size and one action: Install, a progress bar while it downloads, or Retry after a
  failure. Offline the buttons are disabled and the body says translations download when online. "More translations"
  opens Downloads on translations. Once a pack is installed the search store switches to it and searches by itself.
  Used only inside `SearchPanel`.
-->
<script lang="ts">
  import Button from '$components/ui/Button.svelte'
  import Progress from '$components/ui/Progress.svelte'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { app, i18n, packs, settings, ui } from '$lib/stores'
  import { listSeparator } from '$lib/text/refparse'
  import star8 from '../../assets/star8.svg'

  const SHOWN = 3

  const offline = $derived(!app.online || !settings.value.networkAllowed)

  const languageNames = $derived.by(() => {
    try {
      return new Intl.DisplayNames([i18n.locale], { type: 'language' })
    } catch {
      return null
    }
  })

  const candidates: PackInfo[] = $derived.by(() => {
    const score = (p: PackInfo) =>
      (p.language === i18n.locale ? 8 : 0) + (p.language === 'en' ? 2 : 0) + (p.recommended ? 1 : 0)
    return packs.list
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.kind === 'translation' && p.state.type !== 'installed')
      .sort((a, b) => score(b.p) - score(a.p) || a.i - b.i)
      .slice(0, SHOWN)
      .map(({ p }) => p)
  })

  function meta(p: PackInfo): string {
    let language = p.language ?? ''
    try {
      language = (p.language && languageNames?.of(p.language)) || language
    } catch {
      // An unknown code stays as written.
    }
    return [language, i18n.bytes(p.sizeKib)].filter((s) => s !== '').join(listSeparator())
  }

  function percent(p: PackInfo): number {
    const job = packs.jobOf(p.id)
    if (!job || job.totalKib <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((job.receivedKib / job.totalKib) * 100)))
  }

  function install(p: PackInfo): void {
    void packs.install(p.id).catch(ui.toastError)
  }

  function retry(p: PackInfo): void {
    void packs.retry(p.id).catch(ui.toastError)
  }

  function more(): void {
    packs.filter = 'translation'
    ui.setView('downloads')
  }
</script>

<section class="card" aria-labelledby="qd-search-install-title">
  <span class="star" style:--_star={`url("${star8}")`} aria-hidden="true"></span>
  <h3 class="title" id="qd-search-install-title">{i18n.t('search.noPack.title')}</h3>
  <p class="body">{offline ? i18n.t('search.noPack.offline') : i18n.t('search.noPack.body')}</p>

  {#if candidates.length > 0}
    <ul class="packs" aria-label={i18n.t('search.noPack.listLabel')}>
      {#each candidates as p (p.id)}
        {@const job = packs.jobOf(p.id)}
        <li class="pack" data-pack={p.id}>
          <div class="text">
            <span class="name">{packs.title(p)}</span>
            <span class="meta">{meta(p)}</span>
            {#if packs.isBusy(p.id)}
              <Progress value={percent(p)} label={i18n.t('search.noPack.downloading')} />
            {/if}
          </div>
          {#if job?.phase === 'failed'}
            <Button size="sm" variant="secondary" disabled={offline} onclick={() => retry(p)}>
              {i18n.t('common.retry')}
            </Button>
          {:else if !packs.isBusy(p.id)}
            <Button size="sm" variant="secondary" disabled={offline} onclick={() => install(p)}>
              {i18n.t('common.install')}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <Button size="sm" variant="link" onclick={more}>{i18n.t('search.noPack.more')}</Button>
</section>

<style>
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding-block: var(--space-6) var(--space-4);
    padding-inline: var(--space-3);
    text-align: center;
  }

  .star {
    inline-size: 36px;
    block-size: 36px;
    margin-block-end: var(--space-1);
    background-color: var(--frame-gold);
    mask: var(--_star) center / contain no-repeat;
  }

  .title {
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .body {
    max-inline-size: 280px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .packs {
    display: flex;
    flex-direction: column;
    align-self: stretch;
    margin-block: var(--space-2);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    list-style: none;
    text-align: start;
  }

  .pack {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding-block: var(--space-2);
    padding-inline: var(--space-3) var(--space-2);
  }

  .pack + .pack {
    border-block-start: 1px solid var(--border);
  }

  .text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  @media (forced-colors: active) {
    .star {
      background-color: CanvasText;
    }
  }
</style>
