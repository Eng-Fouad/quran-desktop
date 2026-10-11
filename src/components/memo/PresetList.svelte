<!--
  PresetList: the loop presets of the Memorize panel (BRIEF §1.1.8 "range repeat presets"). Owner: WP9b.

  - Each preset is a card: Play (its reciter, speed, range, repeats and pause, `memo.applyPreset`), its name, a meta line
    ("67:1–30 · each ayah ×3 · pause ×1 · 1.25×") and a menu (Edit, Delete with an undo toast).
  - "New preset" opens the editor for the range being practised (`target`), with the repeat and pause settings as
    defaults and the name "Al-Mulk 67:1–30 ×3". The editor sets the name, each ayah ×N (1–99, ∞), the whole range ×N
    and the pause after each ayah (none, ×½, ×1, ×2 of the ayah's length; in UI digits, so ×١/٢, ×١, ×٢ with Eastern
    Arabic numbers). Presets are shared with the dock's repeat popover (`loop_preset_*`).
-->
<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Minus from '@lucide/svelte/icons/minus'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Play from '@lucide/svelte/icons/play'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash from '@lucide/svelte/icons/trash'
  import { Button, IconButton, Menu, Segmented, TextInput } from '$components/ui'
  import type { GapSetting, LoopPreset, LoopPresetInput } from '$lib/ipc/bindings'
  import type { AyahSpan } from '$lib/stores/memo.svelte'
  import { i18n, memo, player, quran, settings, ui } from '$lib/stores'

  interface Props {
    /** The range being practised: what a new preset loops. */
    target: AyahSpan | null
  }

  let { target }: Props = $props()

  /** Repeat steppers: 1–99, then ∞ (0). */
  const REPEAT_MAX = 99
  type GapChoice = 'none' | 'half' | 'one' | 'two'
  const GAP_PCT: Record<Exclude<GapChoice, 'none'>, number> = { half: 50, one: 100, two: 200 }

  interface Draft {
    id: number | null
    name: string
    from: number
    to: number
    ayahRepeat: number
    rangeRepeat: number
    gap: GapChoice
    speedPct: number
    reciterId: number | null
  }

  let draft = $state<Draft | null>(null)
  let saving = $state(false)
  let nameInput: HTMLInputElement | null = $state(null)

  $effect(() => {
    void memo.loadPresets()
  })

  $effect(() => {
    if (draft && nameInput) {
      nameInput.focus()
      nameInput.select()
    }
  })

  function repeatText(n: number): string {
    return n === 0 ? i18n.t('memo.panel.presets.forever') : i18n.t('memo.panel.presets.times', { n })
  }

  function gapChoice(gap: GapSetting): GapChoice {
    if (gap.type !== 'multiplier') return 'none'
    const pct = gap.data.pct
    return pct <= 75 ? 'half' : pct <= 150 ? 'one' : 'two'
  }

  function gapOf(choice: GapChoice): GapSetting {
    return choice === 'none' ? { type: 'none' } : { type: 'multiplier', data: { pct: GAP_PCT[choice] } }
  }

  function gapText(gap: GapSetting): string {
    switch (gap.type) {
      case 'none':
        return ''
      case 'multiplier':
        return gap.data.pct === 50
          ? i18n.t('memo.panel.presets.gapHalf', { half: i18n.fraction(1, 2) })
          : i18n.t('memo.panel.presets.times', { n: i18n.num(gap.data.pct / 100) })
      case 'fixed':
        return i18n.duration(gap.data.ms)
    }
  }

  function rangeText(from: number, to: number): string {
    return quran.refLabel(from, 'short', to)
  }

  function metaOf(p: LoopPreset): string {
    const parts = [rangeText(p.fromAyahId, p.toAyahId)]
    if (p.ayahRepeat !== 1)
      parts.push(i18n.t('memo.panel.presets.eachAyah', { repeat: repeatText(p.ayahRepeat) }))
    if (p.rangeRepeat !== 1)
      parts.push(i18n.t('memo.panel.presets.wholeRange', { repeat: repeatText(p.rangeRepeat) }))
    const gap = gapText(p.gap)
    if (gap) parts.push(i18n.t('memo.panel.presets.pause', { gap }))
    if (p.speedPct !== 100) parts.push(`${i18n.num(p.speedPct / 100)}×`)
    return parts.join(' · ')
  }

  function startNew(): void {
    if (!target) return
    const s = settings.value
    const ayahRepeat = s.ayahRepeat === 1 ? 3 : s.ayahRepeat
    draft = {
      id: null,
      name: i18n.t('memo.panel.presets.defaultName', {
        range: quran.refLabel(target.from, 'long', target.to),
        repeat: repeatText(ayahRepeat),
      }),
      from: target.from,
      to: target.to,
      ayahRepeat,
      rangeRepeat: s.rangeRepeat,
      gap: gapChoice(s.gap),
      speedPct: s.speedPct,
      reciterId: s.reciterId,
    }
  }

  function edit(p: LoopPreset): void {
    draft = {
      id: p.id,
      name: p.name,
      from: p.fromAyahId,
      to: p.toAyahId,
      ayahRepeat: p.ayahRepeat,
      rangeRepeat: p.rangeRepeat,
      gap: gapChoice(p.gap),
      speedPct: p.speedPct,
      reciterId: p.reciterId,
    }
  }

  function step(value: number, delta: 1 | -1): number {
    if (value === 0) return delta < 0 ? REPEAT_MAX : 0
    const next = value + delta
    if (next > REPEAT_MAX) return 0
    return Math.max(1, next)
  }

  async function save(e?: SubmitEvent): Promise<void> {
    e?.preventDefault()
    const d = draft
    if (!d || saving || d.name.trim() === '') return
    saving = true
    const input: LoopPresetInput = {
      id: d.id,
      name: d.name.trim(),
      reciterId: d.reciterId,
      fromAyahId: d.from,
      toAyahId: d.to,
      ayahRepeat: d.ayahRepeat,
      rangeRepeat: d.rangeRepeat,
      gap: gapOf(d.gap),
      speedPct: d.speedPct,
    }
    const saved = await memo.savePreset(input)
    saving = false
    if (saved) {
      draft = null
      ui.toast({ message: i18n.t('memo.toast.presetSaved', { name: saved.name }), tone: 'success' })
    }
  }

  /** Escape anywhere in the editor cancels it (before the app's Escape, which would clear the selection). */
  function escapeCancels(node: HTMLElement) {
    const onkeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      draft = null
    }
    node.addEventListener('keydown', onkeydown)
    return { destroy: () => node.removeEventListener('keydown', onkeydown) }
  }

  const gapOptions = $derived([
    { value: 'none', label: i18n.t('memo.panel.presets.gapNone') },
    { value: 'half', label: i18n.t('memo.panel.presets.gapHalf', { half: i18n.fraction(1, 2) }) },
    { value: 'one', label: i18n.t('memo.panel.presets.times', { n: i18n.num(1) }) },
    { value: 'two', label: i18n.t('memo.panel.presets.times', { n: i18n.num(2) }) },
  ])

  const playingId = $derived.by(() => {
    if (!player.isActive) return null
    const range = player.snapshot?.range
    if (!range) return null
    const from = quran.ayahId(range.from.surah, range.from.ayah)
    const to = quran.ayahId(range.to.surah, range.to.ayah)
    return memo.presets.find((p) => p.fromAyahId === from && p.toAyahId === to)?.id ?? null
  })
