<!--
  PackSection: one kind of pack in the Downloads manager: a heading with the number of packs shown, a
  one-line explanation, and the rows in a card (a list; rows are `PackRow`/`ReciterRow` items separated by hairlines).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { i18n } from '$lib/stores'

  interface Props {
    /** Stable id (`mushaf`, `recitation`, `translation`, `tafsir`, `wbw`), also `data-section`. */
    id: string
    title: string
    hint?: string
    count: number
    children: Snippet
  }

  let { id, title, hint, count, children }: Props = $props()

  const uid = $props.id()
</script>

<section class="section" aria-labelledby="{uid}-title" data-section={id}>
  <header class="head">
    <h2 id="{uid}-title" class="title">
      {title}<span class="count" aria-hidden="true">{i18n.num(count)}</span>
    </h2>
    {#if hint}<p class="hint">{hint}</p>{/if}
  </header>
  <ul class="card" aria-labelledby="{uid}-title">
    {@render children()}
  </ul>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    scroll-margin-block-start: 64px;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-inline: var(--space-1);
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    color: var(--text);
    font-size: var(--text-lg);
    font-weight: var(--weight-title);
    line-height: 1.35;
  }

  .count {
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .card {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  .card > :global(li + li) {
    border-block-start: 1px solid var(--border);
  }
</style>
