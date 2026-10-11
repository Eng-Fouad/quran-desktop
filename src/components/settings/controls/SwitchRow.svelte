<!--
  SwitchRow: a setting row with an on/off `Switch` bound to a boolean field (`showPageFrame`, `sidePane.open`). A click
  on the label toggles it too. `invert` shows the opposite of the stored value (a field named for the "off" state, such
  as `closeToTrayAsked`, read as "Ask when closing").
-->
<script lang="ts">
  import { Switch } from '$components/ui'
  import type { ShortcutLabelKey } from '$lib/contracts/i18n'
  import type { SettingPath } from '../meta'
  import { current, type PathValue, save } from '../model'
  import SettingRow from './SettingRow.svelte'

  type BooleanPath = {
    [P in SettingPath]: PathValue<P> extends boolean ? P : never
  }[SettingPath]

  interface Props {
    id: BooleanPath
    invert?: boolean
    disabled?: boolean
    note?: string
    noteTone?: 'muted' | 'warning'
    shortcut?: ShortcutLabelKey
    /** Called after the new value was saved (e.g. to set a companion field). */
    onChange?: (on: boolean) => void
  }

  let { id, invert = false, disabled = false, note, noteTone, shortcut, onChange }: Props = $props()

  const checked = $derived((current(id) as boolean) !== invert)

  function toggle(on: boolean): void {
    void save(id, (on !== invert) as PathValue<typeof id>)
    onChange?.(on)
  }
</script>

<SettingRow {id} {disabled} {note} {noteTone} {shortcut} labelFor>
  {#snippet control({ labelId, descriptionId, controlId })}
    <Switch
      {checked}
      onCheckedChange={toggle}
      {disabled}
      id={controlId}
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
    />
  {/snippet}
</SettingRow>
