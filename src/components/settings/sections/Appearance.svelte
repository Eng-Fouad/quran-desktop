<!--
  Appearance (§9.7): the live preview, then Theme (cards, the light and dark variants "Match system" uses, the accent),
  Display (interface size 80–200 %, ink brightness 65–100 %, motion, translucent window) and Layout (the sidebar).
  Used only inside the Settings view (WP12b); no props.
-->
<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity'
  import { Switch } from '$components/ui'
  import { app, i18n, settings } from '$lib/stores'
  import AccentPicker from '../controls/AccentPicker.svelte'
  import ChoiceRow from '../controls/ChoiceRow.svelte'
  import { settingsSearch } from '../controls/context'
  import PreviewCard from '../controls/PreviewCard.svelte'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'
  import SliderRow from '../controls/SliderRow.svelte'
  import SwitchRow from '../controls/SwitchRow.svelte'
  import ThemePicker from '../controls/ThemePicker.svelte'
  import { save } from '../model'

  const search = settingsSearch()
  const moreContrast = new MediaQuery('(prefers-contrast: more)', false)

  const dimmable = $derived(settings.resolvedTheme === 'night' || settings.resolvedTheme === 'black')
  /** Under "increase contrast" the ink stays at full brightness (tokens.css, WP7a deviation 4). */
  const inkNote = $derived(
    dimmable && moreContrast.current ? i18n.t('settings.appearance.inkContrast') : undefined,
  )
  const accentForced = $derived(settings.resolvedTheme === 'high_contrast')

  /** Why the translucent window is unavailable or not shown (§9.6), if it is. */
  const chromeNote = $derived(
    app.isLinux
      ? i18n.t('settings.appearance.chromeLinux')
      : settings.chromeUnsupported
        ? i18n.t('settings.appearance.chromeUnsupported')
        : settings.resolvedTheme !== 'paper' && settings.resolvedTheme !== 'night'
          ? i18n.t('settings.appearance.chromeTheme')
          : undefined,
  )
  const chromeUnavailable = $derived(app.isLinux || settings.chromeUnsupported)
</script>

{#if !search.active}
  <PreviewCard />
{/if}

<SettingGroup id="theme">
  <SettingRow id="theme" layout="stack" shortcut="shortcuts.view.theme">
    {#snippet control({ labelId, descriptionId })}
      <ThemePicker labelledBy={labelId} describedBy={descriptionId} />
    {/snippet}
  </SettingRow>
  <ChoiceRow id="lightVariant" values={['paper', 'sepia']} />
  <ChoiceRow id="darkVariant" values={['night', 'black']} />
  <SettingRow id="accent" note={accentForced ? i18n.t('settings.appearance.accentForced') : undefined}>
    {#snippet control({ labelId, descriptionId })}
      <AccentPicker labelledBy={labelId} describedBy={descriptionId} />
    {/snippet}
  </SettingRow>
</SettingGroup>

<SettingGroup id="display">
  <SliderRow id="uiScalePct" shortcut="shortcuts.view.uiScaleUp" />
  <SliderRow id="inkBrightnessPct" live note={inkNote} />
  <ChoiceRow id="motion" values={['system', 'reduce', 'full']} />
  <SettingRow id="chromeEffect" labelFor note={chromeNote} disabled={chromeUnavailable}>
    {#snippet control({ labelId, descriptionId, controlId })}
      <Switch
        checked={settings.value.chromeEffect === 'auto' && !chromeUnavailable}
        onCheckedChange={(on) => void save('chromeEffect', on ? 'auto' : 'off')}
        disabled={chromeUnavailable}
        id={controlId}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
      />
    {/snippet}
  </SettingRow>
</SettingGroup>

<SettingGroup id="layout">
  <SwitchRow id="sidebar.open" shortcut="shortcuts.view.sidebar" />
  <SliderRow id="sidebar.widthPx" />
  <ChoiceRow
    id="sidebar.tab"
    as="select"
    values={['index', 'search', 'bookmarks', 'highlights', 'notes', 'history', 'memorize']}
  />
</SettingGroup>
