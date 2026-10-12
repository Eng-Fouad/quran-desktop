<!--
  RenditionStack (§8.5, D13). Owner: WP8b. The glyph renditions of one page, stacked in `.mp-block`, and the swap
  between them: the bundled-Hafs fallback while a QCF page font is not available, the QCF rendition once it is, and the
  old style's rendition while a style change brings the new one in. Every rendition is a `GlyphLayer` (an absolutely
  positioned `.mp-glyphs` filling the block), so a swap never moves a box (CLS 0, §8.1).

  First render of page P in style S (§8.5):
    (a) the face is loaded and, on a reader page, its glyphs are warm (warmup.ts) → the QCF rendition, directly;
    (b) else `fonts.ensure(S, [P], 'interactive')` and wait up to 120 ms: a file already on disk loads in a few ms and
        is drawn directly, so it never shows the fallback (nothing is drawn while waiting: paper and furniture are).
        A reader page whose face is loaded but whose glyphs are cold has them measured and shaped urgently in slices
        (`shapeWarmer.need`, ≈ 30 ms a page) and is drawn once they are, so its first layout is never one long task
        (§8.18); a face that arrives late gives the warm-up `GLYPH_WAIT_MS` more. Flipping never waits (§8.11): a page
        not yet painted in its QCF font at this size shows the fallback (a new page's glyphs would stall the flip's
        frames, warmup.ts), and the QCF rendition cross-fades in once the flip has ended;
    (c) else the fallback rendition (Unicode text in `qd-hafs`, hafs metrics, the same line boxes). When the face
        becomes ready, a second rendition mounts at opacity 0 (page.css hides a rendition stacked over another from
        its first style), is fitted and measured, then cross-fades in over `--dur-glyph-swap` (0 ms under reduced
        motion) while the old one fades out and is removed.
  A style change on the same page is a swap too: the old style's rendition stays until the new one cross-fades in.
  A different page starts afresh (no cross-fade between pages). Every QCF rendition holds its face (`fonts.track`)
  while it is in the stack, so leaving a style unloads its faces only once nothing draws them any more.

  Every rendition is line-fitted (`fitLines`) once its font is ready and measured (`measure`) for the highlight layer
  (`onmeasure`), and again after a `qfs` change. The first V4 page shown runs the COLR probe before it paints.

  The hafs style's rendition takes the glyph scale of the spread it is on (unicodeFit.ts: one value for the pages
  `SpreadStage` shows together in that style, fitted to their widest line), so facing pages always match. It is known
  before the first layout; while the other page of the spread is still loading, the page waits for it (at most
  `FONT_WAIT_MS`), so it is laid out once, at its final size. A later change (the other page arriving after the wait, a
  single page joining a spread) refits it in place. The fallback of a QCF style is transient (it never faces a page in
  the same rendition for long, and it is what a flip draws) and keeps the measured hafs scale.

  While the page shows the fallback because its font is `unavailable` or `failed`, a subtle dot in the footer band says
  so (§9.8); on `failed`, the dot retries (click or Enter).
