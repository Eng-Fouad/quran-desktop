<!--
  PackPicker (§9.8): the study pane's "add" card for a tab with nothing to show yet — no translation, no tafsir
  chosen, no word-by-word pack. The eight-point star, a title and a sentence, then a short list of packs (best first,
  `picker.ts`), each with its language and size and one action: Use / Show, Install, a download in progress, or Retry
  after a failure. Offline, the sentence says the packs download when you're online and Install is disabled; packs
  fetched as you read stay usable. "More in Downloads" opens the Downloads view on that kind. Owner: WP11b.
-->
<script lang="ts">
  import { Button, Progress } from '$components/ui'
  import type { PackKind } from '$lib/ipc/bindings'
  import { app, i18n, packs, translations, ui } from '$lib/stores'
  import star8 from '../../assets/star8.svg'
  import { jobLine, languageName, type JobLine } from './pane.svelte'
  import type { PickRow } from './picker'

  interface Props {
    kind: Extract<PackKind, 'translation' | 'tafsir' | 'wbw'>
    title: string
    body: string
    offlineBody: string
    /** Accessible name of the list. */
    label: string
    rows: readonly PickRow[]
    /** Use / Show / Install. */
    onpick: (row: PickRow) => void
  }

  let { kind, title, body, offlineBody, label, rows, onpick }: Props = $props()

  const offline = $derived(!app.online)
  const headingId = $derived(`qd-pane-pick-${kind}`)

  function metaLine(row: PickRow): string {
    const m = row.meta
    const language = languageName(m.language, i18n.locale)
    if (m.onDemand) return i18n.t('sidepane.packs.onDemand', { language })
    if (m.sizeKib === null || m.sizeKib <= 0) return language
    return i18n.t('sidepane.packs.meta', { language, size: i18n.bytes(m.sizeKib) })
  }

  /** A download on its way: "Waiting to download", "Downloading… 45%", "Installing…", "Paused at 45%". */
  function statusText(job: JobLine): string {
    switch (job.state) {
      case 'queued':
        return i18n.t('sidepane.packs.queued')
      case 'installing':
        return i18n.t('sidepane.packs.installing')
      case 'paused':
        return i18n.t('sidepane.packs.paused', { percent: job.label })
      default:
        return i18n.t('sidepane.packs.downloading', { percent: job.label })
    }
  }

  function retry(row: PickRow): void {
    packs.retry(row.meta.id).catch((e: unknown) => ui.toastError(e))
  }

  function resume(row: PickRow): void {
    packs.resume(row.meta.id).catch((e: unknown) => ui.toastError(e))
  }

  function more(): void {
    packs.filter = kind
    ui.setView('downloads')
  }
</script>

<section class="picker" aria-labelledby={headingId} data-kind={kind}>
  <span class="star" style:--_star={`url("${star8}")`} aria-hidden="true"></span>
  <h3 class="title" id={headingId}>{title}</h3>
  <p class="body">{offline ? offlineBody : body}</p>

  {#if rows.length > 0}
    <ul class="rows" aria-label={label}>
      {#each rows as row (row.meta.id)}
        {@const job = row.action === 'downloading' ? jobLine(row.meta.id) : null}
        <li class="row" data-pack={row.meta.id} data-action={row.action}>
          <div class="text">
            <span class="name">{translations.packTitle(row.meta.id)}</span>
            <span class="meta">{metaLine(row)}</span>
            {#if job}
              <Progress
                value={job.percent}
                indeterminate={job.state === 'queued' || job.state === 'installing'}
                label={statusText(job)}
              />
            {/if}
          </div>
          <div class="action">
            {#if job?.state === 'paused'}
              <Button size="sm" variant="secondary" disabled={offline} onclick={() => resume(row)}
                >{i18n.t('common.resume')}</Button
              >
            {:else if job}
              <span class="status tabular-nums">{statusText(job)}</span>
            {:else if row.action === 'failed'}
              <Button size="sm" variant="secondary" disabled={offline} onclick={() => retry(row)}
                >{i18n.t('common.retry')}</Button
              >
            {:else if row.action === 'install'}
              <Button size="sm" variant="primary" disabled={offline} onclick={() => onpick(row)}
                >{i18n.t('common.install')}</Button
              >
            {:else}
              <Button size="sm" variant="secondary" onclick={() => onpick(row)}
                >{i18n.t(row.action === 'show' ? 'sidepane.packs.show' : 'sidepane.packs.use')}</Button
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <Button size="sm" variant="link" onclick={more}>{i18n.t('sidepane.packs.more')}</Button>
</section>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding-block: var(--space-8) var(--space-6);
    padding-inline: var(--space-4);
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
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .body {
    max-inline-size: 300px;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
    text-wrap: balance;
  }

  .rows {
    display: flex;
    flex-direction: column;
    align-self: stretch;
    margin-block: var(--space-3) var(--space-1);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-page);
    list-style: none;
    text-align: start;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 56px;
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
  }

  .row + .row {
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
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .text :global(.progress) {
    margin-block-start: var(--space-1);
  }

  .action {
    display: flex;
    flex: none;
    align-items: center;
  }

  .status {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  @media (forced-colors: active) {
    .star {
      background-color: CanvasText;
    }
  }
</style>
