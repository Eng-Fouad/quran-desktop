<!--
  PaneMessage: a state inside a study-pane tab — offline, not downloaded, downloading, failed — as a compact
  block: an icon in a soft disc, a sentence, an optional hint, progress and actions. `role="status"`, so a screen
  reader hears it when it appears. Used only inside `src/components/sidepane`.
-->
<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    icon: LucideIcon
    text: string
    hint?: string
    tone?: 'neutral' | 'danger'
    /** Progress, actions. */
    children?: Snippet
  }

  let { icon: Icon, text, hint, tone = 'neutral', children }: Props = $props()
</script>

<div class="message" data-tone={tone} role="status">
  <span class="disc" aria-hidden="true"><Icon size={18} strokeWidth={1.75} /></span>
  <p class="text">{text}</p>
  {#if hint}<p class="hint">{hint}</p>{/if}
  {#if children}<div class="extra">{@render children()}</div>{/if}
</div>

<style>
  .message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-8) var(--space-5);
    text-align: center;
  }

  .disc {
    display: inline-grid;
    place-items: center;
    inline-size: 40px;
    block-size: 40px;
    margin-block-end: var(--space-2);
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--text) 6%, transparent);
    color: var(--text-muted);
  }

  .message[data-tone='danger'] .disc {
    background-color: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  .text {
    max-inline-size: 300px;
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
    text-wrap: balance;
  }

  .hint {
    max-inline-size: 280px;
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }

  .extra {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    inline-size: min(100%, 260px);
    margin-block-start: var(--space-3);
  }

  @media (forced-colors: active) {
    .disc {
      border: 1px solid CanvasText;
    }
  }
</style>
