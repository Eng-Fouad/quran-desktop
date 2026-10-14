<!--
  PageFrame. The page's ornamental frame, drawn as one SVG the size of the page (px from `qfs`):

    outer rule 0.09·qfs · interlace band 0.32·qfs on --frame-band · inner rule max(1px, 0.04·qfs)
    0.85·qfs corner blocks, each with an 8-point khatam (--frame-green stroke, 20 % gold fill)
    pages 1–2: the ogee-arched medallion around the 8 lines, its 12 rosettes and the illuminated spandrels

  The geometry comes from `frameGeometry()` (`ornaments.ts`), memoised per (qfs, side, opening), so the SVG changes only
  when `qfs` does. `showPageFrame = false` hides the SVG; nothing moves. The page-stack hairlines on the outer
  paper edge belong to the paper, not the frame: they stay, and frame.css shows them only inside a spread.
-->
<script lang="ts">
  import type { PageFurnitureProps } from '$lib/contracts/components'
  import { isOpeningPage } from '$lib/mushaf/geometry'
  import { bandTile, frameGeometry, round2, stackEdgeCount } from '$lib/mushaf/ornaments'
  import { settings } from '$lib/stores'
  import OpeningMedallion from './OpeningMedallion.svelte'

  let { data, qfs, side }: PageFurnitureProps = $props()

  const uid = $props.id()
  const opening = $derived(isOpeningPage(data.page))
  const g = $derived(frameGeometry(qfs, side, opening))
  const bands = $derived([
    { key: 'top', band: g.bands.top, pattern: `${uid}-h` },
    { key: 'bottom', band: g.bands.bottom, pattern: `${uid}-h` },
    { key: 'right', band: g.bands.right, pattern: `${uid}-v` },
    { key: 'left', band: g.bands.left, pattern: `${uid}-v` },
  ])
  const tileH = $derived(g.bands.top.tile)
  const tileV = $derived(g.bands.right.tile)
  const edges = $derived(stackEdgeCount(data.page, side))
</script>

{#if settings.value.showPageFrame && g.width > 0}
  <svg
    class="mp-frame"
    aria-hidden="true"
    focusable="false"
    width={round2(g.width)}
    height={round2(g.height)}
    viewBox="0 0 {round2(g.width)} {round2(g.height)}"
    data-opening={opening ? '' : undefined}
  >
    <defs>
      <pattern id="{uid}-h" patternUnits="userSpaceOnUse" width={tileH.w} height={tileH.h}>
        <path class="tile" d={bandTile(tileH.w, tileH.h)} stroke-width={g.tileStroke} />
      </pattern>
      <pattern id="{uid}-v" patternUnits="userSpaceOnUse" width={tileV.w} height={tileV.h}>
        <path class="tile" d={bandTile(tileV.w, tileV.h)} stroke-width={g.tileStroke} />
      </pattern>
    </defs>

    {#if g.medallion}
      <OpeningMedallion medallion={g.medallion} pattern="{uid}-h" />
    {/if}

    {#each bands as { key, band, pattern } (key)}
      <g transform="translate({round2(band.x)} {round2(band.y)})">
        <rect class="band" width={round2(band.w)} height={round2(band.h)} />
        <rect class="band-tile" width={round2(band.w)} height={round2(band.h)} fill="url(#{pattern})" />
      </g>
    {/each}

    <rect
      class="rule"
      x={round2(g.outerRule.x)}
      y={round2(g.outerRule.y)}
      width={round2(g.outerRule.w)}
      height={round2(g.outerRule.h)}
      stroke-width={round2(g.outerStroke)}
    />
    <path class="rule" d={g.innerRule} stroke-width={round2(g.innerStroke)} />
    <path class="rule" d={g.corners} stroke-width={round2(g.innerStroke)} />
    <path class="star" d={g.stars} stroke-width={round2(g.starStroke)} />
  </svg>
{/if}
<div class="mp-edges" aria-hidden="true" style:--edges={edges}>
  {#each { length: edges }, i (i)}
    <span style:--i={i + 1}></span>
  {/each}
</div>
