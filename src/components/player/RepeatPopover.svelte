<!--
  RepeatPopover (§9.7): repeat, gap, range and presets, opened from the dock's Repeat button. Owner: WP9a.

  - **Each ayah ×N** and **whole range ×N** steppers (Off, ×2 … ×99, ∞) and an ∞ toggle each. Changes apply to the play
    that is loaded and become the defaults of the next one (`player.setRepeat`).
  - **Pause after each ayah**: none, a fixed number of seconds (0.5–30) or a multiple of the ayah's length (×0.25–×3).
  - **Range**: an ayah or a range in one surah (`2:255`, `18:1–10`, Arabic-Indic digits too), defaulting to the
    selection, else the loaded range, else the ayah being heard; "Play range" plays it with the settings above.
  - **Presets**: the saved loop presets (`loop_preset_list`); choosing one plays its range with its repeats, gap,
    speed and reciter. "Save as preset" stores the current loop.

  A floating layer (§7.4): the reader's keys pause while it is open, and Escape closes it.
-->
<script lang="ts">
  import InfinityIcon from '@lucide/svelte/icons/infinity'
  import Minus from '@lucide/svelte/icons/minus'
  import Plus from '@lucide/svelte/icons/plus'
  import { type Snippet, untrack } from 'svelte'
  import { Button, IconButton, Popover, Segmented, TextInput } from '$components/ui'
  import type { Align, SegmentedOption, Side, TriggerProps } from '$components/ui/types'
  import { api, call } from '$lib/ipc'
  import type { GapSetting, LoopPreset } from '$lib/ipc/bindings'
  import { i18n, player, quran, reader, settings, ui } from '$lib/stores'
  import { parseReference } from '$lib/text/refparse'
  import { formatDecimal, gapText, repeatBadge, repeatText } from './dock.svelte'

  interface Props {
    trigger: Snippet<[TriggerProps]>
    side?: Side
    align?: Align
    /** Distance from the trigger (the dock passes enough to clear its own edge). */
    sideOffset?: number
    /** Anchor the panel to this element instead of the trigger (the side card anchors to itself). */
    anchor?: HTMLElement | null
    open?: boolean
  }

  let {
    trigger,
    side = 'top',
    align = 'center',
    sideOffset = 10,
    anchor = null,
    open = $bindable(false),
  }: Props = $props()

  const uid = $props.id()
  const GAP_SECONDS = { min: 500, max: 30_000, step: 500 }
  const GAP_TIMES = { min: 25, max: 300, step: 25 }

  /** The values the dock edits: the loaded play's, else the settings (the next play's defaults). */
  const source = $derived(player.isActive && player.snapshot ? player.snapshot : settings.value)
  const ayahRepeat = $derived(source.ayahRepeat)
  const rangeRepeat = $derived(source.rangeRepeat)
  const gap: GapSetting = $derived(source.gap)
  const status = $derived(repeatBadge()?.status ?? '')

  let rangeText = $state('')
  let rangeTouched = $state(false)
  let presets = $state.raw<LoopPreset[]>([])
  let presetsFailed = $state(false)
  let saving = $state(false)

  /** The range the popover opens with: the selection, else the loaded range, else the ayah heard. */
  function defaultRange(): { from: number; to: number } | null {
    const sel = reader.selection
    if (sel)
      return { from: Math.min(sel.fromAyahId, sel.toAyahId), to: Math.max(sel.fromAyahId, sel.toAyahId) }
    const r = player.snapshot?.range
    if (r && player.isActive) {
      const from = quran.ayahId(r.from.surah, r.from.ayah)
      const to = quran.ayahId(r.to.surah, r.to.ayah)
      if (from > 0 && to >= from && quran.ayahRef(to).surah === r.from.surah) return { from, to }
      if (from > 0) return { from, to: from }
    }
    const id = player.currentAyahId ?? reader.cursorAyahId
    return id ? { from: id, to: id } : null
  }

  /** "2:255" or "18:1-10", ASCII digits (the field is LTR and accepts either digit set). */
  function rangeToText(r: { from: number; to: number } | null): string {
    if (!r) return ''
    const a = quran.ayahRef(r.from)
    const b = quran.ayahRef(r.to)
    if (a.surah === 0) return ''
    return b.surah === a.surah && b.ayah !== a.ayah
      ? `${a.surah}:${a.ayah}–${b.ayah}`
      : `${a.surah}:${a.ayah}`
  }

  // On opening only: the default range and the presets. `defaultRange()` reads the player and the reader, which change
  // at every ayah edge of a recitation; tracking them would overwrite what the user is typing (and reload the presets).
  $effect(() => {
    if (!open) return
    untrack(() => {
      rangeText = rangeToText(defaultRange())
      rangeTouched = false
      void loadPresets()
    })
  })

  async function loadPresets(): Promise<void> {
    try {
      presets = await call(api.loopPresetList())
      presetsFailed = false
    } catch (e) {
      presetsFailed = true
      console.warn('[qd] player: loop presets unavailable', e)
    }
  }

  /** The parsed range field: ayah ids, or `null` when it is not one ayah or range of one surah. */
  const parsedRange = $derived.by(() => {
    const result = parseReference(rangeText, { names: false })[0]
    if (!result || result.issue || result.target.type !== 'ayah') return null
    const t = result.target
    const from = quran.ayahId(t.surah, t.ayah)
    const to = quran.ayahId(t.surah, t.toAyah ?? t.ayah)
    return from > 0 && to >= from ? { from, to } : null
  })
  const rangeInvalid = $derived(rangeTouched && rangeText.trim() !== '' && parsedRange === null)

  // --- steppers -------------------------------------------------------------------------------------------------

  /** Off (1) → ×2 … ×99 → ∞ (0). */
  function stepRepeat(n: number, direction: 1 | -1): number {
    if (direction > 0) return n === 0 ? 0 : n >= 99 ? 0 : n + 1
    return n === 0 ? 99 : Math.max(1, n - 1)
  }

  function setAyahRepeat(n: number): void {
    void player.setRepeat(n, rangeRepeat)
  }

  function setRangeRepeat(n: number): void {
    void player.setRepeat(ayahRepeat, n)
  }

  const gapOptions: SegmentedOption[] = $derived([
    { value: 'none', label: i18n.t('player.repeat.gapNone') },
    { value: 'fixed', label: i18n.t('player.repeat.gapFixed') },
    { value: 'multiplier', label: i18n.t('player.repeat.gapMultiplier') },
  ])

  function setGapKind(kind: string): void {
    if (kind === gap.type) return
    if (kind === 'fixed') void player.setGap({ type: 'fixed', data: { ms: 2_000 } })
    else if (kind === 'multiplier') void player.setGap({ type: 'multiplier', data: { pct: 100 } })
    else void player.setGap({ type: 'none' })
  }

  function stepGap(direction: 1 | -1): void {
    if (gap.type === 'fixed') {
      const ms = Math.min(
        GAP_SECONDS.max,
        Math.max(GAP_SECONDS.min, gap.data.ms + direction * GAP_SECONDS.step),
      )
      void player.setGap({ type: 'fixed', data: { ms } })
    } else if (gap.type === 'multiplier') {
      const pct = Math.min(GAP_TIMES.max, Math.max(GAP_TIMES.min, gap.data.pct + direction * GAP_TIMES.step))
      void player.setGap({ type: 'multiplier', data: { pct } })
    }
  }

  const gapAtMin = $derived(
    (gap.type === 'fixed' && gap.data.ms <= GAP_SECONDS.min) ||
      (gap.type === 'multiplier' && gap.data.pct <= GAP_TIMES.min),
  )
  const gapAtMax = $derived(
    (gap.type === 'fixed' && gap.data.ms >= GAP_SECONDS.max) ||
      (gap.type === 'multiplier' && gap.data.pct >= GAP_TIMES.max),
  )

  // --- range and presets ------------------------------------------------------------------------------------------

  function playRange(): void {
    rangeTouched = true
    const r = parsedRange
    if (!r) return
    open = false
    void player.playRange(r.from, r.to, { ayahRepeat, rangeRepeat, gap })
  }

  function onRangeKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      playRange()
    }
  }

  function presetSummary(p: LoopPreset): string {
    const parts = [rangeLabel(p.fromAyahId, p.toAyahId)]
    if (p.ayahRepeat !== 1) parts.push(repeatText(p.ayahRepeat))
    if (p.gap.type !== 'none') parts.push(gapText(p.gap))
    return parts.join(' · ')
  }

  function rangeLabel(from: number, to: number): string {
    return quran.refLabel(from, 'long', to)
  }

  async function applyPreset(p: LoopPreset): Promise<void> {
    open = false
    if (p.reciterId !== null && p.reciterId !== settings.value.reciterId) {
      void settings.update({ reciterId: p.reciterId })
    }
    await player.setSpeed(p.speedPct)
    await player.playRange(p.fromAyahId, p.toAyahId, {
      ayahRepeat: p.ayahRepeat,
      rangeRepeat: p.rangeRepeat,
      gap: p.gap,
    })
  }

  async function savePreset(): Promise<void> {
    const r = parsedRange ?? defaultRange()
    if (!r) return
    saving = true
    const name = i18n.t('player.repeat.presetName', {
      ref: rangeLabel(r.from, r.to),
      repeat: repeatText(ayahRepeat),
    })
    try {
      await call(
        api.loopPresetUpsert({
          id: null,
          name,
          reciterId: settings.value.reciterId,
          fromAyahId: r.from,
          toAyahId: r.to,
          ayahRepeat,
          rangeRepeat,
          gap,
          speedPct: settings.value.speedPct,
        }),
      )
      ui.toast({ message: i18n.t('player.repeat.presetSaved', { name }), tone: 'success' })
      await loadPresets()
    } catch (e) {
      ui.toastError(e)
    } finally {
      saving = false
    }
  }
