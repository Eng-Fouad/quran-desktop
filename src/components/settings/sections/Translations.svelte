<!--
  Translations (§9.7): Reading (reading view, text size, Arabic text, footnotes), Translations (the shown list, in
  order), Study pane (open, tab, what it follows, the tafsir it shows, width, making room) and Copying (reference, its
  style, ayah numbers, an appended translation, with a live preview of what Copy produces). Used only inside the
  Settings view.
-->
<script lang="ts">
  import type { SelectItem } from '$components/ui'
  import type { PackInfo } from '$lib/ipc/bindings'
  import { i18n, packs, settings } from '$lib/stores'
  import { hasContent, isInstalled, languageOf } from '$lib/stores/packs.svelte'
  import ChoiceRow from '../controls/ChoiceRow.svelte'
  import CopyPreview from '../controls/CopyPreview.svelte'
  import SelectRow from '../controls/SelectRow.svelte'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'
  import SliderRow from '../controls/SliderRow.svelte'
  import SwitchRow from '../controls/SwitchRow.svelte'
  import TranslationList from '../controls/TranslationList.svelte'
  import { save } from '../model'

  /** The select's value for "no pack". */
  const NONE = '__none__'

  /** The UI language first, then by title. */
  function byLanguage(a: PackInfo, b: PackInfo): number {
    return (
      Number(languageOf(b) === i18n.locale) - Number(languageOf(a) === i18n.locale) ||
      packs.title(a).localeCompare(packs.title(b), i18n.locale)
    )
  }

  /**
   * Tafsir the study pane can show: installed whole packs, and Quran.com tafsir fetched chapter by chapter as you read
   * (usable without a download). The current choice stays listed even when it is gone.
   */
  const tafsirItems: SelectItem[] = $derived([
    { value: NONE, label: i18n.t('settings.options.none') },
    ...packs.list
      .filter(
        (p) =>
          p.kind === 'tafsir' &&
          (p.installMode === 'on_demand' || isInstalled(p) || p.id === settings.value.tafsirPackId),
      )
      .sort(byLanguage)
      .map((p) => ({
        value: p.id,
        label: packs.title(p),
        hint:
          p.installMode === 'on_demand' && !hasContent(p)
            ? i18n.t('settings.translations.tafsirOnDemand')
            : i18n.t('settings.translations.tafsirDownloaded'),
      })),
  ])

  /** Translations that can be appended to a copy: the downloaded ones (and the current choice). */
  const copyItems: SelectItem[] = $derived([
    { value: NONE, label: i18n.t('settings.options.none') },
    ...packs.list
      .filter(
        (p) => p.kind === 'translation' && (isInstalled(p) || p.id === settings.value.copy.translationPackId),
      )
      .sort(byLanguage)
      .map((p) => ({
        value: p.id,
        label: packs.title(p),
        hint: isInstalled(p) ? undefined : i18n.t('settings.translations.notDownloaded'),
      })),
  ])

  const referenceOff = $derived(!settings.value.copy.includeReference)
</script>

<SettingGroup id="reading">
  <ChoiceRow id="readingMode" values={['mushaf', 'translation']} shortcut="shortcuts.view.readingMode" />
  <SliderRow id="translationFontPct" live />
  <SwitchRow id="translationArabic" />
  <SwitchRow id="footnotesInline" />
</SettingGroup>

<SettingGroup id="translations">
  <SettingRow id="translations" layout="stack">
    {#snippet control({ labelId })}
      <TranslationList labelledBy={labelId} />
    {/snippet}
  </SettingRow>
</SettingGroup>

<SettingGroup id="studyPane">
  <SwitchRow id="sidePane.open" shortcut="shortcuts.view.sidePane" />
  <ChoiceRow id="sidePane.tab" as="select" values={['translation', 'tafsir', 'notes', 'words']} />
  <ChoiceRow id="sidePane.follow" as="select" values={['selection', 'selection_or_audio', 'pinned']} />
  <SelectRow
    id="tafsirPackId"
    items={tafsirItems}
    value={settings.value.tafsirPackId ?? NONE}
    onValueChange={(v) => void save('tafsirPackId', v === NONE ? null : v)}
  />
  <SliderRow id="sidePane.widthPx" />
  <SwitchRow id="sidePane.autoCollapseSidebar" />
</SettingGroup>

<SettingGroup id="copy">
  <SwitchRow id="copy.includeReference" />
  <ChoiceRow id="copy.referenceStyle" values={['short', 'long', 'arabic']} disabled={referenceOff} />
  <SwitchRow id="copy.ayahNumbers" />
  <SelectRow
    id="copy.translationPackId"
    items={copyItems}
    value={settings.value.copy.translationPackId ?? NONE}
    onValueChange={(v) => void save('copy.translationPackId', v === NONE ? null : v)}
  />
  {#snippet footer()}
    <CopyPreview />
  {/snippet}
</SettingGroup>
