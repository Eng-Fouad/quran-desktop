<!--
  Storage (§9.7): the disk usage card (WP12a's `DiskUsageBar`, with Open folder and Downloads), Clear cache
  (`cache_clear`, after a ConfirmDialog saying downloads stay), the library backup (`user_backup_create` /
  `user_backup_restore`, `../backup.ts`), the streaming cache limit and network use. Used only inside the Settings view;
  opening it refreshes the usage.
-->
<script lang="ts">
  import ArchiveRestore from '@lucide/svelte/icons/archive-restore'
  import DatabaseBackup from '@lucide/svelte/icons/database-backup'
  import Eraser from '@lucide/svelte/icons/eraser'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import Package from '@lucide/svelte/icons/package'
  import { onMount } from 'svelte'
  import DiskUsageBar from '$components/downloads/DiskUsageBar.svelte'
  import { Button } from '$components/ui'
  import type { SelectItem } from '$components/ui'
  import { app, i18n, packs, settings, ui } from '$lib/stores'
  import { backUpLibrary, restoreLibrary } from '../backup'
  import { settingsSearch } from '../controls/context'
  import SelectRow from '../controls/SelectRow.svelte'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'
  import SwitchRow from '../controls/SwitchRow.svelte'
  import { settingsMeta } from '../meta'
  import { save } from '../model'

  const search = settingsSearch()

  /** Streaming cache limits offered (MiB), within the validated range. */
  const CAPS = [256, 512, 1024, 2048, 5120, 10_240, 20_480] as const

  let clearing = $state(false)
  let backingUp = $state(false)
  let restoring = $state(false)

  async function backUp(): Promise<void> {
    backingUp = true
    await backUpLibrary()
    backingUp = false
  }

  async function restore(): Promise<void> {
    restoring = true
    await restoreLibrary()
    restoring = false
  }

  onMount(() => {
    packs.loadUsage().catch((e: unknown) => console.warn('[qd] settings: disk usage', e))
  })

  const capItems: SelectItem[] = $derived.by(() => {
    const range = settingsMeta.streamCacheCapMib.range
    const current = settings.value.streamCacheCapMib
    const values: number[] = CAPS.filter((c) => !range || (c >= range.min && c <= range.max))
    if (!values.includes(current)) values.push(current)
    return values.sort((a, b) => a - b).map((mib) => ({ value: String(mib), label: i18n.bytes(mib * 1024) }))
  })

  function setCap(value: string): void {
    const mib = Number(value)
    if (Number.isInteger(mib) && mib !== settings.value.streamCacheCapMib) void save('streamCacheCapMib', mib)
  }

  async function clearCache(): Promise<void> {
    const ok = await ui.confirm({
      title: i18n.t('settings.storage.confirmTitle'),
      body: i18n.t('settings.storage.confirmBody'),
      confirmLabel: i18n.t('settings.storage.confirmLabel'),
      danger: true,
    })
    if (!ok) return
    clearing = true
    try {
      const freed = await packs.clearCache()
      ui.toast({
        message:
          freed > 0
            ? i18n.t('settings.storage.cleared', { size: i18n.bytes(freed) })
            : i18n.t('settings.storage.alreadyEmpty'),
        tone: freed > 0 ? 'success' : 'neutral',
      })
      packs.loadUsage().catch((e: unknown) => console.warn('[qd] settings: disk usage', e))
    } catch (e) {
      ui.toastError(e)
    } finally {
      clearing = false
    }
  }

  function openFolder(): void {
    app.revealDataDir().catch((e: unknown) => ui.toastError(e))
  }
</script>

{#if !search.active}
  <DiskUsageBar usage={packs.usage}>
    {#snippet actions()}
      <Button size="sm" variant="ghost" onclick={openFolder}>
        {#snippet icon()}<FolderOpen aria-hidden="true" />{/snippet}
        {i18n.t('settings.storage.openFolder')}
      </Button>
    {/snippet}
  </DiskUsageBar>
{/if}

<SettingGroup id="usage">
  <SettingRow id="clearCache">
    {#snippet control()}
      <Button
        variant="secondary"
        loading={clearing}
        onclick={() => void clearCache()}
        data-action="clear-cache"
      >
        {#snippet icon()}<Eraser aria-hidden="true" />{/snippet}
        {i18n.t('settings.storage.clear')}
      </Button>
    {/snippet}
  </SettingRow>
  <SettingRow id="downloads" shortcut="shortcuts.app.downloads">
    {#snippet control()}
      <Button variant="secondary" onclick={() => ui.setView('downloads')} data-action="open-downloads">
        {#snippet icon()}<Package aria-hidden="true" />{/snippet}
        {i18n.t('settings.storage.openDownloads')}
      </Button>
    {/snippet}
  </SettingRow>
</SettingGroup>

<SettingGroup id="library">
  <SettingRow id="backupCreate">
    {#snippet control()}
      <Button
        variant="secondary"
        loading={backingUp}
        onclick={() => void backUp()}
        data-action="backup-create"
      >
        {#snippet icon()}<DatabaseBackup aria-hidden="true" />{/snippet}
        {i18n.t('settings.backup.create')}
      </Button>
    {/snippet}
  </SettingRow>
  <SettingRow id="backupRestore">
    {#snippet control()}
      <Button
        variant="secondary"
        loading={restoring}
        onclick={() => void restore()}
        data-action="backup-restore"
      >
        {#snippet icon()}<ArchiveRestore aria-hidden="true" />{/snippet}
        {i18n.t('settings.backup.restore')}
      </Button>
    {/snippet}
  </SettingRow>
</SettingGroup>

<SettingGroup id="streaming">
  <SelectRow
    id="streamCacheCapMib"
    items={capItems}
    value={String(settings.value.streamCacheCapMib)}
    onValueChange={setCap}
  />
</SettingGroup>

<SettingGroup id="network">
  <SwitchRow
    id="networkAllowed"
    note={settings.value.networkAllowed ? undefined : i18n.t('settings.storage.offlineNote')}
    noteTone="warning"
  />
</SettingGroup>
