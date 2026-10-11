<!--
  AyahScrubber (§9.7): the ayah-tick scrubber on the file timeline of the surah being recited. Owner: WP9a.

  - Track 6 px, radius-full: `--border-input` at 40 % with a 1 px `--border-input` outline. One SVG path draws the
    ayah ticks in `--text-muted` (density rules in `scrubber.ts`); on a track of 480 px or more, every tenth
    ayah gets a 1×10 tick and its number.
  - The played part is `--accent`, the current ayah's span `--accent-soft`. The repeat scope (the ayah, or the range)
    shows as a bracket above the track, an A-B loop as A and B flags.
  - Thumb 14 px in `--accent` with a 2 px `--surface-raised` ring, 18 px on hover or while dragging.
  - Pointer: hovering shows "2:255 · 01:23"; click or drag seeks (on release), Shift snaps to the nearest ayah start,
    Escape cancels a drag. Seeks stay inside the playing range.
  - Keyboard: the thumb is the `role="slider"` (the §7.7 widget guard keeps reader keys away). ←/→ (and ↓/↑) move
    5 s, PageDown/PageUp one ayah, Home/End the first and last ayah of the range.
  - Always left to right (§11.3), in both UI languages. During the basmala the timeline is the coming surah's, at 0.
  - Cheap while playing (§13.6: ≤ 3 % of a core at 1×). The thumb and the played part move in whole device pixels:
    the scrubber asks the player for the position once per device pixel of file time (`player.needPosition`), and
    their styles are written only when that pixel changes (on a 100 px track and a 7-minute surah, once every 4 s, not
    60 times a second). Both are transforms (`translate`), which neither lay out nor clip anew; the played part is a
    full-length fill slid under a rounded clip, its leading edge under the thumb.