</script>

{#snippet stepper(label: string, value: number, set: (n: number) => void, id: string)}
  <div class="row">
    <span class="row-label" {id}>{label}</span>
    <div class="stepper" role="group" aria-labelledby={id}>
      <IconButton
        label={i18n.t('memo.panel.presets.less')}
        icon={Minus}
        size="sm"
        variant="secondary"
        tooltip={false}
        onclick={() => set(step(value, -1))}
      />
      <output class="value" aria-live="polite">{repeatText(value)}</output>
      <IconButton
        label={i18n.t('memo.panel.presets.more')}
        icon={Plus}
        size="sm"
        variant="secondary"
        tooltip={false}
        onclick={() => set(step(value, 1))}
      />
    </div>
  </div>
{/snippet}

{#snippet editor(d: Draft)}
  <form class="editor" onsubmit={save} use:escapeCancels data-qd-preset-editor="">
    <label class="field">
      <span class="row-label">{i18n.t('memo.panel.presets.name')}</span>
      <TextInput bind:ref={nameInput} bind:value={d.name} size="sm" maxlength={100} required />
    </label>
    <div class="row">
      <span class="row-label">{i18n.t('memo.panel.presets.range')}</span>
      <span class="range">{quran.refLabel(d.from, 'long', d.to)}</span>
    </div>
    {@render stepper(
      i18n.t('memo.panel.presets.ayahRepeat'),
      d.ayahRepeat,
      (n) => (d.ayahRepeat = n),
      'pr-ayah',
    )}
    {@render stepper(
      i18n.t('memo.panel.presets.rangeRepeat'),
      d.rangeRepeat,
      (n) => (d.rangeRepeat = n),
      'pr-range',
    )}
    <div class="field">
      <span class="row-label" title={i18n.t('memo.panel.presets.gapHint')}
        >{i18n.t('memo.panel.presets.gap')}</span
      >
      <Segmented
        label={i18n.t('memo.panel.presets.gap')}
        size="sm"
        fullWidth
        options={gapOptions}
        value={d.gap}
        onValueChange={(v) => (d.gap = v === 'half' || v === 'one' || v === 'two' ? v : 'none')}
      />
    </div>
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={() => (draft = null)}>{i18n.t('common.cancel')}</Button>
      <Button size="sm" variant="primary" type="submit" loading={saving} disabled={d.name.trim() === ''}>
        {i18n.t('memo.panel.presets.save')}
      </Button>
    </div>
  </form>
{/snippet}

<div class="presets">
  {#if memo.presets.length > 0}
    <ul class="list">
      {#each memo.presets as p (p.id)}
        <li class={['item', { playing: p.id === playingId }]} data-preset={p.id}>
          {#if draft && draft.id === p.id}
            {@render editor(draft)}
          {:else}
            <button
              type="button"
              class="play"
              aria-label={i18n.t('memo.panel.presets.play', { name: p.name })}
              title={i18n.t('memo.panel.presets.play', { name: p.name })}
              onclick={() => void memo.applyPreset(p)}
            >
              <Play size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="button" class="text" onclick={() => void memo.applyPreset(p)} tabindex={-1}>
              <bdi class="name">{p.name}</bdi>
              <span class="meta" title={metaOf(p)}>{metaOf(p)}</span>
            </button>
            <Menu
              label={i18n.t('memo.panel.presets.actions', { name: p.name })}
              align="end"
              items={[
                {
                  id: 'edit',
                  label: i18n.t('common.edit'),
                  icon: Pencil,
                  onSelect: () => edit(p),
                },
                {
                  id: 'delete',
                  label: i18n.t('common.delete'),
                  icon: Trash,
                  danger: true,
                  onSelect: () => void memo.deletePreset(p.id),
                },
              ]}
            >
              {#snippet trigger({ props })}
                <IconButton
                  {...props}
                  label={i18n.t('memo.panel.presets.actions', { name: p.name })}
                  icon={Ellipsis}
                  size="sm"
                  tooltip={false}
                  class="more"
                />
              {/snippet}
            </Menu>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if !draft}
    <p class="empty">{i18n.t('memo.panel.presets.empty')}</p>
  {/if}

  {#if draft && draft.id === null}
    <div class="item new">{@render editor(draft)}</div>
  {:else if !draft}
    <Button size="sm" variant="secondary" disabled={!target} onclick={startNew} class="new-preset">
      {#snippet icon()}<Plus size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
      {i18n.t('memo.panel.presets.new')}
    </Button>
  {/if}
</div>

<style>
  .presets {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2);
    padding: 6px;
    padding-inline-start: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
  }

  .item.playing {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  }

  .item:has(.editor) {
    display: block;
    padding: var(--space-3);
  }

  .play {
    display: grid;
    place-items: center;
    inline-size: 30px;
    block-size: 30px;
    padding: 0;
    border: none;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    cursor: pointer;
  }

  /* The play triangle points right in both UI directions (transport icons never mirror, §11.3): optical centring. */
  .play :global(svg) {
    translate: 1px 0;
  }

  .play:hover {
    background-color: var(--accent);
    color: var(--accent-ink);
  }

  .play:focus-visible,
  .text:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
    unicode-bidi: plaintext;
  }

  .meta {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  .presets :global(.new-preset) {
    align-self: flex-start;
  }

  /* --- editor ----------------------------------------------------------------------------------------------------- */

  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .row-label {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
  }

  .range {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stepper {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  .value {
    min-inline-size: 36px;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    font-weight: var(--weight-label);
    text-align: center;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
