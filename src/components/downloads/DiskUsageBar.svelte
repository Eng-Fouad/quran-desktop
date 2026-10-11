<!--
  DiskUsageBar (§9.7): the Downloads header card. "Storage" and the total used, a stacked bar with one segment per kind
  of data (downloaded recitations, the streaming cache, Mushaf fonts, ornaments, translations, tafsir, online content,
  your library) in the order of size, a legend with each size, and the data folder. `actions` renders the header
  buttons (Open folder, Clear streaming cache) at the end of the title line.

  Segments use the kind colours of the pack rows (the leading tiles), so a row and its share of the bar read alike. The
  streaming cache is the half-tone of the recitation accent, as in the surah grid.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Skeleton, Tooltip } from '$components/ui'
  import type { DiskUsage } from '$lib/ipc/bindings'
  import { i18n } from '$lib/stores'
  import { LRI, PDI } from '$lib/stores/i18n.svelte'

  interface Props {
    usage: DiskUsage | null
    actions?: Snippet
  }

  let { usage, actions }: Props = $props()

  type SegmentKey = 'audio' | 'stream' | 'mushaf' | 'decor' | 'translation' | 'tafsir' | 'content' | 'library'

  const ORDER: readonly { key: SegmentKey; field: keyof DiskUsage; hint?: boolean }[] = [
    { key: 'audio', field: 'audioPinnedKib' },
    { key: 'stream', field: 'audioStreamKib', hint: true },
    { key: 'mushaf', field: 'mushafKib' },
    { key: 'decor', field: 'decorKib' },
    { key: 'translation', field: 'translationKib' },
    { key: 'tafsir', field: 'tafsirKib' },
    { key: 'content', field: 'contentDbKib', hint: true },
    { key: 'library', field: 'userDbKib', hint: true },
  ]

  const uid = $props.id()

  const segments = $derived(
    usage === null
      ? []
      : ORDER.map((s) => ({ ...s, kib: Number(usage[s.field]) || 0 }))
          .filter((s) => s.kib > 0)
          .sort((a, b) => b.kib - a.kib),
  )
  const total = $derived(usage === null ? 0 : usage.totalKib)

  const label = (key: SegmentKey) => i18n.t(`downloads.usage.segments.${key}`)
  const hint = (key: SegmentKey) =>
    key === 'stream' || key === 'content' || key === 'library' ? i18n.t(`downloads.usage.hints.${key}`) : ''
  const item = (key: SegmentKey, kib: number) =>
    i18n.t('downloads.usage.item', { label: label(key), size: i18n.bytes(kib) })
  const summary = $derived(segments.map((s) => item(s.key, s.kib)).join(i18n.t('downloads.sep')))
</script>

<section class="usage" aria-labelledby="{uid}-title" data-qd-usage>
  <div class="head">
    <div class="totals">
      <h2 id="{uid}-title" class="caption">{i18n.t('downloads.usage.title')}</h2>
      <p class="total" aria-live="polite">
        {#if usage === null}
          <span class="muted">{i18n.t('downloads.usage.measuring')}</span>
        {:else if total === 0}
          <span class="muted">{i18n.t('downloads.usage.empty')}</span>
        {:else}
          {i18n.t('downloads.usage.used', { size: i18n.bytes(total) })}
        {/if}
      </p>
    </div>
    {#if actions}
      <div class="actions" role="group" aria-label={i18n.t('downloads.header.actions')}>
        {@render actions()}
      </div>
    {/if}
  </div>

  {#if usage === null}
    <Skeleton h={10} radius="full" />
  {:else}
    <div class="bar" role="img" aria-label={summary || i18n.t('downloads.usage.empty')}>
      {#each segments as s (s.key)}
        <span class="seg k-{s.key}" style:flex-grow={s.kib}></span>
      {/each}
    </div>
  {/if}

  {#if segments.length > 0}
    <ul class="legend" aria-label={i18n.t('downloads.usage.label')}>
      {#each segments as s (s.key)}
        <li class="entry" data-segment={s.key}>
          {#if s.hint}
            <Tooltip content={hint(s.key)} side="bottom">
              {#snippet children({ props })}
                <span {...props} class="key hinted">
                  <span class="dot k-{s.key}" aria-hidden="true"></span>
                  <span class="name">{label(s.key)}</span>
                  <span class="size">{i18n.bytes(s.kib)}</span>
                  <span class="sr-only">{hint(s.key)}</span>
                </span>
              {/snippet}
            </Tooltip>
          {:else}
            <span class="key">
              <span class="dot k-{s.key}" aria-hidden="true"></span>
              <span class="name">{label(s.key)}</span>
              <span class="size">{i18n.bytes(s.kib)}</span>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if usage !== null && usage.dataDir !== ''}
    <p class="where" title={usage.dataDir}>
      {i18n.t('downloads.usage.where', { path: `${LRI}${usage.dataDir}${PDI}` })}
    </p>
  {/if}
</section>

<style>
  .usage {
    /* Kind colours, shared with the pack rows' leading tiles (PackRow) and the surah grid. */
    --k-audio: var(--accent);
    --k-stream: color-mix(in srgb, var(--accent) 42%, var(--surface-raised));
    --k-mushaf: var(--frame-gold);
    --k-decor: color-mix(in srgb, var(--frame-gold) 55%, var(--surface-raised));
    --k-translation: color-mix(in srgb, var(--user-hl-blue-solid) 78%, var(--text));
    --k-tafsir: color-mix(in srgb, var(--user-hl-purple-solid) 78%, var(--text));
    --k-content: color-mix(in srgb, var(--user-hl-yellow-solid) 82%, var(--text));
    --k-library: var(--text-faint);

    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-block: var(--space-4) var(--space-4);
    padding-inline: var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3) var(--space-4);
  }

  .totals {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .caption {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(:root[lang='ar']) .caption {
    letter-spacing: 0;
    text-transform: none;
  }

  .total {
    margin: 0;
    color: var(--text);
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-title, 1.3);
  }

  .muted {
    color: var(--text-muted);
    font-weight: var(--weight-body);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .bar {
    display: flex;
    gap: 2px;
    block-size: 10px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--border-input) 22%, transparent);
  }

  .seg {
    flex-shrink: 0;
    flex-basis: 0;
    min-inline-size: 4px;
    block-size: 100%;
    transition: flex-grow var(--dur-slow) var(--ease-standard);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-5);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .entry {
    display: flex;
    min-inline-size: 0;
  }

  .key {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .hinted {
    cursor: help;
  }

  .dot {
    flex: none;
    inline-size: 9px;
    block-size: 9px;
    border-radius: 3px;
  }

  .name {
    color: var(--text);
  }

  .size {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .where {
    margin: 0;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .k-audio {
    background-color: var(--k-audio);
  }

  .k-stream {
    background-color: var(--k-stream);
  }

  .k-mushaf {
    background-color: var(--k-mushaf);
  }

  .k-decor {
    background-color: var(--k-decor);
  }

  .k-translation {
    background-color: var(--k-translation);
  }

  .k-tafsir {
    background-color: var(--k-tafsir);
  }

  .k-content {
    background-color: var(--k-content);
  }

  .k-library {
    background-color: var(--k-library);
  }

  @media (forced-colors: active) {
    .seg,
    .dot {
      forced-color-adjust: none;
      border: 1px solid CanvasText;
    }
  }
</style>
