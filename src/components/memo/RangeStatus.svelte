<!--
  RangeStatus: the memorisation status of a range as one proportional bar (memorized · due for review · learning · not
  started) and a legend with the counts. Used by the Memorize panel and the self-test dialog. The bar's colours are the
  Mushaf map's (`ProgressHeatmap`), so the two read as one system.
-->
<script lang="ts">
  import type { ProgressSummary } from '$lib/stores/memo.svelte'
  import { i18n } from '$lib/stores'

  interface Props {
    summary: ProgressSummary
    class?: string
  }

  let { summary, class: className }: Props = $props()

  /** Bar segments in reading order: memorized, overdue, learning, not started. */
  const parts = $derived([
    { key: 'memorized', n: summary.memorized },
    { key: 'review', n: summary.review },
    { key: 'learning', n: summary.learning },
    { key: 'new', n: summary.new },
  ])
  const spoken = $derived(
    [
      i18n.tp('memo.count.memorized', summary.memorized + summary.review),
      i18n.tp('memo.count.learning', summary.learning),
      i18n.tp('memo.count.new', summary.new),
      ...(summary.due > 0 ? [i18n.tp('memo.count.due', summary.due)] : []),
    ].join(', '),
  )
</script>

<div class={['range-status', className]}>
  <div class="bar" role="img" aria-label={spoken}>
    {#each parts as p (p.key)}
      {#if p.n > 0}<span class={['seg', `s-${p.key}`]} style:flex-grow={p.n}></span>{/if}
    {/each}
  </div>
  <ul class="legend" aria-hidden="true">
    {#if summary.memorized + summary.review > 0}
      <li>
        <span class="dot s-memorized"></span>{i18n.tp(
          'memo.count.memorized',
          summary.memorized + summary.review,
        )}
      </li>
    {/if}
    {#if summary.learning > 0}
      <li><span class="dot s-learning"></span>{i18n.tp('memo.count.learning', summary.learning)}</li>
    {/if}
    {#if summary.new > 0}
      <li><span class="dot s-new"></span>{i18n.tp('memo.count.new', summary.new)}</li>
    {/if}
    {#if summary.due > 0}
      <li class="due"><span class="dot s-review"></span>{i18n.tp('memo.count.due', summary.due)}</li>
    {/if}
  </ul>
</div>

<style>
  .range-status {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .bar {
    display: flex;
    gap: 2px;
    block-size: 6px;
    overflow: hidden;
    border-radius: var(--radius-full);
  }

  .seg {
    flex-basis: 0;
    min-inline-size: 3px;
    border-radius: var(--radius-full);
  }

  .s-memorized {
    background-color: var(--accent);
  }

  .s-review {
    background-color: var(--warning);
  }

  .s-learning {
    background-color: color-mix(in srgb, var(--accent) 38%, var(--surface-raised));
  }

  .s-new {
    background-color: color-mix(in srgb, var(--border-input) 35%, transparent);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    padding: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-ui);
    list-style: none;
  }

  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .legend .due {
    color: var(--warning-text);
  }

  .dot {
    flex: none;
    inline-size: 8px;
    block-size: 8px;
    border-radius: var(--radius-full);
  }

  .dot.s-new {
    box-shadow: inset 0 0 0 1px var(--border-input);
    background-color: transparent;
  }

  @media (forced-colors: active) {
    .seg,
    .dot {
      forced-color-adjust: none;
    }
  }
</style>
