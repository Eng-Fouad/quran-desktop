<!--
  PageFooter (§8.9). Owner: WP8c. The page number in Arabic-Indic digits, centred under the text block in a 1.1·qfs
  medallion (a disc inside a scalloped rosette ring, --frame-gold), in the bundled Naskh (qd-hafs,
  `--mp-furniture-font`) at max(0.55·qfs, 12px).

  Decorative and `aria-hidden` (the page's accessible name carries the number), with `pointer-events: none`: the
  rendition stack's font-status dot sits in the same band towards the spine and must stay hoverable (WP8b). A plain
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
      <path class="ring" d={m.ring} stroke-width={round2(m.stroke)} />
      <circle
        class="disc"
        cx={round2(m.disc.cx)}
        cy={round2(m.disc.cy)}
        r={round2(m.disc.r)}
        stroke-width={round2(m.stroke * 0.6)}
      />
    </svg>
    <span class="mp-foot-num" lang="ar">{arabicNum(data.page)}</span>
  </span>
</div>