-->
<script module lang="ts">
  /** §8.5 (b): how long a page waits for its QCF face before it paints the Hafs fallback. */
  export const FONT_WAIT_MS = 120
  /** How long a reader page whose face arrived during the wait still waits for its glyphs (warmup.ts). */
  export const GLYPH_WAIT_MS = 100

  /** A rendition serial: new renditions always mount after (on top of) the older ones. */
  let serial = 0
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte'
  import Tooltip from '$components/ui/Tooltip.svelte'
  import type { RenditionKind, RenditionStackProps, WordBox } from '$lib/contracts/components'
  import type { MushafStyle, PageData } from '$lib/ipc/bindings'
  import { fitLines, getPageContext } from '$lib/mushaf/geometry'
  import { measure } from '$lib/mushaf/layout'
  import { STYLE_METRICS } from '$lib/mushaf/metrics'
  import { getSpreadContext, unicodeScale } from '$lib/mushaf/unicodeFit'
  import { glyphKey, shapeWarmer, warmPageOf } from '$lib/mushaf/warmup'
  import { fonts, i18n, reader } from '$lib/stores'
  import GlyphLayer from './GlyphLayer.svelte'

  let { data, qfs, onmeasure }: RenditionStackProps = $props()

  const pageContext = getPageContext()
  const interactive = $derived(pageContext?.interactive ?? false)
  const side = $derived(pageContext?.side ?? 'right')
  const spreadContext = getSpreadContext()

  interface Layer {
    key: number
    data: PageData
    kind: RenditionKind
    family: string
    /** The style's measured scale; the hafs style's rendition draws at its spread's (`spreadGlyphScale`) instead. */
    glyphScale: number
    centerGap: number
    /** `entering`: mounted at opacity 0, waiting to cross-fade in; `leaving`: fading out, removed after the fade. */
    phase: 'entering' | 'shown' | 'leaving'
  }

  /** The hafs style's rendition: Unicode text fitted per spread (unicodeFit.ts). */
  const fitsSpread = (l: Layer) => l.data.style === 'hafs'

  let layers = $state.raw<Layer[]>([])
  /** The `.mp-glyphs` element of each rendition (bound from `GlyphLayer`). */
  const elements: Record<number, HTMLElement | null | undefined> = $state({})

  const style: MushafStyle = $derived(data.style)
  /** The page number alone (fresh page data for the same page does not restart the subject). */
  const pageNo = $derived(data.page)
  const subject = $derived(`${pageNo}:${style}`)
  const fontState = $derived(fonts.state(style, pageNo))
  /** QCF V4 on a webview that cannot draw COLR (§8.6): keep the fallback until the style switches to V2. */
  const v4Blocked = $derived(style === 'qcf_v4' && fonts.v4Supported === false)
  const qcfReady = $derived(style === 'hafs' || (fonts.isReady(style, pageNo) && !v4Blocked))
  /** The first V4 page waits for the COLR probe before it paints (§8.6). */
  const needsProbe = $derived(style === 'qcf_v4' && qcfReady && fonts.v4Supported === null)

  /** §8.5 (b): the page is waiting for its face (at most `FONT_WAIT_MS`). */
  let waiting = $state(false)
  /** The subject whose COLR probe has finished (whatever its result). */
  let probed = $state<string | null>(null)
  let retrying = $state(false)

  /** The rendition the reader sees (the newest that is not fading out). */
  const current = $derived(layers.findLast((l) => l.phase !== 'leaving'))

  /** The hidden host this page's glyphs are warmed in (reader pages only). */
  let warmHost: HTMLElement | null = $state(null)
  /** This page's glyphs at this size (warmup.ts); `null` for hafs, whose one bundled face is shared by every page. */
  const glyphs = $derived(style === 'hafs' ? null : glyphKey(style, pageNo, qfs))
  /**
   * A reader page draws its QCF rendition once its glyphs are warm, so that first layout is never a long task
   * (§8.18); while the reader flips, only once it has been painted in that font before (its glyph images exist). A
   * page that shows its QCF rendition already keeps it (a new size refits it in place); thumbnails and previews never
   * wait.
   */
  const glyphsReady = $derived(
    !interactive ||
      glyphs === null ||
      (current?.kind === 'qcf' && current.data.page === pageNo && current.data.style === style) ||
      (reader.flipping ? shapeWarmer.wasPainted(glyphs) : shapeWarmer.hasGlyphs(glyphs)),
  )

  /**
   * The pages on screen with this one in its style, this one included (`SpreadStage`; a facing page still showing the
   * previous style counts as loading), else this page alone.
   */
  const together: readonly (PageData | undefined)[] = $derived.by(() => {
    const all = spreadContext?.pages ?? []
    if (!all.some((d) => d?.page === pageNo)) return [data]
    return all.map((d) => (d?.page === pageNo ? data : d?.style === style ? d : undefined))
  })
  /** Every page of the spread has its data in this style. */
  const togetherLoaded = $derived(together.every((d) => d !== undefined))
  /** `--glyph-scale` of the hafs style's rendition: one value per spread (unicodeFit.ts). */
  const spreadGlyphScale = $derived(unicodeScale(together.filter((d): d is PageData => d !== undefined)))

  /** The other page of the spread has kept this hafs page waiting for `FONT_WAIT_MS`: it draws without it. */
  let spreadWaitOver = $state(false)
  $effect(() => {
    if (style !== 'hafs' || togetherLoaded) return
    spreadWaitOver = false
    const timer = setTimeout(() => (spreadWaitOver = true), FONT_WAIT_MS)
    return () => clearTimeout(timer)
  })
  /** The spread's scale is final (or the wait for the other page is over). */
  const scaleSettled = $derived(togetherLoaded || spreadWaitOver)

  /**
   * What the page should show now: `null` = keep what is there (waiting for the face, its glyphs, the probe, or a
   * hafs page for the other page of its spread).
   */
  const desired: RenditionKind | null = $derived.by(() => {
    if (qcfReady && glyphsReady) {
      if (needsProbe && probed !== subject) return null
      return style === 'hafs' && !scaleSettled ? null : 'qcf'
    }
    return waiting ? null : 'fallback'
  })

  /** The §9.8 footer dot. */
  const notice: 'unavailable' | 'failed' | 'retrying' | null = $derived.by(() => {
    if (!interactive || style === 'hafs' || v4Blocked) return null
    if (fontState === 'unavailable') return 'unavailable'
    if (fontState === 'failed') return 'failed'
    if (fontState === 'loading' && retrying) return 'retrying'
    return null
  })
  const noticeText = $derived(
    notice === 'unavailable'
      ? i18n.t('fonts.dot.offline')
      : notice === 'retrying'
        ? i18n.t('fonts.dot.retrying')
        : i18n.t('fonts.dot.failed'),
  )

  // --- subject: track the page, ensure its font, wait up to 120 ms --------------------------------------------------

  $effect(() => {
    const s = style
    const p = pageNo
    const release = fonts.track(s, p)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    untrack(() => {
      retrying = false
      /** The face is loaded but a reader page's glyphs are still cold (their warm-up runs now). */
      const coldGlyphs = () =>
        interactive && s !== 'hafs' && fonts.isReady(s, p) && !shapeWarmer.hasGlyphsNow(glyphKey(s, p, qfs))
      if (s === 'hafs' || (fonts.isReady(s, p) && !coldGlyphs()) || reader.flipping) {
        // Flipping never waits (§8.11): what is not ready shows the fallback at once.
        waiting = false
        if (s !== 'hafs' && !fonts.isReady(s, p)) void fonts.ensure(s, [p], 'interactive')
        return
      }
      waiting = true
      const stopWaitingIn = (ms: number) => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          if (!cancelled) waiting = false
        }, ms)
      }
      stopWaitingIn(FONT_WAIT_MS)
      // Settled either way (ready, failed or unavailable): no reason to wait any longer, unless the face is here and
      // its glyphs are being warmed (a little longer for those: `desired` draws it as soon as they are warm).
      void fonts.ensure(s, [p], 'interactive').then(() => {
        if (cancelled) return
        if (coldGlyphs()) stopWaitingIn(GLYPH_WAIT_MS)
        else waiting = false
      })
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
      release()
    }
  })

  // --- the warm-up of this page's glyphs (warmup.ts) ----------------------------------------------------------------

  $effect(() => {
    const host = warmHost
    const d = data
    // Not while flipping: the flip shows the fallback (above); the warm-up runs once the reader rests on a page.
    if (!host || glyphs === null || glyphsReady || !qcfReady || d.style === 'hafs' || reader.flipping) return
    const page = warmPageOf(d, qfs)
    return untrack(() => shapeWarmer.need(host, page, fonts.faceEpoch))
  })

  /**
   * A QCF rendition laid out at this size leaves its glyphs (and words) warm, so the neighbours' warm-up skips it, and
   * it is painted next, so a flip may show it again.
   */
  function markLaidOut(layer: Layer): void {
    if (layer.kind !== 'qcf' || layer.data.style === 'hafs') return
    const key = glyphKey(layer.data.style, layer.data.page, qfs)
    shapeWarmer.markWarm(
      key,
      untrack(() => fonts.faceEpoch),
    )
    shapeWarmer.markPainted(key)
  }

  // --- every QCF rendition holds its face while it is mounted --------------------------------------------------------

  /**
   * A QCF rendition keeps its face loaded for as long as it is in the stack, a fading-out one included: after a style
   * change the old style's rendition is still drawn until the new one has cross-faded in, and the fonts store unloads a
   * left style's faces as soon as nothing holds them (§8.5). Per rendition key, the release of its hold (plain,
   * deliberately not reactive, like `prepared`).
   */
  const holds: Record<number, () => void> = {}

  $effect(() => {
    const live = layers.filter((l) => l.kind === 'qcf' && l.data.style !== 'hafs')
    for (const layer of live) {
      if (holds[layer.key]) continue
      const { style: s, page: p } = layer.data
      holds[layer.key] = untrack(() => fonts.track(s, p))
    }
    for (const key of Object.keys(holds).map(Number)) {
      if (live.some((l) => l.key === key)) continue
      const release = holds[key]
      delete holds[key]
      release?.()
    }
  })

  $effect(() => () => {
    for (const key of Object.keys(holds).map(Number)) {
      const release = holds[key]
      delete holds[key]
      release?.()
    }
  })

  // --- the COLR probe (first V4 page only) --------------------------------------------------------------------------

  $effect(() => {
    if (!needsProbe) return
    const d = data
    const key = subject
    untrack(() => {
      void fonts.probeV4(d).finally(() => (probed = key))
    })
  })

  // --- reconcile the stack with what should be shown ----------------------------------------------------------------

  /** The page the stack currently shows. */
  let shownPage = 0
  /**
   * The size, page data and spread scale (0 while no hafs rendition is in the stack) the renditions were last fitted for
   * (the refit effect skips a repeat).
   */
  let lastQfs = 0
  let lastData: PageData | null = null
  let lastScale = 0

  /** The spread scale the stack's hafs renditions are drawn at (0 while there is none). */
  function drawnScale(): number {
    return layers.some(fitsSpread) ? spreadGlyphScale : 0
  }

  $effect(() => {
    const d = data
    const kind = desired
    untrack(() => reconcile(d, kind))
  })

  function targetOf(d: PageData, kind: RenditionKind) {
    if (kind === 'fallback') return { kind, family: fonts.family('hafs', d.page), ...STYLE_METRICS.hafs }
    return { kind, family: fonts.family(d.style, d.page), ...STYLE_METRICS[d.style] }
  }

  function reconcile(d: PageData, kind: RenditionKind | null): void {
    if (d.page !== shownPage) {
      // Another page: start afresh. The old page's word boxes must not outlive it in the highlight layer.
      shownPage = d.page
      if (layers.length > 0) {
        drop(layers.map((l) => l.key))
        layers = []
        lastData = null
        onmeasure?.([])
      }
    }
    if (kind === null) return
    const target = targetOf(d, kind)
    const matches = (l: Layer | undefined): l is Layer =>
      l !== undefined && l.data.style === d.style && l.kind === target.kind && l.family === target.family
    const adopt = (l: Layer): Layer => (l.data === d ? l : { ...l, data: d })
    const top = layers.findLast((l) => l.phase !== 'leaving')
    if (matches(top)) {
      // The same rendition: adopt fresh page data (the refit effect fits and measures it again).
      if (top.data !== d) layers = layers.map((l) => (l === top ? adopt(l) : l))
      return
    }
    const shown = layers.findLast((l) => l.phase === 'shown')
    if (matches(shown)) {
      // Back to what is on screen before a newer rendition came in (a quick style toggle): no fade at all.
      drop(layers.filter((l) => l.phase === 'entering').map((l) => l.key))
      layers = layers.filter((l) => l.phase !== 'entering').map((l) => (l === shown ? adopt(l) : l))
      return
    }
    const layer: Layer = {
      key: ++serial,
      data: d,
      ...target,
      phase: layers.length > 0 ? 'entering' : 'shown',
    }
    layers = [...layers, layer]
  }

  // --- mount, fit, cross-fade ---------------------------------------------------------------------------------------

  /** Renditions already prepared (fitted, or set up for their cross-fade); plain, deliberately not reactive. */
  const prepared: Record<number, true> = {}
  let disposed = false

  $effect(() => {
    for (const layer of layers) {
      const el = elements[layer.key]
      if (el && !prepared[layer.key]) untrack(() => prepare(layer, el))
    }
  })

  $effect(() => {
    return () => {
      disposed = true
    }
  })

  /** Resolves once the rendition's font can be laid out (the QCF face is loaded by construction; qd-hafs may not be). */
  function fontReady(layer: Layer): Promise<void> | null {
    if (typeof document === 'undefined' || !document.fonts) return null
    const font = `${Math.max(1, qfs)}px "${layer.family}"`
    if (document.fonts.check(font)) return null
    return document.fonts.load(font).then(
      () => undefined,
      () => undefined,
    )
  }

  /** Fits the rendition's lines (§8.4) and measures its word boxes against `.mp-block`. */
  function fitAndMeasure(el: HTMLElement): WordBox[] {
    fitLines(el)
    const block = el.parentElement
    return block ? measure(el, block) : []
  }

  function prepare(layer: Layer, el: HTMLElement): void {
    prepared[layer.key] = true
    if (layer.phase === 'entering') {
      // Invisible from its first paint; the transition starts from 0 once it has been fitted.
      el.style.opacity = '0'
      const pending = fontReady(layer)
      if (pending) void pending.then(() => requestAnimationFrame(() => commit(layer.key)))
      else requestAnimationFrame(() => commit(layer.key))
      return
    }
    // Shown directly (first render): fit before the first paint when the font is ready, which it normally is.
    const pending = fontReady(layer)
    if (!pending) shownFitted(layer, el)
    else
      void pending.then(() =>
        requestAnimationFrame(() => {
          if (!disposed && elements[layer.key] === el) shownFitted(layer, el)
        }),
      )
  }

  /** Fits and measures a rendition shown directly, and records the size and data it was fitted for. */
  function shownFitted(layer: Layer, el: HTMLElement): void {
    lastQfs = qfs
    lastData = layer.data
    lastScale = drawnScale()
    onmeasure?.(fitAndMeasure(el))
    markLaidOut(layer)
  }

  /** The cross-fade (§8.5 c): fit and measure the new rendition, fade it in and the others out, then remove them. */
  function commit(key: number): void {
    if (disposed) return
    const layer = layers.find((l) => l.key === key)
    const el = elements[key]
    if (!layer || !el || layer.phase !== 'entering') return
    // A newer rendition already waits to come in: this one is superseded before it was ever visible.
    if (layers.some((l) => l.key > key && l.phase === 'entering')) return
    lastQfs = qfs
    lastData = layer.data
    lastScale = drawnScale()
    onmeasure?.(fitAndMeasure(el))
    markLaidOut(layer)
    const others = layers.filter((l) => l.key !== key)
    for (const other of others) {
      const otherEl = elements[other.key]
      if (!otherEl) continue
      otherEl.style.opacity = '0'
      otherEl.style.pointerEvents = 'none'
    }
    el.style.opacity = '1'
    layers = layers.map((l): Layer => {
      if (l.key === key) return { ...l, phase: 'shown' }
      return l.phase === 'leaving' ? l : { ...l, phase: 'leaving' }
    })
    const duration = transitionMs(el)
    if (duration <= 0) {
      finish(key)
      return
    }
    let done = false
    const end = () => {
      if (done) return
      done = true
      el.removeEventListener('transitionend', onEnd)
      clearTimeout(timer)
      finish(key)
    }
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === 'opacity') end()
    }
    el.addEventListener('transitionend', onEnd)
    // `transitionend` never fires when the transition is cancelled (hidden tab, removed node): a timer backs it up.
    const timer = setTimeout(end, duration + 80)
  }

  /**
   * After a cross-fade: the shown rendition stays, everything older goes. It keeps its inline opacity until they have
   * left the DOM: stacked over them, page.css would hide it again.
   */
  function finish(key: number): void {
    if (disposed) return
    const el = elements[key]
    const gone = layers.filter((l) => l.key < key).map((l) => l.key)
    if (gone.length === 0) {
      el?.style.removeProperty('opacity')
      return
    }
    drop(gone)
    layers = layers.filter((l) => l.key >= key)
    void tick().then(() => {
      if (!disposed && elements[key] === el) el?.style.removeProperty('opacity')
    })
  }

  /**
   * Forgets removed renditions. Their `bind:element` writes `null` back while they unmount, so the binding slots are
   * pruned once more after that flush.
   */
  function drop(keys: readonly number[]): void {
    for (const key of keys) {
      delete prepared[key]
      delete elements[key]
    }
    queueMicrotask(() => {
      for (const key of Object.keys(elements)) {
        if (!layers.some((l) => l.key === Number(key))) delete elements[Number(key)]
      }
    })
  }

  /** The opacity transition's duration in ms (`--dur-glyph-swap`; 0 under reduced motion). */
  function transitionMs(el: HTMLElement): number {
    const style = getComputedStyle(el)
    const properties = style.transitionProperty.split(',').map((p) => p.trim())
    const durations = style.transitionDuration.split(',').map((d) => d.trim())
    const delays = style.transitionDelay.split(',').map((d) => d.trim())
    const index = properties.findIndex((p) => p === 'opacity' || p === 'all')
    if (index < 0) return 0
    const ms = (value: string | undefined) => {
      if (!value) return 0
      const n = Number.parseFloat(value)
      if (!Number.isFinite(n)) return 0
      return value.endsWith('ms') ? n : n * 1000
    }
    // CSS repeats the duration and delay lists to match the property list.
    return (
      ms(durations[index % Math.max(1, durations.length)]) + ms(delays[index % Math.max(1, delays.length)])
    )
  }

  // --- refit after a qfs change, fresh page data or a new spread scale ----------------------------------------------

  $effect(() => {
    const size = qfs
    const top = current
    const topData = top?.data ?? null
    const scale = drawnScale()
    untrack(() => {
      // A hafs rendition leaving the stack (scale 0) needs no refit; a new one is fitted as it mounts.
      const changed = size !== lastQfs || topData !== lastData || (scale !== 0 && scale !== lastScale)
      lastQfs = size
      lastData = topData
      lastScale = scale
      if (!changed || !top) return
      // Fitted already by `prepare` when it was mounted for this size and data.
      for (const layer of layers) {
        const el = elements[layer.key]
        if (!el || !prepared[layer.key]) continue
        const boxes = fitAndMeasure(el)
        markLaidOut(layer)
        if (layer.key === top.key && top.phase === 'shown') onmeasure?.(boxes)
      }
    })
  })

  // --- the footer dot (§9.8) ----------------------------------------------------------------------------------------

  async function retry(): Promise<void> {
    if (notice !== 'failed') return
    retrying = true
    try {
      await fonts.retry(style, pageNo)
    } finally {
      retrying = false
    }
  }

  /** The tooltip trigger's own click handler (it closes the tooltip) runs first, then the retry. */
  function dotProps(props: Record<string, unknown>): Record<string, unknown> {
    const inner = props.onclick
    return {
      ...props,
      onclick: (e: MouseEvent) => {
        if (typeof inner === 'function') (inner as (e: MouseEvent) => void)(e)
        void retry()
      },
    }
  }
