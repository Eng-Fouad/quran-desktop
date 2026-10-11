<!--
  Mushaf (§9.7): the page preview in the chosen style, then Style (the four styles, tajweed colours), Pages (page mode,
  zoom), On the page (frame, running heads, margin markers, your marks), Interaction (hover, the ayah action bar,
  page-turn animation) and Word by word (meanings pack, tooltip, transliteration). Used only inside the Settings view.
-->
<script lang="ts">
  import type { SelectItem } from '$components/ui'
  import { i18n, packs, settings } from '$lib/stores'
  import { hasContent, languageOf } from '$lib/stores/packs.svelte'
  import ChoiceRow from '../controls/ChoiceRow.svelte'
  import { settingsSearch } from '../controls/context'
  import PreviewCard from '../controls/PreviewCard.svelte'
  import SelectRow from '../controls/SelectRow.svelte'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'
  import SliderRow from '../controls/SliderRow.svelte'
  import StylePicker from '../controls/StylePicker.svelte'
  import SwitchRow from '../controls/SwitchRow.svelte'
  import { save } from '../model'

  const search = settingsSearch()
  /** The select's value for "no pack". */
  const NONE = '__none__'

  const tajweed = $derived(settings.value.mushafStyle === 'qcf_v4')

  /** Word-by-word packs (fetched as you read), the UI language first. */
  const wbwItems: SelectItem[] = $derived([
    { value: NONE, label: i18n.t('settings.mushaf.wbwNone') },
    ...packs.list
      .filter((p) => p.kind === 'wbw' || p.id === settings.value.wbwPackId)
      .sort(
        (a, b) =>
          Number(languageOf(b) === i18n.locale) - Number(languageOf(a) === i18n.locale) ||
          packs.title(a).localeCompare(packs.title(b), i18n.locale),
      )
      .map((p) => ({
        value: p.id,
        label: packs.title(p),
        hint: hasContent(p) ? i18n.t('settings.mushaf.wbwDownloaded') : i18n.t('settings.mushaf.wbwOnDemand'),
      })),
  ])

  const wbwValue = $derived(settings.value.wbwPackId ?? NONE)
</script>

{#if !search.active}
  <PreviewCard translation={false} />
{/if}

<SettingGroup id="style">
  <SettingRow id="mushafStyle" layout="stack">
    {#snippet control({ labelId, descriptionId })}
      <StylePicker labelledBy={labelId} describedBy={descriptionId} />
    {/snippet}
  </SettingRow>
  <SwitchRow id="tajweedColors" note={tajweed ? undefined : i18n.t('settings.mushaf.tajweedOnly')} />
</SettingGroup>

<SettingGroup id="pages">
  <ChoiceRow id="pageMode" values={['auto', 'single', 'spread']} shortcut="shortcuts.view.pageMode" />
  <SliderRow id="zoomPct" shortcut="shortcuts.view.zoomIn" />
</SettingGroup>

<SettingGroup id="furniture">
  <SwitchRow id="showPageFrame" />
  <SwitchRow id="showRunningHeads" />
  <SwitchRow id="showMarginMarkers" />
  <SwitchRow id="highlightBookmarks" />
</SettingGroup>

<SettingGroup id="interaction">
  <SwitchRow id="hoverHighlight" />
  <SwitchRow id="ayahActionBar" />
  <SwitchRow id="pageTurnAnimation" />
</SettingGroup>

<SettingGroup id="wbw">
  <SelectRow
    id="wbwPackId"
    items={wbwItems}
    value={wbwValue}
    onValueChange={(v) => void save('wbwPackId', v === NONE ? null : v)}
  />
  <SwitchRow id="wbwTooltip" />
  <SwitchRow id="wbwShowTransliteration" />
</SettingGroup>
