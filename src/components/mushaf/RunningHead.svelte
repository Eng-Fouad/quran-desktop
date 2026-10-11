<!--
  RunningHead (§8.9). Owner: WP8c. The page's running heads in the HEAD band above the frame, in the bundled Naskh
  (qd-hafs, `--mp-furniture-font`: no web-font swap after the first paint) and --text-muted at max(0.5·qfs, 12px),
  always Arabic with Eastern Arabic numbers:

    right: سورة {name_ar of info.headSurah}
    left:  the juz: the decor calligraphy "الجزء الرابع عشر" (quran-common U+E001 + juz − 1, `decorJuzGlyph`) when
           installed, else الجزء {juz}; when the margin labels are not drawn (glyph-only below qfs 28, or markers off),
           the quarter of the first rub starting on the page follows after a small gold khatam (not a middle dot, which
           reads as the digit zero ٠ beside Eastern Arabic numbers), in words on one line (`rubShortLabel`):
           الجزء ١٤ [khatam] ثلاثة أرباع الحزب ٢٧

  Below qfs 20 the prefixes drop: the surah name alone, and ج ١٤ for the juz. Hidden on the opening pages (1–2, as in
  print) and when `showRunningHeads` is off. Decorative (`aria-hidden`) in a plain `div`, not a `header`: page furniture
  is no banner landmark (pages also show inside dialogs, the onboarding).
-->
<script lang="ts">
  import type { PageFurnitureProps } from '$lib/contracts/components'
  import { isOpeningPage } from '$lib/mushaf/geometry'
  import {
    arabicNum,
    decorJuzGlyph,
    firstRubStart,
    khatam,
    marginLabelsVisible,
    rubShortLabel,
  } from '$lib/mushaf/ornaments'
  import { fonts, quran, settings } from '$lib/stores'

  let { data, qfs }: PageFurnitureProps = $props()

  /** Below this qfs the heads drop their سورة / الجزء prefixes (§8.9). */
  const COMPACT_BELOW = 20

  const show = $derived(settings.value.showRunningHeads && !isOpeningPage(data.page))
  const compact = $derived(qfs < COMPACT_BELOW)
  const nameAr = $derived(quran.surah(data.info.headSurah)?.nameAr ?? '')
  const juz = $derived(data.info.juz)
  const decor = $derived(fonts.status.get('qd-quran-common') === 'ready' && juz >= 1 && juz <= 30)
  const labelsDrawn = $derived(settings.value.showMarginMarkers && marginLabelsVisible(qfs))
  const quarter = $derived(labelsDrawn ? null : firstRubStart(data))
</script>

{#if show}
  <div class="mp-head" aria-hidden="true" dir="rtl" lang="ar" data-compact={compact ? '' : undefined}>
    <span class="mp-head-surah">{compact || !nameAr ? nameAr : `سورة ${nameAr}`}</span>
    <span class="mp-head-juz">
      {#if decor}
        <span class="mp-head-juz-glyph">{decorJuzGlyph(juz)}</span>
      {:else}
        <span>{compact ? `ج ${arabicNum(juz)}` : `الجزء ${arabicNum(juz)}`}</span>
      {/if}
      {#if quarter}
        <!-- A small khatam, not a middle dot: a dot beside Eastern Arabic numbers reads as the zero ٠. -->
        <svg class="mp-head-sep" viewBox="0 0 10 10" focusable="false"><path d={khatam(5, 5, 4.4)} /></svg>
        <span class="mp-head-quarter">{rubShortLabel(quarter)}</span>
      {/if}
    </span>
  </div>
{/if}
