<!--
  PlayerMore: the dock's "More" panel.

  Stop-at (the default end of the next play), download this surah for the current reciter, the A-B loop (set A, set B,
  clear, like `L`), the volume with mute, the follow-along and word-highlight switches, and Stop. It is a popover
  panel rather than a menu because it holds a slider and switches; it is a floating layer like the menus.
-->
<script lang="ts">
  import Download from '@lucide/svelte/icons/download'
  import Square from '@lucide/svelte/icons/square'
  import Volume1 from '@lucide/svelte/icons/volume-1'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import VolumeX from '@lucide/svelte/icons/volume-x'
  import type { Snippet } from 'svelte'
  import { Button, IconButton, Kbd, Popover, Select, Slider, Switch } from '$components/ui'
  import type { Align, SelectItem, Side, TriggerProps } from '$components/ui/types'
  import type { StopAt } from '$lib/ipc/bindings'
  import { i18n, packs, player, quran, settings, ui } from '$lib/stores'
  import { isolatedClock } from '$lib/stores/player.svelte'
  import { keyHint } from './dock.svelte'

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
    align = 'end',
    sideOffset = 10,
    anchor = null,
    open = $bindable(false),
  }: Props = $props()

  const uid = $props.id()
  const STOP_AT: readonly StopAt[] = ['end_of_surah', 'end_of_page', 'end_of_juz', 'end_of_quran']

  const stopItems: SelectItem[] = $derived(
    STOP_AT.map((value) => ({ value, label: i18n.t(`player.more.stopAtOptions.${value}`) })),
  )

  // --- volume -----------------------------------------------------------------------------------------------------
  let volumeDraft = $state<number | null>(null)
  const volume = $derived(volumeDraft ?? (player.muted ? 0 : settings.value.volumePct))
  const VolumeIcon = $derived(volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2)

  // --- download ---------------------------------------------------------------------------------------------------
  const surah = $derived(player.heard?.surah ?? player.snapshot?.range?.from.surah ?? 0)
  const reciterId = $derived(player.snapshot?.reciterId ?? settings.value.reciterId)
  const packId = $derived(`audio.qdc.${reciterId}`)
  const pack = $derived(packs.pack(packId))
  const item = $derived(packs.items.get(packId)?.find((i) => i.item === surah))
  const downloaded = $derived(item?.pinned === true)
  const downloading = $derived(item?.queued === true)
  const surahName = $derived(surah > 0 ? quran.surahName(surah) : '')
  const downloadLabel = $derived.by(() => {
    if (surah === 0) return ''
    if (downloaded) return i18n.t('player.more.downloaded', { surah: surahName })
    if (downloading) return i18n.t('player.more.downloading', { surah: surahName })
    return pack
      ? i18n.t('player.more.downloadSize', { surah: surahName, size: i18n.bytes(packs.itemKib(pack, surah)) })
      : i18n.t('player.more.download', { surah: surahName })
  })

  $effect(() => {
    if (open && surah > 0 && !packs.items.has(packId)) void packs.loadItems(packId)
  })

  function download(): void {
    if (surah === 0) return
    packs.install(packId, { type: 'items', data: { items: [surah] } }).catch(ui.toastError)
  }

  // --- A-B --------------------------------------------------------------------------------------------------------
  const abLoop = $derived(player.snapshot?.abLoop ?? null)
  const abStatus = $derived.by(() => {
    const scale = player.snapshot?.fileDurationMs ?? 0
    if (abLoop) {
      return i18n.t('player.repeat.status.ab', {
        from: isolatedClock(abLoop.aMs, scale),
        to: isolatedClock(abLoop.bMs, scale),
      })
    }
    if (player.abPending !== null) {
      return i18n.t('player.more.abPendingA', { time: isolatedClock(player.abPending, scale) })
    }
    return i18n.t('player.more.abHint')
  })
  const abAction = $derived(
    abLoop
      ? i18n.t('player.more.abClear')
      : player.abPending === null
        ? i18n.t('player.more.abSetA')
        : i18n.t('player.more.abSetB'),
  )

  function stop(): void {
    open = false
    void player.stop()
  }
