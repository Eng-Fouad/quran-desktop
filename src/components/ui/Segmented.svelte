<!--
  Segmented (§9.5): a single-choice control (bits-ui ToggleGroup, `type="single"`). 28 or 32 px tall; the container
  has a 1 px `--border-input` outline on `--surface-sunken`; the active option sits on a raised pill with a 1 px
  `--border-input` outline, weight 600 and `--accent-text`, and the pill glides between options in 150 ms (instant
  under reduced motion). One option is always selected: clicking the active one keeps it.

  Arrow keys move between options (mirrored in RTL, §9.5), Space/Enter selects. Options may be icon-only
  (`iconOnly`; the label stays the accessible name).

  The options never leave the group's box (a full-width group in a narrow panel, longer Arabic labels): when they do
  not fit, the group first turns compact (`data-fit="tight"`: 6 px padding, `text-xs`), and only if that is still too
  wide do the labels share the width equally and end in an ellipsis (`data-fit="clip"`, the full label in the tooltip;
  the accessible name stays whole). Checked on every resize, label change and web-font load.
-->
<script lang="ts">
  import { ToggleGroup } from 'bits-ui'
  import { resolveDir } from './floating.svelte'
  import type { Dir, SegmentedOption } from './types'

  type FitMode = 'normal' | 'tight' | 'clip'

  interface Props {
    options: readonly SegmentedOption[]
    value: string
    onValueChange?: (value: string) => void
    /** Accessible name of the group. */
    label: string
    size?: 'sm' | 'md'
    /** Stretch to the container's width, options sharing it equally (each at least as wide as its label). */
    fullWidth?: boolean
    disabled?: boolean
    dir?: Dir
    class?: string
  }

  let {
    options,
    value = $bindable(),
    onValueChange,
    label,
    size = 'md',
    fullWidth = false,
    disabled = false,
    dir: dirProp,
    class: className,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))

  let root: HTMLElement | null = $state(null)
  /** The pill's physical box (measured from the active option). */
  let pill = $state<{ x: number; w: number } | null>(null)
  /** No glide on the first placement (or after the size changed). */
  let animate = $state(false)
  /** How the options fit the group (mirrors `data-fit`, which `fit()` sets synchronously). */
  let fitMode = $state<FitMode>('normal')

  function select(next: string): void {
    // ToggleGroup clears the value when the active item is clicked again: a segmented control keeps one selected.
    if (next === '' || next === value) return
    value = next
    onValueChange?.(next)
  }

  /**
   * The options are wider than the group's content box (sub-pixel rounding aside). Summed from the options themselves:
   * the group's `scrollWidth` would also count the pill, which is absolutely placed at the last measured offset.
   */
  function overflows(el: HTMLElement): boolean {
    let total = 0
    for (const option of el.querySelectorAll<HTMLElement>(':scope > .option')) {
      total += option.getBoundingClientRect().width
    }
    const cs = getComputedStyle(el)
    const chrome = [
      'borderInlineStartWidth',
      'borderInlineEndWidth',
      'paddingInlineStart',
      'paddingInlineEnd',
    ] as const
    const box = el.getBoundingClientRect().width
    // Rects are in zoomed pixels and computed lengths are not (the browser mock's CSS zoom): scale the latter.
    const scale = el.offsetWidth > 0 ? box / el.offsetWidth : 1
    const room = box - scale * chrome.reduce((sum, p) => sum + (parseFloat(cs[p]) || 0), 0)
    return total > room + 0.5
  }

  /**
   * Picks the roomiest look whose options fit: normal, compact, or equal shares with ellipses. Each step is measured
   * with its attribute set (a forced layout, before any paint), so the result is exact for the current labels and font.
   * It only changes what is inside the group: a full-width group keeps its own size, so a resize observer on it does not
   * loop.
   */
  function fit(): void {
    const el = root
    if (!el) return
    let mode: FitMode = 'normal'
    el.removeAttribute('data-fit')
    if (overflows(el)) {
      mode = 'tight'
      el.setAttribute('data-fit', mode)
      if (overflows(el)) {
        mode = 'clip'
        el.setAttribute('data-fit', mode)
      }
    }
    fitMode = mode
  }

  function measure(): void {
    const active = root?.querySelector<HTMLElement>('[data-state="on"]')
    pill = active ? { x: active.offsetLeft, w: active.offsetWidth } : null
  }

  /** Fits and places the pill again, without the glide (a resize or a font changed the options' widths). */
  function refit(): void {
    animate = false
    fit()
    measure()
    requestAnimationFrame(() => (animate = true))
    awaitFonts()
  }

  /** A `document.fonts.ready` wait is pending (`awaitFonts`). */
  let fontWait = false

  /**
   * A web font that the labels' layout just started loading changes their widths without resizing a full-width group.
   * Chromium reports it with `loadingdone`; WebKit (WKWebView, WebKitGTK) fires no FontFaceSet event for a load that
   * CSS starts, so after every measurement a pending load is awaited through `document.fonts.ready` as well.
   */
  function awaitFonts(): void {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (!fonts || fonts.status !== 'loading' || fontWait) return
    fontWait = true
    void fonts.ready.then(() => {
      fontWait = false
      if (root) refit()
    })
  }

  $effect(() => {
    void value
    void options
    void dir
    void size
    fit()
    measure()
    awaitFonts()
    const id = requestAnimationFrame(() => (animate = true))
    return () => cancelAnimationFrame(id)
  })

  $effect(() => {
    const el = root
    if (!el) return
    const observer = new ResizeObserver(refit)
    observer.observe(el)
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    fonts?.addEventListener('loadingdone', refit)
    return () => {
      observer.disconnect()
      fonts?.removeEventListener('loadingdone', refit)
    }
  })
