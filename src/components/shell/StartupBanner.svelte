<!--
  StartupBanner: a strip under the title bar for a startup notice that needs the user.

  `user_db_recovered`: "Your library couldn't be opened. A copy was kept." with the kept file's name, [Restore from
  backup…] (pick a backup, confirm, `user_backup_restore`; the banner goes once it succeeded), [Show files…]
  (reveals the data folder, which holds the kept copy and `backups/`) and [Dismiss].
  `content_db_recovered` is silent (packs re-sync and may show Partial). The app never exits for user.db or content.db.
  Takes no props: it reads stores.
-->
<script lang="ts">
  import DatabaseBackup from '@lucide/svelte/icons/database-backup'
  import X from '@lucide/svelte/icons/x'
  import { restoreLibrary } from '$components/settings/backup'
  import { Button, IconButton } from '$components/ui'
  import { app, i18n, ui } from '$lib/stores'
  import { baseName, splitAround } from '$lib/util/format'

  const recovered = $derived(app.notices.find((n) => n.type === 'user_db_recovered'))
  const keptFile = $derived(
    recovered?.type === 'user_db_recovered' ? baseName(recovered.data.quarantinedFile) : '',
  )

  let restoring = $state(false)

  async function restore(): Promise<void> {
    restoring = true
    const done = await restoreLibrary()
    restoring = false
    if (done && recovered) app.dismissNotice(recovered)
  }

  async function showFiles(): Promise<void> {
    try {
      await app.revealDataDir()
    } catch (e) {
      ui.toastError(e)
    }
  }
</script>

{#if recovered}
  <div class="banner" role="alert" data-notice={recovered.type}>
    <span class="icon" aria-hidden="true"><DatabaseBackup size={18} strokeWidth={1.75} /></span>
    <p class="text">
      <span class="message">{i18n.t('shell.banner.userDbRecovered')}</span>
      {#if keptFile}
        {@const around = splitAround(i18n.t('shell.banner.keptAs'), 'file')}
        <span class="file">{around?.[0] ?? ''}<bdi dir="ltr">{keptFile}</bdi>{around?.[1] ?? ''}</span>
      {/if}
    </p>
    <div class="actions">
      <Button size="sm" variant="primary" loading={restoring} onclick={() => void restore()}>
        {i18n.t('shell.banner.restore')}
      </Button>
      <Button size="sm" variant="secondary" onclick={showFiles}>{i18n.t('shell.banner.showFiles')}</Button>
      <IconButton
        size="sm"
        icon={X}
        label={i18n.t('common.dismiss')}
        tooltipSide="bottom"
        onclick={() => recovered && app.dismissNotice(recovered)}
      />
    </div>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 44px;
    padding-block: var(--space-1);
    padding-inline: var(--space-4) var(--space-2);
    border-block-end: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
    /* The soft warning tint over the opaque app surface (the root is transparent under vibrant chrome). */
    background-color: var(--surface-app);
    background-image: linear-gradient(var(--warning-soft), var(--warning-soft));
    color: var(--text);
  }

  .icon {
    display: grid;
    flex: none;
    place-items: center;
    color: var(--warning-text);
  }

  .text {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    min-inline-size: 0;
    font-size: var(--text-sm);
  }

  .message {
    font-weight: var(--weight-label);
  }

  .file {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .file bdi {
    font-family: var(--font-mono);
  }

  .actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
  }
</style>
