<!--
  Language (§9.7, §11): the UI language (switches live, §11.1) and how numbers are written (§11.2), with an example in
  the current choice. The Mushaf is always Arabic with Arabic-Indic digits. Used only inside the Settings view.
-->
<script lang="ts">
  import { i18n } from '$lib/stores'
  import ChoiceRow from '../controls/ChoiceRow.svelte'
  import SettingGroup from '../controls/SettingGroup.svelte'

  /** "Example: Page 262 · 2:255 · 1.5 MB", in the digits the setting gives. */
  const sample = $derived(
    i18n.t('settings.language.sample', {
      sample: i18n.t('settings.options.digitsSample', {
        page: 262,
        ref: i18n.ref(2, 255),
        size: i18n.bytes(1536),
      }),
    }),
  )
</script>

<SettingGroup id="language">
  <ChoiceRow id="uiLanguage" values={['en', 'ar']} />
  <ChoiceRow id="digits" values={['auto', 'latin', 'arabic_indic']} note={sample} />
</SettingGroup>
