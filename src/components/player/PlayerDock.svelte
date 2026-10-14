<!--
  PlayerDock: the recitation dock as a floating pill at the bottom of the canvas (`reader.dock` is `bar`, 64 px, or
  `compact`, 56 px). The shell positions it (centred, 10 px above the canvas edge); it takes no props and reads stores.

  Modes (one pill that morphs between them, so nothing jumps):
  - **idle** (nothing loaded): a 380 px pill "▶ Resume Al-Kahf · 18:45 / Mishary Alafasy" when a resume candidate
    exists (with × to forget it), else "▶ Play Al-Fatihah from 1:1" for the selection or the visible page; the
    monogram opens the reciter picker. Nothing ever plays by itself.
  - **bar**: `[reciter 208] [transport 132] [scrubber 1fr] [readout 104] [actions]`, gap 12, padding 0 14. Under
    720 px the reciter cell is the monogram alone and the readout one line; under 600 px the scrubber drops its labels.
    Actions: Repeat (live "2/3", "∞" or "A-B" badge), Speed ("1.25×"), More, and the collapse chevron.
  - **collapsed**: a small pill (play/pause, where, expand), remembered per viewer.
  - **error**: offline and not downloaded (with "Download when online"), no audio output (reconnecting), or any
    other failure (Retry); each can be dismissed.

  The audio shortcuts are registered while a dock is mounted (`registerAudioShortcuts`).

  The morph never shifts the layout (CLS 0, playback start included, even when it starts without input: the
  follow-along, a media key). The dock's box is the canvas width and the bar's height, and never changes with the mode
  (`pointer-events: none`). The visible pill (`.shell`, `[data-qd-dock-pill]`) is anchored at the box's inline-start
  corner and centred by `translate`, so its size can animate while its starting point stays put (layout-shift entries
  follow a box's inline-start corner and ignore transforms). Each mode's content (`.pane`) is laid out once at its final
  size and position and revealed by the pill as it grows (`clip-path`). The pill's width, height and radius are
  registered custom properties (`--qd-dock-w/h/r`) that transition, so the pill and the reveal move as one.
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Pause from '@lucide/svelte/icons/pause'
  import Play from '@lucide/svelte/icons/play'
  import Repeat from '@lucide/svelte/icons/repeat'
  import X from '@lucide/svelte/icons/x'
  import { mergeProps } from 'bits-ui'
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { IconButton, Tooltip } from '$components/ui'
  import { i18n, player, reader, settings } from '$lib/stores'
  import { formatSpeed } from '$lib/stores/player.svelte'
  import { registerAudioShortcuts } from '$lib/shortcuts/audio'
  import AyahScrubber from './AyahScrubber.svelte'
  import DockError from './DockError.svelte'
  import {
    dock,
    idleOffer,
    keyHint,
    monogram,
    closeOnLeave,
    nowLabel,
    playIdleOffer,
    reciterName,
    repeatBadge,
  } from './dock.svelte'
  import PlayerMore from './PlayerMore.svelte'
  import ReciterPicker from './ReciterPicker.svelte'
  import RepeatPopover from './RepeatPopover.svelte'
  import SpeedPopover from './SpeedPopover.svelte'
  import TimeReadout from './TimeReadout.svelte'
  import Transport from './Transport.svelte'

  onMount(() => registerAudioShortcuts())

  /** The dock region's width (the box is as wide as the canvas). */
  let regionWidth = $state(0)
  /** The bar's width, as the CSS computes it (`--_bar-w`): `clamp(min(560px, 100% − 24px), 70 %, 880px)`. */
  const width = $derived(
    regionWidth > 0 ? Math.max(Math.min(560, regionWidth - 24), Math.min(regionWidth * 0.7, 880)) : 0,
  )
  // The popovers of the idle pane and of the bar pane: each pane resets its own when it leaves (`closeOnLeave`).
  let idleReciterOpen = $state(false)
  let reciterOpen = $state(false)
  let repeatOpen = $state(false)
  let speedOpen = $state(false)
  let moreOpen = $state(false)
  const closeIdle = closeOnLeave(() => (idleReciterOpen = false))
  const closeBar = closeOnLeave(() => {
    reciterOpen = false
    repeatOpen = false
    speedOpen = false
    moreOpen = false
  })

  const error = $derived(player.error)
  const mode = $derived(
    error && !player.isActive ? 'error' : !player.isActive ? 'idle' : dock.collapsed ? 'collapsed' : 'bar',
  )
  const narrow = $derived(width > 0 && width < 720)
  const tight = $derived(width > 0 && width < 600)
  const reciter = $derived(player.reciter)
  const offer = $derived(mode === 'idle' ? idleOffer() : null)
  const badge = $derived(repeatBadge())
  const repeatOn = $derived(
    player.snapshot !== null &&
      (player.snapshot.abLoop !== null ||
        player.snapshot.ayahRepeat !== 1 ||
        player.snapshot.rangeRepeat !== 1),
  )
  const where = $derived(nowLabel())
  const fadeIn = $derived({
    duration: settings.reducedMotion ? 0 : 160,
    delay: settings.reducedMotion ? 0 : 60,
  })
  const playKey = $derived(keyHint('audio.playPause'))
  /** The collapsed pill's 36 px ayah progress, in whole pixels (it changes a few times a second, not every frame). */
  const MINI_PX = 36
  const miniFill = $derived(Math.round(player.ayahProgress * MINI_PX))
  // The collapsed pill shows the ayah's progress: the position is wanted once per pixel of it.
  $effect(() => {
    const span = player.ayahSpan
    if (mode !== 'collapsed' || !player.isActive || !span || span.toMs <= span.fromMs) return
    return player.needPosition((span.toMs - span.fromMs) / MINI_PX)
  })
  /** Popovers open 8 px above the dock's edge, whatever the height of their trigger inside it. */
  const dockHeight = $derived(reader.dock === 'compact' ? 56 : 64)
  const clear = (triggerHeight: number, height = dockHeight) => (height - triggerHeight) / 2 + 8
</script>

<div
  class={['dock', `m-${mode}`, { narrow, tight }]}
  data-dock={reader.dock}
  data-mode={mode}
  data-qd-dock
  bind:clientWidth={regionWidth}
>
  <div class="frame">
    <div class="shell" data-qd-dock-pill aria-hidden="true"></div>
    {#if mode === 'idle'}
      <div class="pane idle" in:fade={fadeIn} {@attach closeIdle}>
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
          <span class="idle-text">
            <span class="idle-title">{offer?.label ?? i18n.t('common.play')}</span>
            <span class="idle-sub">{reciterName(reciter)}</span>
          </span>
        </button>
        {#if offer?.kind === 'resume'}
          <IconButton
            label={i18n.t('player.idle.dismissResume')}
            icon={X}
            size="sm"
            onclick={() => player.dismissResume()}
          />
        {/if}
        <ReciterPicker bind:open={idleReciterOpen} side="top" align="end" sideOffset={clear(40, 52)}>
          {#snippet trigger({ props })}
            <Tooltip content={i18n.t('player.reciter.current', { name: reciterName(reciter) })}>
              {#snippet children({ props: tip })}
                <button
                  {...mergeProps(props, tip)}
                  type="button"
                  class="mono-button"
                  aria-label={i18n.t('player.reciter.change')}
                >
                  <span class="mono" lang={i18n.locale}>{monogram(reciter, i18n.locale)}</span>
                </button>
              {/snippet}
            </Tooltip>
          {/snippet}
        </ReciterPicker>
      </div>
    {:else if mode === 'error' && error}
      <div class="pane error-wrap" in:fade={fadeIn}>
        <DockError {error} />
      </div>
    {:else if mode === 'collapsed'}
      <div class="pane mini" in:fade={fadeIn}>
        <button
          type="button"
          class="mini-play"
          aria-label={player.wantsPlay ? i18n.t('player.transport.pause') : i18n.t('player.transport.play')}
          onclick={() => void player.toggle()}
        >
          {#if player.wantsPlay}
            <Pause size={16} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
          {:else}
            <Play size={16} strokeWidth={1.75} fill="currentColor" class="glyph" aria-hidden="true" />
          {/if}
        </button>
        <span class="mini-where">{where}</span>
        <span class="mini-progress" aria-hidden="true">
          <span class="mini-fill" style:inline-size="{miniFill}px"></span>
        </span>
        <IconButton
          label={i18n.t('player.expand')}
          icon={ChevronUp}
          size="sm"
          onclick={() => dock.setCollapsed(false)}
        />
      </div>
    {:else}
      <div class="pane bar" in:fade={fadeIn} {@attach closeBar}>
        <ReciterPicker bind:open={reciterOpen} side="top" align="start" sideOffset={clear(44)}>
          {#snippet trigger({ props })}
            <Tooltip content={i18n.t('player.reciter.change')} disabled={!narrow}>
              {#snippet children({ props: tip })}
                <button
                  {...mergeProps(props, tip)}
                  type="button"
                  class="reciter"
                  aria-label={`${i18n.t('player.reciter.change')}: ${reciterName(reciter)}`}
                >
                  <span class="mono" lang={i18n.locale} aria-hidden="true"
                    >{monogram(reciter, i18n.locale)}</span
                  >
                  {#if !narrow}
                    <span class="who" aria-hidden="true">
                      <span class="name">{reciterName(reciter)}</span>
                      <span class="where">{where}</span>
                    </span>
                  {/if}
                </button>
              {/snippet}
            </Tooltip>
          {/snippet}
        </ReciterPicker>

        <Transport size={tight ? 'card' : 'bar'} />

        <AyahScrubber labels={!tight} />

        <TimeReadout oneLine={narrow} />

        <div class="actions">
          <RepeatPopover bind:open={repeatOpen} side="top" align="center" sideOffset={clear(32)}>
            {#snippet trigger({ props })}
              <Tooltip
                content={badge?.status ?? i18n.t('player.repeat.button')}
                kbd={keyHint('audio.repeat')}
              >
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
                    <Repeat size={18} strokeWidth={1.75} aria-hidden="true" />
                    {#if badge}<span class="badge" aria-hidden="true">{badge.text}</span>{/if}
                  </button>
                {/snippet}
              </Tooltip>
            {/snippet}
          </RepeatPopover>

          <SpeedPopover bind:open={speedOpen} side="top" align="center" sideOffset={clear(32)}>
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

          <PlayerMore bind:open={moreOpen} side="top" align="end" sideOffset={clear(32)}>
            {#snippet trigger({ props })}
              <IconButton {...props} label={i18n.t('player.more.button')} icon={Ellipsis} />
            {/snippet}
          </PlayerMore>

          <IconButton
            label={i18n.t('player.collapse')}
            icon={ChevronDown}
            onclick={() => dock.setCollapsed(true)}
          />
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* The pill's size and radius: registered, so a mode change transitions them (and everything derived from them). */
  @property --qd-dock-w {
    syntax: '<length>';
    inherits: true;
    initial-value: 0px;
  }

  @property --qd-dock-h {
    syntax: '<length>';
    inherits: true;
    initial-value: 0px;
  }

  @property --qd-dock-r {
    syntax: '<length>';
    inherits: true;
    initial-value: 0px;
  }

  /* The box: the canvas width and the bar's height, whatever the mode (see the header). Clicks pass through it. */
  .dock[data-qd-dock] {
    --_h: 64px;
    /* Each mode's width (`cqi`: the box's width, i.e. the canvas's). */
    --_bar-w: clamp(min(560px, 100cqi - 24px), 70cqi, 880px);
    --_idle-w: min(380px, 100cqi - 24px);
    --_error-w: min(640px, 100cqi - 24px);
    --_mini-w: min(280px, 100cqi - 24px);
    position: relative;
    inline-size: 100%;
    block-size: var(--_h);
    container-type: inline-size;
    color: var(--text);
    pointer-events: none;
  }

  .dock[data-dock='compact'] {
    --_h: 56px;
  }

  .frame {
    --qd-dock-w: var(--_bar-w);
    --qd-dock-h: var(--_h);
    --qd-dock-r: var(--radius-xl);
    position: absolute;
    inset: 0;
    transition:
      --qd-dock-w var(--dur-gentle) var(--ease-emphasized),
      --qd-dock-h var(--dur-gentle) var(--ease-emphasized),
      --qd-dock-r var(--dur-gentle) var(--ease-emphasized);
  }

  .m-idle .frame {
    --qd-dock-w: var(--_idle-w);
    --qd-dock-h: 52px;
    --qd-dock-r: 26px;
  }

  .m-error .frame {
    --qd-dock-w: var(--_error-w);
  }

  .m-collapsed .frame {
    --qd-dock-w: var(--_mini-w);
    --qd-dock-h: 44px;
    --qd-dock-r: 22px;
  }

  /*
   * The visible pill: anchored at the inline-start corner of the box (its starting point never moves), centred and
   * bottom-aligned by `translate`, which layout-shift entries ignore.
   */
  .shell {
    --_toward-centre: 1;
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    box-sizing: border-box;
    inline-size: var(--qd-dock-w);
    block-size: var(--qd-dock-h);
    translate: calc(var(--_toward-centre) * (100cqi - var(--qd-dock-w)) / 2)
      calc(var(--_h) - var(--qd-dock-h));
    border: 1px solid var(--border);
    border-radius: var(--qd-dock-r);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-3);
    pointer-events: auto;
  }

  /* The inline-start corner is the right one: the centre is to the left. */
  :global([dir='rtl']) .shell {
    --_toward-centre: -1;
  }

  /*
   * A mode's content, at its final size and place from its first frame; the growing pill reveals it (the clip is the
   * pill's current box, in the pane's coordinates).
   */
  .pane {
    position: absolute;
    inset-block-end: 0;
    inset-inline-start: calc((100cqi - var(--_pw)) / 2);
    box-sizing: border-box;
    inline-size: var(--_pw);
    block-size: var(--_ph);
    clip-path: inset(
      max(0px, var(--_ph) - var(--qd-dock-h)) max(0px, (var(--_pw) - var(--qd-dock-w)) / 2) 0 round
        var(--qd-dock-r)
    );
    pointer-events: auto;
  }

  /* --- idle ------------------------------------------------------------------------------------------------------ */

  .idle {
    --_pw: var(--_idle-w);
    --_ph: 52px;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding-inline: 5px var(--space-2);
  }

  .idle-play {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: var(--space-3);
    min-inline-size: 0;
    block-size: 42px;
    padding: 0;
    padding-inline-end: var(--space-2);
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

  .disc :global(.glyph),
  .mini-play :global(.glyph) {
    translate: 1px 0; /* physical-ok: the play triangle's optical centre */
  }

  .idle-text {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
    line-height: 1.3;
  }

  .idle-title,
  .idle-sub {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .idle-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
  }

  .idle-sub {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .mono-button {
    display: grid;
    place-items: center;
    flex: none;
    padding: 2px;
    border: none;
    border-radius: var(--radius-full);
    background: none;
    cursor: pointer;
  }

  .mono-button:hover .mono {
    background-color: color-mix(in srgb, var(--accent) 20%, transparent);
  }

  /* --- monogram ------------------------------------------------------------------------------------------------- */

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

  /* --- bar ------------------------------------------------------------------------------------------------------- */

  .bar {
    --_pw: var(--_bar-w);
    --_ph: var(--_h);
    display: grid;
    grid-template-columns: 208px 132px minmax(96px, 1fr) minmax(104px, auto) auto;
    align-items: center;
    column-gap: var(--space-3);
    padding-inline: 10px 12px;
  }

  .narrow .bar {
    grid-template-columns: 48px 132px minmax(96px, 1fr) auto auto;
  }

  /* Under 600 px every cell gives a little, so the scrubber keeps a usable width (it never collapses). */
  .tight .bar {
    grid-template-columns: 44px auto minmax(72px, 1fr) auto auto;
    column-gap: var(--space-2);
    padding-inline: 6px 8px;
  }

  .tight .actions {
    gap: 0;
  }

  .tight .action {
    min-inline-size: 30px;
  }

  .tight .speed {
    min-inline-size: 38px;
  }

  .reciter {
    display: flex;
    align-items: center;
    gap: 10px;
    min-inline-size: 0;
    padding: var(--space-1);
    border: none;
    border-radius: var(--radius-md);
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .reciter:hover {
    background-color: var(--surface-hover);
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

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-0_5);
  }

  .action {
    position: relative;
    display: inline-grid;
    place-items: center;
    min-inline-size: 32px;
    block-size: 32px;
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
    min-inline-size: 44px;
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
  }

  .badge {
    position: absolute;
    inset-block-start: -3px;
    inset-inline-end: -5px;
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

  /* --- collapsed ------------------------------------------------------------------------------------------------- */

  .mini {
    --_pw: var(--_mini-w);
    --_ph: 44px;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding-inline: 5px var(--space-1);
  }

  .mini-play {
    display: grid;
    place-items: center;
    flex: none;
    inline-size: 32px;
    block-size: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    color: var(--accent-ink);
    cursor: pointer;
  }

  .mini-where {
    flex: 1 1 auto;
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mini-progress {
    position: relative;
    flex: none;
    inline-size: 36px;
    block-size: 4px;
    overflow: hidden;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--border-input) 40%, transparent);
  }

  .mini-fill {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    background-color: var(--accent);
  }

  .error-wrap {
    --_pw: var(--_error-w);
    --_ph: var(--_h);
  }

  @media (forced-colors: active) {
    .shell {
      border-color: CanvasText;
    }

    .disc,
    .mini-play,
    .badge {
      forced-color-adjust: none;
      background-color: Highlight;
      color: HighlightText;
    }
  }
</style>
