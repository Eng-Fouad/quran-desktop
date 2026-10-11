<!--
  Card (§9.5): a raised surface (surface-raised, radius-md, shadow-1) grouping related content. `interactive` makes
  the whole card a button (hover lifts it to shadow-2, focus ring, Enter/Space activate) with `onclick`;
  `selected` adds a 2 px accent ring and `aria-pressed` (onboarding theme cards, style cards).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    interactive?: boolean
    selected?: boolean
    onclick?: (e: MouseEvent) => void
    disabled?: boolean
    padding?: 'none' | 'sm' | 'md' | 'lg'
    /** Element for a static card. */
    as?: 'div' | 'section' | 'article' | 'li'
    /** Accessible name: interactive cards whose content is not a good label, or a `section`/`article` card. */
    label?: string
    class?: string
    children: Snippet
  }

  let {
    interactive = false,
    selected,
    onclick,
    disabled = false,
    padding = 'md',
    as = 'div',
    label,
    class: className,
    children,
  }: Props = $props()
</script>

{#if interactive}
  <button
    type="button"
    class={['card', 'interactive', `pad-${padding}`, { selected }, className]}
    aria-pressed={selected}
    aria-label={label}
    {disabled}
    {onclick}
  >
    {@render children()}
  </button>
{:else}
  <!-- A name only where the element is a landmark-like region (a generic div or li cannot carry one). -->
  <svelte:element
    this={as}
    class={['card', `pad-${padding}`, { selected }, className]}
    aria-label={as === 'section' || as === 'article' ? label : undefined}
  >
    {@render children()}
  </svelte:element>
{/if}

<style>
  .card {
    display: block;
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
    color: var(--text);
  }

  .pad-sm {
    padding: var(--space-3);
  }

  .pad-md {
    padding: var(--space-4);
  }

  .pad-lg {
    padding: var(--space-6);
  }

  .interactive {
    inline-size: 100%;
    border: 0;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      box-shadow var(--dur-quick) var(--ease-standard),
      translate var(--dur-quick) var(--ease-standard);
  }

  .interactive:hover:not(:disabled) {
    box-shadow: var(--shadow-2);
    translate: 0 -1px;
  }

  .interactive:active:not(:disabled) {
    translate: none;
  }

  :global(:root[data-motion='reduce']) .interactive:hover {
    translate: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .interactive:hover {
      translate: none;
    }
  }

  .interactive:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .selected {
    box-shadow:
      0 0 0 2px var(--accent),
      var(--shadow-1);
  }

  .selected.interactive:hover:not(:disabled) {
    box-shadow:
      0 0 0 2px var(--accent),
      var(--shadow-2);
  }

  @media (forced-colors: active) {
    .card {
      border: 1px solid CanvasText;
    }

    .selected {
      outline: 2px solid Highlight;
    }
  }
</style>
