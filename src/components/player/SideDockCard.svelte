<!--
  SideDockCard (§9.7): the 272×120 recitation card beside the pages when `reader.dock === 'side'` (D28). Owner: WP9a.
  The shell anchors it at the bottom inline-end of the canvas; it takes no props and reads stores (§7.9).

  Rows: the reciter (monogram, name, where; opens the picker) with More; the mini scrubber between the elapsed and
  total times; the transport with Repeat (live badge) and Speed. Idle, the lower rows become the play offer (resume
  candidate, else the selection or the page); a failure shows the §9.8 copy there. Same surfaces as the bar.
-->
<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Play from '@lucide/svelte/icons/play'
  import Repeat from '@lucide/svelte/icons/repeat'
  import X from '@lucide/svelte/icons/x'
  import { mergeProps } from 'bits-ui'
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { IconButton, Tooltip } from '$components/ui'
  import { i18n, player, settings } from '$lib/stores'
  import { formatClock, formatSpeed } from '$lib/stores/player.svelte'
  import { registerAudioShortcuts } from '$lib/shortcuts/audio'
  import AyahScrubber from './AyahScrubber.svelte'
  import DockError from './DockError.svelte'
  import {
    idleOffer,
    closeOnLeave,
    keyHint,
    monogram,
    nowLabel,
    playIdleOffer,
    reciterName,
    repeatBadge,
  } from './dock.svelte'
  import PlayerMore from './PlayerMore.svelte'
  import ReciterPicker from './ReciterPicker.svelte'
  import RepeatPopover from './RepeatPopover.svelte'
  import SpeedPopover from './SpeedPopover.svelte'
  import Transport from './Transport.svelte'

  onMount(() => registerAudioShortcuts())

  let card: HTMLDivElement | null = $state(null)
  let reciterOpen = $state(false)
  let repeatOpen = $state(false)
  let speedOpen = $state(false)
  let moreOpen = $state(false)
  // More, Repeat and Speed live in the active rows: they reset when those rows leave (`closeOnLeave`).
  const closeMore = closeOnLeave(() => (moreOpen = false))
  const closeControls = closeOnLeave(() => {
    repeatOpen = false
    speedOpen = false
  })

  const error = $derived(player.error)
  const mode = $derived(error && !player.isActive ? 'error' : !player.isActive ? 'idle' : 'active')
  const reciter = $derived(player.reciter)
  const offer = $derived(mode === 'idle' ? idleOffer() : null)
  const badge = $derived(repeatBadge())
  const repeatOn = $derived(
    player.snapshot !== null &&
      (player.snapshot.abLoop !== null ||
        player.snapshot.ayahRepeat !== 1 ||
        player.snapshot.rangeRepeat !== 1),
  )
  const where = $derived(mode === 'active' ? nowLabel() : (offer?.label ?? ''))
  const playKey = $derived(keyHint('audio.playPause'))
  const fadeIn = $derived({
    duration: settings.reducedMotion ? 0 : 160,
    delay: settings.reducedMotion ? 0 : 60,
  })

  const surah = $derived(player.heard?.surah ?? player.snapshot?.range?.from.surah ?? 0)
  const basmala = $derived(player.heard?.ayah === 0)
  const timings = $derived(
    surah > 0 ? player.timingsFor(player.snapshot?.reciterId ?? settings.value.reciterId, surah) : null,
  )
  const durationMs = $derived(
    timings?.durationMs ?? (basmala ? 0 : Math.max(0, player.snapshot?.fileDurationMs ?? 0)),
  )
  /** Whole seconds: the position moves every frame, the elapsed time once a second. */
  const second = $derived(basmala ? 0 : Math.floor(Math.max(0, player.positionMs) / 1000))
  const elapsed = $derived(formatClock(second * 1000, durationMs))
  const total = $derived(formatClock(durationMs, durationMs))
</script>

