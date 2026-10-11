<!--
  Button (§9.5). Variants: primary (accent fill, accent-ink text), secondary (raised fill, 1 px input border), ghost,
  danger (danger fill, danger-ink text) and link (accent text). Sizes sm 28 / md 32 / lg 40 px, radius-sm. Hover mixes
  6 % of the text colour into the fill; active scales to .98 (not under reduced motion).

  `loading` keeps the button focusable and its width stable: the label is hidden behind a spinner, `aria-busy` is set
  and clicks are swallowed. `icon` renders before the label, `iconEnd` after it (directional icons take
  `class="icon-dir"`). Every other attribute (`onclick`, `aria-*`, `data-*`, `form`, …) is passed to the `<button>`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import Spinner from './Spinner.svelte'
  import type { ButtonVariant, ControlSize } from './types'

  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    variant?: ButtonVariant
    size?: ControlSize
    /** Shows a spinner instead of the label and ignores clicks, without losing focus. */
    loading?: boolean
    /** Leading icon (16 px in sm/md, 20 px in lg). */
    icon?: Snippet
    /** Trailing icon (a chevron, an external-link mark). */
    iconEnd?: Snippet
    /** Stretch to the container's inline size. */
    fullWidth?: boolean
    ref?: HTMLButtonElement | null
    children?: Snippet
  }

  let {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconEnd,
    fullWidth = false,
    ref = $bindable(null),
    children,
    type = 'button',
    onclick,
    class: className,
    ...rest
  }: Props = $props()

  function handleClick(e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }): void {
    if (loading) {
      e.preventDefault()
      return
    }
    onclick?.(e)
  }
</script>

<button
  {...rest}
  bind:this={ref}
  {type}
  class={['btn', `v-${variant}`, `s-${size}`, { full: fullWidth, busy: loading }, className]}
  aria-busy={loading || undefined}
  aria-disabled={loading || rest['aria-disabled'] || undefined}
  onclick={handleClick}
>
  <span class="content">
    {#if icon}<span class="icon">{@render icon()}</span>{/if}
    {#if children}<span class="label">{@render children()}</span>{/if}
    {#if iconEnd}<span class="icon">{@render iconEnd()}</span>{/if}
  </span>
  {#if loading}
    <span class="spinner"><Spinner size={size === 'lg' ? 20 : 16} /></span>
  {/if}
</button>

<style>
  .btn {
    --_h: 32px;
    --_px: 12px;
    --_gap: 6px;
    --_fs: var(--text-md);
    --_bg: transparent;
    --_fg: var(--text);
    --_bd: transparent;
    --_bg-hover: var(--surface-hover);
    --_bg-active: color-mix(in srgb, var(--text) 12%, transparent);

    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    block-size: var(--_h);
    min-inline-size: var(--_h);
    padding-block: 0;
    padding-inline: var(--_px);
    border: 1px solid var(--_bd);
    border-radius: var(--radius-sm);
    background-color: var(--_bg);
    color: var(--_fg);
    font-family: inherit;
    font-size: var(--_fs);
    font-weight: var(--weight-label);
    line-height: 1.2;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      border-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard),
      scale var(--dur-instant) var(--ease-standard);
  }

  .s-sm {
    --_h: 28px;
    --_px: 10px;
    --_gap: 4px;
    --_fs: var(--text-sm);
  }

  .s-lg {
    --_h: 40px;
    --_px: 16px;
    --_gap: 8px;
  }

  .v-primary {
    --_bg: var(--accent);
    --_fg: var(--accent-ink);
    --_bd: var(--accent);
    --_bg-hover: color-mix(in srgb, var(--accent) 94%, var(--text));
    --_bg-active: color-mix(in srgb, var(--accent) 86%, var(--text));
  }

  .v-secondary {
    --_bg: var(--surface-raised);
    --_bd: var(--border-input);
    --_bg-hover: color-mix(in srgb, var(--surface-raised) 94%, var(--text));
    --_bg-active: color-mix(in srgb, var(--surface-raised) 88%, var(--text));
  }

  .v-danger {
    --_bg: var(--danger);
    --_fg: var(--danger-ink);
    --_bd: var(--danger);
    --_bg-hover: color-mix(in srgb, var(--danger) 94%, var(--text));
    --_bg-active: color-mix(in srgb, var(--danger) 86%, var(--text));
  }

  .v-link {
    --_fg: var(--accent-text);
    --_px: 0;
    --_bg-hover: transparent;
    --_bg-active: transparent;
    min-inline-size: 0;
    text-underline-offset: 0.2em;
  }

  .btn:hover:not(:disabled, [aria-disabled='true']) {
    background-color: var(--_bg-hover);
  }

  .btn:active:not(:disabled, [aria-disabled='true']) {
    background-color: var(--_bg-active);
    scale: 0.98;
  }

  .v-link:hover:not(:disabled, [aria-disabled='true']) {
    text-decoration: underline;
  }

  .v-link:active:not(:disabled, [aria-disabled='true']) {
    scale: none;
  }

  /* §9.5: no press motion when motion is reduced (the setting, or the OS unless the user chose full motion). */
  :global(:root[data-motion='reduce']) .btn:active {
    scale: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .btn:active {
      scale: none;
    }
  }

  .btn:disabled,
  .btn[aria-disabled='true']:not(.busy) {
    opacity: 0.5;
    cursor: default;
  }

  .busy {
    cursor: progress;
  }

  .full {
    display: flex;
    inline-size: 100%;
  }

  .content {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--_gap);
    min-inline-size: 0;
  }

  .busy .content {
    visibility: hidden;
  }

  .label {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  .icon {
    display: inline-flex;
    flex: none;
  }

  .icon :global(svg) {
    inline-size: 16px;
    block-size: 16px;
    stroke-width: 1.75;
  }

  .s-lg .icon :global(svg) {
    inline-size: 20px;
    block-size: 20px;
  }

  .spinner {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }

  @media (forced-colors: active) {
    .btn {
      border-color: ButtonText;
    }
  }
</style>
