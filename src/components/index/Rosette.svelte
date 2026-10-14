<!--
  Rosette: a number inside an eight-point khatam star (two squares at 45°, the brand's star8 geometry) in
  `--frame-gold`, used as the leading badge of index rows and Go to results. `active` fills it with the accent (the
  current surah, juz or hizb). Numbers follow the UI digits. Decorative: rows carry the number in their accessible name.
-->
<script lang="ts">
  import { i18n, settings } from '$lib/stores'

  interface Props {
    n: number
    /** Edge length in px (24 in lists). */
    size?: number
    active?: boolean
    class?: string
  }

  let { n, size = 24, active = false, class: className }: Props = $props()

  const label = $derived(i18n.num(n))
</script>

<span
  class={['rosette', { active, long: label.length > 2, arab: settings.arabicDigits }, className]}
  style:--_size="{size}px"
  aria-hidden="true"
>
  <svg viewBox="0 0 24 24" focusable="false">
    <!-- The outline of two overlapping squares of the same size, one turned 45° (outer radius 11, inner 8.6). -->
    <path
      d="M12 1 15.222 4.222h4.556v4.556L23 12l-3.222 3.222v4.556h-4.556L12 23l-3.222-3.222H4.222v-4.556L1 12l3.222-3.222V4.222h4.556Z"
    />
  </svg>
  <span class="num">{label}</span>
</span>

<style>
  .rosette {
    position: relative;
    display: inline-grid;
    flex: none;
    place-items: center;
    inline-size: var(--_size);
    block-size: var(--_size);
    color: var(--text-muted);
  }

  svg {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    overflow: visible;
    fill: transparent;
    stroke: var(--frame-gold);
    stroke-width: 1;
    stroke-linejoin: miter;
    transition:
      fill var(--dur-quick) var(--ease-standard),
      stroke var(--dur-quick) var(--ease-standard);
  }

  /* Size-aware digits: 0.42 of the edge in lists (10 px at 24), growing slower at larger sizes (11.7 px at 28, 13 px
     at 36) so they stay inside the star's inner octagon. The fit below is worked out from the faces' advances, so the
     digits keep them exactly: Chromium on Linux otherwise hints each advance to a whole pixel (a 4.6 px Inter digit
     takes 5 px, and 114 at 22 px grows from 13.3 to 14.6 px, wider than the star's 14.3). */
  .num {
    position: relative;
    font-size: min(calc(var(--_size) * 0.42), calc(var(--_size) / 6 + 7px));
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    letter-spacing: 0;
    text-rendering: geometricPrecision;
  }

  /* Three Western Arabic digits: 0.32 of the edge, so 114 (and ayah 286) stay inside the star at every size (6.4 px at
     20, 7.7 px at 24, 9 px at 28, 11.5 px at 36). Near the digits the star is as wide as its square (2 × 7.78 of 24),
     and three tabular Inter digits take 1.88 em: at 24 px, 14.4 px of 15.6. */
  .long .num {
    font-size: calc(var(--_size) * 0.32);
    letter-spacing: -0.02em;
  }

  /* Three Eastern Arabic digits are narrower (IBM Plex Sans Arabic: 1.67 em at most, ٢٣٣), so they stay larger: 0.37
     of the edge, never above the size of two (7.4 px at 20, 8.9 px at 24, 10.4 px at 28, 13 px at 36). At 24 px,
     ١١٤ takes 8.2 px and ٢٣٣ 14.8 px of 15.6. */
  .long.arab .num {
    font-size: min(calc(var(--_size) * 0.37), calc(var(--_size) / 6 + 7px));
    letter-spacing: 0;
  }

  .active {
    color: var(--accent-text);
  }

  .active svg {
    fill: var(--accent-soft);
    stroke: var(--accent);
  }

  @media (forced-colors: active) {
    svg {
      stroke: CanvasText;
    }

    .active svg {
      stroke: Highlight;
      fill: transparent;
    }
  }
</style>
