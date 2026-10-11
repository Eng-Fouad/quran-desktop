<!--
  MarginMarkers (§8.9). Owner: WP8c. The division and sajda markers in the page's outer margin (M_OUT), in --marker-ink:

  - a rub start (`flags & 1`, the mushaf-source rub, D6): ۞ in qd-hafs, or, while labels are drawn and decor is loaded
    (and the page's ornaments are on: `MushafPageProps.ornaments`, else `ornateHeaders`), the quran-common ornament (U+FC23 for a hizb start, U+FC22 for the other quarters). Glyphs are sized by their
    measured ink, not their em (۞ has only 0.45 em of ink): 0.75·qfs tall (≥ 13 px), the decor ornaments 1.45·qfs
    (U+FC22) and a line, 1.75·qfs (the slender U+FC23; `markerGlyphBox`). An ornament's hairlines are thickened
    (`-webkit-text-stroke`, `decorStroke`) so it reads at 3:1 like the solid ۞, and its empty frame holds the
    number of the hizb it opens or divides (`markerInset`; a quarter's words do not fit a frame);
  - a rub start whose first word already carries the ۞ inline (LEAD 17, ≈198 quarters): the label alone, centred on
    the line, never a second ۞ beside the inline one; not drawn while labels are hidden (the running head names the
    quarter then);
  - a sajda: ۩ beside the line where its ayah ends;
  - under each glyph its Arabic label (الجزء ١٤ · الحزب ٢٧ · سجدة · سجدة واجبة) at max(0.36·qfs, 11px), only while
    0.36·qfs ≥ 10 (qfs ≥ 28); smaller pages draw the glyph alone and the running head carries the quarter. A quarter
    is written in words on two lines, ربع / نصف / ثلاثة أرباع over الحزب ٢٧ (`rubLabelLines`): on one line it is wider
    than the margin.

  The furniture is Arabic in every UI language, so the column carries `dir="rtl" lang="ar"` itself, as the running
  head does: inside a settings or onboarding preview no `.spread` gives it a direction.

  Markers on the same line stack 0.2·qfs apart, centred on the line. On an interactive page each marker is a pointer
  target: its tooltip shows the full label and a description in the UI language, a click selects the ayah. The
  container is `aria-hidden` (the a11y layer announces divisions); the targets are `tabindex=-1`.
-->
<script lang="ts">
  import { Tooltip } from '$components/ui'
  import { mergeProps } from 'bits-ui'
  import type { PageFurnitureProps } from '$lib/contracts/components'
  import { getPageContext } from '$lib/mushaf/geometry'
  import {
    decorStroke,
    insetBox,
    isDecorInk,
    labelSize,
    marginLabelsVisible,
    markerGlyphBox,
    markerInk,
    markerInset,
    pageMarkers,
    placeMarkers,
    round2,
    type MarginMarker,
  } from '$lib/mushaf/ornaments'
  import { fonts, i18n, reader, settings } from '$lib/stores'

  let { data, qfs, side }: PageFurnitureProps = $props()

  const page = getPageContext()
  const interactive = $derived(page?.interactive ?? false)
  const labels = $derived(marginLabelsVisible(qfs))
  /** The page's ornaments are on and the quran-common face is loaded; they are drawn while labels are (`markerInk`). */
  const decor = $derived(
    (page?.ornaments ?? settings.value.ornateHeaders) && fonts.status.get('qd-quran-common') === 'ready',
  )
  const ornaments = $derived(decor && labels)
  const placed = $derived(
    settings.value.showMarginMarkers ? placeMarkers(pageMarkers(data), qfs, labels, decor).placed : [],
  )
  /** Tooltips open away from the text block, into the canvas beside the page. */
  const tooltipSide = $derived(side === 'right' ? 'right' : 'left')

  /** The glyph, its font, the box that centres its ink (sized by ink, not em), and an ornament's frame text. */
  function glyph(m: MarginMarker) {
    const ink = markerInk(m, decor, labels)
    const box = markerGlyphBox(qfs, ink)
    const decorGlyph = isDecorInk(ink)
    const text = decorGlyph ? markerInset(m, ink) : null
    const place = text === null ? null : insetBox(qfs, ink, text)
    return {
      ink,
      ...box,
      decor: decorGlyph,
      stroke: decorGlyph ? decorStroke(box.fontSize) : 0,
      inset: text !== null && place !== null ? { text, ...place } : null,
    }
  }

  function description(m: MarginMarker): string {
    const ref = i18n.ref(m.surah, m.ayah)
    if (m.kind === 'sajda')
      return i18n.t(
        m.sajda === 'obligatory' ? 'furniture.marker.sajdaObligatory' : 'furniture.marker.sajda',
        { ref },
      )
    const rub = m.rub
    if (!rub) return ref
    if (rub.kind === 'juz') return i18n.t('furniture.marker.juz', { juz: rub.juz, ref })
    if (rub.kind === 'hizb') return i18n.t('furniture.marker.hizb', { hizb: rub.hizb, ref })
    const key =
      rub.quarter === 1
        ? 'furniture.marker.quarter1'
        : rub.quarter === 2
          ? 'furniture.marker.quarter2'
          : 'furniture.marker.quarter3'
    return i18n.t(key, { hizb: rub.hizb, ref })
  }

  function select(m: MarginMarker): void {
    reader.select(m.ayahId)
  }
</script>

{#if placed.length > 0}
  <div
    class="mp-margin mp-markers"
    aria-hidden="true"
    dir="rtl"
    lang="ar"
    data-labels={labels ? '' : undefined}
    data-decor={ornaments ? '' : undefined}
    style:--mk-label="{round2(labelSize(qfs))}px"
  >
    <!-- Keyed by the face too: decor arriving late re-creates the markers rather than moving them (CLS 0). -->
    {#each placed as { item, top, height } (`${item.key}|${ornaments}|${labels}`)}
      {#snippet marker(props: Record<string, unknown>)}
        <button
          {...props}
          type="button"
          tabindex={-1}
          class="mk"
          data-kind={item.kind}
          data-rub={item.rub?.kind}
          data-inline={item.inline ? '' : undefined}
          data-ayah={item.ayahId}
          data-line={item.line}
          style:top="{round2(top)}px"
          style:height="{round2(height)}px"
        >
          {#if !item.inline}
            {@const g = glyph(item)}
            <span
              class="mk-glyph"
              data-ornament={g.decor ? '' : undefined}
              style:font-size="{round2(g.fontSize)}px"
              style:height="{round2(g.height)}px"
              style:line-height="{round2(g.height)}px"
              style:--shift="{Math.round(g.shift * 1000) / 1000}em"
              style:--mk-stroke={g.decor ? `${round2(g.stroke)}px` : undefined}>{g.ink.char}</span
            >
            {#if g.inset}
              <span
                class="mk-inset"
                style:top="{round2(g.inset.top)}px"
                style:font-size="{round2(g.inset.fontSize)}px">{g.inset.text}</span
              >
            {/if}
          {/if}
          {#if labels}
            <span class="mk-label">{item.lines.join('\n')}</span>
          {/if}
        </button>
      {/snippet}
      {#if interactive}
        <Tooltip side={tooltipSide} delay={300}>
          {#snippet content()}
            <span class="mk-tip">
              <span class="mk-tip-label" lang="ar" dir="rtl">{item.label}</span>
              <span class="mk-tip-text">{description(item)}</span>
              <span class="mk-tip-hint">{i18n.t('furniture.marker.select')}</span>
            </span>
          {/snippet}
          {#snippet children({ props })}
            {@render marker(mergeProps(props, { onclick: () => select(item) }))}
          {/snippet}
        </Tooltip>
      {:else}
        {@render marker({ disabled: true })}
      {/if}
    {/each}
  </div>
{/if}
