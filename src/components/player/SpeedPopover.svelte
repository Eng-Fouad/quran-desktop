<!--
  SpeedPopover (§9.7): the speed slider, opened from the dock's speed label. Owner: WP9a.

  0.5×–2.0× in 0.05 steps with ticks at 0.75×, 1×, 1.25×, 1.5× and 2×, the value large at the top, a "Normal speed"
  reset and the note that the pitch is preserved (WSOLA, §2.3.5). Dragging previews the value; the speed is applied
  (and persisted) when the drag ends or after each key press, so the engine flushes once, not once per step
  (D15). A value slider: it mirrors in the Arabic UI (§11.3). Keys inside it never reach the reader (§7.4, §7.7).
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Button, Popover, Slider } from '$components/ui'
  import type { Align, Side, TriggerProps } from '$components/ui/types'
  import { i18n, player } from '$lib/stores'
  import { formatSpeed, SPEED_MAX, SPEED_MIN, SPEED_STEP } from '$lib/stores/player.svelte'

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
  const TICKS = [75, 100, 125, 150, 200] as const

  /** The value under the thumb while dragging; `null` shows the player's speed. */
  let draft = $state<number | null>(null)
  const shown = $derived(draft ?? player.speedPct)

  $effect(() => {
    if (!open) draft = null
  })

  function commit(pct: number): void {
    draft = null
    void player.setSpeed(pct)
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
  label={i18n.t('player.speed.title')}
>
  <div class="speed" data-qd-popover="speed">
    <!-- Not `header`: in a popover (portalled to the body) that would be a banner landmark. -->
    <div class="head">
      <h2 id="{uid}-title">{i18n.t('player.speed.title')}</h2>
      <span class="head-end">
        {#if shown !== 100}
          <Button size="sm" variant="ghost" onclick={() => commit(100)}
            >{i18n.t('player.speed.normal')}</Button
          >
        {/if}
        <output class="value" aria-live="polite"><bdi dir="ltr">{formatSpeed(shown)}</bdi></output>
      </span>
    </div>
    <Slider
      value={shown}
      min={SPEED_MIN}
      max={SPEED_MAX}
      step={SPEED_STEP}
      bigStep={25}
      ticks={TICKS}
      format={formatSpeed}
      labelledBy="{uid}-title"
      onValueChange={(v) => (draft = v)}
      onValueCommit={commit}
    />
    <p class="note">{i18n.t('player.speed.pitch')}</p>
  </div>
</Popover>

<style>
  .speed {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    min-block-size: 32px;
  }

  h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-title);
  }

  .head-end {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .value {
    min-inline-size: 56px;
    color: var(--accent-text);
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }

  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-ui);
  }
</style>
