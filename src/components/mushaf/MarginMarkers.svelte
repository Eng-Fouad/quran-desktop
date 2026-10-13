<!--
  MarginMarkers (§8.9). Owner: WP8c. The division and sajda markers in the page's outer margin (M_OUT), in --marker-ink.
  One family at every page size, whether or not the ayah's first word carries the ۞ inline (LEAD 17: the text keeps
  it; owner request 2026-10-13, after the printed Mushaf):

  - a rub start (`flags & 1`, the mushaf-source rub, D6), with decor (the page's ornaments are on:
    `MushafPageProps.ornaments`, else `ornateHeaders`, and quran-common is loaded) and the bundled print-labels face:
    the print's ornament, its label inside it (`markerInk`, `markerLabelTop`). A quarter, a half or three quarters
    hangs the lamp (U+FC22 at 3.56·qfs: a crest over an arched box) with «رُبُع» / «الحِزۡبُ» / «٢٧» in its box; a hizb
    start the medallion (U+FC23 at 3.72·qfs: crest, frame, crest) with «الحِزۡبُ» / «٢٧» in its frame; a juz start the
    same medallion at 4.48·qfs with «الجُزۡءُ ١٤» / «الحِزۡبُ ٢٧». The box (the label's ink centre) sits on the line's
    centre, the crests rise above it (and the medallion's below). An ornament's advance (1 em) is wider than the
    margin, so its box is its ink's width and the glyph is centred on it; its hairlines are thickened
    (`-webkit-text-stroke`, `decorStroke`) so it reads at 3:1;
  - a rub start without decor: the solid ۞ in qd-hafs, its label under it;
  - a sajda: ۩ beside the line where its ayah ends, «سجدة» under it from qfs 28.

  A rub start's label is the 1441H print's own (LEAD 25): its stacked calligraphy in the bundled `qd-print-labels`
  face (U+F800 + rub), at one size for the whole margin (`MARGIN_LABEL_EM`·qfs) in a box as tall as the ink of its
  kind of label (`marginLabelBox`), its hairlines thickened like the ornament's, drawn whatever `ornateHeaders` says
  (bundled print furniture) and at every page size. Glyphs are sized by their measured ink, not their em (۞ and ۩
  0.75·qfs tall, ≥ 13 px; `markerGlyphBox`). Without that face no ornament is drawn: ۞ with the Hafs words under it
  (`rubLabelLines`: الجزء ١٤ · الحزب ٢٧, or a quarter's words over its hizb, ربع / نصف / ثلاثة أرباع over الحزب ٢٧), at
  max(0.36·qfs, 11px), which need 0.36·qfs ≥ 10 (qfs ≥ 28) like the sajda's: smaller pages draw the glyph alone and the
  running head carries the quarter. The tooltip always has the Hafs words, and a print label carries them in
  `data-text`.

  The furniture is Arabic in every UI language, so the column carries `dir="rtl" lang="ar"` itself, as the running
  head does: inside a settings or onboarding preview no `.spread` gives it a direction.

  A marker alone on its line meets it at its anchor (`markerAnchor`): a rub start's label, in its ornament or under its
  ۞ (which then stands above the line as a crest does, so decor arriving late moves no label), else its middle. Markers
  sharing a line stack 0.2·qfs apart, centred on the line, but a lamp keeps its box on the line with the ۩ under it.
  An ornament's ink is drawn over the page bookmark's dog-ear (a line-1 lamp reaches into it); the marks are drawn over
  the markers and keep clear of them (`placeMarks`). On an interactive page each marker is a pointer target: its
  tooltip shows the full label and a description in the UI language, a click selects the ayah. The container is
  `aria-hidden` (the a11y layer announces divisions); the targets are `tabindex=-1`.
-->
<script lang="ts">
  import { Tooltip } from '$components/ui'
  import { mergeProps } from 'bits-ui'
  import type { PageFurnitureProps } from '$lib/contracts/components'
  import { getPageContext } from '$lib/mushaf/geometry'
  import {
    decorStroke,
    isDecorInk,
    labelSize,
    marginLabelsVisible,
    markerGlyphBox,
    markerInk,
    markerLabelShown,
    markerLabelTop,
    markerPrintLabel,
    pageMarkers,
    placeMarkers,
    round2,
    type MarginMarker,
  } from '$lib/mushaf/ornaments'
  import { marginLabelBox, marginLabelStroke } from '$lib/mushaf/printLabels'
  import { fonts, i18n, reader, settings } from '$lib/stores'

  let { data, qfs, side }: PageFurnitureProps = $props()

  const page = getPageContext()
  const interactive = $derived(page?.interactive ?? false)
  const labels = $derived(marginLabelsVisible(qfs))
  /** The page's ornaments are on and the quran-common face is loaded. */
  const decor = $derived(
    (page?.ornaments ?? settings.value.ornateHeaders) && fonts.status.get('qd-quran-common') === 'ready',
  )
  /** The print's own rub labels (the bundled face is loaded); else the Hafs words. */
  const print = $derived(fonts.printLabelsReady)
  /** The ornaments are drawn: decor, and the print's labels to hold (`markerInk`). */
  const ornaments = $derived(decor && print)
  const placed = $derived(
    settings.value.showMarginMarkers
      ? placeMarkers(pageMarkers(data), qfs, labels, decor, false, print).placed
      : [],
  )
  /** Tooltips open away from the text block, into the canvas beside the page. */
  const tooltipSide = $derived(side === 'right' ? 'right' : 'left')

  /** The glyph, its font, the box that centres its ink (sized by ink, not em), and an ornament's ink width. */
  function glyph(m: MarginMarker) {
    const ink = markerInk(m, decor, print)
    const box = markerGlyphBox(qfs, ink)
    const decorGlyph = isDecorInk(ink)
    return {
      ink,
      ...box,
      decor: decorGlyph,
      width: decorGlyph && ink.width !== undefined ? ink.width * box.fontSize : null,
      stroke: decorGlyph ? decorStroke(box.fontSize) : 0,
    }
  }

  /**
   * A rub start's print label: the glyph, its font size, its box (the ink of its kind), the shift onto it, and its top
   * inside an ornament (null: under the ۞).
   */
  function printLabel(m: MarginMarker) {
    const ink = markerPrintLabel(m, print)
    if (!ink) return null
    return { char: ink.char, ...marginLabelBox(qfs, ink), top: markerLabelTop(m, qfs, decor, print) }
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
    {#each placed as { item, top, height } (`${item.key}|${ornaments}|${labels}|${print}`)}
      {#snippet marker(props: Record<string, unknown>)}
        {@const g = glyph(item)}
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
          <span
            class="mk-glyph"
            data-ornament={g.decor ? '' : undefined}
            style:font-size="{round2(g.fontSize)}px"
            style:height="{round2(g.height)}px"
            style:line-height="{round2(g.height)}px"
            style:width={g.width === null ? undefined : `${round2(g.width)}px`}
            style:--shift="{Math.round(g.shift * 1000) / 1000}em"
            style:--mk-stroke={g.decor ? `${round2(g.stroke)}px` : undefined}>{g.ink.char}</span
          >
          {#if markerLabelShown(item, labels, print)}
            {@const p = printLabel(item)}
            {#if p}
              <span
                class="mk-label"
                data-print=""
                data-inside={p.top === null ? undefined : ''}
                data-text={item.lines.join('\n')}
                style:top={p.top === null ? undefined : `${round2(p.top)}px`}
                style:font-size="{round2(p.fontSize)}px"
                style:height="{round2(p.height)}px"
                style:--mk-label-stroke="{round2(marginLabelStroke(p.fontSize))}px"
                style:--shift="{Math.round(p.shift * 1000) / 1000}em">{p.char}</span
              >
            {:else}
              <span class="mk-label">{item.lines.join('\n')}</span>
            {/if}
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
