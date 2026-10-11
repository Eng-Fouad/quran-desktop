<!--
  Popover (§9.5): a non-modal floating panel (surface-raised, radius-md, shadow-2, padding 12). Anchored to the element
  `trigger` renders (it receives the props to spread), or to `anchor`: an element, a selector or a viewport point
  (the action bar's swatch popover, a margin-mark popover). Repeat/Speed/ReciterPicker and the surah info popover are
  built on it.

  While open it is a floating layer (§7.4): shortcuts other than `allowInInput` ones pause, so keys typed into it
  never reach the reader. Escape and outside clicks close it; focus returns to the trigger.
-->
<script lang="ts">
  import { Popover } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { floatingZ, resolveDir, trackFloating } from './floating.svelte'
  import type { Align, Dir, Point, Side, TriggerProps } from './types'

  interface Props {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    trigger?: Snippet<[TriggerProps]>
    /** Anchor instead of (or besides) the trigger: an element, a CSS selector or a viewport point. */
    anchor?: HTMLElement | string | Point | null
    side?: Side
    align?: Align
    sideOffset?: number
    arrow?: boolean
    /** Accessible name when the content has no visible heading. */
    label?: string
    /** Fixed width in px (content otherwise sizes itself, up to the available width). */
    width?: number
    padding?: 'none' | 'sm' | 'md'
    /** Trap Tab inside the popover (default) or let it flow on. */
    trapFocus?: boolean
    onOpenAutoFocus?: (e: Event) => void
    onCloseAutoFocus?: (e: Event) => void
    class?: string
    dir?: Dir
    children: Snippet
  }

  let {
    open = $bindable(false),
    onOpenChange,
    trigger,
    anchor,
    side = 'bottom',
    align = 'center',
    sideOffset,
    arrow = false,
    label,
    width,
    padding = 'md',
    trapFocus = true,
    onOpenAutoFocus,
    onCloseAutoFocus,
    class: className,
    dir: dirProp,
    children,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const offset = $derived(sideOffset ?? (arrow ? 10 : 6))
  /** A point becomes a zero-size virtual element (floating-ui's `Measurable`). */
  const customAnchor = $derived.by(() => {
    if (anchor === null || anchor === undefined) return null
    if (typeof anchor === 'string' || anchor instanceof HTMLElement) return anchor
    const { x, y } = anchor
    return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }
  })

  trackFloating(() => open)
  const zIndex = floatingZ('popover')
</script>

<Popover.Root bind:open {onOpenChange}>
  {#if trigger}
    <Popover.Trigger>
      {#snippet child({ props })}
        {@render trigger({ props })}
      {/snippet}
    </Popover.Trigger>
  {/if}
  <Popover.Portal>
    <Popover.Content
      {side}
      {align}
      {dir}
      {customAnchor}
      {trapFocus}
      {onOpenAutoFocus}
      {onCloseAutoFocus}
      sideOffset={offset}
      collisionPadding={8}
    >
      {#snippet child({ props, wrapperProps })}
        <div {...wrapperProps}>
          <div
            {...props}
            class={['popover', className]}
            style:inline-size={width === undefined ? undefined : `${width}px`}
            style:z-index={zIndex()}
            aria-label={label}
            {dir}
          >
            <div class={['inner', `pad-${padding}`]}>
              {@render children()}
            </div>
            {#if arrow}
              <Popover.Arrow>
                {#snippet child({ props: arrowProps })}
                  <span {...arrowProps} class="arrow">
                    <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true">
                      <path d="M0 0 L8 8 L16 0" />
                    </svg>
                  </span>
                {/snippet}
              </Popover.Arrow>
            {/if}
          </div>
        </div>
      {/snippet}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  .popover {
    position: relative;
    display: flex;
    flex-direction: column;
    max-inline-size: min(var(--bits-floating-available-width, 100vw), calc(100vw - 16px));
    max-block-size: var(--bits-floating-available-height, 80vh);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-md);
    z-index: var(--z-popover);
    outline: none;
    transform-origin: var(--bits-floating-transform-origin);
    transition:
      opacity var(--dur-quick) var(--ease-decelerate),
      scale var(--dur-quick) var(--ease-decelerate);
  }

  .popover[data-starting-style],
  .popover[data-ending-style] {
    opacity: 0;
    scale: 0.97;
  }

  .popover[data-ending-style] {
    transition-duration: var(--dur-fast);
  }

  .inner {
    min-block-size: 0;
    overflow: auto;
    border-radius: inherit;
    overscroll-behavior: contain;
  }

  .pad-sm {
    padding: var(--space-2);
  }

  .pad-md {
    padding: var(--space-3);
  }

  .arrow {
    color: var(--surface-raised);
  }

  .arrow svg {
    display: block;
    fill: currentColor;
    stroke: none;
  }

  @media (forced-colors: active) {
    .popover {
      border: 1px solid CanvasText;
    }
  }
</style>