</script>

<ToggleGroup.Root type="single" bind:value={() => value, select} bind:ref={root} {disabled} loop>
  {#snippet child({ props })}
    <div
      {...props}
      class={['segmented', `s-${size}`, { full: fullWidth }, className]}
      aria-label={label}
      {dir}
    >
      {#if pill}
        <span
          class={['pill', { animate }]}
          style:translate="{pill.x}px 0"
          style:inline-size="{pill.w}px"
          aria-hidden="true"
        ></span>
      {/if}
      {#each options as option (option.value)}
        {@const Icon = option.icon}
        <ToggleGroup.Item value={option.value} disabled={option.disabled}>
          {#snippet child({ props: itemProps })}
            <button
              {...itemProps}
              class={['option', { 'icon-only': option.iconOnly }]}
              aria-label={option.iconOnly ? option.label : undefined}
              title={option.iconOnly || fitMode === 'clip' ? option.label : undefined}
            >
              {#if Icon}<Icon size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
              {#if !option.iconOnly}
                <span class="text">
                  <span>{option.label}</span>
                  <span class="reserve" aria-hidden="true">{option.label}</span>
                </span>
              {/if}
            </button>
          {/snippet}
        </ToggleGroup.Item>
      {/each}
    </div>
  {/snippet}
</ToggleGroup.Root>

<style>
  .segmented {
    --_h: 32px;
    position: relative;
    display: inline-flex;
    align-items: stretch;
    block-size: var(--_h);
    padding: 2px;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    isolation: isolate;
  }

  .s-sm {
    --_h: 28px;
  }

  /* `min-inline-size: 0`: as a flex item the group may still be narrower than its options (they then fit, below). */
  .full {
    display: flex;
    inline-size: 100%;
    min-inline-size: 0;
  }

  .segmented[data-disabled] {
    opacity: 0.5;
  }

  /* Placed from the measured physical offset of the active option, so it is anchored physically. */
  .pill {
    position: absolute;
    inset-block: 2px;
    left: 0; /* physical-ok */
    z-index: 0;
    border: 1px solid var(--border-input);
    border-radius: calc(var(--radius-sm) - 2px);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-1);
  }

  .pill.animate {
    transition:
      translate var(--dur-quick) var(--ease-standard),
      inline-size var(--dur-quick) var(--ease-standard);
  }

  .option {
    position: relative;
    z-index: 1;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-inline-size: 0;
    padding-block: 0;
    padding-inline: var(--space-3);
    border: 0;
    border-radius: calc(var(--radius-sm) - 2px);
    background: none;
    color: var(--text-muted);
    font-family: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--dur-quick) var(--ease-standard);
  }

  /* Equal shares of the width, but never narrower than the option itself: a long label ("Translation") takes the room
     it needs from its neighbours instead of being clipped. */
  .full .option {
    flex: 1 1 0;
    min-inline-size: max-content;
  }

  /* A 28 px control needs less room around its label than a 32 px one. */
  .s-sm .option:not(.icon-only) {
    padding-inline: var(--space-2);
  }

  /* The options do not fit at their normal size (see `fit()`): compact first, still never clipped. */
  .segmented[data-fit] .option:not(.icon-only) {
    padding-inline: 6px;
    font-size: var(--text-xs);
  }

  /* Last resort: equal shares of the group and an ellipsis (the full label is the tooltip and the accessible name). */
  .segmented[data-fit='clip'] .option {
    flex: 1 1 0;
    min-inline-size: 0;
  }

  .segmented[data-fit='clip'] .text {
    min-inline-size: 0;
    max-inline-size: 100%;
  }

  .segmented[data-fit='clip'] .text > span {
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  .option:hover:not(:disabled, [data-state='on']) {
    color: var(--text);
  }

  .option[data-state='on'] {
    color: var(--accent-text);
    font-weight: var(--weight-title);
  }

  .option:disabled {
    color: var(--text-faint);
    cursor: default;
  }

  .icon-only {
    padding-inline: var(--space-2);
  }

  /* Reserves the bold width, so selecting an option never shifts its neighbours (hidden from assistive tech). */
  .text {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
  }

  .reserve {
    block-size: 0;
    overflow: hidden;
    visibility: hidden;
    font-weight: var(--weight-title);
  }

  @media (forced-colors: active) {
    .pill {
      border-color: Highlight;
    }
  }
</style>
