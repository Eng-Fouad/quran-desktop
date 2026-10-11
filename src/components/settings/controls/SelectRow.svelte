<!--
  SelectRow: a setting row with a `Select` over computed items (packs, reciters, size presets), where the field's value
  needs mapping (a pack id or none, a number). `searchable` turns it into a type-to-filter combobox for long lists.
-->
<script lang="ts">
  import { Select } from '$components/ui'
  import type { SelectItem } from '$components/ui'
  import type { RowId } from '../meta'
  import SettingRow from './SettingRow.svelte'

  interface Props {
    id: RowId
    items: readonly SelectItem[]
    value: string
    onValueChange: (value: string) => void
    searchable?: boolean
    placeholder?: string
    emptyText?: string
    disabled?: boolean
    note?: string
    noteTone?: 'muted' | 'warning'
  }

  let {
    id,
    items,
    value,
    onValueChange,
    searchable = false,
    placeholder,
    emptyText,
    disabled = false,
    note,
    noteTone,
  }: Props = $props()
</script>

<SettingRow {id} {disabled} {note} {noteTone} labelFor>
  {#snippet control({ labelId, descriptionId, controlId })}
    <span class="select-box">
      <Select
        {items}
        {value}
        {onValueChange}
        {searchable}
        {placeholder}
        {emptyText}
        {disabled}
        id={controlId}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        fullWidth
      />
    </span>
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
