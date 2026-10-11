<!--
  RunningHead (§8.9). Owner: WP8c. The page's running heads in the HEAD band above the frame, in --text-muted, always
  Arabic with Eastern Arabic numbers:

    right: the surah of info.headSurah
    left:  the juz; when the margin labels are not drawn (glyph-only below qfs 28, or markers off), the quarter of the
           first rub starting on the page follows after a small gold khatam (not a middle dot, which reads as the digit
           zero ٠ beside Eastern Arabic numbers), on one line: الجزء ١٤ [khatam] ثلاثة أرباع الحزب ٢٧

  From qfs 20, with the bundled print-labels face loaded (`fonts.printLabelsReady`, LEAD 25), the heads are the 1441H
  print's own calligraphy in `qd-print-labels` at the print's proportion (`PRINT_EM`·qfs, baseline
  `PRINT_HEAD_BASELINE`·qfs above the frame): «سُورَةُ name» (U+F600 + surah) and «الجُزۡءُ …» with the juz's ordinal in
  words (U+F700 + juz), and the quarter composed of the face's words and digits (`printQuarterLine`) as an RTL flex
  row of spans (its private-use code points are bidi class L, so the line is never left to the bidi algorithm). It is
  bundled print furniture, not the decor pack: drawn whatever `ornateHeaders` says. Each glyph's span carries its
  words in `data-text` (the text fallback: سورة الحجر, الجزء ١٤, ثلاثة أرباع الحزب ٢٧).

  Otherwise the heads are text in the bundled Naskh (qd-hafs, `--mp-furniture-font`: no web-font swap after the first
  paint) at max(0.5·qfs, 12px): سورة {name_ar}, الجزء {juz} and the quarter in words (`rubShortLabel`); below qfs 20 the
  prefixes drop: the surah name alone, and ج ١٤ for the juz. The face is loaded before the first paint, so a page never
  switches between the two (CLS 0).

  Hidden on the opening pages (1–2, as in print) and when `showRunningHeads` is off. Decorative (`aria-hidden`) in a
  plain `div`, not a `header`: page furniture is no banner landmark (pages also show inside dialogs, the onboarding).
-->
<script lang="ts">
  import type { PageFurnitureProps } from '$lib/contracts/components'
  import { isOpeningPage } from '$lib/mushaf/geometry'
  import {
    arabicNum,
    firstRubStart,
    khatam,
    marginLabelsVisible,
    round2,
    rubShortLabel,
  } from '$lib/mushaf/ornaments'
  import {
    PRINT_WORD_GAP,
    printFontSize,
    printHeadDrop,
    printJuzHead,
    printQuarterLine,
    printSurahHead,
  } from '$lib/mushaf/printLabels'
  import { fonts, quran, settings } from '$lib/stores'

  let { data, qfs }: PageFurnitureProps = $props()

  /** Below this qfs the heads drop their سورة / الجزء prefixes and stay text (§8.9). */
  const COMPACT_BELOW = 20

  const show = $derived(settings.value.showRunningHeads && !isOpeningPage(data.page))
  const compact = $derived(qfs < COMPACT_BELOW)
  const nameAr = $derived(quran.surah(data.info.headSurah)?.nameAr ?? '')
  const juz = $derived(data.info.juz)
  /** The heads in words: the text fallback, and the `data-text` of the print's glyphs. */
  const surahText = $derived(nameAr ? `سورة ${nameAr}` : '')
  const juzText = $derived(`الجزء ${arabicNum(juz)}`)
  const labelsDrawn = $derived(settings.value.showMarginMarkers && marginLabelsVisible(qfs))
  const quarter = $derived(labelsDrawn ? null : firstRubStart(data))
  /** The print's calligraphy: the face is loaded, the page is not compact, and both heads have their glyph. */
  const print = $derived.by(() => {
    if (compact || !fonts.printLabelsReady) return null
    const surah = printSurahHead(data.info.headSurah)
    const juzHead = printJuzHead(juz)
    return surah && juzHead ? { surah, juz: juzHead } : null
  })
</script>

{#if show}
  <div
    class="mp-head"
    aria-hidden="true"
    dir="rtl"
    lang="ar"
    data-compact={compact ? '' : undefined}
    data-print={print ? '' : undefined}
    style:--mp-print-fs={print ? `${round2(printFontSize(qfs))}px` : undefined}
    style:--mp-print-drop={print ? `${round2(printHeadDrop(qfs))}px` : undefined}
    style:--mp-print-gap={print ? `${PRINT_WORD_GAP}em` : undefined}
  >
    {#if print}
      <span class="mp-head-surah"><span class="mp-head-print" data-text={surahText}>{print.surah}</span></span
      >
    {:else}
      <span class="mp-head-surah">{compact ? nameAr : surahText}</span>
    {/if}
    <span class="mp-head-juz">
      {#if print}
        <span class="mp-head-print" data-text={juzText}>{print.juz}</span>
      {:else}
        <span>{compact ? `ج ${arabicNum(juz)}` : juzText}</span>
      {/if}
      {#if quarter}
        <!-- A small khatam, not a middle dot: a dot beside Eastern Arabic numbers reads as the zero ٠. -->
        <svg class="mp-head-sep" viewBox="0 0 10 10" focusable="false"><path d={khatam(5, 5, 4.4)} /></svg>
        {#if print}
          <!-- The face's words and digits in reading order, laid out right to left by the flex row, not by bidi. -->
          <span class="mp-head-quarter mp-head-print" data-text={rubShortLabel(quarter)}>
            {#each printQuarterLine(quarter.rub, quarter.hizb) as part, i (i)}<span>{part}</span>{/each}
          </span>
        {:else}
          <span class="mp-head-quarter">{rubShortLabel(quarter)}</span>
        {/if}
      {/if}
    </span>
  </div>
{/if}