<div
  class={['card', `m-${mode}`]}
  data-dock="side"
  data-mode={mode}
  data-qd-dock
  data-qd-dock-pill
  bind:this={card}
>
  <div class="head">
    <ReciterPicker bind:open={reciterOpen} side="top" align="end" sideOffset={8} anchor={card}>
      {#snippet trigger({ props })}
        <button
          {...props}
          type="button"
          class="reciter"
          aria-label={`${i18n.t('player.reciter.change')}: ${reciterName(reciter)}`}
        >
          <span class="mono" lang={i18n.locale} aria-hidden="true">{monogram(reciter, i18n.locale)}</span>
          <span class="who" aria-hidden="true">
            <span class="name">{reciterName(reciter)}</span>
            {#if mode === 'active'}<span class="where">{where}</span>{/if}
          </span>
        </button>
      {/snippet}
    </ReciterPicker>
    {#if mode === 'active'}
      <span class="more" {@attach closeMore}>
        <PlayerMore bind:open={moreOpen} side="top" align="end" sideOffset={8} anchor={card}>
          {#snippet trigger({ props })}
            <IconButton {...props} label={i18n.t('player.more.button')} icon={Ellipsis} size="sm" />
          {/snippet}
        </PlayerMore>
      </span>
    {/if}
  </div>

  {#if mode === 'idle'}
    <div class="idle" in:fade={fadeIn}>
      <button
        type="button"
        class="idle-play"
        aria-label={offer
          ? i18n.t('player.idle.hint', { action: offer.label, key: playKey ?? 'Space' })
          : i18n.t('common.play')}
        onclick={playIdleOffer}
      >
        <span class="disc" aria-hidden="true">
          <Play size={18} strokeWidth={1.75} fill="currentColor" class="glyph" />
        </span>
        <span class="idle-title">{offer?.label ?? i18n.t('common.play')}</span>
      </button>
      {#if offer?.kind === 'resume'}
        <IconButton
          label={i18n.t('player.idle.dismissResume')}
          icon={X}
          size="sm"
          onclick={() => player.dismissResume()}
        />
      {/if}
    </div>
  {:else if mode === 'error' && error}
    <div class="error" in:fade={fadeIn}>
      <DockError {error} layout="card" />
    </div>
  {:else}
    <div class="scrub" in:fade={fadeIn}>
      <span class="time" aria-hidden="true">{elapsed}</span>
      <AyahScrubber variant="card" labels={false} />
      <span class="time" aria-hidden="true">{total}</span>
    </div>
    <div class="controls" in:fade={fadeIn} {@attach closeControls}>
      <Transport size="card" />
      <div class="actions">
        <RepeatPopover bind:open={repeatOpen} side="top" align="end" sideOffset={8} anchor={card}>
          {#snippet trigger({ props })}
            <Tooltip content={badge?.status ?? i18n.t('player.repeat.button')} kbd={keyHint('audio.repeat')}>
              {#snippet children({ props: tip })}
                <button
                  {...mergeProps(props, tip)}
                  type="button"
                  class="action repeat"
                  class:on={repeatOn}
                  aria-label={badge
                    ? `${i18n.t('player.repeat.button')}: ${badge.status}`
                    : i18n.t('player.repeat.button')}
                >
                  <Repeat size={16} strokeWidth={1.75} aria-hidden="true" />
                  {#if badge}<span class="badge" aria-hidden="true">{badge.text}</span>{/if}
                </button>
              {/snippet}
            </Tooltip>
          {/snippet}
        </RepeatPopover>
        <SpeedPopover bind:open={speedOpen} side="top" align="end" sideOffset={8} anchor={card}>
          {#snippet trigger({ props })}
            <Tooltip content={i18n.t('player.speed.button')} kbd={keyHint('audio.faster')}>
              {#snippet children({ props: tip })}
                <button
                  {...mergeProps(props, tip)}
                  type="button"
                  class="action speed"
                  class:on={player.speedPct !== 100}
                  aria-label={`${i18n.t('player.speed.button')}: ${formatSpeed(player.speedPct)}`}
                >
                  <bdi dir="ltr">{formatSpeed(player.speedPct)}</bdi>
                </button>
              {/snippet}
            </Tooltip>
          {/snippet}
        </SpeedPopover>
      </div>
    </div>
  {/if}
</div>

<style>
  .card {
    box-sizing: border-box;
    display: grid;
    grid-template-rows: 36px 16px 36px;
    row-gap: var(--space-1);
    inline-size: 272px;
    block-size: 120px;
    padding-block: var(--space-3);
    padding-inline: var(--space-3) var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-3);
    color: var(--text);
  }

  .m-idle,
  .m-error {
    grid-template-rows: 36px 1fr;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-inline-size: 0;
  }

  /* Only there to scope More's open state to the active card (`closeOnLeave`): no box of its own. */
  .more {
    display: contents;
  }

  .reciter {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 10px;
    min-inline-size: 0;
    padding: 0;
    padding-inline-end: var(--space-1);
    border: none;
    border-radius: var(--radius-md);
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .reciter:hover .mono {
    background-color: color-mix(in srgb, var(--accent) 20%, transparent);
  }

  .reciter:hover .name {
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 3px;
  }

  .mono {
    display: grid;
    place-items: center;
    flex: none;
    inline-size: 36px;
    block-size: 36px;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
    letter-spacing: 0.02em;
    line-height: 1;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .mono:lang(ar) {
    font-family: var(--font-naskh);
    font-size: 19px;
    letter-spacing: 0;
  }

  .who {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    line-height: 1.3;
  }

  .name,
  .where {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .where {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .scrub {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2);
    padding-inline-end: var(--space-1);
    direction: ltr; /* physical-ok: elapsed · scrubber · total never mirror (§11.3) */
  }

  .time {
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-inline-start: -4px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-0_5);
  }

  .action {
    position: relative;
    display: inline-grid;
    place-items: center;
    min-inline-size: 28px;
    block-size: 28px;
    padding-inline: var(--space-1);
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .action:hover,
  .action[aria-expanded='true'] {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .action.on {
    color: var(--accent-text);
  }

  .speed {
    min-inline-size: 40px;
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
  }

  .badge {
    position: absolute;
    inset-block-start: -4px;
    inset-inline-end: -6px;
    display: grid;
    place-items: center;
    min-inline-size: 16px;
    block-size: 15px;
    padding-inline: 4px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    box-shadow: 0 0 0 2px var(--surface-raised);
    color: var(--accent-ink);
    font-size: 10px;
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }

  .idle {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-inline-size: 0;
  }

  .idle-play {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--space-3);
    min-inline-size: 0;
    padding: 0;
    border: none;
    border-radius: 21px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .idle-play:hover .disc {
    background-color: color-mix(in srgb, var(--accent) 90%, var(--text));
  }

  .disc {
    display: grid;
    place-items: center;
    flex: none;
    inline-size: 40px;
    block-size: 40px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--accent) 35%, transparent);
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .disc :global(.glyph) {
    translate: 1px 0; /* physical-ok: the play triangle's optical centre */
  }

  .idle-title {
    display: -webkit-box;
    overflow: hidden;
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    line-height: 1.35;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  /* A clamp has to clip both axes: give Arabic ink (≈ 1.5 em with its dots and marks) a line box it fits in. */
  .idle-title:lang(ar) {
    line-height: 1.6;
  }

  .error {
    min-block-size: 0;
    margin-inline: calc(-1 * var(--space-3)) calc(-1 * var(--space-2));
  }

  @media (forced-colors: active) {
    .card {
      border-color: CanvasText;
    }

    .disc,
    .badge {
      forced-color-adjust: none;
      background-color: Highlight;
      color: HighlightText;
    }
  }
</style>