</script>

<Popover
  bind:open
  {trigger}
  {side}
  {align}
  width={320}
  padding="none"
  {sideOffset}
  {anchor}
  label={i18n.t('player.more.title')}
>
  <div class="more" data-qd-popover="more">
    <section class="block">
      <div class="row">
        <span class="label" id="{uid}-stop">{i18n.t('player.more.stopAt')}</span>
        <Select
          items={stopItems}
          value={settings.value.stopAt}
          onValueChange={(v) => void settings.update({ stopAt: v as StopAt })}
          aria-labelledby="{uid}-stop"
          size="sm"
        />
      </div>
    </section>

    <section class="block">
      <div class="row">
        <span class="label" id="{uid}-volume">{i18n.t('player.more.volume')}</span>
        <span class="pct">{i18n.num(volume)}%</span>
      </div>
      <div class="volume">
        <IconButton
          label={player.muted ? i18n.t('player.more.unmute') : i18n.t('player.more.mute')}
          icon={VolumeIcon}
          size="sm"
          pressed={player.muted}
          shortcut={keyHint('audio.mute')}
          onclick={() => void player.toggleMute()}
        />
        <Slider
          class="volume-slider"
          value={volume}
          min={0}
          max={100}
          step={1}
          labelledBy="{uid}-volume"
          format={(v) => `${i18n.num(v)}%`}
          onValueChange={(v) => (volumeDraft = v)}
          onValueCommit={(v) => {
            volumeDraft = null
            void player.setVolume(v)
          }}
        />
      </div>
    </section>

    <section class="block switches">
      <Switch
        label={i18n.t('player.more.followAlong')}
        description={i18n.t('player.more.followAlongHint')}
        checked={settings.value.followAlong}
        onCheckedChange={(on) => void settings.update({ followAlong: on })}
      />
      <Switch
        label={i18n.t('player.more.wordHighlight')}
        checked={settings.value.wordHighlight}
        onCheckedChange={(on) => void settings.update({ wordHighlight: on })}
      />
    </section>

    <section class="block">
      <div class="row">
        <span class="label">{i18n.t('player.more.ab')}</span>
        <span class="kbd"><Kbd chord={keyHint('audio.abLoop') ?? 'L'} size="sm" /></span>
      </div>
      <div class="row">
        <span class="hint">{abStatus}</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={!player.isActive}
          onclick={() => void player.abMark()}
        >
          {abAction}
        </Button>
      </div>
    </section>

    {#if surah > 0}
      <section class="block actions">
        <Button
          size="sm"
          variant="ghost"
          fullWidth
          disabled={downloaded || downloading}
          loading={downloading}
          onclick={download}
        >
          {#snippet icon()}<Download size={16} strokeWidth={1.75} aria-hidden="true" />{/snippet}
          {downloadLabel}
        </Button>
        {#if player.isActive}
          <Button size="sm" variant="ghost" fullWidth onclick={stop}>
            {#snippet icon()}<Square
                size={14}
                strokeWidth={1.75}
                fill="currentColor"
                aria-hidden="true"
              />{/snippet}
            {i18n.t('player.more.stop')}
          </Button>
        {/if}
      </section>
    {/if}
  </div>
</Popover>

<style>
  .more {
    display: flex;
    flex-direction: column;
    max-block-size: min(560px, 75vh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
  }

  .block + .block {
    border-block-start: 1px solid var(--border);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-block-size: 28px;
  }

  .label {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .hint {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .pct {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .volume {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .volume :global(.volume-slider) {
    flex: 1 1 auto;
  }

  .switches {
    gap: var(--space-3);
  }

  .actions {
    gap: var(--space-1);
    padding-block: var(--space-2);
    padding-inline: var(--space-2);
  }

  .actions :global(button) {
    justify-content: flex-start;
  }
</style>
