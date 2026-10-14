<!--
  SpreadStage. The book on the canvas: one page (single mode) or two facing pages (a spread), laid out in the canvas
  with its padding and the dock reserve, inside `MushafView`'s scroll area. Used only by `MushafView`, which shapes its
  props.

  - `.spread` holds `[odd, even]` in `direction: rtl`, so the odd page sits on the right. One page shadow is
    drawn by the spread itself, the spine is shaded on both pages and a hairline marks the fold (`spread.css`).
  - `.single` is `SINGLE_W = PW + 1.0` qfs wide and moves the *paper* ±0.5 qfs (`SHIFT`) by the page's side, so the text
    block stays put across page turns.
  - Both carry `view-transition-name: qd-spread`: a page turn animates this element only.
  - The stage reserves the bar dock's height under the pages and the side card's width at the inline end,
    and centres the book in what is left; once the book is larger than the canvas (zoom, `QFS_MIN`), it starts at the
    top and the canvas scrolls.
  - A slot whose page data has not arrived shows its blank paper in the final geometry (never a skeleton).
  - Pages are keyed by page number: a turn mounts fresh pages instead of moving the old page's furniture to new
    places, which the layout-shift metric would count (CLS 0). A style change keeps the page (and its rendition
    stack, which cross-fades the two styles).
  - It tells its pages which pages are on screen with them (`setSpreadContext`), so the hafs style takes one glyph
    scale per spread and facing pages always match (unicodeFit.ts).
-->
<script module lang="ts">
  import type { PageSide } from '$lib/contracts/components'
  import type { PageData } from '$lib/ipc/bindings'

  /** One page position of the stage. */
  export interface StageSlot {
    page: number
    side: PageSide
    /** `undefined` while the page data loads (blank paper is shown). */
    data: PageData | undefined
  }
</script>

<script lang="ts">
  import { setSpreadContext } from '$lib/mushaf/unicodeFit'
  import MushafPage from './MushafPage.svelte'

  interface Props {
    slots: readonly StageSlot[]
    qfs: number
    spread: boolean
    /** Canvas padding around the book (px): `PAD_X` at the sides, `PAD_Y` above and below. */
    padX?: number
    padY?: number
    /** Space kept free at the inline end for the side dock card (px). */
    reserveEnd?: number
    /** Space kept free under the pages for the bar dock (px). */
    reserveBottom?: number
  }

  let { slots, qfs, spread, padX = 24, padY = 16, reserveEnd = 0, reserveBottom = 0 }: Props = $props()

  const spreadPages = $derived(slots.map((s) => s.data))
  setSpreadContext({
    get pages() {
      return spreadPages
    },
  })
</script>

<div
  class="mv-stage"
  style:--stage-pad-x={`${padX}px`}
  style:--stage-pad-y={`${padY}px`}
  style:--stage-end={`${reserveEnd}px`}
  style:--stage-bottom={`${reserveBottom}px`}
>
  <div
    class={spread ? 'spread' : 'single'}
    data-qd-stage=""
    data-pages={slots.map((s) => s.page).join(' ')}
    style:--qfs={`${qfs}px`}
  >
    {#each slots as slot (slot.page)}
      {#if slot.data}
        <MushafPage data={slot.data} {qfs} side={slot.side} />
      {:else}
        <div class="mp mp-blank" data-page={slot.page} data-side={slot.side} aria-hidden="true">
          <div class="mp-paper"></div>
        </div>
      {/if}
    {/each}
  </div>
</div>

<style>
  /* PAD_Y above and below, PAD_X at the sides, plus the dock reserve; the book is centred in what is left. */
  .mv-stage {
    box-sizing: border-box;
    display: flex;
    min-inline-size: 100%;
    min-block-size: 100%;
    padding-block: var(--stage-pad-y) calc(var(--stage-pad-y) + var(--stage-bottom));
    padding-inline: var(--stage-pad-x) calc(var(--stage-pad-x) + var(--stage-end));
  }

  /* Auto margins centre the book while it fits and pin it to the start once it overflows (it stays scrollable). */
  .mv-stage > :global([data-qd-stage]) {
    margin: auto;
  }
</style>
