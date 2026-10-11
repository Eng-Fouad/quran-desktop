<!--
  Badge (§9.5): a pill with a short status or count, text-2xs 600, tabular digits. Tones: neutral, accent, success,
  warning, danger. Status text uses the `--{tone}-text` tokens (≥ 4.5:1) on a fill mixed opaquely from the tone over
  `--surface-raised`, so the pair keeps its contrast on any surface; high contrast adds an outline.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Tone } from './types'

  interface Props {
    tone?: Tone
    size?: 'sm' | 'md'
    /** Leading icon or dot. */
    icon?: Snippet
    title?: string
    class?: string
    children: Snippet
  }

  let { tone = 'neutral', size = 'md', icon, title, class: className, children }: Props = $props()
</script>

<span class={['badge', `t-${tone}`, `s-${size}`, className]} {title}>
  {#if icon}<span class="icon">{@render icon()}</span>{/if}
  {@render children()}
</span>

<style>
  .badge {
    --_tone: var(--text);
    --_fg: var(--text);
    --_mix: 9%;

    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    block-size: 20px;
    padding-inline: var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--_tone) var(--_mix), var(--surface-raised));
    color: var(--_fg);
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
    vertical-align: middle;
  }

  .s-sm {
    block-size: 18px;
    padding-inline: 6px;
  }

  .t-accent {
    --_tone: var(--accent);
    --_fg: var(--accent-text);
    --_mix: 12%;
  }

  .t-success {
    --_tone: var(--success);
    --_fg: var(--success-text);
    --_mix: 12%;
  }

  .t-warning {
    --_tone: var(--warning);
    --_fg: var(--warning-text);
    --_mix: 12%;
  }

  .t-danger {
    --_tone: var(--danger);
    --_fg: var(--danger-text);
    --_mix: 12%;
  }

  .icon {
    display: inline-flex;
  }

  .icon :global(svg) {
    inline-size: 12px;
    block-size: 12px;
  }

  :global(:root[data-theme='high_contrast']) .badge {
    border-color: currentColor;
  }

  @media (forced-colors: active) {
    .badge {
      border-color: CanvasText;
    }
  }
</style>
