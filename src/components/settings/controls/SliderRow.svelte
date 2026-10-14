<!--
  SliderRow: a setting row with a `Slider` bound to a numeric field, its range and unit from `settingsMeta`, the value
  beside it ("150 %") and a reset button while the value differs from the default.

  `live` saves while dragging (ink brightness, text size: the preview follows the thumb). Without it the value is saved
  when the drag ends or a key is released: interface size and pane widths re-lay the window, which would move the
  slider out from under the pointer mid-drag. Arrow keys step, Shift+arrows and Page Up/Down take big steps.
-->
<script lang="ts">
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import { IconButton, Slider } from '$components/ui'
  import type { ShortcutLabelKey } from '$lib/contracts/i18n'
  import { i18n } from '$lib/stores'
  import { metaOf, type SettingPath } from '../meta'
  import { current, defaultOf, formatValue, type PathValue, save } from '../model'
  import SettingRow from './SettingRow.svelte'

  type NumberPath = {
    [P in SettingPath]: PathValue<P> extends number ? P : never
  }[SettingPath]

  interface Props {
    id: NumberPath
    /** Save on every change instead of when the drag ends. */
    live?: boolean
    /** Values with a tick mark under the track. */
    ticks?: readonly number[]
    disabled?: boolean
    note?: string
    noteTone?: 'muted' | 'warning'
    shortcut?: ShortcutLabelKey
  }

  let { id, live = false, ticks, disabled = false, note, noteTone, shortcut }: Props = $props()

  const meta = $derived(metaOf(id))
  const range = $derived(meta?.range ?? { min: 0, max: 100, step: 1 })
  const stored = $derived(current(id) as number)
  const fallback = $derived(defaultOf(id) as number)
  /** The value under the thumb while a non-live drag is in progress. */
  let pending = $state<number | null>(null)
  const shown = $derived(pending ?? stored)
  const format = (v: number) => formatValue(meta?.unit, v)

  function change(v: number): void {
    if (live) {
      pending = null
      void save(id, v as PathValue<typeof id>)
    } else pending = v
  }

  function commit(v: number): void {
    pending = null
    if (v !== stored) void save(id, v as PathValue<typeof id>)
  }
</script>

<SettingRow {id} {disabled} {note} {noteTone} {shortcut}>
  {#snippet control({ labelId })}
    <div class="slider-control">
      <span class={['reset', { shown: stored !== fallback && !disabled }]}>
        <IconButton
          size="sm"
          icon={RotateCcw}
          label={i18n.t('settings.controls.resetValue', { value: format(fallback) })}
          disabled={stored === fallback || disabled}
          onclick={() => commit(fallback)}
        />
      </span>
      <Slider
        class="setting-slider"
        value={shown}
        min={range.min}
        max={range.max}
        step={range.step}
        {ticks}
        {format}
        labelledBy={labelId}
        {disabled}
        onValueChange={change}
        onValueCommit={commit}
      />
      <output class="value" aria-hidden="true">{format(shown)}</output>
    </div>
  {/snippet}
</SettingRow>

<style>
  .slider-control {
    display: grid;
    grid-template-columns: 28px 220px 56px;
    align-items: center;
    gap: var(--space-2);
  }

  .slider-control :global(.setting-slider) {
    min-inline-size: 0;
  }

  .value {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    text-align: end;
    white-space: nowrap;
  }

  /* The reset button keeps its place before the slider, so sliders line up from row to row. */
  .reset {
    visibility: hidden;
  }

  .reset.shown {
    visibility: visible;
  }

  @container settings-card (max-width: 480px) {
    .slider-control {
      grid-template-columns: 28px minmax(0, 1fr) 56px;
      inline-size: 100%;
    }
  }
</style>
