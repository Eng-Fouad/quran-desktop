<!--
  System (§9.7, §9.6): Window and tray (the tray icon, keep reciting after closing, asking when closing during a
  recitation), Guidance (the welcome tour, one-time tips) and Reset (every setting back to its default, after a
  ConfirmDialog). Used only inside the Settings view.
-->
<script lang="ts">
  import Lightbulb from '@lucide/svelte/icons/lightbulb'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import { Button, Switch } from '$components/ui'
  import { i18n, settings, ui } from '$lib/stores'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'
  import SwitchRow from '../controls/SwitchRow.svelte'

  const tray = $derived(settings.value.showTrayIcon)
  const hints = $derived(settings.value.hintsSeen.length)
  let resetting = $state(false)

  /** Choosing whether to keep reciting is the answer to the first-close question (§9.6): it is not asked again. */
  function setCloseToTray(on: boolean): void {
    void settings.update({ closeToTray: on, closeToTrayAsked: true })
  }

  function showTour(): void {
    void settings.update({ onboardingDone: false })
    ui.open('onboarding', {})
  }

  function showTips(): void {
    void settings.update({ hintsSeen: [] }).then((saved) => {
      if (saved) ui.toast({ message: i18n.t('settings.system.tipsShown'), tone: 'success' })
    })
  }

  async function resetAll(): Promise<void> {
    const ok = await ui.confirm({
      title: i18n.t('settings.system.resetTitle'),
      body: i18n.t('settings.system.resetBody'),
      confirmLabel: i18n.t('settings.system.resetConfirm'),
      danger: true,
    })
    if (!ok) return
    resetting = true
    try {
      if (await settings.resetToDefaults())
        ui.toast({ message: i18n.t('settings.system.resetDone'), tone: 'success' })
    } finally {
      resetting = false
    }
  }
</script>

<SettingGroup id="window">
  <SwitchRow id="showTrayIcon" />
  <SettingRow
    id="closeToTray"
    labelFor
    disabled={!tray}
    note={tray ? undefined : i18n.t('settings.system.trayNeeded')}
  >
    {#snippet control({ labelId, descriptionId, controlId })}
      <!-- Saves the answer to the first-close question with it (setCloseToTray), so not a SwitchRow. -->
      <Switch
        checked={settings.value.closeToTray}
        onCheckedChange={setCloseToTray}
        disabled={!tray}
        id={controlId}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
      />
    {/snippet}
  </SettingRow>
  <SwitchRow id="closeToTrayAsked" invert disabled={!tray} />
</SettingGroup>

<SettingGroup id="guidance">
  <SettingRow id="onboardingDone">
    {#snippet control()}
      <Button variant="secondary" onclick={showTour} data-action="show-tour">
        {#snippet icon()}<Sparkles aria-hidden="true" />{/snippet}
        {i18n.t('settings.system.showTour')}
      </Button>
    {/snippet}
  </SettingRow>
  <SettingRow
    id="hintsSeen"
    note={hints === 0 ? i18n.t('settings.system.tipsNone') : i18n.tp('settings.system.tipsSeen', hints)}
  >
    {#snippet control()}
      <Button variant="secondary" disabled={hints === 0} onclick={showTips} data-action="show-tips">
        {#snippet icon()}<Lightbulb aria-hidden="true" />{/snippet}
        {i18n.t('settings.system.showTips')}
      </Button>
    {/snippet}
  </SettingRow>
</SettingGroup>

<SettingGroup id="reset">
  <SettingRow id="resetAll">
    {#snippet control()}
      <Button variant="danger" loading={resetting} onclick={() => void resetAll()} data-action="reset-all">
        {#snippet icon()}<RotateCcw aria-hidden="true" />{/snippet}
        {i18n.t('settings.system.reset')}
      </Button>
    {/snippet}
  </SettingRow>
</SettingGroup>
