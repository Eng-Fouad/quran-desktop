<!--
  About (§9.7): the app's identity (icon, name, version, the core.db build line, platform and web view) with "Copy
  version details" (the app info as JSON, for bug reports), and the way to the full About view with credits and
  licences (WP12c). Used only inside the Settings view.
-->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy'
  import ScrollText from '@lucide/svelte/icons/scroll-text'
  import { Badge, Button } from '$components/ui'
  import { app, i18n, ui } from '$lib/stores'
  import { LRI, PDI } from '$lib/stores/i18n.svelte'
  import appIcon from '../../../assets/app-icon.svg'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'

  const info = $derived(app.info)
  const sep = $derived(i18n.t('settings.sep'))
  /** Version strings stay left to right inside Arabic text. */
  const ltr = (text: string) => `${LRI}${text}${PDI}`

  const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' } as const

  const builtOn = $derived.by(() => {
    const at = Date.parse(info.core.builtAt)
    return Number.isNaN(at) ? info.core.builtAt : i18n.date(Math.floor(at / 1000))
  })

  const dataLine = $derived(
    i18n.t('settings.about.data', {
      source: info.core.source,
      date: builtOn,
      schema: info.core.schemaVersion,
      sep,
    }),
  )
  const platformLine = $derived(
    [
      i18n.t('settings.about.platform', {
        os: ltr(`${OS_NAMES[info.platform]} ${info.osVersion}`.trim()),
        arch: ltr(info.arch),
        sep,
      }),
      i18n.t('settings.about.webview', { version: ltr(info.webviewVersion) }),
    ].join(sep),
  )

  async function copyDetails(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(info, null, 2))
      ui.toast({ message: i18n.t('settings.about.copied'), tone: 'success' })
    } catch (e) {
      ui.toastError(e)
    }
  }
</script>

<SettingGroup id="app" untitled>
  <SettingRow
    id="version"
    label={i18n.t('common.appFullName')}
    description={i18n.t('settings.about.version', { version: ltr(info.version) })}
  >
    {#snippet leading()}
      <img class="icon" src={appIcon} width="48" height="48" alt="" draggable="false" />
    {/snippet}
    {#snippet control()}
      <Button variant="secondary" onclick={() => void copyDetails()} data-action="copy-version">
        {#snippet icon()}<Copy aria-hidden="true" />{/snippet}
        {i18n.t('settings.about.copy')}
      </Button>
    {/snippet}
    {#snippet body()}
      <div class="facts">
        <p class="line">{dataLine}</p>
        <p class="line">{platformLine}</p>
        {#if info.debug}
          <span class="badge"><Badge tone="warning" size="sm">{i18n.t('settings.about.debug')}</Badge></span>
        {/if}
      </div>
    {/snippet}
  </SettingRow>
  <SettingRow id="about">
    {#snippet control()}
      <Button variant="secondary" onclick={() => ui.setView('about')} data-action="open-about">
        {#snippet icon()}<ScrollText aria-hidden="true" />{/snippet}
        {i18n.t('settings.about.credits')}
      </Button>
    {/snippet}
  </SettingRow>
</SettingGroup>

<style>
  .icon {
    display: block;
    flex: none;
    inline-size: 48px;
    block-size: 48px;
    border-radius: var(--radius-md);
  }

  .facts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }

  .badge {
    margin-block-start: var(--space-1);
  }

  .line {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
    overflow-wrap: anywhere;
  }
</style>
