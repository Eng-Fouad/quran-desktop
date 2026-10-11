<!--
  IconButton (§9.5): a square button with an icon only. `label` is required: it is the accessible name and the
  tooltip text (with the optional `shortcut` as keycaps). `pressed` makes it a toggle (`aria-pressed`, accent tint).
  Ghost by default; sizes sm 28 (16 px icon) / md 32 / lg 40 (20 px icon). `mirror` mirrors a directional icon in RTL
  (`.icon-dir`; never for media transport icons, §11.3).

  Give either `icon` (a lucide component) or a `children` snippet. Other attributes go to the `<button>`.

  `aria-disabled` looks disabled but keeps the button focusable (a stepper at its limit keeps the focus it had; the
  caller makes the click a no-op), where `disabled` would drop focus to `<body>`.
-->
<script lang="ts">
  import type { LucideIcon } from '@lucide/svelte'
  import { mergeProps } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import Tooltip from './Tooltip.svelte'
  import type { ControlSize, Side } from './types'

  interface Props extends Omit<HTMLButtonAttributes, 'children' | 'aria-label' | 'aria-pressed'> {
    /** Accessible name and tooltip text. */
    label: string
    icon?: LucideIcon
    variant?: 'ghost' | 'secondary' | 'primary' | 'danger'
    size?: ControlSize
    /** Toggle state; `undefined` for a plain action button. */
    pressed?: boolean
    /** Tooltip text when it differs from `label`; `false` hides the tooltip. */
    tooltip?: string | false
    /** Shortcut label (`shortcuts.format(def)`) shown in the tooltip. */
    shortcut?: string
    tooltipSide?: Side
    /** Mirror the icon in RTL (chevrons and arrows). */
    mirror?: boolean
    ref?: HTMLButtonElement | null
    children?: Snippet
  }

  let {
    label,
    icon: Icon,
    variant = 'ghost',
    size = 'md',
    pressed,
    tooltip,
    shortcut,
    tooltipSide = 'top',
    mirror = false,
    ref = $bindable(null),
    children: glyph,
    type = 'button',
    class: className,
    ...rest
  }: Props = $props()

  const iconSize = $derived(size === 'sm' ? 16 : 20)

  /**
   * The button's attributes: ours merged with the tooltip trigger's. A disabled button keeps no `tabindex` (the
   * trigger sets 0 by default), so it never looks tabbable to `firstTabbable` or to assistive tech.
   */
  function buttonProps(trigger: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = mergeProps(rest, trigger)
    if (rest.disabled) delete merged.tabindex
    return merged
  }
</script>

<Tooltip
  triggerId={rest.id ?? undefined}
  tabindex={rest.tabindex}
  content={tooltip === false ? label : (tooltip ?? label)}
  kbd={shortcut}
  side={tooltipSide}
  disabled={tooltip === false}
>
  {#snippet children({ props })}
    <button
      {...buttonProps(props)}
      bind:this={ref}
      {type}
      class={['icon-button', `v-${variant}`, `s-${size}`, className]}
      aria-label={label}
      aria-pressed={pressed}
    >
      {#if Icon}
        <Icon size={iconSize} strokeWidth={1.75} class={mirror ? 'icon-dir' : undefined} aria-hidden="true" />
      {:else if glyph}
        {@render glyph()}
      {/if}
    </button>
  {/snippet}
</Tooltip>

<style>
  .icon-button {
    --_size: 32px;
    --_fg: var(--text-muted);
    --_bg: transparent;
    --_bd: transparent;
    --_bg-hover: var(--surface-hover);
    --_bg-active: color-mix(in srgb, var(--text) 12%, transparent);

    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: var(--_size);
    block-size: var(--_size);
    padding: 0;
    border: 1px solid var(--_bd);
    border-radius: var(--radius-sm);
    background-color: var(--_bg);
    color: var(--_fg);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard),
      scale var(--dur-instant) var(--ease-standard);
  }

  .s-sm {
    --_size: 28px;
  }

  .s-lg {
    --_size: 40px;
  }

  .v-secondary {
    --_fg: var(--text);
    --_bg: var(--surface-raised);
    --_bd: var(--border-input);
    --_bg-hover: color-mix(in srgb, var(--surface-raised) 94%, var(--text));
    --_bg-active: color-mix(in srgb, var(--surface-raised) 88%, var(--text));
  }

  .v-primary {
    --_fg: var(--accent-ink);
    --_bg: var(--accent);
    --_bd: var(--accent);
    --_bg-hover: color-mix(in srgb, var(--accent) 94%, var(--text));
    --_bg-active: color-mix(in srgb, var(--accent) 86%, var(--text));
  }

  .v-danger {
    --_fg: var(--danger-ink);
    --_bg: var(--danger);
    --_bd: var(--danger);
    --_bg-hover: color-mix(in srgb, var(--danger) 94%, var(--text));
    --_bg-active: color-mix(in srgb, var(--danger) 86%, var(--text));
  }

  .icon-button:hover:not(:disabled, [aria-disabled='true']) {
    background-color: var(--_bg-hover);
    color: color-mix(in srgb, var(--_fg) 40%, var(--text));
  }

  .icon-button:active:not(:disabled, [aria-disabled='true']) {
    background-color: var(--_bg-active);
    scale: 0.96;
  }

  .icon-button[aria-pressed='true'] {
    --_fg: var(--accent-text);
    --_bg: var(--accent-soft);
    --_bg-hover: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .v-primary:hover:not(:disabled, [aria-disabled='true']),
  .v-danger:hover:not(:disabled, [aria-disabled='true']),
  .icon-button[aria-pressed='true']:hover:not(:disabled, [aria-disabled='true']) {
    color: var(--_fg);
  }

  :global(:root[data-motion='reduce']) .icon-button:active {
    scale: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .icon-button:active {
      scale: none;
    }
  }

  .icon-button:disabled,
  .icon-button[aria-disabled='true'] {
    opacity: 0.5;
    cursor: default;
  }

  @media (forced-colors: active) {
    .icon-button[aria-pressed='true'] {
      border-color: Highlight;
    }
  }
</style>
