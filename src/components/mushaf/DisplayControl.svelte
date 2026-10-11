<!--
  DisplayControl (§8.13, §9.7; owner request 2026-10-11, the approved phase 2). Owner: WP8e; its popover is WP12b's
  `DisplayPopover`. The "Aa" button on the reading canvas: the theme, ink brightness, Mushaf style, pages and
  translation text size, changed live on the page itself. Takes no props: it reads stores (§7.9). MushafView and
  TranslationView each mount it once, outside their scroll viewports.

  - **Where.** A 40 px glass capsule in the canvas's top inline-end corner, 12 px in from the edge (top right in the
    English UI, top left in the Arabic UI). Beside the Mushaf it sits 8 px under the zoom control (116 px down); in
    translation mode, which has no zoom control, it takes that control's place (16 px down), in the gutter beside the
    reading column. In zen it moves down by the title bar's reveal zone, as the zoom control does.
  - **Look.** The zoom control's rules (`CanvasControl`): 40 % with the pointer off the canvas, 60 % over it, 100 %
    hovered, focused or open. It yields to what it never rests on (the Mushaf's text, running heads and marks; the
    translation paper, in a canvas too narrow for the gutter) until the pointer reaches for it, and in zen it hides
    until the pointer moves.
  - **Popover.** Arrowless, like the app's chrome-button popovers, 8 px beside the capsule toward the canvas (left in
    the English UI, right in the Arabic UI), top edges aligned; tooltip "Display". A floating layer.
  - **Keys and pointer.** One tab stop, after the zoom control (translation mode: after the feed); Enter or Space
    opens; Escape, while it is closed, hands focus back to the reading cursor and keeps the selection. A pointer press
    never takes focus, so ← → keep turning pages, and the popover gives focus back to where it was when it closes. The
    wheel over it scrolls the canvas as over the page (and turns a fitted Mushaf page).
-->
<script lang="ts">
  import CaseSensitive from '@lucide/svelte/icons/case-sensitive'
  import DisplayPopover from '$components/settings/DisplayPopover.svelte'
  import IconButton from '$components/ui/IconButton.svelte'
  import { forwardWheel, normalizeDelta } from '$lib/mushaf/wheel'
  import { i18n, reader, settings, translations, ui } from '$lib/stores'
  import { STAGE_SELECTOR } from '$lib/stores/reader.svelte'
  import { readingCursor, ZEN_TOP_ZONE_PX } from '$lib/stores/ui.svelte'
  import { CanvasControl, PROTECTED } from './canvasControl.svelte'

  let root: HTMLDivElement | undefined = $state()
  let open = $state(false)

  const mushaf = $derived(settings.value.readingMode === 'mushaf')
  /** The popover and the tooltip open into the canvas, away from its edge. */
  const inward = $derived(i18n.dir === 'rtl' ? 'right' : 'left')

  // Quiet at rest; it yields to the Mushaf's text and marks, or to the translation paper, and hides in zen.
  const control = new CanvasControl({
    element: () => root,
    covers: (view) => {
      if (!mushaf) {
        const paper = view.querySelector(':scope > .sheet')
        return paper ? [paper.getBoundingClientRect()] : []
      }
      const stage = view.querySelector(STAGE_SELECTOR)
      return stage ? [...stage.querySelectorAll(PROTECTED)].map((el) => el.getBoundingClientRect()) : []
    },
    watched: (view) => (mushaf ? view.querySelector(STAGE_SELECTOR) : null),
    scroller: (view) => (mushaf ? view.querySelector('[data-scroll-area-viewport]') : null),
    ignore: (target) => target instanceof Element && target.closest('.mp-hl') !== null,
    // Zen, the UI direction and the book's size move it or the book; the side card and the first translation move the
    // paper.
    deps: () => {
      void ui.zen
      void i18n.dir
      void reader.qfs
      void reader.scrolls
      void reader.dock
      void translations.activePacks.length
    },
    paused: () => mushaf && reader.flipping,
  })
  const presence = $derived(control.state(open))

  // --- input ---------------------------------------------------------------------------------------------------------

  /** A pointer press never moves focus here: ← → must keep turning pages after a click (§8.11). */
  function keepFocus(e: MouseEvent): void {
    e.preventDefault()
  }

  /** Over the capsule the wheel scrolls the canvas as over the page (a fitted Mushaf turns, `use:wheel`). */
  function onwheel(e: WheelEvent): void {
    const view = root?.parentElement
    if (!view) return
    if (mushaf) {
      forwardWheel(e, view)
      return
    }
    if (e.ctrlKey || e.metaKey) return
    const feed = view.querySelector<HTMLElement>('.qd-virtual-list')
    feed?.scrollBy({ top: normalizeDelta(e.deltaY, e.deltaMode, feed.clientHeight) })
  }

  /**
   * Escape on the closed button: consumed, so the reader's Escape keeps the selection; focus goes to the reading cursor
   * (the Mushaf's ayah item or the feed's verse, `readingCursor`).
   */
  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || open || e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    readingCursor()?.focus({ preventScroll: true })
  }
</script>

<div
  bind:this={root}
  class="dc"
  data-qd-display-control=""
  data-qd-keep-selection=""
  data-mode={mushaf ? 'mushaf' : 'translation'}
  data-state={presence}
  style:--dc-zen-top={ui.zen ? `${ZEN_TOP_ZONE_PX}px` : undefined}
  role="presentation"
  onmousedown={keepFocus}
  {onkeydown}
  onfocusin={() => control.focusIn()}
  onfocusout={(e) => control.focusOut(e)}
  onpointerenter={(e) => control.pointerEnter(e)}
  onpointerleave={(e) => control.pointerLeave(e)}
  {onwheel}
>
  <DisplayPopover bind:open anchor={root} side={inward} align="start" sideOffset={8}>
    {#snippet trigger({ props })}
      <IconButton
        {...props}
        icon={CaseSensitive}
        label={i18n.t('reader.display.button')}
        tooltipSide={inward}
        data-action="display"
      />
    {/snippet}
  </DisplayPopover>
</div>

<style>
  /* 40 × 40 px: 3 px padding around a 32 px button, as the zoom capsule's glass. */
  .dc {
    --_top: var(--space-4);
    position: absolute;
    inset-block-start: calc(var(--_top) + var(--dc-zen-top, 0px));
    inset-inline-end: var(--space-3);
    z-index: var(--z-popover);
    display: grid;
    place-items: center;
    inline-size: 40px;
    block-size: 40px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    /* Floating glass (§9.4); an opaque raised surface where blur is not allowed. */
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    color: var(--text-muted);
    -webkit-user-select: none;
    user-select: none;
    opacity: 0.4;
    transition: opacity var(--dur-quick) var(--ease-standard);
  }

  /* Beside the Mushaf: 8 px under the zoom capsule (16 px down, 92 px tall). */
  .dc[data-mode='mushaf'] {
    --_top: calc(var(--space-4) + 92px + var(--space-2));
  }

  .dc[data-state='quiet'] {
    opacity: 0.6;
  }

  .dc[data-state='active'] {
    opacity: 1;
  }

  /* Yielded to the page, or zen: invisible, and a click reaches the page under it. */
  .dc[data-state='hidden'] {
    opacity: 0;
    pointer-events: none;
  }

  .dc :global(.icon-button) {
    inline-size: 100%;
    block-size: 100%;
    border-radius: var(--radius-full);
  }

  /* Open: the button stays lit while its popover shows. */
  .dc :global(.icon-button[aria-expanded='true']) {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  @media (forced-colors: active) {
    .dc {
      border-color: CanvasText;
    }
  }
</style>