</script>

{#snippet stepper(label: string, value: number, onChange: (n: number) => void, id: string)}
  <div class="row">
    <span class="label" {id}>{label}</span>
    <div class="stepper" role="group" aria-labelledby={id}>
      <!-- At a limit the buttons only look disabled (`aria-disabled`): a focused one keeps focus in the popover. -->
      <IconButton
        label={i18n.t('player.repeat.decrease')}
        icon={Minus}
        size="sm"
        aria-disabled={value === 1}
        tooltip={false}
        onclick={() => {
          if (value !== 1) onChange(stepRepeat(value, -1))
        }}
      />
      <output class="value" aria-live="polite">{repeatText(value)}</output>
      <IconButton
        label={i18n.t('player.repeat.increase')}
        icon={Plus}
        size="sm"
        aria-disabled={value === 0}
        tooltip={false}
        onclick={() => {
          if (value !== 0) onChange(stepRepeat(value, 1))
        }}
      />
      <IconButton
        label={i18n.t('player.repeat.forever')}
        icon={InfinityIcon}
        size="sm"
        pressed={value === 0}
        onclick={() => onChange(value === 0 ? 1 : 0)}
      />
    </div>
  </div>
{/snippet}

<Popover
  bind:open
  {trigger}
  {side}
  {align}
  width={340}
  padding="none"
  {sideOffset}
  {anchor}
  label={i18n.t('player.repeat.title')}
>
  <div class="repeat" data-qd-popover="repeat">
    <!-- Not `header`: in a popover (portalled to the body) that would be a banner landmark. -->
    <div class="head">
      <h2>{i18n.t('player.repeat.title')}</h2>
      {#if status}<span class="status">{status}</span>{/if}
    </div>

    <section class="block">
      {@render stepper(i18n.t('player.repeat.ayah'), ayahRepeat, setAyahRepeat, `${uid}-ayah`)}
      {@render stepper(i18n.t('player.repeat.range'), rangeRepeat, setRangeRepeat, `${uid}-range`)}
    </section>

    <section class="block">
      <span class="label" id="{uid}-gap">{i18n.t('player.repeat.gap')}</span>
      <Segmented
        options={gapOptions}
        value={gap.type}
        onValueChange={setGapKind}
        label={i18n.t('player.repeat.gap')}
        size="sm"
        fullWidth
      />
      {#if gap.type !== 'none'}
        <div class="row gap-row">
          <span class="hint">
            {gap.type === 'fixed'
              ? i18n.t('player.repeat.gapFixedHint')
              : i18n.t('player.repeat.gapMultiplierHint')}
          </span>
          <div class="stepper" role="group" aria-labelledby="{uid}-gap">
            <IconButton
              label={i18n.t('player.repeat.decrease')}
              icon={Minus}
              size="sm"
              tooltip={false}
              disabled={gapAtMin}
              onclick={() => stepGap(-1)}
            />
            <output class="value" aria-live="polite">
              {gap.type === 'fixed'
                ? i18n.t('player.repeat.gapSeconds', { n: formatDecimal(gap.data.ms / 1000) })
                : i18n.t('player.repeat.gapTimes', { n: formatDecimal(gap.data.pct / 100) })}
            </output>
            <IconButton
              label={i18n.t('player.repeat.increase')}
              icon={Plus}
              size="sm"
              tooltip={false}
              disabled={gapAtMax}
              onclick={() => stepGap(1)}
            />
          </div>
        </div>
      {/if}
    </section>

    <section class="block">
      <label class="label" for="{uid}-range-input">{i18n.t('player.repeat.rangeLabel')}</label>
      <div class="range-row">
        <TextInput
          id="{uid}-range-input"
          bind:value={rangeText}
          size="sm"
          dir="ltr"
          inputmode="numeric"
          spellcheck={false}
          autocomplete="off"
          placeholder={i18n.t('player.repeat.rangePlaceholder')}
          invalid={rangeInvalid}
          aria-describedby="{uid}-range-hint"
          onblur={() => (rangeTouched = true)}
          onkeydown={onRangeKeydown}
        />
        <Button size="sm" variant="primary" disabled={parsedRange === null} onclick={playRange}>
          {i18n.t('player.repeat.playRange')}
        </Button>
      </div>
      <p class="hint" class:error={rangeInvalid} id="{uid}-range-hint">
        {rangeInvalid ? i18n.t('player.repeat.rangeInvalid') : i18n.t('player.repeat.rangeHint')}
      </p>
    </section>

    <section class="block presets">
      <div class="presets-head">
        <span class="label">{i18n.t('player.repeat.presets')}</span>
        <Button
          size="sm"
          variant="ghost"
          loading={saving}
          disabled={!parsedRange && !player.isActive}
          onclick={savePreset}
        >
          {i18n.t('player.repeat.savePreset')}
        </Button>
      </div>
      {#if presets.length > 0}
        <ul class="preset-list">
          {#each presets as p (p.id)}
            <li>
              <button type="button" class="preset" onclick={() => void applyPreset(p)}>
                <span class="preset-name">{p.name}</span>
                <span class="preset-meta">{presetSummary(p)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if !presetsFailed}
        <p class="hint">{i18n.t('player.repeat.presetNone')}</p>
      {/if}
    </section>
  </div>
</Popover>

<style>
  .repeat {
    display: flex;
    flex-direction: column;
    max-block-size: min(560px, 75vh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding-block: var(--space-3) var(--space-2);
    padding-inline: var(--space-4);
  }

  h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-title);
  }

  .status {
    color: var(--accent-text);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
    border-block-start: 1px solid var(--border);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-block-size: 32px;
  }

  .label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .hint.error {
    color: var(--danger);
  }

  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-0_5);
  }

  .value {
    min-inline-size: 44px;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .gap-row {
    min-block-size: 28px;
  }

  .range-row {
    display: flex;
    gap: var(--space-2);
  }

  .presets-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .preset-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-0_5);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .preset {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    inline-size: 100%;
    padding-block: var(--space-2);
    padding-inline: var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .preset:hover {
    background-color: var(--surface-hover);
  }

  .preset-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .preset-meta {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
