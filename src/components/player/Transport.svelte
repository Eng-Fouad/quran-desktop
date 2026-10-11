<!--
  Transport (§9.7): previous ayah · play/pause · next ayah. Owner: WP9a.

  - Play/pause is a 40 px accent circle with a 20 px icon in `--accent-ink` (36 px in the side card). While the play
    loads or buffers it shows an indeterminate ring around it (static under reduced motion), and its label says so.
  - With nothing loaded, play starts what the idle dock offers (the resume candidate, else the selection or the page),
    like Space.
  - The group is `direction: ltr` in both UI languages (§11.3): previous stays on the left, next on the right, and the
    media icons never mirror. Tooltips carry the shortcut keys.
-->
<script lang="ts">
  import Pause from '@lucide/svelte/icons/pause'
  import Play from '@lucide/svelte/icons/play'
  import SkipBack from '@lucide/svelte/icons/skip-back'
  import SkipForward from '@lucide/svelte/icons/skip-forward'
  import { Tooltip } from '$components/ui'
  import { i18n, player } from '$lib/stores'
  import { keyHint, playIdleOffer } from './dock.svelte'

  interface Props {
    /** `bar`: 32 px skip buttons and a 40 px play button; `card`: 28 px and 36 px. */
    size?: 'bar' | 'card'
  }

  let { size = 'bar' }: Props = $props()

  const waiting = $derived(player.status === 'loading' || player.status === 'buffering')
  const playLabel = $derived(
    player.status === 'loading'
      ? i18n.t('player.transport.loading')
      : player.status === 'buffering'
        ? i18n.t('player.transport.buffering')
        : player.wantsPlay
          ? i18n.t('player.transport.pause')
          : i18n.t('player.transport.play'),
  )
  const skipIcon = $derived(size === 'card' ? 16 : 18)
  const playIcon = $derived(size === 'card' ? 18 : 20)

  function togglePlay(): void {
    if (player.isActive) void player.toggle()
    else playIdleOffer()
  }
</script>

<div class={['transport', `s-${size}`]} role="group" aria-label={i18n.t('player.transport.group')}>
  <Tooltip content={i18n.t('player.transport.previous')} kbd={keyHint('audio.prevAyah')}>
    {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="skip"
        aria-label={i18n.t('player.transport.previous')}
        disabled={!player.isActive}
        onclick={() => void player.prev()}
      >
        <SkipBack size={skipIcon} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
      </button>
    {/snippet}
  </Tooltip>

  <Tooltip content={playLabel} kbd={keyHint('audio.playPause')}>
    {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="play"
        class:waiting
        aria-label={playLabel}
        aria-busy={waiting}
        data-state={player.wantsPlay ? 'playing' : 'paused'}
        onclick={togglePlay}
      >
        {#if waiting}
          <svg class="ring" viewBox="0 0 48 48" aria-hidden="true">
            <circle cx="24" cy="24" r="22.5" pathLength="100" />
          </svg>
        {/if}
        {#if player.wantsPlay}
          <Pause size={playIcon} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
        {:else}
          <Play
            size={playIcon}
            strokeWidth={1.75}
            fill="currentColor"
            class="play-glyph"
            aria-hidden="true"
          />
        {/if}
      </button>
    {/snippet}
  </Tooltip>

  <Tooltip content={i18n.t('player.transport.next')} kbd={keyHint('audio.nextAyah')}>
    {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="skip"
        aria-label={i18n.t('player.transport.next')}
        disabled={!player.isActive}
        onclick={() => void player.next()}
      >
        <SkipForward size={skipIcon} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
      </button>
    {/snippet}
  </Tooltip>
</div>

<style>
  .transport {
    direction: ltr; /* physical-ok: media transport never mirrors (§11.3) */
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
  }

  .skip {
    display: inline-grid;
    place-items: center;
    inline-size: 32px;
    block-size: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard),
      scale var(--dur-instant) var(--ease-standard);
  }

  .s-card .skip {
    inline-size: 28px;
    block-size: 28px;
  }

  .skip:hover:not(:disabled) {
    background-color: var(--surface-hover);
  }

  .skip:active:not(:disabled) {
    scale: 0.94;
  }

  .skip:disabled {
    color: var(--text-faint);
    cursor: default;
  }

  .play {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: 40px;
    block-size: 40px;
    margin-inline: var(--space-1);
    padding: 0;
    border: none;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--accent) 35%, transparent);
    cursor: pointer;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      scale var(--dur-instant) var(--ease-standard);
  }

  .s-card .play {
    inline-size: 36px;
    block-size: 36px;
  }

  .play:hover {
    background-color: color-mix(in srgb, var(--accent) 90%, var(--text));
  }

  .play:active {
    scale: 0.95;
  }

  /* The play triangle's optical centre sits right of its box centre. */
  .play :global(.play-glyph) {
    translate: 1px 0; /* physical-ok: LTR group */
  }

  .ring {
    position: absolute;
    inset: -4px;
    inline-size: calc(100% + 8px);
    block-size: calc(100% + 8px);
    pointer-events: none;
    animation: qd-transport-spin 1.1s linear infinite;
  }

  .ring circle {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-dasharray: 28 72;
  }

  @keyframes qd-transport-spin {
    to {
      rotate: 360deg;
    }
  }

  :global(:root[data-motion='reduce']) .ring {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .ring {
      animation: none;
    }
  }

  :global(:root[data-motion='reduce']) .play:active,
  :global(:root[data-motion='reduce']) .skip:active {
    scale: none;
  }

  @media (forced-colors: active) {
    .play {
      border: 2px solid ButtonText;
      background-color: ButtonFace;
      color: ButtonText;
    }

    .ring circle {
      stroke: Highlight;
    }
  }
</style>
