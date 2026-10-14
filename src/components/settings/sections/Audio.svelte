<!--
  Audio: Playback (the reciter, searchable with style and word timings; speed, volume, where a recitation stops),
  Repetition (each ayah, a selection, the pause between repeats) and Following along (page turns, the word highlight,
  screen-reader announcements). Speed, repeats and the pause are the defaults of the next recitation; volume applies at
  once (`settings_set` → `AudioService::apply_settings`). Used only inside the Settings view.
-->
<script lang="ts">
  import { Segmented } from '$components/ui'
  import type { SegmentedOption, SelectItem } from '$components/ui'
  import type { GapSetting } from '$lib/ipc/bindings'
  import { i18n, player, settings } from '$lib/stores'
  import ChoiceRow from '../controls/ChoiceRow.svelte'
  import SelectRow from '../controls/SelectRow.svelte'
  import SettingGroup from '../controls/SettingGroup.svelte'
  import SettingRow from '../controls/SettingRow.svelte'
  import SliderRow from '../controls/SliderRow.svelte'
  import Stepper from '../controls/Stepper.svelte'
  import SwitchRow from '../controls/SwitchRow.svelte'
  import { settingsMeta } from '../meta'
  import { formatSeconds, formatShare, formatTimes, formatValue, save } from '../model'

  const sep = $derived(i18n.t('settings.sep'))

  const reciterItems: SelectItem[] = $derived(
    player.reciters.map((r) => {
      const other = i18n.locale === 'ar' ? r.name.en : r.name.ar
      const style = r.style ? r.style[i18n.locale] || r.style.en : ''
      const hint = [style, r.wordLevel ? i18n.t('settings.audio.wordTimings') : ''].filter(Boolean).join(sep)
      return {
        value: String(r.id),
        label: r.name[i18n.locale] || r.name.en,
        hint: hint || undefined,
        keywords: [other, r.style?.en ?? '', r.style?.ar ?? ''],
      }
    }),
  )

  function chooseReciter(value: string): void {
    const id = Number(value)
    if (!Number.isInteger(id) || id === settings.value.reciterId) return
    void save('reciterId', id)
    // The dock follows at once; the setting is the default for every later recitation.
    void player.setReciter(id).catch((e: unknown) => console.warn('[qd] settings: reciter', e))
  }

  // --- the pause between repeats -------------------------------------------------------------------------------------

  const gap = $derived(settings.value.gap)
  const gapRanges = settingsMeta.gap.ranges ?? {}
  const fixedRange = gapRanges.fixedMs ?? { min: 0, max: 30_000, step: 500 }
  const shareRange = gapRanges.multiplierPct ?? { min: 0, max: 300, step: 25 }
  /** The last value of each kind this visit, so switching kinds back and forth keeps it. */
  let lastMs = $state(1_000)
  let lastPct = $state(100)

  $effect(() => {
    if (gap.type === 'fixed') lastMs = gap.data.ms
    else if (gap.type === 'multiplier') lastPct = gap.data.pct
  })

  const gapOptions: SegmentedOption[] = $derived(
    (['none', 'fixed', 'multiplier'] as const).map((value) => ({
      value,
      label: i18n.t(`settings.options.gap.${value}`),
    })),
  )

  function setGapKind(kind: string): void {
    const next: GapSetting =
      kind === 'fixed'
        ? { type: 'fixed', data: { ms: lastMs } }
        : kind === 'multiplier'
          ? { type: 'multiplier', data: { pct: lastPct } }
          : { type: 'none' }
    if (next.type !== gap.type) void save('gap', next)
  }
</script>

<SettingGroup id="playback">
  <SelectRow
    id="reciterId"
    items={reciterItems}
    value={String(settings.value.reciterId)}
    onValueChange={chooseReciter}
    searchable
    placeholder={i18n.t('settings.audio.findReciter')}
    emptyText={i18n.t('settings.audio.noReciterMatch')}
    disabled={reciterItems.length === 0}
    note={reciterItems.length === 0 ? i18n.t('settings.audio.noReciters') : undefined}
  />
  <SliderRow id="speedPct" live />
  <SliderRow id="volumePct" live />
  <ChoiceRow id="stopAt" as="select" values={['end_of_surah', 'end_of_page', 'end_of_juz', 'end_of_quran']} />
</SettingGroup>

<SettingGroup id="repeat">
  <SettingRow id="ayahRepeat">
    {#snippet control({ labelId, descriptionId })}
      <Stepper
        value={settings.value.ayahRepeat}
        min={settingsMeta.ayahRepeat.range?.min ?? 0}
        max={settingsMeta.ayahRepeat.range?.max ?? 99}
        format={(v) => formatValue('count', v)}
        valueText={formatTimes}
        onValueChange={(v) => void save('ayahRepeat', v)}
        labelledBy={labelId}
        describedBy={descriptionId}
      />
    {/snippet}
  </SettingRow>
  <SettingRow id="rangeRepeat">
    {#snippet control({ labelId, descriptionId })}
      <Stepper
        value={settings.value.rangeRepeat}
        min={settingsMeta.rangeRepeat.range?.min ?? 0}
        max={settingsMeta.rangeRepeat.range?.max ?? 99}
        format={(v) => formatValue('count', v)}
        valueText={formatTimes}
        onValueChange={(v) => void save('rangeRepeat', v)}
        labelledBy={labelId}
        describedBy={descriptionId}
      />
    {/snippet}
  </SettingRow>
  <SettingRow id="gap">
    {#snippet control()}
      <div class="gap">
        <Segmented
          options={gapOptions}
          value={gap.type}
          onValueChange={setGapKind}
          label={i18n.t('settings.fields.gap.label')}
        />
        {#if gap.type === 'fixed'}
          <Stepper
            value={gap.data.ms}
            min={fixedRange.min}
            max={fixedRange.max}
            step={fixedRange.step}
            format={formatSeconds}
            onValueChange={(ms) => void save('gap', { type: 'fixed', data: { ms } })}
            label={i18n.t('settings.audio.pauseSeconds')}
            typedScale={1000}
          />
        {:else if gap.type === 'multiplier'}
          <Stepper
            value={gap.data.pct}
            min={shareRange.min}
            max={shareRange.max}
            step={shareRange.step}
            format={formatShare}
            onValueChange={(pct) => void save('gap', { type: 'multiplier', data: { pct } })}
            label={i18n.t('settings.audio.pauseShare')}
            typedScale={100}
          />
        {/if}
      </div>
    {/snippet}
  </SettingRow>
</SettingGroup>

<SettingGroup id="followAlong">
  <SwitchRow id="followAlong" />
  <SwitchRow id="wordHighlight" />
  <SwitchRow id="announceRecitation" />
</SettingGroup>

<style>
  .gap {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  @container settings-card (max-width: 480px) {
    .gap {
      justify-content: flex-start;
    }
  }
</style>
