<!--
  OpeningMedallion (§8.9). Owner: WP8c; used only by `PageFrame`, inside its SVG. The opening pages (1–2) set their 8
  lines in an arched medallion, as the printed opening spread does: an ogee-topped field with straight sides and the
  mirrored ogee below, a 0.06·qfs outline in --frame-gold with a fine companion line inside, twelve small rosettes
  (khatams in --frame-green) on the outline, and the spandrels around it filled with the frame's interlace on
  --frame-band, so the page reads as illuminated around a calm reading field.
-->
<svelte:options namespace="svg" />

<script lang="ts">
  import type { MedallionGeometry } from '$lib/mushaf/ornaments'
  import { round2 } from '$lib/mushaf/ornaments'

  interface Props {
    medallion: MedallionGeometry
    /** The id of the frame's interlace `<pattern>` (horizontal tiles) that fills the spandrels. */
    pattern: string
  }

  let { medallion: m, pattern }: Props = $props()
</script>

<g class="opening">
  <path class="spandrel" d={m.spandrels} fill-rule="evenodd" />
  <path class="spandrel-tile" d={m.spandrels} fill-rule="evenodd" fill="url(#{pattern})" />
  <path class="medallion-field" d={m.outline} />
  <path class="medallion" d={m.outline} stroke-width={round2(m.stroke)} />
  <path class="medallion-inner" d={m.inner} stroke-width={round2(m.innerStroke)} />
  <path class="rosette" d={m.rosettePaths} stroke-width={round2(m.innerStroke)} />
  <path class="star" d={m.rosetteStars} stroke-width={round2(m.innerStroke)} />
</g>
