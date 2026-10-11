<!--
  ChoiceRow: a setting row choosing one value of a field, as a `Segmented` control (two to four short options) or a
  `Select` (more, or longer, options). Option labels come from the field's `options` dictionary group in
  `settingsMeta` unless `labels` are given; `hints` add a secondary text to select options.
-->
<script lang="ts">
  import { Segmented, Select } from '$components/ui'
  import type { SegmentedOption, SelectItem } from '$components/ui'
  import type { ShortcutLabelKey } from '$lib/contracts/i18n'
  import { isTextKey } from '$lib/i18n'
  import { i18n } from '$lib/stores'
  import { metaOf, type SettingPath } from '../meta'
  import { current, type PathValue, save } from '../model'
  import SettingRow from './SettingRow.svelte'

  type StringPath = {
    [P in SettingPath]: PathValue<P> extends string ? (string extends PathValue<P> ? never : P) : never
  }[SettingPath]

  interface Props {
    id: StringPath
    /** The options, in display order. */
    values: readonly string[]
    as?: 'segmented' | 'select'
    labels?: Readonly<Record<string, string>>
    hints?: Readonly<Record<string, string>>
    disabled?: boolean
    note?: string
    noteTone?: 'muted' | 'warning'
    shortcut?: ShortcutLabelKey
  }

  let {
    id,
    values,
    as = 'segmented',
    labels,
    hints,
    disabled = false,
    note,
    noteTone,
    shortcut,
  }: Props = $props()

  const meta = $derived(metaOf(id))
  const value = $derived(current(id) as string)

  function label(v: string): string {
    const given = labels?.[v]
    if (given !== undefined) return given
    const key = `${meta?.options ?? ''}.${v}`
    return isTextKey(key) ? i18n.t(key) : v
  }

  const segments: SegmentedOption[] = $derived(values.map((v) => ({ value: v, label: label(v) })))
  const items: SelectItem[] = $derived(values.map((v) => ({ value: v, label: label(v), hint: hints?.[v] })))

  function choose(next: string): void {
    if (next !== value) void save(id, next as PathValue<typeof id>)
  }
</script>

<SettingRow {id} {disabled} {note} {noteTone} {shortcut} labelFor={as === 'select'}>
  {#snippet control({ labelId, descriptionId, controlId })}
    {#if as === 'segmented'}
      <Segmented
        options={segments}
        {value}
        onValueChange={choose}
        label={meta ? i18n.t(meta.label) : id}
        {disabled}
      />
    {:else}
      <span class="select-box">
        <Select
          {items}
          {value}
          onValueChange={choose}
          id={controlId}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          {disabled}
          fullWidth
        />
      </span>
    {/if}
  {/snippet}
</SettingRow>

<style>
  .select-box {
    display: block;
    inline-size: 260px;
    max-inline-size: 100%;
  }

  @container settings-card (max-width: 480px) {
    .select-box {
      inline-size: 100%;
    }
  }
</style>
