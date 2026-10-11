<!--
  Language (§9.7, §11): the UI language (switches live, §11.1) and how numbers are written (§11.2), with an example in
  the current choice. The Mushaf is always Arabic with Eastern Arabic numbers. Used only inside the Settings view.

  The digit systems are named in full, "Western Arabic numbers" / "Eastern Arabic numbers" (IMPLEMENTATION_NOTES §13),
  so the Numbers row is a select: as a segmented control the two names squeezed the row's title and description into
  a column under 100 px wide at a 900 px window.
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
  <ChoiceRow id="digits" as="select" values={['auto', 'latin', 'arabic_indic']} note={sample} />
</SettingGroup>
