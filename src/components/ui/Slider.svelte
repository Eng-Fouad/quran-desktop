<!--
  Slider: a single-value slider (bits-ui Slider) for values such as speed, ink brightness or UI scale.
  Track 4 px with a 1 px `--border-input` outline, accent range, a 14 px thumb with a 2 px raised ring, and optional
  `ticks` (values) with `format`ted labels in text-2xs.

  Keys: arrows step by `step`; Shift+arrows and PageUp/PageDown by `bigStep` (10 × step); Home/End jump to the ends.
  Value sliders mirror with the UI direction (`dir`); pass `dir="ltr"` for one that must never mirror. The
  thumb is `role="slider"`, so the shortcut widget guard keeps arrow keys away from the reader.
-->
<script lang="ts">
  import { Slider } from 'bits-ui'
  import { settings } from '$lib/stores/settings.svelte'
  import { resolveDir } from './floating.svelte'
  import type { Dir } from './types'

  interface Props {
    value?: number
    min?: number
    max?: number
    step?: number
    /** Step for Shift+arrows and PageUp/PageDown (default 10 × `step`). */
    bigStep?: number
    /** Values that get a tick mark and a label under the track. */
    ticks?: readonly number[]
    /** Text for a value: the tick labels and `aria-valuetext` ("1.25×", "80 %"). */
    format?: (value: number) => string
    /** Accessible name of the thumb (or use `labelledBy`). */
    label?: string
    labelledBy?: string
    disabled?: boolean
    /** Called on every change (drag, keys). */
    onValueChange?: (value: number) => void
    /** Called when a drag ends or after a key press: persist here. */
    onValueCommit?: (value: number) => void
    dir?: Dir
    class?: string
  }

  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    bigStep,
    ticks,
    format,
    label,
    labelledBy,
    disabled = false,
    onValueChange,
    onValueCommit,
    dir: dirProp,
    class: className,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  /** Value labels are isolated runs: Latin digits read left to right even in the Arabic UI. */
  const numberDir = $derived(settings.arabicDigits ? 'rtl' : 'ltr')
  const decimals = $derived((String(step).split('.')[1] ?? '').length)
  const span = $derived(max > min ? max - min : 1)

  function percent(v: number): number {
    return Math.min(100, Math.max(0, ((v - min) / span) * 100))
  }

  /** Clamps to [min, max] and snaps to the step grid that starts at `min`, without float noise. */
  function snap(v: number): number {
    const stepped = min + Math.round((v - min) / step) * step
    const clamped = Math.min(max, Math.max(min, stepped))
    return Number(clamped.toFixed(decimals))
  }

  function setValue(next: number): void {
    if (next === value) return
    value = next
    onValueChange?.(next)
  }

  /** Big steps (bits-ui only knows single steps): handled before the thumb sees the key. */
  function onkeydowncapture(e: KeyboardEvent): void {
    if (disabled) return
    const big = bigStep ?? step * 10
    const forward = dir === 'rtl' ? -1 : 1
    let delta = 0
    if (e.key === 'PageUp') delta = big
    else if (e.key === 'PageDown') delta = -big
    else if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'))
      delta = (e.key === 'ArrowRight' ? big : -big) * forward
    else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))
      delta = e.key === 'ArrowUp' ? big : -big
    if (delta === 0) return
    e.preventDefault()
    e.stopPropagation()
    const next = snap(value + delta)
    setValue(next)
    onValueCommit?.(next)
  }
</script>

<div class={['slider', { disabled, 'has-ticks': ticks !== undefined && ticks.length > 0 }, className]} {dir}>
  <Slider.Root
    type="single"
    bind:value={() => value, setValue}
    {min}
    {max}
    {step}
    {dir}
    {disabled}
    {onValueCommit}
    thumbPositioning="exact"
  >
    {#snippet child({ props })}
      <span {...props} class="rail" {onkeydowncapture}>
        <span class="track">
          <Slider.Range>
            {#snippet child({ props: rangeProps })}
              <span {...rangeProps} class="range"></span>
            {/snippet}
          </Slider.Range>
        </span>
        {#each ticks ?? [] as tick (tick)}
          <span class="tick" style:inset-inline-start="{percent(tick)}%" aria-hidden="true">
            {#if format}<span class="tick-label"><bdi dir={numberDir}>{format(tick)}</bdi></span>{/if}
          </span>
        {/each}
        <Slider.Thumb index={0}>
          {#snippet child({ props: thumbProps, active })}
            <span
              {...thumbProps}
              class={['thumb', { active }]}
              aria-label={label}
              aria-labelledby={labelledBy}
              aria-valuetext={format?.(value)}
            ></span>
          {/snippet}
        </Slider.Thumb>
      </span>
    {/snippet}
  </Slider.Root>
</div>

<style>
  .slider {
    padding-inline: 7px;
    touch-action: none;
  }

  .has-ticks {
    padding-block-end: 18px;
  }

  .disabled {
    opacity: 0.5;
  }

  .rail {
    position: relative;
    display: flex;
    align-items: center;
    block-size: 20px;
    cursor: pointer;
    user-select: none;
  }

  .disabled .rail {
    cursor: default;
  }

  .track {
    position: relative;
    flex: 1 1 auto;
    block-size: 4px;
    border-radius: var(--radius-full);
    background-color: var(--surface-sunken);
    box-shadow: inset 0 0 0 1px var(--border-input);
  }

  .range {
    block-size: 100%;
    border-radius: var(--radius-full);
    background-color: var(--accent);
  }

  .tick {
    position: absolute;
    inset-block-start: calc(50% + 5px);
    inline-size: 1px;
    block-size: 4px;
    margin-inline-start: -0.5px;
    background-color: var(--border-input);
  }

  /* A zero-width box centred on the tick, so the label centres on it in either direction. */
  .tick-label {
    position: absolute;
    inset-block-start: 6px;
    inset-inline-start: 50%;
    display: flex;
    justify-content: center;
    inline-size: 0;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    white-space: nowrap;
  }

  .thumb {
    display: block;
    inline-size: 14px;
    block-size: 14px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    box-shadow:
      0 0 0 2px var(--surface-raised),
      var(--shadow-1);
    transition: scale var(--dur-fast) var(--ease-standard);
  }

  .rail:hover .thumb,
  .thumb.active {
    scale: 1.15;
  }

  .disabled .rail:hover .thumb {
    scale: none;
  }

  @media (forced-colors: active) {
    .track {
      border: 1px solid CanvasText;
    }

    .range,
    .thumb {
      background-color: Highlight;
    }
  }
</style>