-->
<script lang="ts">
  import { i18n, player, quran, settings } from '$lib/stores'
  import { ayahTiming, formatClock, isolatedClock } from '$lib/stores/player.svelte'
  import type { MushafLayout } from '$lib/ipc/bindings'
  import { type AyahStart, ayahIndexAt, planTicks, snapToAyah } from './scrubber'

  interface Props {
    /** `bar` (40 px tall, labels when wide enough) or `card` (16 px, no labels). */
    variant?: 'bar' | 'card'
    /** Show the every-ten ayah labels (the dock hides them below 600 px). */
    labels?: boolean
  }

  let { variant = 'bar', labels = true }: Props = $props()

  const LAYOUT: Record<string, MushafLayout> = { hafs: 'v2', qcf_v2: 'v2', qcf_v1: 'v1', qcf_v4: 'v4' }
  const NUDGE_MS = 5_000

  let width = $state(0)
  let rail: HTMLDivElement | null = $state(null)
  let thumb: HTMLDivElement | null = $state(null)
  /** Pointer position over the rail (ms), while hovering or dragging. */
  let hoverMs = $state<number | null>(null)
  /** The drag's target (ms), shown until release. */
  let dragMs = $state<number | null>(null)
  let pointerId: number | null = null

  const active = $derived(player.isActive)
  const reciterId = $derived(player.snapshot?.reciterId ?? settings.value.reciterId)
  /** The surah whose file the timeline shows (during the basmala, the surah it opens). */
  const surah = $derived(player.heard?.surah ?? player.snapshot?.range?.from.surah ?? 0)
  const basmala = $derived(player.heard?.ayah === 0)
  const timings = $derived(surah > 0 ? player.timingsFor(reciterId, surah) : null)
  const durationMs = $derived(
    timings?.durationMs ?? (basmala ? 0 : Math.max(0, player.snapshot?.fileDurationMs ?? 0)),
  )
  const layout = $derived(LAYOUT[settings.value.mushafStyle] ?? 'v2')
  const starts: AyahStart[] = $derived.by(() => {
    if (!timings) return []
    const info = quran.surah(surah)
    return timings.ayahs.map((a) => ({
      ayah: a.ayah,
      fromMs: a.fromMs,
      page: info ? quran.pageOfAyah(layout, info.firstAyahId + a.ayah - 1) : 0,
    }))
  })
  const ticks = $derived(planTicks(starts, durationMs, width))
  const showLabels = $derived(labels && variant === 'bar' && ticks.labels.length > 0)

  /** The playing range within this file (ms). */
  const rangeMs = $derived.by(() => {
    const r = player.snapshot?.range
    let from = 0
    let to = durationMs
    if (r && timings) {
      if (r.from.surah === surah) from = ayahTiming(timings, r.from.ayah)?.fromMs ?? 0
      if (r.to.surah === surah) to = ayahTiming(timings, r.to.ayah)?.toMs ?? durationMs
    }
    return { from, to: Math.max(from, to) }
  })

  const positionMs = $derived(active && !basmala ? Math.min(Math.max(0, player.positionMs), durationMs) : 0)
  const shownMs = $derived(dragMs ?? positionMs)
  const fraction = $derived(durationMs > 0 ? Math.min(1, Math.max(0, shownMs / durationMs)) : 0)

  /** Device pixels per CSS px. The thumb can't be drawn between device pixels, so it moves on their grid. */
  let dpr = $state(typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1)
  $effect(() => {
    if (typeof matchMedia !== 'function') return
    // Fires once the ratio changes (another monitor, the OS scale, a zoom); the effect then watches the new one.
    const query = matchMedia(`(resolution: ${dpr}dppx)`)
    const update = () => (dpr = devicePixelRatio > 0 ? devicePixelRatio : 1)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })
  /** The thumb's offset, in whole device pixels. An equal value doesn't propagate: the DOM changes on a new pixel. */
  const thumbX = $derived(Math.round(fraction * width * dpr) / dpr)
  // While it shows a play, the position is wanted once per device pixel of the track (the player samples no finer).
  $effect(() => {
    if (!active || basmala || durationMs <= 0 || width <= 0) return
    return player.needPosition(durationMs / (width * dpr))
  })

  const pct = (ms: number) => (durationMs > 0 ? Math.min(100, Math.max(0, (ms / durationMs) * 100)) : 0)

  /** The current ayah's span (accent-soft). */
  const span = $derived(active && !basmala ? player.ayahSpan : null)

  /** The repeat scope bracket: the ayah while it repeats, else the range while it repeats (§9.7). */
  const bracket = $derived.by(() => {
    const s = player.snapshot
    if (!s || !active || durationMs <= 0 || s.abLoop) return null
    if (s.ayahRepeat !== 1 && span) return { from: span.fromMs, to: span.toMs }
    if (s.rangeRepeat !== 1) return rangeMs
    return null
  })
  const ab = $derived.by(() => {
    const loop = player.snapshot?.abLoop
    if (loop && active) return { a: loop.aMs, b: loop.bMs as number | null }
    if (player.abPending !== null && active) return { a: player.abPending, b: null }
    return null
  })

  function refAt(ms: number): string {
    const i = ayahIndexAt(starts, ms)
    const a = starts[i]
    return a ? i18n.ref(surah, a.ayah) : surah > 0 ? i18n.ref(surah, 1) : ''
  }

  /** The slider's values move in whole seconds, so assistive technology is not updated every frame. */
  const second = $derived(Math.floor(positionMs / 1000))
  const valueText = $derived(
    active && surah > 0
      ? i18n.t('player.scrubber.valueText', {
          ref: basmala ? i18n.t('player.basmala') : refAt(positionMs),
          time: formatClock(second * 1000, durationMs),
          total: formatClock(durationMs, durationMs),
        })
      : undefined,
  )
  const tipMs = $derived(dragMs ?? hoverMs)
  const tipText = $derived(
    tipMs !== null && durationMs > 0
      ? i18n.t('player.scrubber.hover', { ref: refAt(tipMs), time: isolatedClock(tipMs, durationMs) })
      : '',
  )
  const tipX = $derived(
    tipMs !== null && durationMs > 0 ? Math.min(Math.max((tipMs / durationMs) * width, 34), width - 34) : 0,
  )

  function msAt(clientX: number): number {
    if (!rail || durationMs <= 0) return 0
    const r = rail.getBoundingClientRect()
    const f =
      r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0 /* physical-ok: LTR track */
    return f * durationMs
  }

  /** A seek target inside the playing range, snapped to an ayah start with Shift. */
  function target(ms: number, snap: boolean): number {
    const { from, to } = rangeMs
    const inRange = Math.min(Math.max(ms, from), Math.max(from, to - 1))
    return snap ? snapToAyah(starts, inRange, from, to) : inRange
  }

  function onpointerdown(e: PointerEvent): void {
    if (!active || durationMs <= 0 || e.button !== 0) return
    e.preventDefault()
    pointerId = e.pointerId
    rail?.setPointerCapture(e.pointerId)
    dragMs = target(msAt(e.clientX), e.shiftKey)
    thumb?.focus({ preventScroll: true })
  }

  function onpointermove(e: PointerEvent): void {
    if (durationMs <= 0) return
    const ms = msAt(e.clientX)
    hoverMs = ms
    if (pointerId === e.pointerId && dragMs !== null) dragMs = target(ms, e.shiftKey)
  }

  function onpointerup(e: PointerEvent): void {
    if (pointerId !== e.pointerId) return
    const ms = dragMs
    endDrag()
    if (ms !== null) void player.seekMs(ms)
  }

  function endDrag(): void {
    if (pointerId !== null && rail?.hasPointerCapture(pointerId)) rail.releasePointerCapture(pointerId)
    pointerId = null
    dragMs = null
  }

  function onpointerleave(): void {
    if (pointerId === null) hoverMs = null
  }

  /** The ayah ids of the range in this surah (keyboard jumps stay inside it). */
  function ayahBounds(): { first: number; last: number } | null {
    const r = player.snapshot?.range
    const info = quran.surah(surah)
    if (!r || !info) return null
    const first = r.from.surah === surah ? r.from.ayah : 1
    const last = r.to.surah === surah ? r.to.ayah : info.ayahCount
    return { first: info.firstAyahId + first - 1, last: info.firstAyahId + last - 1 }
  }

  function onkeydown(e: KeyboardEvent): void {
    if (!active) return
    if (e.key === 'Escape' && dragMs !== null) {
      e.preventDefault()
      e.stopPropagation()
      endDrag()
      return
    }
    const bounds = ayahBounds()
    const current = player.currentAyahId ?? bounds?.first ?? 0
    let handled = true
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        void player.nudge(NUDGE_MS)
        break
      case 'ArrowLeft':
      case 'ArrowDown':
        void player.nudge(-NUDGE_MS)
        break
      case 'PageUp':
        if (bounds && current < bounds.last) void player.seekAyah(current + 1)
        break
      case 'PageDown':
        if (bounds && current > bounds.first) void player.seekAyah(current - 1)
        break
      case 'Home':
        if (bounds) void player.seekAyah(bounds.first)
        break
      case 'End':
        if (bounds) void player.seekAyah(bounds.last)
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }
</script>

