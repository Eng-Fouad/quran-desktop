<!--
  Progress: determinate or indeterminate progress (bits-ui Progress, `role="progressbar"`).
  - `bar`: 4 px, radius-full, on a `--border-input` 40 % track; fills from the inline start (from the right in RTL).
  - `ring`: 16 or 24 px (the play button's buffering ring, a download cell).
  Indeterminate shows a moving segment (bar) or a spinning arc (ring); under reduced motion both stand still.
-->
<script lang="ts">
  import { Progress } from 'bits-ui'
  import { resolveDir } from './floating.svelte'
  import type { Dir } from './types'

  interface Props {
    value?: number
    max?: number
    indeterminate?: boolean
    variant?: 'bar' | 'ring'
    /** Ring diameter in px. */
    size?: 16 | 24
    tone?: 'accent' | 'success' | 'danger'
    /** Accessible name ("Downloading Al-Kahf"). */
    label?: string
    /** Accessible value text ("12.4 of 93.2 MB"). */
    valueText?: string
    dir?: Dir
    class?: string
  }

  let {
    value = 0,
    max = 100,
    indeterminate = false,
    variant = 'bar',
    size = 16,
    tone = 'accent',
    label,
    valueText,
    dir: dirProp,
    class: className,
  }: Props = $props()

  const dir = $derived(resolveDir(dirProp))
  const ratio = $derived(max > 0 ? Math.min(1, Math.max(0, value / max)) : 0)

  const STROKE = 2
  const radius = $derived((size - STROKE) / 2)
  const circumference = $derived(2 * Math.PI * radius)
</script>

<Progress.Root value={indeterminate ? null : Math.min(max, Math.max(0, value))} {max}>
  {#snippet child({ props })}
    {#if variant === 'bar'}
      <div
        {...props}
        class={['bar', `t-${tone}`, { indeterminate }, className]}
        aria-label={label}
        aria-valuetext={valueText}
        {dir}
      >
        <div class="fill" style:inline-size={indeterminate ? undefined : `${ratio * 100}%`}></div>
      </div>
    {:else}
      <div
        {...props}
        class={['ring', `t-${tone}`, { indeterminate }, className]}
        aria-label={label}
        aria-valuetext={valueText}
        style:inline-size="{size}px"
        style:block-size="{size}px"
      >
        <svg width={size} height={size} viewBox="0 0 {size} {size}" aria-hidden="true">
          <circle class="track" cx={size / 2} cy={size / 2} r={radius} stroke-width={STROKE} />
          <circle
            class="arc"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke-width={STROKE}
            stroke-dasharray={circumference}
            stroke-dashoffset={indeterminate ? circumference * 0.7 : circumference * (1 - ratio)}
          />
        </svg>
      </div>
    {/if}
  {/snippet}
</Progress.Root>

<style>
  .bar {
    --_fill: var(--accent);
    position: relative;
    display: flex;
    inline-size: 100%;
    block-size: 4px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--border-input) 40%, transparent);
  }

  .t-success {
    --_fill: var(--success);
  }

  .t-danger {
    --_fill: var(--danger);
  }

  .fill {
    block-size: 100%;
    border-radius: inherit;
    background-color: var(--_fill);
    transition: inline-size var(--dur-normal) var(--ease-standard);
  }

  .bar.indeterminate .fill {
    position: absolute;
    inset-block: 0;
    inline-size: 32%;
    animation: slide 1.4s var(--ease-standard) infinite;
  }

  @keyframes slide {
    from {
      inset-inline-start: -32%;
    }

    to {
      inset-inline-start: 100%;
    }
  }

  .ring {
    --_fill: var(--accent);
    display: inline-grid;
    flex: none;
    place-items: center;
  }

  .ring svg {
    rotate: -90deg;
  }

  .ring circle {
    fill: none;
  }

  .track {
    stroke: color-mix(in srgb, var(--border-input) 40%, transparent);
  }

  .arc {
    stroke: var(--_fill);
    stroke-linecap: round;
    transition: stroke-dashoffset var(--dur-normal) var(--ease-standard);
  }

  .ring.indeterminate svg {
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    from {
      rotate: -90deg;
    }

    to {
      rotate: 270deg;
    }
  }

  @media (forced-colors: active) {
    .bar {
      border: 1px solid CanvasText;
    }

    .fill {
      background-color: Highlight;
    }

    .arc {
      stroke: Highlight;
    }
  }
</style>
