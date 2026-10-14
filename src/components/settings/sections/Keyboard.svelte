<!--
  Keyboard: every registered shortcut, through `ShortcutTable` (the keys this platform and keyboard layout show), with
  a filter and a button for the shortcut sheet (`?`). Used only inside the Settings view.
-->
<script lang="ts">
  import Keyboard from '@lucide/svelte/icons/keyboard'
  import ShortcutTable from '$components/dialogs/ShortcutTable.svelte'
  import { Button, SearchInput } from '$components/ui'
  import { i18n, ui } from '$lib/stores'
  import { shortcutLabel } from '../controls/context'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'

  let filter = $state('')
  const sheetKeys = $derived(shortcutLabel('shortcuts.app.shortcutSheet'))
</script>

<SettingGroup id="shortcuts" untitled>
  <SettingRow id="shortcuts" layout="stack">
    {#snippet control()}
      <div class="tools">
        <SearchInput
          size="sm"
          bind:value={filter}
          placeholder={i18n.t('settings.keyboard.filter')}
          aria-label={i18n.t('settings.keyboard.filter')}
          fullWidth={false}
        />
        <Button
          size="sm"
          variant="secondary"
          onclick={() => ui.open('shortcuts', {})}
          title={sheetKeys || undefined}
        >
          {#snippet icon()}<Keyboard aria-hidden="true" />{/snippet}
          {i18n.t('settings.keyboard.openSheet')}
        </Button>
      </div>
    {/snippet}
    {#snippet body()}
      <div class="table">
        <ShortcutTable query={filter} />
      </div>
    {/snippet}
  </SettingRow>
</SettingGroup>

<style>
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    inline-size: 100%;
  }

  .tools :global(input[type='search']) {
    inline-size: 240px;
  }

  .table {
    padding-block-start: var(--space-2);
  }
</style>
