<!--
  MushafPage (§8.3, §7.5, §7.9). Owner: WP8a. One printed page, in fixed geometry derived from `qfs` alone (§8.2):

    section.mp ─ .mp-paper · PageFrame · RunningHead
               ─ .mp-block[dir=rtl lang=ar] { HighlightLayer · RenditionStack { GlyphLayer × 1–2 } · A11yLayer }
               ─ MarginMarkers · MarginMarks · PageFooter

  Geometry and line CSS live in `src/styles/mushaf/{page,lines}.css` (layer `mushaf`, so the spread, frame and highlight
  sheets of other packages can refine it). The page provides its context (`qfs`, side, interactivity) to the layers
  inside it, collects the rendition's word boxes for the highlight layer, and records `performance.measure('qd:page')`
  after each render (§8.18).

  `interactive={false}` (onboarding thumbnails, the Settings preview) renders an inert, decorative page: no pointer
  interactions, no highlight layer and no roving a11y items. `furniture={false}` leaves out the frame, heads, margins
  and footer. `ornaments` overrides the `ornateHeaders` setting for this page (the onboarding's Mushaf preview shows
  the choice before it is saved): the header, basmala, running head and margin layers read it from the page context.
-->
<script lang="ts">
  import type { MushafPageProps, WordBox } from '$lib/contracts/components'
  import { isOpeningPage, isSyntheticPage, setPageContext } from '$lib/mushaf/geometry'
  import { i18n, quran, settings } from '$lib/stores'
  import A11yLayer from './A11yLayer.svelte'
  import HighlightLayer from './HighlightLayer.svelte'
  import MarginMarkers from './MarginMarkers.svelte'
  import MarginMarks from './MarginMarks.svelte'
  import PageFooter from './PageFooter.svelte'
  import PageFrame from './PageFrame.svelte'
  import RenditionStack from './RenditionStack.svelte'
  import RunningHead from './RunningHead.svelte'

  let { data, qfs, side, interactive = true, furniture = true, ornaments }: MushafPageProps = $props()

  setPageContext({
    get page() {
      return data.page
    },
    get qfs() {
      return qfs
    },
    get side() {
      return side
    },
    get interactive() {
      return interactive
    },
    get ornaments() {
      return ornaments ?? settings.value.ornateHeaders
    },
  })

  const opening = $derived(isOpeningPage(data.page))
  const label = $derived(
    i18n.t('mushaf.page.label', {
      page: data.page,
      surah: quran.surahName(data.info.headSurah),
      juz: data.info.juz,
    }),
  )
  /** Browser mock only: the page was invented outside the fixture list (`__MOCK_IPC__` drops it from production). */
  const synthetic = $derived(__MOCK_IPC__ && isSyntheticPage(data))

  /** Word boxes of the visible rendition, after line-fit (§8.7): the highlight layer's only geometry input. */
  let boxes = $state.raw<readonly WordBox[]>([])
  function onmeasure(next: WordBox[]): void {
    boxes = next
  }

  // §8.18 `qd:page`: from receiving the page data to its DOM being committed.
  let renderStart = performance.now()
  let firstRender = true
  $effect.pre(() => {
    void data
    if (firstRender) firstRender = false
    else renderStart = performance.now()
  })
  $effect(() => {
    const { page, style } = data
    try {
      performance.measure('qd:page', { start: renderStart, detail: { page, style, interactive } })
    } catch {
      // A measure is diagnostics only; an unsupported or full performance timeline must never break rendering.
    }
  })
</script>

<section
  class="mp"
  data-page={data.page}
  data-side={side}
  data-style={data.style}
  data-layout={data.layout}
  data-opening={opening ? '' : undefined}
  aria-roledescription={interactive ? i18n.t('mushaf.page.roleDescription') : undefined}
  aria-label={interactive ? label : undefined}
  aria-hidden={interactive ? undefined : 'true'}
  inert={!interactive}
  style:--qfs={`${qfs}px`}
>
  <div class="mp-paper"></div>
  {#if furniture}
    <PageFrame {data} {qfs} {side} />
    <RunningHead {data} {qfs} {side} />
  {/if}
  <div class="mp-block" dir="rtl" lang="ar">
    {#if interactive}
      <HighlightLayer {data} {qfs} {boxes} />
    {/if}
    <RenditionStack {data} {qfs} {onmeasure} />
    {#if interactive}
      <A11yLayer {data} />
    {/if}
  </div>
  {#if furniture}
    <MarginMarkers {data} {qfs} {side} />
    <MarginMarks {data} {qfs} {side} />
    <PageFooter {data} {qfs} {side} />
  {/if}
  {#if __MOCK_IPC__ && synthetic}
    <p class="synthetic" lang={i18n.locale} dir={i18n.dir} title={i18n.t('mushaf.synthetic.hint')}>
      {i18n.t('mushaf.synthetic.badge')}
    </p>
  {/if}
</section>

<style>
  /* Browser mock only (§4.6): marks a page the mock invented outside the exported fixtures. */
  .synthetic {
    position: absolute;
    inset-block-start: calc(var(--qfs) * 0.35);
    inset-inline: 0;
    z-index: 3;
    inline-size: max-content;
    margin-inline: auto;
    padding: 1px var(--space-2);
    border: 1px dashed var(--warning);
    border-radius: var(--radius-full);
    background: var(--warning-soft);
    color: var(--warning-text);
    font-family: var(--font-ui);
    font-size: var(--text-2xs);
    font-weight: var(--weight-label);
    line-height: 1.5;
  }
</style>
