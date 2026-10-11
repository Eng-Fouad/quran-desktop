<!--
  AccentPicker (§9.7): the six accents as round swatches in the current theme's shade (light or dark), the chosen one
  ringed and ticked, its name beside them. A radio group (arrow keys choose). High contrast forces its own accent, which
  the row explains; the choice still applies to the other themes.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import type { Accent } from '$lib/ipc/bindings'
  import { i18n, settings } from '$lib/stores'
  import { save } from '../model'
  import { ACCENT_SWATCHES } from '../themes'
  import { radioGroup } from './radio'

  interface Props {
    labelledBy: string
    describedBy?: string
  }

  let { labelledBy, describedBy }: Props = $props()

  const ACCENTS: readonly Accent[] = ['teal', 'emerald', 'blue', 'indigo', 'rose', 'amber']

  const value = $derived(settings.value.accent)

  function colour(accent: Accent): string {
    const swatch = ACCENT_SWATCHES[accent]
    return settings.isDark ? swatch.dark : swatch.light
  }

  function choose(next: string): void {
    if (next !== value) void save('accent', next as Accent)
  }
</script>

<div class="accent-picker">
  <div
    class="swatches"
    role="radiogroup"
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    use:radioGroup={choose}
  >
    {#each ACCENTS as accent (accent)}
      {@const checked = value === accent}
      <button
        type="button"
        class={['swatch', { checked }]}
        role="radio"
        aria-checked={checked}
        aria-label={i18n.t(`settings.options.accent.${accent}`)}
        title={i18n.t(`settings.options.accent.${accent}`)}
        tabindex={checked ? 0 : -1}
        data-value={accent}
        style:--_swatch={colour(accent)}
        onclick={() => choose(accent)}
      >
        {#if checked}<Check size={14} strokeWidth={3} aria-hidden="true" />{/if}
      </button>
    {/each}
  </div>
  <span class="name" aria-hidden="true">{i18n.t(`settings.options.accent.${value}`)}</span>
</div>

<style>
  .accent-picker {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .swatches {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .swatch {
    display: inline-grid;
    place-items: center;
    inline-size: 26px;
    block-size: 26px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-full);
    background-color: var(--_swatch);
    color: var(--surface-raised);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 14%, transparent);
    cursor: pointer;
    transition: box-shadow var(--dur-fast) var(--ease-standard);
  }

  .swatch:hover:not(.checked) {
    box-shadow:
      0 0 0 2px var(--surface-raised),
      0 0 0 3px var(--border-strong);
  }

  .swatch.checked {
    box-shadow:
      0 0 0 2px var(--surface-raised),
      0 0 0 4px var(--_swatch);
  }

  .name {
    min-inline-size: 64px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  @media (forced-colors: active) {
    .swatch {
      forced-color-adjust: none;
    }

    .swatch.checked {
      outline: 2px solid Highlight;
      outline-offset: 3px;
    }
  }
</style>
