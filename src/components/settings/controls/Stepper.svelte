<!--
  Stepper: a compact number control (APG spinbutton) for small counts and durations: − value +. The value box takes
  focus; ↑/↓ (and →/← in the reading direction) step, Page Up/Down take ten steps, Home/End jump to the ends, and typed
  digits set the value. The buttons are pointer conveniences outside the tab order. `format` writes the value ("3",
  "∞", "1.5 s"); `valueText` is what screen readers hear ("3 times").
-->
<script lang="ts">
  import Minus from '@lucide/svelte/icons/minus'
  import Plus from '@lucide/svelte/icons/plus'
  import { i18n } from '$lib/stores'

  interface Props {
    value: number
    min: number
    max: number
    step?: number
    format: (value: number) => string
    valueText?: (value: number) => string
    onValueChange: (value: number) => void
    labelledBy?: string
    describedBy?: string
    /** Accessible name when no label element names it. */
    label?: string
    disabled?: boolean
    /** Typed digits are read in this unit (`1000` for seconds typed into a millisecond value). */
    typedScale?: number
  }

  let {
    value,
    min,
    max,
    step = 1,
    format,
    valueText,
    onValueChange,
    labelledBy,
    describedBy,
    label,
    disabled = false,
    typedScale = 1,
  }: Props = $props()

  /** Digits typed in quick succession. */
  let typed = ''
  let typedAt = 0

  function clamp(v: number): number {
    const stepped = min + Math.round((v - min) / step) * step
    return Math.min(max, Math.max(min, stepped))
  }

  function set(next: number): void {
    const v = clamp(next)
    if (v !== value) onValueChange(v)
  }

  function onkeydown(e: KeyboardEvent): void {
    if (disabled) return
    const forward = i18n.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
    const backward = i18n.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    let next: number | null = null
    if (e.key === 'ArrowUp' || e.key === forward) next = value + step
    else if (e.key === 'ArrowDown' || e.key === backward) next = value - step
    else if (e.key === 'PageUp') next = value + step * 10
    else if (e.key === 'PageDown') next = value - step * 10
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    else if (/^[0-9]$/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = performance.now()
      typed = now - typedAt < 900 ? typed + e.key : e.key
      typedAt = now
      next = Number(typed) * typedScale
    }
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    set(next)
  }
</script>

<div class={['stepper', { disabled }]}>
  <button
    type="button"
    class="step"
    tabindex="-1"
    aria-label={i18n.t('settings.controls.less')}
    disabled={disabled || value <= min}
    onclick={() => set(value - step)}
  >
    <Minus size={14} strokeWidth={2} aria-hidden="true" />
  </button>
  <span
    class="value"
    role="spinbutton"
    tabindex={disabled ? -1 : 0}
    aria-valuenow={value}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuetext={(valueText ?? format)(value)}
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    aria-label={label}
    aria-disabled={disabled || undefined}
    {onkeydown}
  >
    {format(value)}
  </span>
  <button
    type="button"
    class="step"
    tabindex="-1"
    aria-label={i18n.t('settings.controls.more')}
    disabled={disabled || value >= max}
    onclick={() => set(value + step)}
  >
    <Plus size={14} strokeWidth={2} aria-hidden="true" />
  </button>
</div>

<style>
  .stepper {
    display: inline-grid;
    grid-template-columns: 30px minmax(52px, auto) 30px;
    align-items: stretch;
    block-size: 32px;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    overflow: clip;
  }

  .stepper.disabled {
    opacity: 0.5;
  }

  .step {
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .step:hover:not(:disabled) {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .step:active:not(:disabled) {
    background-color: color-mix(in srgb, var(--text) 12%, transparent);
  }

  .step:disabled {
    color: var(--text-faint);
    cursor: default;
  }

  .value {
    display: inline-grid;
    place-items: center;
    padding-inline: var(--space-2);
    border-inline: 1px solid var(--border);
    background-color: var(--surface-raised);
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: default;
    user-select: none;
  }

  .value:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: -2px;
  }

  @media (forced-colors: active) {
    .stepper {
      border-color: CanvasText;
    }
  }
</style>
