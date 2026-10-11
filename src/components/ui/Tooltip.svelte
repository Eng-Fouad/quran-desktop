<!--
  Tooltip (§9.5): a short label for the element rendered by `children`, which receives the trigger props to spread
  (`{#snippet children({ props })}<button {...props}>…</button>{/snippet}`). Opens after `delay` (the provider's,
  500 ms by default) on hover and on keyboard focus (never on pointer focus); closes on Escape, a click or pointer
  leave. Opening it programmatically (`open = true`) anchors it to the same trigger. Inside a dialog, sheet or popover,
  Escape belongs to that layer (`defer-otherwise-close`): a tooltip that came up with the layer's first focused control
  never takes a second press to close the layer.

  Surface-overlay as blurred glass (`--glass-fill`, `--backdrop-palette`), text-xs, radius-sm, shadow-2, max-width
  280 px; an optional shortcut (`kbd`) follows the text as keycaps. Tooltips are not floating layers (§7.4): one showing
  never blocks shortcuts.
-->
<script lang="ts">
  import { Tooltip } from 'bits-ui'
  import { getContext, type Snippet } from 'svelte'
  import { resolveDir, TOOLTIP_PROVIDER } from './floating.svelte'
  import Kbd from './Kbd.svelte'
  import type { Align, Dir, Side, TriggerProps } from './types'

  interface Props {
    /** The tooltip text (or a snippet for rich content). */
    content: string | Snippet
    /** A shortcut label from `shortcuts.format(def)`, shown as keycaps after the text. */
    kbd?: string
    /** Hover delay (ms); defaults to the surrounding `TooltipProvider`'s, else 500. */
    delay?: number
    side?: Side
    align?: Align
    disabled?: boolean
    open?: boolean
    dir?: Dir
    /** The trigger element's id (generated when not given). */
    triggerId?: string
    /** The trigger's tab index (bits-ui's trigger props set 0 otherwise): a roving toolbar passes -1 for its other items. */
    tabindex?: number | null
    children: Snippet<[TriggerProps]>
  }

  let {
    content,
    kbd,
    delay,
    side = 'top',
    align = 'center',
    disabled = false,
    open = $bindable(false),
    dir: dirProp,
    triggerId: triggerIdProp,
    tabindex,
    children,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  /** The trigger's id, so a programmatically opened tooltip (`open = true`) knows its anchor. */
  const uid = $props.id()
  const triggerId = $derived(triggerIdProp ?? `${uid}-trigger`)
  const shared = getContext<boolean | undefined>(TOOLTIP_PROVIDER) === true
</script>

{#snippet tooltip()}
  <Tooltip.Root bind:open {triggerId} delayDuration={delay} {disabled} ignoreNonKeyboardFocus>
    <Tooltip.Trigger id={triggerId} tabindex={tabindex ?? undefined}>
      {#snippet child({ props })}
        {@render children({ props })}
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content
        {side}
        {align}
        {dir}
        sideOffset={6}
        collisionPadding={8}
        escapeKeydownBehavior="defer-otherwise-close"
      >
        {#snippet child({ props, wrapperProps })}
          <div {...wrapperProps}>
            <div {...props} class="tooltip" {dir}>
              {#if typeof content === 'string'}
                <span class="text">{content}</span>
              {:else}
                {@render content()}
              {/if}
              {#if kbd}<Kbd chord={kbd} size="sm" />{/if}
            </div>
          </div>
        {/snippet}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
{/snippet}

{#if shared}
  {@render tooltip()}
{:else}
  <Tooltip.Provider delayDuration={delay ?? 500} ignoreNonKeyboardFocus>
    {@render tooltip()}
  </Tooltip.Provider>
{/if}

<style>
  .tooltip {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-inline-size: 280px;
    padding-block: 5px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    /* §9.5's surface-overlay as floating glass (§9.4): blurred, so the page's glyphs never show through the text; an
       opaque raised surface where blur is not allowed (reduced transparency, Linux, forced colours). */
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-palette);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-xs);
    font-weight: var(--weight-body);
    line-height: var(--leading-ui);
    overflow-wrap: anywhere;
    z-index: var(--z-tooltip);
    pointer-events: none;
    transform-origin: var(--bits-floating-transform-origin);
    transition:
      opacity var(--dur-fast) var(--ease-standard),
      scale var(--dur-fast) var(--ease-decelerate);
  }

  .tooltip[data-starting-style],
  .tooltip[data-ending-style] {
    opacity: 0;
    scale: 0.96;
  }

  .text {
    min-inline-size: 0;
  }

  @media (forced-colors: active) {
    .tooltip {
      border: 1px solid CanvasText;
    }
  }
</style>