<div
  class={['scrubber', `v-${variant}`, { labelled: showLabels, active, dragging: dragMs !== null }]}
  bind:clientWidth={width}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rail"
    bind:this={rail}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    onpointercancel={endDrag}
    onlostpointercapture={() => {
      if (pointerId !== null) endDrag()
    }}
    {onpointerleave}
  >
    {#if bracket}
      <span
        class="bracket"
        style:inset-inline-start="{pct(bracket.from)}%"
        style:inline-size="{Math.max(0, pct(bracket.to) - pct(bracket.from))}%"
        aria-hidden="true"
      ></span>
    {/if}
    {#if ab}
      {#if ab.b !== null}
        <span
          class="bracket ab-span"
          style:inset-inline-start="{pct(ab.a)}%"
          style:inline-size="{Math.max(0, pct(ab.b) - pct(ab.a))}%"
          aria-hidden="true"
        ></span>
      {/if}
      <span
        class="flag"
        class:pending={ab.b === null}
        style:inset-inline-start="{pct(ab.a)}%"
        aria-hidden="true">{i18n.t('player.scrubber.abA')}</span
      >
      {#if ab.b !== null}
        <span class="flag" style:inset-inline-start="{pct(ab.b)}%" aria-hidden="true"
          >{i18n.t('player.scrubber.abB')}</span
        >
      {/if}
    {/if}

    <div class="track">
      {#if span && durationMs > 0}
        <span
          class="span"
          style:inset-inline-start="{pct(span.fromMs)}%"
          style:inline-size="{Math.max(0, pct(span.toMs) - pct(span.fromMs))}%"
        ></span>
      {/if}
      <span class="played-clip"
        ><span class="played" style:translate={width > 0 ? `${thumbX - width}px 0` : '-100% 0'}></span></span
      >
      {#if width > 0 && (ticks.small !== '' || ticks.tall !== '')}
        <svg class="ticks" {width} height="6" viewBox="0 0 {width} 6" aria-hidden="true">
          {#if ticks.small}<path d={ticks.small} />{/if}
          {#if ticks.tall}<path class="tall" d={ticks.tall} />{/if}
        </svg>
      {/if}
    </div>

    <div
      class="thumb"
      bind:this={thumb}
      style:translate="{thumbX}px 0"
      role="slider"
      tabindex={active ? 0 : -1}
      aria-label={i18n.t('player.scrubber.label')}
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuenow={second}
      aria-valuetext={valueText}
      aria-disabled={!active}
      aria-orientation="horizontal"
      {onkeydown}
    ></div>
  </div>

  {#if showLabels}
    <div class="labels" aria-hidden="true">
      {#each ticks.labels as label (label.ayah)}
        <span class="label" style:inset-inline-start="{label.x}px">{i18n.num(label.ayah)}</span>
      {/each}
    </div>
  {/if}

  {#if tipText !== '' && active}
    <div class="tip" style:inset-inline-start="{tipX}px" aria-hidden="true">{tipText}</div>
  {/if}
</div>

<style>
  .scrubber {
    --_track-top: 17px;
    position: relative;
    direction: ltr; /* physical-ok: the media scrubber never mirrors (§11.3) */
    min-inline-size: 0;
    block-size: 40px;
    user-select: none;
    -webkit-user-select: none;
  }

  .v-card {
    --_track-top: 5px;
    block-size: 16px;
  }

  .rail {
    position: absolute;
    inset: 0;
    touch-action: none;
  }

  .active .rail {
    cursor: pointer;
  }

  .track {
    position: absolute;
    inset-inline: 0;
    inset-block-start: var(--_track-top);
    block-size: 6px;
    border-radius: var(--radius-full);
    background-color: color-mix(in srgb, var(--border-input) 40%, transparent);
    box-shadow: inset 0 0 0 1px var(--border-input);
  }

  .span,
  .played-clip {
    position: absolute;
    inset-block: 0;
    border-radius: var(--radius-full);
  }

  .span {
    background-color: var(--accent-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
  }

  /* The played part: a full-length fill slid in from the start, clipped to the track's rounded shape. */
  .played-clip {
    inset-inline: 0;
    overflow: clip;
  }

  .played {
    position: absolute;
    inset: 0;
    background-color: var(--accent);
  }

  .ticks {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    overflow: visible;
    pointer-events: none;
    shape-rendering: crispEdges;
  }

  /* Full --text-muted: at 70 % the ticks fall to 2.4–3.6:1 against the track, below §9.2's 3:1 (WP7a measured). */
  .ticks path {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1;
  }

  .thumb {
    position: absolute;
    inset-block-start: calc(var(--_track-top) + 3px - 7px);
    inset-inline-start: -7px;
    inline-size: 14px;
    block-size: 14px;
    border-radius: var(--radius-full);
    background-color: var(--accent);
    box-shadow:
      0 0 0 2px var(--surface-raised),
      var(--shadow-1);
    opacity: 0;
    transition:
      scale var(--dur-fast) var(--ease-standard),
      opacity var(--dur-fast) var(--ease-standard);
    outline-offset: 3px;
  }

  .active .thumb {
    opacity: 1;
  }

  .rail:hover .thumb,
  .dragging .thumb,
  .thumb:focus-visible {
    scale: 1.2857; /* 14 → 18 px */
  }

  .bracket {
    position: absolute;
    inset-block-start: calc(var(--_track-top) - 6px);
    block-size: 4px;
    border: 1.5px solid color-mix(in srgb, var(--accent) 80%, transparent);
    border-block-end: none;
    border-start-start-radius: 2px;
    border-start-end-radius: 2px;
    pointer-events: none;
  }

  .ab-span {
    border-color: var(--accent-text);
  }

  .flag {
    position: absolute;
    inset-block-start: calc(var(--_track-top) - 16px);
    display: grid;
    place-items: center;
    min-inline-size: 13px;
    block-size: 13px;
    padding-inline: 2px;
    border-radius: 3px;
    background-color: var(--accent);
    color: var(--accent-ink);
    font-size: 9px;
    font-weight: var(--weight-title);
    line-height: 1;
    translate: -50% 0;
    pointer-events: none;
  }

  .flag.pending {
    background-color: var(--surface-raised);
    color: var(--accent-text);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .v-card .bracket,
  .v-card .flag {
    display: none;
  }

  .labels {
    position: absolute;
    inset-inline: 0;
    inset-block-start: calc(var(--_track-top) + 10px);
    block-size: 12px;
    pointer-events: none;
  }

  .label {
    position: absolute;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    translate: -50% 0;
  }

  .tip {
    position: absolute;
    inset-block-end: calc(100% - var(--_track-top) + 12px);
    z-index: 1;
    padding-block: 3px;
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    background-color: var(--surface-overlay);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    translate: -50% 0;
    pointer-events: none;
  }

  .v-card .tip {
    inset-block-end: calc(100% + 6px);
  }

  :global(:root[data-motion='reduce']) .thumb {
    transition: none;
  }

  @media (forced-colors: active) {
    .track {
      border: 1px solid CanvasText;
    }

    .played,
    .thumb,
    .flag {
      background-color: Highlight;
      forced-color-adjust: none;
    }

    .span {
      outline: 1px solid Highlight;
    }
  }
</style>
