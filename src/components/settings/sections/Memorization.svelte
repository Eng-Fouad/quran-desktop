<!--
  Memorization (§9.7, §8.16): Hidden words (blurred or blank, with a sample; peek on hover) and the keys used while
  memorising (the shortcut table's memorisation group). Used only inside the Settings view.
-->
<script lang="ts">
  import ShortcutTable from '$components/dialogs/ShortcutTable.svelte'
  import { shortcuts } from '$lib/stores'
  import { settingsSearch } from '../controls/context'
  import HideStylePicker from '../controls/HideStylePicker.svelte'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'
  import SwitchRow from '../controls/SwitchRow.svelte'

  const search = settingsSearch()
  /** The memorisation keys are listed once WP9b has registered them. */
  const hasKeys = $derived(shortcuts.byGroup.memorize.some((d) => shortcuts.isAvailable(d)))
</script>

<SettingGroup id="hiding">
  <SettingRow id="memoHideStyle" layout="stack">
    {#snippet control({ labelId, descriptionId })}
      <HideStylePicker labelledBy={labelId} describedBy={descriptionId} />
    {/snippet}
  </SettingRow>
  <SwitchRow id="memoRevealOnHover" />
</SettingGroup>

{#if !search.active && hasKeys}
  <SettingGroup id="keys">
    <div class="keys">
      <ShortcutTable groups={['memorize']} />
    </div>
  </SettingGroup>
{/if}

<style>
  .keys {
    padding-block: var(--space-4) 0;
    padding-inline: var(--space-4);
  }
</style>
