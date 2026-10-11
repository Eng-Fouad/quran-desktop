<!--
  ScrollArea (§9.5): a scrolling region with overlay scrollbars (8 px, thumb `--border-strong`, darker on hover) that
  take no layout space, so content width never jumps when it starts to overflow. Native scrolling (wheel, keys,
  touchpad) is untouched. The scrollbars follow the UI direction (the vertical bar sits at the inline end).

  Size the ScrollArea itself (block size from its container); the content scrolls inside. `viewport` binds the
  scrolling element (scroll restoration, `scrollIntoView` targets).
-->
<script lang="ts">
  import { ScrollArea } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { resolveDir } from './floating.svelte'
  import type { Dir } from './types'

  interface Props {
    orientation?: 'vertical' | 'horizontal' | 'both'
    /** When the scrollbars show: on hover (default), while scrolling, when overflowing, or always. */
    type?: 'hover' | 'scroll' | 'auto' | 'always'
    viewport?: HTMLElement | null
    /** Accessible name for a scrollable region that can take focus (keyboard scrolling of plain text). */
    label?: string
    dir?: Dir
    class?: string
    children: Snippet
  }

  let {
    orientation = 'vertical',
    type = 'hover',
    viewport = $bindable(null),
    label,
    dir: dirProp,
    class: className,
    children,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const vertical = $derived(orientation !== 'horizontal')
  const horizontal = $derived(orientation !== 'vertical')
</script>

{#snippet bar(axis: 'vertical' | 'horizontal')}
  <ScrollArea.Scrollbar orientation={axis}>
    {#snippet child({ props })}
      <div {...props} class={['scrollbar', axis]}>
        <ScrollArea.Thumb>
          {#snippet child({ props: thumbProps })}
            <div {...thumbProps} class="thumb"></div>
          {/snippet}
        </ScrollArea.Thumb>
      </div>
    {/snippet}
  </ScrollArea.Scrollbar>
{/snippet}

<ScrollArea.Root {type} {dir}>
  {#snippet child({ props })}
    <div {...props} class={['scroll-area', className]} {dir}>
      <ScrollArea.Viewport
        bind:ref={viewport}
        aria-label={label}
        role={label ? 'region' : undefined}
        tabindex={label ? 0 : undefined}
      >
        {@render children()}
      </ScrollArea.Viewport>
      {#if vertical}{@render bar('vertical')}{/if}
      {#if horizontal}{@render bar('horizontal')}{/if}
      {#if vertical && horizontal}<ScrollArea.Corner />{/if}
    </div>
  {/snippet}
</ScrollArea.Root>

<style>
  .scroll-area {
    position: relative;
    overflow: hidden;
    min-block-size: 0;
  }

  .scroll-area > :global([data-scroll-area-viewport]) {
    inline-size: 100%;
    block-size: 100%;
    border-radius: inherit;
    overscroll-behavior: contain;
  }

  .scrollbar {
    display: flex;
    padding: 1px;
    touch-action: none;
    user-select: none;
    transition: opacity var(--dur-quick) var(--ease-standard);
  }

  .scrollbar.vertical {
    inline-size: 8px;
  }

  .scrollbar.horizontal {
    flex-direction: column;
    block-size: 8px;
  }

  .scrollbar[data-state='hidden'] {
    opacity: 0;
  }

  .thumb {
    position: relative;
    flex: 1 1 auto;
    border-radius: var(--radius-full);
    background-color: var(--border-strong);
  }

  .scrollbar:hover .thumb,
  .thumb:active {
    background-color: var(--text-faint);
  }

  @media (forced-colors: active) {
    .thumb {
      background-color: CanvasText;
    }
  }
</style>
