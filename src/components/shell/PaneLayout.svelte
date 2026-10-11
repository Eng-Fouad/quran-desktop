<!--
  PaneLayout (§9.6): the body grid beside the rail: sidebar · canvas · side pane, with splitters. Owner: WP7c.

  - Widths are pixels (settings `sidebar.widthPx`, and `ui.paneWidthPx`, which the §9.6 rule may shrink); paneforge
    sizes panes in percent of the group, so the layout is recomputed from the pixel widths whenever the group resizes
    (the panes keep their width when the window grows, and the canvas takes the difference).
  - Dragging a splitter changes the width live and persists it when the drag ends; arrow keys on a focused splitter
    move it by 16 px (Shift: to the limit) and persist at once. Double-click restores the default width. The limits
    (`ui.paneLimits`) keep the side pane dockable during a drag, so it never jumps into a sheet mid-gesture.
  - The side pane docks only when `ui.paneDocked` (geometry rule, `paneCanDock`); otherwise it is a `Sheet` from the
    inline end. Below 900 px the sidebar floats over the canvas (`ui.sidebarOverlay`) with a scrim that closes it.
  - Landmarks (§8.15): `<aside>` for the sidebar and the side pane; the canvas snippet renders the `<main>`.
  Used only by `App.svelte`.
-->
<script lang="ts">
  import { PaneGroup, Pane } from 'paneforge'
  import { untrack, type Snippet } from 'svelte'
  import { fade, fly } from 'svelte/transition'
  import { pctToPx, pxToPct, Sheet, Splitter } from '$components/ui'
  import { i18n, reader, settings, ui } from '$lib/stores'
  import { RAIL_W } from '$lib/stores/ui.svelte'

  interface Props {
    /** The sidebar content (the active panel). */
    sidebar: Snippet
    /** The canvas: the `<main>` landmark with the view and the dock. */
    canvas: Snippet
    /** The side pane content. */
    pane: Snippet
    /** The accessible name of the sidebar landmark (the active tab). */
    sidebarLabel: string
  }

  let { sidebar, canvas, pane, sidebarLabel }: Props = $props()

  /** One keyboard step of a focused splitter (px). */
  const KEY_STEP_PX = 16

  let measured = $state(0)
  /** The group's width: measured, or the window minus the rail before the first measurement. */
  const groupW = $derived(measured > 0 ? measured : Math.max(0, ui.windowSize.w - RAIL_W))

  const dockedSidebar = $derived(ui.sidebarOpen && !ui.sidebarOverlay)
  const overlaySidebar = $derived(ui.sidebarOpen && ui.sidebarOverlay)
  const dockedPane = $derived(ui.sidePaneOpen && ui.paneDocked)
  const sheetPane = $derived(ui.sidePaneOpen && !ui.paneDocked)

  /** Live widths while a splitter is dragged (persisted when the drag ends). */
  let dragging = $state<'sidebar' | 'pane' | null>(null)
  let liveSidebarPx = $state<number | null>(null)
  let livePanePx = $state<number | null>(null)

  const sidebarPx = $derived(liveSidebarPx ?? settings.value.sidebar.widthPx)
  const panePx = $derived(livePanePx ?? ui.paneWidthPx)

  /** The target layout in percent, in pane order: [sidebar?, canvas, pane?]. */
  const target = $derived.by((): number[] => {
    const sidebarPct = dockedSidebar ? pxToPct(sidebarPx, groupW) : 0
    const panePct = dockedPane ? pxToPct(panePx, groupW) : 0
    const canvasPct = Math.max(0, 100 - sidebarPct - panePct)
    return [...(dockedSidebar ? [sidebarPct] : []), canvasPct, ...(dockedPane ? [panePct] : [])]
  })

  const limits = $derived(ui.paneLimits)
  const sidebarMinPct = $derived(pxToPct(limits.sidebarMin, groupW))
  const sidebarMaxPct = $derived(pxToPct(limits.sidebarMax, groupW))
  const paneMinPct = $derived(pxToPct(limits.paneMin, groupW))
  const paneMaxPct = $derived(pxToPct(limits.paneMax, groupW))
  const keyStepPct = $derived(groupW > 0 ? (KEY_STEP_PX / groupW) * 100 : null)

  let group: ReturnType<typeof PaneGroup> | undefined = $state()

  // Keep paneforge on the pixel widths whenever the group, the panes or the widths change (not mid-drag).
  $effect(() => {
    const next = target
    if (dragging !== null || group === undefined || groupW <= 0) return
    untrack(() => {
      const current = group?.getLayout() ?? []
      if (!sameLayout(current, next)) group?.setLayout(next)
    })
  })

  function sameLayout(a: readonly number[], b: readonly number[]): boolean {
    const tolerance = groupW > 0 ? (0.5 / groupW) * 100 : 0
    return a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) <= tolerance)
  }

  /** paneforge reports a new layout: a drag step (live), a keyboard step (persist), or pane (un)registration. */
  function onLayoutChange(layout: number[]): void {
    if (groupW <= 0) return
    const sidebarSize = dockedSidebar ? layout[0] : undefined
    const paneSize = dockedPane ? layout.at(-1) : undefined
    const nextSidebar = sidebarSize === undefined ? null : pctToPx(sidebarSize, groupW)
    const nextPane = paneSize === undefined ? null : pctToPx(paneSize, groupW)
    if (dragging === 'sidebar') {
      liveSidebarPx = nextSidebar
      return
    }
    if (dragging === 'pane') {
      livePanePx = nextPane
      return
    }
    // A keyboard step on a focused splitter (registration yields the target layout, which persists nothing).
    if (nextSidebar !== null && Math.abs(nextSidebar - settings.value.sidebar.widthPx) >= 1) {
      ui.resizeSidebar(nextSidebar)
    }
    if (nextPane !== null && Math.abs(nextPane - ui.paneWidthPx) >= 1) ui.resizeSidePane(nextPane)
  }

  function onDragging(which: 'sidebar' | 'pane', active: boolean): void {
    if (active) {
      dragging = which
      return
    }
    if (dragging !== which) return
    dragging = null
    if (which === 'sidebar' && liveSidebarPx !== null) ui.resizeSidebar(liveSidebarPx)
    if (which === 'pane' && livePanePx !== null) ui.resizeSidePane(livePanePx)
    liveSidebarPx = null
    livePanePx = null
  }

  // A sidebar floating over a narrow window closes once the reader moves (a surah, bookmark or hit was opened).
  let lastPages = ''
  $effect(() => {
    const pages = reader.visiblePages.join(',')
    untrack(() => {
      if (lastPages !== '' && pages !== lastPages && ui.sidebarOverlay && ui.sidebarOpen) ui.closeSidebar()
      lastPages = pages
    })
  })

  const flyFrom = $derived((i18n.dir === 'rtl' ? 1 : -1) * 24)
  const flyDuration = $derived(settings.reducedMotion ? 0 : 200)
