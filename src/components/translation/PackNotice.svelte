<!--
  PackNotice (§9.8): a slim bar above the verses when a selected translation cannot be shown while others can: it is
  downloading (progress), not downloaded or failed (Download / Retry), or the backend could not open it (Retry). Hide
  removes it from `settings.translations`. Polite live region, so a screen reader hears when it changes. Owner: WP11a.
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import Download from '@lucide/svelte/icons/download'
  import Button from '$components/ui/Button.svelte'
  import Progress from '$components/ui/Progress.svelte'
  import { app, i18n, packs, settings, translations } from '$lib/stores'
  import type { PackMeta } from '$lib/stores/translations.svelte'

  interface Line {
    meta: PackMeta
    kind: 'downloading' | 'missing' | 'failed' | 'broken'
  }

  const lines: readonly Line[] = $derived([
    ...translations.missingPacks.map((meta): Line => ({
      meta,
      kind:
        meta.availability === 'downloading'
          ? 'downloading'
          : meta.availability === 'failed'
            ? 'failed'
            : 'missing',
    })),
    ...translations.brokenPacks.map(({ meta }): Line => ({ meta, kind: 'broken' })),
  ])

  function name(meta: PackMeta): string {
    return translations.packTitle(meta.id)
  }

  function percent(id: string): number {
    const job = packs.jobs.get(id)
    if (!job || job.totalKib <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((job.receivedKib / job.totalKib) * 100)))
  }

  function percentLabel(id: string): string {
    return new Intl.NumberFormat(i18n.intlLocale, { style: 'percent' }).format(percent(id) / 100)
  }

  function text(line: Line): string {
    const params = { name: name(line.meta), percent: percentLabel(line.meta.id) }
    switch (line.kind) {
      case 'downloading':
        return i18n.t('content.notice.downloading', params)
      case 'broken':
        return i18n.t('content.notice.broken', params)
      default:
        return i18n.t('content.notice.missing', params)
    }
  }

  function hide(id: string): void {
    void settings.update({ translations: settings.value.translations.filter((t) => t !== id) })
  }
</script>

{#if lines.length > 0}
  <div class="notices" role="status">
    {#each lines as line (line.meta.id)}
      <div class="notice" data-kind={line.kind} data-pack={line.meta.id}>
        {#if line.kind === 'downloading'}
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />
        {:else}
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        {/if}
        <span class="text">
          {text(line)}
          {#if line.kind === 'downloading'}
            <Progress value={percent(line.meta.id)} label={text(line)} />
          {/if}
        </span>
        {#if line.kind === 'missing'}
          <Button
            size="sm"
            variant="secondary"
            disabled={!app.online}
            onclick={() => void packs.install(line.meta.id)}>{i18n.t('common.download')}</Button
          >
        {:else if line.kind === 'failed'}
          <Button
            size="sm"
            variant="secondary"
            disabled={!app.online}
            onclick={() => void packs.retry(line.meta.id)}>{i18n.t('common.retry')}</Button
          >
        {:else if line.kind === 'broken'}
          <Button size="sm" variant="secondary" onclick={() => void translations.retry()}
            >{i18n.t('common.retry')}</Button
          >
        {/if}
        {#if line.kind !== 'downloading'}
          <Button size="sm" variant="ghost" onclick={() => hide(line.meta.id)}
            >{i18n.t('content.notice.hide')}</Button
          >
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .notices {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-block: var(--space-3) 0;
  }

  .notice {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 44px;
    padding-block: var(--space-1);
    padding-inline: var(--space-3) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .notice[data-kind='failed'],
  .notice[data-kind='broken'] {
    color: var(--warning-text);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-1);
    min-inline-size: 0;
    color: var(--text);
    line-height: var(--leading-ui);
  }
</style>
