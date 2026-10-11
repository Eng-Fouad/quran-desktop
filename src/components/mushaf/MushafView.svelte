<!--
  MushafView (§7.5, §8.10–§8.14). Owner: WP8e. The reader's Mushaf body: the canvas that holds the book. Takes no props
  (§7.9).

    .mushaf-view ─ ScrollArea (overlay scrollbars, both axes) ─ SpreadStage ─ MushafPage × 1–2
                 ─ PageTurnZones · FlipHUD · PageRail (WP8f)
                 ─ overlay slot (bottom centre): FollowChip · DivisionChip · HintChip, then MemoToolbar · SelfTestBar
                   (WP9b) at its foot
                 ─ zoom indicator · WordTooltip · AyahActionBar (WP8d) · SurahInfoPopover (WP8c)

  - Measures the canvas for the reader's fit (`reader.setViewport`), loads the visible pages (`pages.ensure`) and shows
    each slot's page; a style change keeps showing the old style's page until the new style's data arrives, so the
    rendition stack can cross-fade between them (§8.5).
  - The overlay slot (§7.5): the transient chips float over the page; a bar that stays for a whole mode (the
    memorisation toolbar, the self-test bar) sits at the slot's foot, and while it is up the book ends 12 px above it
    (`slotClearance`: the fit's qfs is capped and the stage reserves the room), so it never covers the page's footer
    and its number. The book re-fits once when the mode starts and once when it ends; the dock never moves. The slot
    publishes its reach above the canvas bottom (`overlayReach`), so the shell's toasts stay above it.
  - Wheel and touchpad (§8.13): `use:wheel` turns one page per gesture while the page fits, zooms with Mod+wheel or a
    pinch anchored at the pointer, and leaves scrolling alone when the canvas scrolls. Every zoom keeps the anchor
    point (the pointer, else the canvas centre) fixed: `scroll' = (scroll + p) · qfs'/qfs − p` on both axes, measured
    on the book itself so the stage padding and centring cancel out. A new page on a scrolled canvas starts at its
    top, on the reading side (right). Cursor moves and jumps scroll their ayah into view (`reader.revealRequest`).
  - Drag (§8.13, `use:pan`): at the fit or below (≤ 100 %) a horizontal drag turns one page on release (right = next,
    book order, in both UI languages; a vertical one pans while the canvas still scrolls at `QFS_MIN`); zoomed past the
    fit the canvas follows the pointer (grab / grabbing cursor). A press that does not travel stays a click, and the
    canvas is never a native text-selection surface (`user-select: none`).
  - Copy (§8.14): copy goes through the ayah selection (`C`, `Mod+C`, the action bar, the context menu). A DOM
    selection that still reaches the glyphs (programmatic, assistive technology) copies the selected words' Unicode
    text in the user's copy format (`buildCopyText`), never the PUA glyph codes; with a translation in the copy
    settings, the clipboard is completed with it from `quran_copy_text` a moment later.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { fade } from 'svelte/transition'
  import MemoToolbar from '$components/memo/MemoToolbar.svelte'
  import SelfTestBar from '$components/memo/SelfTestBar.svelte'
  import { overlayReach } from '$components/shell/overlayReach'
  import Button from '$components/ui/Button.svelte'
  import ScrollArea from '$components/ui/ScrollArea.svelte'
  import { api, call } from '$lib/ipc'
  import type { PageData } from '$lib/ipc/bindings'
  import { buildCopyText, selectedPageWords } from '$lib/mushaf/copy'
  import {
    BAR_RESERVE,
    COMPACT_BAR_RESERVE,
    PAD_X,
    PAD_Y,
    pageSide,
    SIDE_DOCK_W,
    slotBottom as slotBottomOf,
    slotClearance,
  } from '$lib/mushaf/geometry'
  import { pan } from '$lib/mushaf/pan'
  import { unicodeScale } from '$lib/mushaf/unicodeFit'
  import { shapeWarmer, warmPageOf, type WarmPage } from '$lib/mushaf/warmup'
  import { wheel } from '$lib/mushaf/wheel'
  import { fonts, i18n, pages, quran, reader, settings, ui } from '$lib/stores'
  import AyahActionBar from './AyahActionBar.svelte'
  import DivisionChip from './DivisionChip.svelte'
  import FlipHUD from './FlipHUD.svelte'
  import FollowChip from './FollowChip.svelte'
  import HintChip from './HintChip.svelte'
  import PageRail from './PageRail.svelte'
  import PageTurnZones from './PageTurnZones.svelte'
  import SpreadStage, { type StageSlot } from './SpreadStage.svelte'
  import SurahInfoPopover from './SurahInfoPopover.svelte'
  import WordTooltip from './WordTooltip.svelte'

  /** How long the zoom indicator stays after the last zoom step. */
  const ZOOM_HUD_MS = 900

  let width = $state(0)
  let height = $state(0)
  let viewport: HTMLElement | null = $state(null)
  /** The height of the bar that stays in the overlay slot (memorisation toolbar, self-test bar); 0 while none is up. */
  let barsHeight = $state(0)
  /** How far above the canvas bottom the book ends while such a bar is up (§7.5). */
  const clearBottom = $derived(slotClearance(reader.dock, barsHeight))

  $effect(() => reader.setViewport(width, height, clearBottom))
  // Unmounted (translation mode, another view): the reader estimates the canvas from the shell layout again.
  $effect(() => () => reader.setViewport(0, 0))

  // --- the pages on screen ------------------------------------------------------------------------------------------

  /** The data each slot showed last: a style change keeps it until the new style's page arrives (§8.5 cross-fade). */
  const shown: (PageData | undefined)[] = []

  const slots: StageSlot[] = $derived.by(() => {
    const style = reader.style
    return reader.visiblePages.map((page, i) => {
      let data = pages.get(style, page)
      if (data === undefined) {
        const previous = untrack(() => shown[i])
        if (previous?.page === page) data = previous
      }
      return { page, side: pageSide(page), data }
    })
  })

  $effect(() => {
    const current = slots
    untrack(() => {
      shown.length = current.length
      current.forEach((slot, i) => (shown[i] = slot.data))
    })
  })

  let failed = $state(false)
  let attempt = $state(0)
  $effect(() => {
    const style = reader.style
    const visible = reader.visiblePages
    void attempt
    untrack(() => {
      failed = false
      pages.ensure(style, visible).catch((e: unknown) => {
        console.warn('[qd] the Mushaf pages could not be loaded', e)
        if (reader.style === style && reader.visiblePages.join() === visible.join()) failed = true
      })
    })
  })

  /**
   * The dock reserves (§8.2, D28). Zen hides the dock until it is called, so the book centres in the whole canvas. A
   * persistent slot bar adds its room under the book (the stage then centres the book above it, as the fit sized it).
   */
  const reserveEnd = $derived(reader.dock === 'side' && !ui.zen ? SIDE_DOCK_W : 0)
  const dockReserve = $derived(
    ui.zen ? 0 : reader.dock === 'bar' ? BAR_RESERVE : reader.dock === 'compact' ? COMPACT_BAR_RESERVE : 0,
  )
  const reserveBottom = $derived(Math.max(dockReserve, clearBottom - PAD_Y))
  const slotBottom = $derived(slotBottomOf(reader.dock))

  // --- shaping warm-up (§8.18 page turn; warmup.ts) -----------------------------------------------------------------

  /** The hidden host the warm-up lays lines out in; it carries the reader's `--qfs`, as the pages do. */
  let warmHost: HTMLElement | null = $state(null)

  /**
   * The pages a turn shows next: the next and the previous spread. `pagesFor` clamps to the Mushaf, so at either end
   * the "neighbour" is the visible spread itself (skipped).
   */
  const warmTargets: number[] = $derived.by(() => {
    const visible = reader.visiblePages
    if (visible.length === 0) return []
    const next = reader.pagesFor(Math.max(...visible) + 1)
    const prev = reader.pagesFor(Math.min(...visible) - 1)
    return [...new Set([...next, ...prev].filter((p) => !visible.includes(p)))]
  })

  // Those pages are measured and shaped in idle time once their data and page font are there, so a turn's layout
  // finds every glyph and word ready at this font and size. Nothing is queued while a turn animates or a flip runs
  // (a flip draws only pages already painted in their font, warmup.ts). Chromium keeps glyph metrics (the expensive
  // part) across font-set changes but drops shaped words, so a change of the font set (`faceEpoch`) warms them again,
  // cheaply. The visible pages are their RenditionStacks' (`shapeWarmer.need`). A hafs page is warmed at the glyph
  // scale of the spread it will show in (unicodeFit.ts: its pages are measured here once, after the turn has ended).
  $effect(() => {
    const host = warmHost
    const style = reader.style
    const qfs = reader.qfs
    const epoch = fonts.faceEpoch
    const targets = warmTargets
    if (!host || qfs <= 0 || reader.turning || reader.flipping) {
      shapeWarmer.cancel()
      return
    }
    const jobs: WarmPage[] = []
    for (const page of targets) {
      const data = pages.get(style, page)
      if (!data || !fonts.isReady(style, page)) continue
      if (style !== 'hafs') {
        jobs.push(warmPageOf(data, qfs))
        continue
      }
      const spread = reader.pagesFor(page).map((p) => pages.get(style, p))
      if (spread.every((d): d is PageData => d !== undefined))
        jobs.push(warmPageOf(data, qfs, unicodeScale(spread)))
    }
    untrack(() => shapeWarmer.prefer(host, jobs, epoch))
  })
  $effect(() => () => shapeWarmer.cancel())

  // --- scrolling: zoom anchor, new pages, revealed ayahs (§8.13, §8.15) ---------------------------------------------

  const stage = () => viewport?.querySelector<HTMLElement>('[data-qd-stage]') ?? null

  /** The book's fractional point under the zoom anchor, captured before `qfs` changes. */
  let zoomAnchor: { fx: number; fy: number; x: number; y: number } | null = null
  let lastQfs = 0

  $effect.pre(() => {
    const qfs = reader.qfs
    untrack(() => {
      const anchor = reader.takeZoomAnchor()
      const vp = viewport
      const book = stage()
      if (lastQfs > 0 && qfs !== lastQfs && vp && book) {
        const v = vp.getBoundingClientRect()
        const b = book.getBoundingClientRect()
        const x = anchor?.x ?? v.left + v.width / 2
        const y = anchor?.y ?? v.top + v.height / 2
        if (b.width > 0 && b.height > 0)
          zoomAnchor = { fx: (x - b.left) / b.width, fy: (y - b.top) / b.height, x, y }
      }
      lastQfs = qfs
    })
  })

  $effect(() => {
    void reader.qfs
    untrack(() => {
      const anchor = zoomAnchor
      zoomAnchor = null
      const vp = viewport
      const book = stage()
      if (!anchor || !vp || !book) return
      const b = book.getBoundingClientRect()
      vp.scrollLeft += b.left + anchor.fx * b.width - anchor.x
      vp.scrollTop += b.top + anchor.fy * b.height - anchor.y
    })
  })

  // A new page on a scrolled canvas starts at its top, on the reading side: the right edge of the book.
  $effect(() => {
    void reader.visiblePages.join()
    const vp = viewport
    if (!vp) return
    untrack(() => {
      if (!reader.scrolls) return
      vp.scrollTop = 0
      vp.scrollLeft = getComputedStyle(vp).direction === 'rtl' ? 0 : vp.scrollWidth
    })
  })

  // Cursor keys and jumps: bring the ayah's words into view when the canvas scrolls (§8.15).
  $effect(() => {
    const request = reader.revealRequest
    const vp = viewport
    if (!request || !vp) return
    let frame = requestAnimationFrame(() => {
      frame = 0
      if (reader.scrolls) reveal(vp, request.ayahId)
    })
    return () => cancelAnimationFrame(frame)
  })

  /** Scrolls the least distance that shows every word of the ayah (the visible rendition of each page). */
  function reveal(vp: HTMLElement, ayahId: number): void {
    const spans = [...vp.querySelectorAll<HTMLElement>('section.mp')].flatMap((section) => {
      const layers = section.querySelectorAll<HTMLElement>('.mp-glyphs')
      const layer = layers[layers.length - 1]
      return layer ? [...layer.querySelectorAll<HTMLElement>(`.w[data-a="${ayahId}"]`)] : []
    })
    if (spans.length === 0) return
    let top = Number.POSITIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    let left = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    for (const span of spans) {
      const r = span.getBoundingClientRect()
      top = Math.min(top, r.top)
      bottom = Math.max(bottom, r.bottom)
      left = Math.min(left, r.left)
      right = Math.max(right, r.right)
    }
    const v = vp.getBoundingClientRect()
    const margin = reader.qfs * 1.75
    const dy =
      top - margin < v.top
        ? top - margin - v.top
        : bottom + margin > v.bottom
          ? bottom + margin - v.bottom
          : 0
    const dx =
      right + margin > v.right
        ? right + margin - v.right
        : left - margin < v.left
          ? left - margin - v.left
          : 0
    if (dx !== 0 || dy !== 0)
      vp.scrollBy({ left: dx, top: dy, behavior: settings.reducedMotion ? 'instant' : 'smooth' })
  }

  // --- zoom indicator ------------------------------------------------------------------------------------------------

  let zoomShown = $state(false)
  let zoomTimer: ReturnType<typeof setTimeout> | undefined
  let zoomSeen = untrack(() => reader.zoomPct)
  $effect(() => {
    const pct = reader.zoomPct
    untrack(() => {
      if (pct === zoomSeen) return
      zoomSeen = pct
      zoomShown = true
      clearTimeout(zoomTimer)
      zoomTimer = setTimeout(() => (zoomShown = false), ZOOM_HUD_MS)
      ui.announce(i18n.t('reader.zoom.announce', { pct: i18n.num(pct) }))
    })
  })
  $effect(() => () => clearTimeout(zoomTimer))

  // --- copy (§8.14) --------------------------------------------------------------------------------------------------

  function oncopy(e: ClipboardEvent): void {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !e.clipboardData) return
    const root = viewport
    if (!root) return
    const shownData = slots.flatMap((slot) => (slot.data ? [slot.data] : []))
    const words = selectedPageWords(selection, root, (page) => shownData.find((d) => d.page === page))
    if (words.length === 0) return
    const options = settings.value.copy
    const text = buildCopyText(words, options, quran)
    if (text === '') return
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
    const packId = options.translationPackId
    const first = words[0]
    const last = words.at(-1)
    if (packId !== null && first && last) void appendTranslation(text, first.ayahId, last.ayahId, packId)
  }

  /**
   * §5.5: with a translation in the copy settings, completes the clipboard with that translation of the touched ayahs
   * (`\n\n{plain text}`), as `quran_copy_text` builds it. The synchronous copy above stays if this fails.
   */
  async function appendTranslation(arabic: string, from: number, to: number, packId: string): Promise<void> {
    try {
      const full = await call(
        api.quranCopyText(Math.min(from, to), Math.max(from, to), {
          includeReference: false,
          referenceStyle: settings.value.copy.referenceStyle,
          ayahNumbers: false,
          translationPackId: packId,
        }),
      )
      const split = full.indexOf('\n\n')
      if (split < 0) return
      await navigator.clipboard.writeText(`${arabic}${full.slice(split)}`)
    } catch (e) {
      console.debug('[qd] copy: the translation could not be added', e)
    }
  }
