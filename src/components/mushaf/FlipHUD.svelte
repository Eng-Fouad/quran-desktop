<!--
  FlipHUD. The heads-up chip in the centre of the page area while pages fly by. Takes no props: it reads stores.

  - Shown while the reader flips (key repeat, `reader.flipping`) and while the page rail previews a page (a drag or
    keyboard steps, `railState.preview`), with the label of what is shown: "surah · page · juz" — `الحجر · ص ٢٦٢ ·
    ج ١٤` in Naskh in the Arabic UI; in the English UI the Arabic surah name in Naskh, then "Al-Hijr · Page 262 · Juz
    14". A spread reads "Pages 261–262" (`ص ٢٦١–٢٦٢`).
  - It fades out 600 ms after the last flip or preview step, keeping its last label while it goes; under reduced motion
    it disappears at once.
  - Decorative for assistive technology (`aria-hidden`): the reader announces the page it settles on and the rail
    carries its own value text.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { fade } from 'svelte/transition'
  import { BAR_RESERVE, COMPACT_BAR_RESERVE } from '$lib/mushaf/geometry'
  import { i18n, reader, settings, ui } from '$lib/stores'
  import { pageLabel, railState, type PageLabel } from './PageRail.svelte'

  /** The HUD fades out this long after the last flip. */
  const FADE_AFTER_MS = 600
  /** Between the label's parts (as in `PageLabel.text`). */
  const SEP = ' · '

  /** The pages to describe: the rail's preview, else the spread or page on screen while flipping. */
  const source: readonly number[] | null = $derived.by(() => {
    const preview = railState.preview
    if (preview !== null) return [preview]
    return reader.flipping ? reader.visiblePages : null
  })

  let label = $state.raw<PageLabel | null>(null)
  let visible = $state(false)
  let lastActive = 0
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    const pages = source
    const next = pages ? pageLabel(pages) : null
    untrack(() => {
      if (next) {
        label = next
        visible = true
        lastActive = performance.now()
        clearTimeout(hideTimer)
        hideTimer = undefined
        return
      }
      if (visible && hideTimer === undefined)
        hideTimer = setTimeout(
          () => {
            hideTimer = undefined
            visible = false
          },
          Math.max(0, FADE_AFTER_MS - (performance.now() - lastActive)),
        )
    })
  })
  $effect(() => () => clearTimeout(hideTimer))

  /** The page area: above the bottom dock's reserve, beside the side card's column (zen reserves nothing). */
  const reserveBottom = $derived(
    ui.zen ? 0 : reader.dock === 'bar' ? BAR_RESERVE : reader.dock === 'compact' ? COMPACT_BAR_RESERVE : 0,
  )
  const arabicUi = $derived(i18n.locale === 'ar')
</script>

<!-- "surah · page · juz": tabular digits for the numbers only (Inter's tabular forms widen the hyphen of "Al-Hijr"). -->
{#snippet parts(l: PageLabel)}
  <span>{l.surah}</span><span class="sep">{SEP}</span><span class="num">{l.pages}</span><span class="sep"
    >{SEP}</span
  ><span class="num">{l.juz}</span>
{/snippet}

{#if visible && label}
  <div class="hud-area" style:--hud-reserve-bottom={`${reserveBottom}px`} aria-hidden="true">
    <div
      class="hud"
      data-qd-flip-hud=""
      dir={i18n.dir}
      in:fade={{ duration: settings.reducedMotion ? 0 : 90 }}
      out:fade={{ duration: settings.reducedMotion ? 0 : 220 }}
    >
      {#if arabicUi}
        <span class="naskh" lang="ar">{@render parts(label)}</span>
      {:else}
        <span class="naskh name" lang="ar" dir="rtl">{label.surahAr}</span>
        <span class="text">{@render parts(label)}</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .hud-area {
    position: absolute;
    inset-block: 0 var(--hud-reserve-bottom);
    inset-inline: 0 var(--mv-reserve-end, 0px);
    z-index: var(--z-popover);
    display: grid;
    place-items: center;
    pointer-events: none;
  }

  /* A chip on the overlay surface, Naskh 18 px. */
  .hud {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-block-size: 48px;
    padding-block: var(--space-1);
    padding-inline: var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-3);
    color: var(--text);
    white-space: nowrap;
  }

  .naskh {
    font-family: var(--font-naskh);
    font-size: 18px;
    font-weight: var(--weight-body);
    line-height: 1.6;
  }

  .num {
    font-variant-numeric: tabular-nums;
  }

  .sep {
    color: var(--text-faint);
    white-space: pre;
  }

  /* English UI: the Arabic name leads, set off from the details by a hairline (on the details: the name is RTL). */
  .name {
    color: var(--surah-header-ink);
    font-size: 20px;
  }

  .text {
    padding-inline-start: var(--space-3);
    border-inline-start: 1px solid var(--border-strong);
    font-size: var(--text-lg);
    font-weight: var(--weight-label);
    line-height: var(--leading-ui);
  }

  @media (forced-colors: active) {
    .hud {
      border-color: CanvasText;
    }
  }
</style>
