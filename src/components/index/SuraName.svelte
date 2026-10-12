<!--
  SuraName (§9.7): a surah's name in the sura-names decor calligraphy (`qd-sura-names`), boxed by its ink. The face
  leaves 0.17–0.41 em of empty advance on the left of every name and draws Yusuf's first letter 0.25 em past the right
  of its advance, so names aligned by their advance look ragged at either end. Here the box ends where the ink ends (it
  is as wide as the ink's extent from the glyph's origin) and a negative margin of the ink's offset from the origin
  moves its start to where the ink starts, whatever the advance (`suraNameInk`): wherever a row aligns the name, at its
  inline end in the English UI (the right) or in the Arabic UI (the left), the ink lines up. The glyph is a private-use
  character: hidden from assistive technology (rows name the surah). Render it only once the face is ready; the caller
  shows Naskh text, or nothing, before. Used by SurahList, PaletteRow and SurahInfoPopover. Owner: WP10a.
-->
<script lang="ts">
  import { SURA_NAMES_FAMILY, suraNameGlyph, suraNameInk } from '$lib/mushaf/suraNames'

  interface Props {
    /** The surah, 1–114. */
    n: number
    /** Font size in px (26 in lists, 30 in the surah info popover). */
    size: number
  }

  let { n, size }: Props = $props()

  const ink = $derived(suraNameInk(n))
</script>

<!--
  Left to right: the name is one private-use glyph (bidi class L), drawn the same either way, and the box's inline
  start is then the glyph's origin (its left). The advance past the ink overflows the box, empty.
-->
<span
  class="glyph"
  lang="ar"
  dir="ltr"
  aria-hidden="true"
  style:font-family={SURA_NAMES_FAMILY}
  style:font-size="{size}px"
  style:inline-size={ink ? `${ink.right}em` : undefined}
  style:margin-inline-start={ink ? `${-ink.left}em` : undefined}>{suraNameGlyph(n)}</span
>

<style>
  .glyph {
    display: inline-block;
    flex: none;
    color: var(--text);
    line-height: 1;
    text-align: start;
    white-space: nowrap;
  }
</style>
