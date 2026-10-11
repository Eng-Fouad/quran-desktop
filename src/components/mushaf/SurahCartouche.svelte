<!--
  SurahCartouche (§8.8). Owner: WP8c. The original SVG surah cartouche: the plain surah header of the Mushaf (without
  the decor fonts, or with "Ornate surah headers" off; S03's look), also used by the translation-mode `SurahCard` (WP11a)
  at a smaller qfs.

    an ogee-ended body (--cartouche-fill) with three nested strokes (0.06 / 0.02 / 0.02·qfs) in --frame-gold,
    end medallions of 1.1·qfs, each with a khatam in --frame-green over a 20 % gold fill,
    and "سُورَةُ {name_ar}" centred in qd-hafs at 0.85·qfs in --ink.

  It is 1.55·qfs tall and as wide as the line: 16.5·qfs, or 12.1·qfs on the opening pages (read from the page context;
  outside a page, always 16.5). The name is real text (selectable, readable by screen readers outside the Mushaf's
  aria-hidden glyph layer); the artwork is decorative.
-->
<script lang="ts">
  import type { SurahCartoucheProps } from '$lib/contracts/components'
  import { getPageContext, isOpeningPage, OPENING_INSET, TB_W } from '$lib/mushaf/geometry'
  import { CARTOUCHE_H, cartouche, round2 } from '$lib/mushaf/ornaments'
  import { quran } from '$lib/stores'

  let { surah, qfs }: SurahCartoucheProps = $props()

  const page = getPageContext()
  /** The line's width in qfs: the opening pages inset their 8 lines by 2.2·qfs on each side. */
  const widthQ = $derived(page && isOpeningPage(page.page) ? TB_W - 2 * OPENING_INSET : TB_W)
  const g = $derived(cartouche(widthQ))
  const name = $derived(quran.surah(surah)?.nameAr ?? '')
</script>

<span
  class="sc"
  data-surah={surah}
  style:--qfs="{qfs}px"
  style:width="{round2(widthQ * qfs)}px"
  style:height="{round2(CARTOUCHE_H * qfs)}px"
>
  <svg class="sc-art" viewBox={g.viewBox} aria-hidden="true" focusable="false">
    <path class="sc-body" d={g.body} />
    {#each g.outlines as outline, i (i)}
      <path class={['sc-line', i === 0 && 'sc-outer']} d={outline.d} stroke-width={outline.stroke} />
    {/each}
    {#each g.medallions as m, i (i)}
      <circle
        class="sc-medallion"
        cx={round2(m.cx)}
        cy={round2(m.cy)}
        r={round2(m.r)}
        stroke-width={g.medallionStroke}
      />
      <circle
        class="sc-medallion-inner"
        cx={round2(m.cx)}
        cy={round2(m.cy)}
        r={round2(m.r - 9)}
        stroke-width={g.medallionStroke * 0.6}
      />
    {/each}
    <path class="sc-star" d={g.stars} stroke-width={g.starStroke} />
  </svg>
  {#if name}
    <span class="sc-name quran-text" lang="ar" dir="rtl">سُورَةُ {name}</span>
  {/if}
</span>
