<!--
  TimeReadout: the reference being recited over the file time, "2:255" (text-sm 600, tabular) above "01:23 / 07:12"
  (text-xs, muted).

  `oneLine` (a dock narrower than 720 px) folds it to "2:255 · 01:23". Always `direction: ltr`, and each
  number is its own isolate, so the times never reorder under bidi, even with Arabic-Indic digits (whose separators
  would otherwise resolve right to left). Digits follow the UI. The scrubber's slider carries the same information for
  screen readers, so this is hidden from them.
-->
<script lang="ts">
  import { i18n, player, settings } from '$lib/stores'
  import { formatClock } from '$lib/stores/player.svelte'

  interface Props {
    /** One line: "2:255 · 01:23". */
    oneLine?: boolean
  }

  let { oneLine = false }: Props = $props()

  const heard = $derived(player.heard)
  const basmala = $derived(heard?.ayah === 0)
  const reciterId = $derived(player.snapshot?.reciterId ?? settings.value.reciterId)
  const surah = $derived(heard?.surah ?? player.snapshot?.range?.from.surah ?? 0)
  const timings = $derived(surah > 0 ? player.timingsFor(reciterId, surah) : null)
  const durationMs = $derived(
    timings?.durationMs ?? (basmala ? 0 : Math.max(0, player.snapshot?.fileDurationMs ?? 0)),
  )
  /** Whole seconds: the position moves every frame, the readout (and the work behind it) once a second. */
  const second = $derived(player.isActive && !basmala ? Math.floor(Math.max(0, player.positionMs) / 1000) : 0)

  /** "2:255" with the UI's digits (plain: the readout is already an LTR island). */
  const ref = $derived.by(() => {
    if (!heard) {
      const from = player.snapshot?.range?.from
      return from ? plainRef(from.surah, from.ayah) : '–'
    }
    if (basmala) return i18n.t('player.basmala')
    return plainRef(heard.surah, heard.ayah)
  })
  const time = $derived(formatClock(second * 1000, durationMs))
  const total = $derived(formatClock(durationMs, durationMs))

  function plainRef(surah: number, ayah: number): string {
    const f = new Intl.NumberFormat(i18n.intlLocale, { useGrouping: false })
    return `${f.format(surah)}:${f.format(ayah)}`
  }
</script>

<div class={['readout', { 'one-line': oneLine }]} aria-hidden="true">
  {#if oneLine}
    <bdi class="ref" dir="ltr">{ref}</bdi><span class="sep">·</span><bdi class="time" dir="ltr">{time}</bdi>
  {:else}
    <bdi class="ref" dir="ltr">{ref}</bdi>
    <span class="times"
      ><bdi class="time" dir="ltr">{time}</bdi> / <bdi class="total" dir="ltr">{total}</bdi></span
    >
  {/if}
</div>

<style>
  .readout {
    direction: ltr; /* physical-ok: the readout never reorders */
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 1px;
    min-inline-size: 0;
    font-variant-numeric: tabular-nums;
    line-height: 1.25;
    white-space: nowrap;
  }

  .ref {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
  }

  .times {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .one-line {
    flex-direction: row;
    align-items: baseline;
    gap: var(--space-1);
  }

  .one-line .time,
  .sep {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