</script>

<div
  class="mushaf-view"
  data-qd-view="mushaf"
  data-dock={reader.dock}
  data-scrolls={reader.scrolls ? '' : undefined}
  data-zoomed={reader.zoomPct > 100 ? '' : undefined}
  bind:clientWidth={width}
  bind:clientHeight={height}
  style:--mv-reserve-end={`${reserveEnd}px`}
  style:--mv-slot-bottom={`${slotBottom}px`}
  use:wheel
  use:pan
  {oncopy}
>
  <!-- The shaping warm-up's host (warmup.ts): unseen and size-contained; its lines are added and removed in one slice. -->
  <div class="qd-warm" aria-hidden="true" style:--qfs={`${reader.qfs}px`} bind:this={warmHost}></div>

  <ScrollArea class="mv-scroll" orientation="both" type="scroll" bind:viewport>
    <SpreadStage
      {slots}
      qfs={reader.qfs}
      spread={reader.spread}
      padX={PAD_X}
      padY={PAD_Y}
      {reserveEnd}
      {reserveBottom}
    />
  </ScrollArea>

  {#if failed}
    <div class="mv-error" role="alert">
      <p>{i18n.t('reader.error.page')}</p>
      <Button size="sm" variant="secondary" onclick={() => (attempt += 1)}>{i18n.t('common.retry')}</Button>
    </div>
  {/if}

  <PageTurnZones />
  <FlipHUD />
  <PageRail />

  <!-- Publishes how far it reaches above the canvas bottom, so toasts keep clear of its chips and bars. -->
  <div class="mv-slot" {@attach overlayReach('mushaf-slot')}>
    <FollowChip />
    <DivisionChip />
    <HintChip />
    <!-- At the slot's foot, so a chip appearing never moves the toolbar; measured for the book's clearance. -->
    <div class="mv-slot-bars" bind:offsetHeight={barsHeight}>
      <MemoToolbar />
      <SelfTestBar />
    </div>
  </div>

  {#if zoomShown}
    <div class="mv-zoom" aria-hidden="true" transition:fade={{ duration: settings.reducedMotion ? 0 : 150 }}>
      {reader.zoomPct === 100
        ? i18n.t('reader.zoom.fit')
        : i18n.t('reader.zoom.level', { pct: i18n.num(reader.zoomPct) })}
    </div>
  {/if}

  <WordTooltip />
  <AyahActionBar />
  <SurahInfoPopover />
</div>

<style>
  .mushaf-view {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  /* The scroll area fills the canvas (bits-ui sets `position: relative` inline, so size it, never inset it). */
  .mushaf-view :global(.mv-scroll) {
    inline-size: 100%;
    block-size: 100%;
  }

  /*
   * §8.13 drag (pan.ts): a press on the page or its margins is a click or a drag, never a native text selection (copy
   * goes through the ayah selection, §8.14). Unlayered, so it beats the `mushaf` layer; WKWebView needs the prefix.
   */
  .mushaf-view :global([data-scroll-area-viewport]) {
    -webkit-user-select: none;
    user-select: none;
  }

  /* Zoomed past the fit the book can be grabbed; end markers, headers and margin marks keep their pointer. */
  .mushaf-view[data-zoomed] :global([data-scroll-area-viewport]),
  .mushaf-view[data-zoomed] :global(.mp-glyphs[data-interactive]) {
    cursor: grab;
  }

  /* While a drag runs (`data-drag`, set by the action), over everything it crosses: the canvas holds the capture. */
  .mushaf-view:global([data-drag]),
  .mushaf-view:global([data-drag]) :global(*) {
    cursor: grabbing;
  }

  /* §7.5 overlay slot: bottom centre of the page area, above the bar dock (or low beside the side card). */
  .mv-slot {
    position: absolute;
    inset-block-end: var(--mv-slot-bottom);
    inset-inline: 0 var(--mv-reserve-end);
    z-index: var(--z-popover);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    pointer-events: none;
  }

  .mv-slot > :global(*) {
    pointer-events: auto;
  }

  /* The persistent bars (they take pointer events themselves); out of the column while neither is up. */
  .mv-slot > .mv-slot-bars {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-inline-size: 100%;
    pointer-events: none;
  }

  .mv-slot > .mv-slot-bars:not(:has(> :global(*))) {
    display: none;
  }

  /* The zoom level, briefly, at the top of the page area. */
  .mv-zoom {
    position: absolute;
    inset-block-start: var(--space-4);
    inset-inline: 0 var(--mv-reserve-end);
    z-index: var(--z-popover);
    inline-size: fit-content;
    margin-inline: auto;
    padding-block: var(--space-1);
    padding-inline: var(--space-3);
    border-radius: var(--radius-full);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .mv-error {
    position: absolute;
    inset-block-start: 40%;
    inset-inline: 0 var(--mv-reserve-end);
    z-index: var(--z-popover);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    inline-size: fit-content;
    margin-inline: auto;
    padding: var(--space-4) var(--space-6);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    color: var(--text);
    font-size: var(--text-md);
  }

  .mv-error p {
    margin: 0;
  }
</style>