</script>

<div class="pane-layout" bind:clientWidth={measured}>
  <PaneGroup
    bind:this={group}
    direction="horizontal"
    {onLayoutChange}
    keyboardResizeBy={keyStepPct}
    class="pane-group"
  >
    {#if dockedSidebar}
      <Pane
        id="qd-pane-sidebar"
        order={1}
        defaultSize={target[0]}
        minSize={sidebarMinPct}
        maxSize={sidebarMaxPct}
      >
        <aside class="sidebar" aria-label={sidebarLabel} data-qd-region="sidebar">
          {@render sidebar()}
        </aside>
      </Pane>
      <Splitter
        label={i18n.t('shell.sidebar.resize')}
        onReset={() => ui.resetSidebarWidth()}
        onDraggingChange={(active) => onDragging('sidebar', active)}
        class="splitter-sidebar"
      />
    {/if}
    <Pane id="qd-pane-canvas" order={2} defaultSize={target[dockedSidebar ? 1 : 0]}>
      {@render canvas()}
    </Pane>
    {#if dockedPane}
      <Splitter
        label={i18n.t('shell.sidePane.resize')}
        onReset={() => ui.resetSidePaneWidth()}
        onDraggingChange={(active) => onDragging('pane', active)}
        class="splitter-pane"
      />
      <Pane id="qd-pane-side" order={3} defaultSize={target.at(-1)} minSize={paneMinPct} maxSize={paneMaxPct}>
        <aside class="side-pane" aria-label={i18n.t('shell.landmarks.sidePane')} data-qd-region="side-pane">
          {@render pane()}
        </aside>
      </Pane>
    {/if}
  </PaneGroup>

  {#if overlaySidebar}
    <button
      type="button"
      class="scrim"
      tabindex="-1"
      aria-label={i18n.t('shell.sidebar.hide')}
      onclick={() => ui.closeSidebar()}
      transition:fade={{ duration: flyDuration }}
    ></button>
    <aside
      class="sidebar floating"
      aria-label={sidebarLabel}
      data-qd-region="sidebar"
      style:inline-size="{Math.min(settings.value.sidebar.widthPx, Math.max(240, groupW - 48))}px"
      transition:fly={{ x: flyFrom, duration: flyDuration, opacity: 0 }}
    >
      {@render sidebar()}
    </aside>
  {/if}
</div>

<!-- Always mounted (its content renders only while open), so closing slides out instead of vanishing. -->
<Sheet
  open={sheetPane}
  onOpenChange={(open) => {
    if (!open) ui.closeSidePane()
  }}
  title={i18n.t('shell.landmarks.sidePane')}
  width={ui.paneWidthPx}
  class="side-pane-sheet"
>
  {@render pane()}
</Sheet>

<style>
  .pane-layout {
    position: relative;
    flex: 1 1 auto;
    min-inline-size: 0;
    min-block-size: 0;
    display: flex;
  }

  .pane-layout :global(.pane-group) {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .sidebar,
  .side-pane {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
    min-inline-size: 0;
  }

  /* Docked panes draw no border of their own: the splitter's 1 px line is the separator. */
  .sidebar {
    background-color: var(--surface-chrome);
  }

  /* The canvas, page and side pane are always opaque (§9.6). */
  .side-pane {
    background-color: var(--surface-raised);
  }

  /* Above the dock: the floating sidebar and its scrim cover the whole canvas, player included. */
  .scrim {
    position: absolute;
    inset: 0;
    z-index: calc(var(--z-player) + 1);
    padding: 0;
    border: 0;
    background-color: rgb(0 0 0 / 0.18);
    cursor: default;
  }

  .floating {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    z-index: calc(var(--z-player) + 2);
    max-inline-size: calc(100% - 48px);
    /* Opaque: a floating panel over the page must not show the page through translucent chrome. */
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-3);
  }
</style>
