<!--
  PageFooter. The page number in Eastern Arabic numbers, centred under the text block in a 1.1·qfs medallion (a 12-lobed
  rosette in --frame-gold, its whole interior tinted 10 % gold: one path, filled and stroked, so the shading follows the
  lobes at every size), in the bundled Naskh (qd-hafs, `--mp-furniture-font`) at max(0.55·qfs, 12px).

  Decorative and `aria-hidden` (the page's accessible name carries the number), with `pointer-events: none`: the
  rendition stack's font-status dot sits in the same band towards the spine and must stay hoverable. A plain
  `div`, not a `footer`: page furniture is no contentinfo landmark (pages also show inside dialogs, the onboarding).
-->
<script lang="ts">
  import type { PageFurnitureProps } from '$lib/contracts/components'
  import { arabicNum, footerMedallion, round2 } from '$lib/mushaf/ornaments'

  let { data, qfs }: PageFurnitureProps = $props()

  const m = $derived(footerMedallion(qfs))
</script>

<div class="mp-foot" aria-hidden="true">
  <span class="mp-foot-medallion">
    <svg
      width={round2(m.size)}
      height={round2(m.size)}
      viewBox="0 0 {round2(m.size)} {round2(m.size)}"
      focusable="false"
    >
      <path class="rosette" d={m.rosette} stroke-width={round2(m.stroke)} />
    </svg>
    <span class="mp-foot-num" lang="ar">{arabicNum(data.page)}</span>
  </span>
</div>