</script>

{#if interactive}
  <div class="qd-warm" aria-hidden="true" bind:this={warmHost}></div>
{/if}

{#each layers as layer (layer.key)}
  <GlyphLayer
    bind:element={elements[layer.key]}
    data={layer.data}
    rendition={layer.kind}
    family={layer.family}
    glyphScale={fitsSpread(layer) ? spreadGlyphScale : layer.glyphScale}
    centerGap={layer.centerGap}
  />
{/each}

{#if notice}
  <!-- Below the dot: the tooltip opens over the page's bottom margin, never over the text. -->
  <Tooltip content={tip} side="bottom">
    {#snippet children({ props })}
      <button
        {...dotProps(props)}
        type="button"
        class="rs-dot"
        data-side={side}
        data-state={notice}
        aria-label={notice === 'failed' ? i18n.t('fonts.dot.failedAction') : noticeText}
        aria-disabled={notice === 'failed' ? undefined : 'true'}
      >
        <span class="rs-mark" aria-hidden="true"></span>
      </button>
    {/snippet}
  </Tooltip>
{/if}

{#snippet tip()}
  <span class="rs-tip">
    <span>{noticeText}</span>
    {#if notice === 'failed'}
      <span class="rs-tip-action">{i18n.t('fonts.dot.retry')}</span>
    {/if}
  </span>
{/snippet}

<style>
  /*
   * The font-status dot sits in the footer band below the text block (§9.8), 1.3 qfs from the block's centre towards
   * the spine, clear of the page-number medallion (1.1 qfs) whether that is centred on the block or on the page.
   */
  .rs-dot {
    position: absolute;
    top: calc(var(--mp-tb-h) + var(--mp-fr) + var(--mp-foot) / 2);
    left: calc(
      50% - var(--qfs) * 1.3
    ); /* physical-ok: book geometry, the spine side of an odd (right) page */
    z-index: 3;
    display: grid;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-faint);
    cursor: default;
    translate: -50% -50%;
  }

  .rs-dot[data-side='left'] {
    left: calc(50% + var(--qfs) * 1.3); /* physical-ok: the spine side of an even (left) page */
  }

  .rs-dot[data-state='failed'] {
    color: var(--warning);
    cursor: pointer;
  }

  .rs-mark {
    inline-size: clamp(6px, calc(var(--qfs) * 0.24), 9px);
    aspect-ratio: 1;
    border-radius: var(--radius-full);
    background: currentColor;
    box-shadow: 0 0 0 2px var(--surface-page);
    transition: scale var(--dur-fast) var(--ease-standard);
  }

  .rs-dot:hover .rs-mark,
  .rs-dot:focus-visible .rs-mark {
    scale: 1.25;
  }

  :global(html:not([data-motion='reduce'])) .rs-dot[data-state='retrying'] .rs-mark {
    animation: rs-pulse 0.9s var(--ease-standard) infinite alternate;
  }

  @keyframes rs-pulse {
    from {
      opacity: 1;
    }

    to {
      opacity: 0.35;
    }
  }

  .rs-tip {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-0_5);
  }

  .rs-tip-action {
    color: var(--accent-text);
    font-weight: var(--weight-label);
  }

  @media (forced-colors: active) {
    .rs-mark {
      background: CanvasText;
      box-shadow: none;
    }

    .rs-dot[data-state='failed'] .rs-mark {
      background: LinkText;
    }
  }
</style>
