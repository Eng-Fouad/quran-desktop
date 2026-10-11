<!--
  AddTranslationCard (§9.8, translation mode with no translation to show): "Add a translation", with up to three
  packs to add, each with its language, size and one action:
  - a selected pack that is missing comes first (downloading: progress; failed: Retry; else Install);
  - then installed packs that are not selected (Show);
  - then the catalogue's best matches for the UI language (and the OS language), recommended packs first (Install).
  Install adds the pack to `settings.translations` and starts its download (`packs.install`, WP12a); the view switches
  to the verses by itself once it is installed. Offline, Install is disabled and the body says that translations
  download when you're online. Below: "More translations" (Downloads) and "Back to the Mushaf". Owner: WP11a.
-->
<script lang="ts">
  import Button from '$components/ui/Button.svelte'
  import Progress from '$components/ui/Progress.svelte'
  import { app, i18n, packs, settings, translations, ui } from '$lib/stores'
  import { MAX_PACKS, type PackMeta } from '$lib/stores/translations.svelte'
  import star8 from '../../assets/star8.svg'

  /** Packs listed when nothing more specific applies. */
  const SHOWN = 3

  const offline = $derived(!app.online)
  const selected = $derived(translations.selectedPacks)

  const languageNames = $derived.by(() => {
    try {
      return new Intl.DisplayNames([i18n.locale], { type: 'language' })
    } catch {
      return null
    }
  })

  /** The OS language (`ar-EG` → `ar`), a hint for what to recommend besides the UI language. */
  const osLanguage = $derived((app.info.osLocale ?? '').toLowerCase().split(/[-_]/)[0] ?? '')

  const entries: readonly PackMeta[] = $derived.by(() => {
    const out: PackMeta[] = [...translations.missingPacks]
    const add = (m: PackMeta) => {
      if (!out.some((o) => o.id === m.id)) out.push(m)
    }
    const catalog = translations.translationCatalog
    for (const m of catalog) if (m.availability === 'installed' && !selected.includes(m.id)) add(m)
    const score = (m: PackMeta) =>
      (m.language === i18n.locale ? 8 : 0) +
      (m.language === osLanguage ? 4 : 0) +
      (m.language === 'en' ? 2 : 0) +
      (m.recommended ? 1 : 0)
    const ranked = catalog
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.availability !== 'installed')
      .sort((a, b) => score(b.m) - score(a.m) || a.i - b.i)
    for (const { m } of ranked) {
      if (out.length >= Math.max(SHOWN, translations.missingPacks.length)) break
      add(m)
    }
    return out.slice(0, Math.max(SHOWN, translations.missingPacks.length))
  })

  function title(m: PackMeta): string {
    return i18n.locale === 'ar' ? m.title.ar || m.title.en : m.title.en || m.title.ar
  }

  function metaLine(m: PackMeta): string {
    const language = (m.language && languageNames?.of(m.language)) || m.language || ''
    if (m.sizeKib === null) return language
    return i18n.t('content.empty.meta', { language, size: i18n.bytes(m.sizeKib) })
  }

  function percent(id: string): number {
    const job = packs.jobs.get(id)
    if (!job || job.totalKib <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((job.receivedKib / job.totalKib) * 100)))
  }

  function percentLabel(id: string): string {
    return new Intl.NumberFormat(i18n.intlLocale, { style: 'percent' }).format(percent(id) / 100)
  }

  function select(id: string): Promise<boolean> {
    if (selected.includes(id)) return Promise.resolve(true)
    return settings.update({ translations: [...selected, id].slice(0, MAX_PACKS) })
  }

  async function install(m: PackMeta): Promise<void> {
    await select(m.id)
    await packs.install(m.id)
  }

  function retry(m: PackMeta): void {
    void packs.retry(m.id)
  }

  function more(): void {
    packs.filter = 'translation'
    ui.setView('downloads')
  }

  function mushaf(): void {
    void settings.update({ readingMode: 'mushaf' })
  }
</script>

<section class="card" aria-labelledby="tv-add-title">
  <span class="star" style:--_star={`url("${star8}")`} aria-hidden="true"></span>
  <h2 class="title" id="tv-add-title">{i18n.t('content.empty.title')}</h2>
  <p class="body">{offline ? i18n.t('content.empty.offline') : i18n.t('content.empty.body')}</p>

  {#if entries.length > 0}
    <ul class="packs" aria-label={i18n.t('content.empty.listLabel')}>
      {#each entries as m (m.id)}
        <li class="pack" data-pack={m.id}>
          <div class="text">
            <span class="name">{title(m)}</span>
            <span class="meta">{metaLine(m)}</span>
            {#if m.availability === 'downloading'}
              <Progress
                value={percent(m.id)}
                label={i18n.t('content.empty.downloading', { percent: percentLabel(m.id) })}
              />
            {/if}
          </div>
          <div class="action">
            {#if m.availability === 'installed'}
              <Button size="sm" variant="secondary" onclick={() => void select(m.id)}
                >{i18n.t('content.empty.use')}</Button
              >
            {:else if m.availability === 'downloading'}
              <span class="status"
                >{i18n.t('content.empty.downloading', { percent: percentLabel(m.id) })}</span
              >
            {:else if m.availability === 'failed'}
              <span class="status failed">{i18n.t('content.empty.failed')}</span>
              <Button size="sm" variant="secondary" disabled={offline} onclick={() => retry(m)}
                >{i18n.t('common.retry')}</Button
              >
            {:else}
              <Button size="sm" variant="primary" disabled={offline} onclick={() => void install(m)}
                >{i18n.t('common.install')}</Button
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="footer">
    <Button size="sm" variant="link" onclick={more}>{i18n.t('content.empty.more')}</Button>
    <Button size="sm" variant="ghost" onclick={mushaf}>{i18n.t('content.empty.mushaf')}</Button>
  </div>
</section>

<style>
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    inline-size: min(460px, 100%);
    padding-block: var(--space-8) var(--space-4);
    padding-inline: var(--space-6);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    text-align: center;
  }

  .star {
    inline-size: 44px;
    block-size: 44px;
    margin-block-end: var(--space-2);
    background-color: var(--frame-gold);
    mask: var(--_star) center / contain no-repeat;
  }

  .title {
    margin: 0;
    color: var(--text);
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .body {
    max-inline-size: 360px;
    margin: 0;
    text-wrap: balance;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .packs {
    display: flex;
    flex-direction: column;
    align-self: stretch;
    margin: var(--space-4) 0 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    list-style: none;
    text-align: start;
  }

  .pack {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 56px;
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
  }

  .pack + .pack {
    border-block-start: 1px solid var(--border);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .name {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .meta {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .text :global([role='progressbar']) {
    margin-block-start: var(--space-1);
  }

  .action {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }

  .status {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .failed {
    color: var(--danger-text);
  }

  .footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    margin-block-start: var(--space-3);
  }

  @media (forced-colors: active) {
    .star {
      background-color: CanvasText;
    }
  }
</style>
