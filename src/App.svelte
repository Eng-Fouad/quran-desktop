<!--
  App (§7.5, §9.6): the shell. Owner: WP7c.

  TitleBar · StartupBanner · body [ <nav> NavRail │ PaneLayout( <aside> Sidebar │ <main> canvas │ <aside> SidePane ) ]
  · SettingsDialog · OverlayHost · AyahContextMenu · LiveRegion, all under one TooltipProvider.

  - The canvas `<main>` holds the view (reader: Mushaf or translation; downloads, which hides the sidebar), the dock
    region (`role=region`, the player stays in every view, §7.4) and the toast layer. Settings and About show in
    `SettingsDialog` over the reader, which stays mounted under it (owner request 2026-10-11): while it is open the dock
    is lifted above its scrim, and floating content opened from the chrome left usable (the dock's popovers) stacks
    above it as from inside it.
  - The toast layer covers the canvas and is a containing block for svelte-sonner's fixed list, so toasts centre on the
    dock (bar) or sit above the side card, whatever the sidebar and side pane take. They also stay above the
    bottom-centre overlays (§7.5's slot: "Return to recitation", the division and hint chips, the memorisation bars;
    `ui.overlayReach`), never over them. Nor over the Quran text: where the band under the book is too short for them
    (zen, where the book centres in the whole canvas, or a held `qfs` whose book fills it), they move to the canvas's
    top edge (`toastPlacement.ts`). In zen, with the dock away, they rest just above the canvas bottom.
  - "Skip to Quran text" is the first tab stop (§8.15): it focuses the reading cursor's ayah, else the canvas.
  - Zen (`Z`, §9.6): only the canvas stays; the title bar slides in at the top edge and the dock at the bottom 80 px
    (or briefly on an audio key); the cursor hides after 2.5 s still. A hint names the key that leaves it.
  - A failed bootstrap shows `FatalScreen` instead (§9.8). In test mode the QA hooks are installed after mounting
    (`window.__QD_TEST__`, WP13a), in their own chunk.
  - First run (§9.7): the welcome flow opens once the shell is up, until it is finished (`onboardingDone`; a first run
    has no Skip).
    Never in test mode, so QA scenarios start on the reader (S01/S02 open it themselves).
  - The app accepts no drop (`dropGuard.ts`): a file or an outside link dropped on the window never navigates it.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import DownloadsView from '$components/downloads/DownloadsView.svelte'
  import AyahContextMenu from '$components/mushaf/AyahContextMenu.svelte'
  import MushafView from '$components/mushaf/MushafView.svelte'
  import PlayerDock from '$components/player/PlayerDock.svelte'
  import SideDockCard from '$components/player/SideDockCard.svelte'
  import { refuseDrop } from '$components/shell/dropGuard'
  import FatalScreen from '$components/shell/FatalScreen.svelte'
  import LiveRegion from '$components/shell/LiveRegion.svelte'
  import NavRail from '$components/shell/NavRail.svelte'
  import OverlayHost from '$components/shell/OverlayHost.svelte'
  import PaneLayout from '$components/shell/PaneLayout.svelte'
  import SettingsDialog from '$components/shell/SettingsDialog.svelte'
  import Sidebar from '$components/shell/Sidebar.svelte'
  import StartupBanner from '$components/shell/StartupBanner.svelte'
  import { TOAST_TOP_GAP, type TextClear, toastSide, trackTextClear } from '$components/shell/toastPlacement'
  import TitleBar from '$components/shell/TitleBar.svelte'
  import SidePane from '$components/sidepane/SidePane.svelte'
  import TranslationView from '$components/translation/TranslationView.svelte'
  import { Kbd, setModalLayer, Toaster, TooltipProvider } from '$components/ui'
  import { app, i18n, reader, settings, shortcuts, ui } from '$lib/stores'
  import { readingCursor, TITLEBAR_H } from '$lib/stores/ui.svelte'
  import { splitAround } from '$lib/util/format'

  /** Toasts sit this far above the canvas bottom: above the 64 px bar (§9.5), or above the 120 px side card. */
  const TOAST_OFFSET_BAR = 96
  const TOAST_OFFSET_SIDE = 146
  /** In zen, with the dock away, toasts rest this far above the canvas bottom (in the paper's bottom margin). */
  const TOAST_OFFSET_ZEN = 16
  /** The zen hint's foot below the window top (16 px off the edge, a 28 px pill): toasts at the top keep under it. */
  const ZEN_HINT_FOOT = 44
  /** Room between a bottom-centre overlay (§7.5 slot) and the toasts above it. */
  const TOAST_OVER_SLOT_GAP = 8
  /** The side card's distance from the canvas's inline end (matches `.dock-region[data-dock='side']`). */
  const SIDE_CARD_INSET = 24
  /** How long the zen hint stays. */
  const ZEN_HINT_MS = 2_600

  // While the Settings dialog is open, a popover or menu opened from the chrome it leaves usable (the dock, the title
  // bar) stacks above it, as one opened inside it does; dialogs and sheets set their own layer for their content.
  setModalLayer(() => (ui.settingsOpen ? 'dialog' : null))

  const sidebarLabel = $derived(i18n.t(`shell.tabs.${settings.value.sidebar.tab}`))
  const sideDock = $derived(reader.dock === 'side')
  /** Toasts clear a bottom-centre overlay (§7.5 slot) that reaches higher than the dock. */
  const slotOffset = $derived(ui.overlayReach > 0 ? ui.overlayReach + TOAST_OVER_SLOT_GAP : 0)
  /** Where toasts rest above the canvas bottom: above the dock, or low in zen, where the dock is away. */
  const restOffset = $derived(
    Math.max(ui.zen ? TOAST_OFFSET_ZEN : sideDock ? TOAST_OFFSET_SIDE : TOAST_OFFSET_BAR, slotOffset),
  )
  /** A zen dock called up for a moment lifts them above it. */
  const toastOffset = $derived(
    ui.zen && ui.zenDock ? Math.max(sideDock ? TOAST_OFFSET_SIDE : TOAST_OFFSET_BAR, slotOffset) : restOffset,
  )

  // A short hint when zen starts: which key leaves it.
  let zenHint = $state(false)
  /** At the top edge: under the zen title bar or hint while one floats over the canvas. */
  const toastTop = $derived(
    TOAST_TOP_GAP + (ui.zen && ui.zenTitleBar ? TITLEBAR_H : ui.zen && zenHint ? ZEN_HINT_FOOT : 0),
  )

  // How far the Mushaf's text block stays from the canvas edges, while the canvas shows the book.
  let canvasEl: HTMLElement | null = $state(null)
  let textClear: TextClear | null = $state(null)
  $effect(() => {
    const canvas = canvasEl
    const book = ui.view === 'reader' && settings.value.readingMode === 'mushaf'
    // Re-armed on every refit: the book's size and place follow these.
    const qfs = reader.qfs
    void [reader.spread, reader.scrolls, reader.dock, ui.zen]
    if (canvas === null || !book) {
      textClear = null
      return
    }
    return trackTextClear(canvas, qfs, (clear) => (textClear = clear))
  })
  /**
   * The side card's toasts sit beside the book, at its inline end. Bottom-centre toasts take the top edge when, at
   * rest, they would cover text at the bottom (a zen title bar, hint or dock showing for a moment moves them along,
   * never across).
   */
  const toastAtTop = $derived(
    !(sideDock && !ui.zen) && toastSide(textClear, restOffset, TOAST_TOP_GAP) === 'top',
  )

  onMount(() => {
    if (!app.testMode) {
      if (app.fatal === null && app.firstRun && !settings.value.onboardingDone) ui.open('onboarding', {})
      return
    }
    import('$lib/testing/qdtest')
      .then((m) => m.installQdTest())
      .catch((e: unknown) => console.error('[qd] the test hooks could not be installed', e))
  })

  /** "Skip to Quran text" (§8.15): the reading cursor's roving item, else the first ayah item, else the canvas. */
  function skipToText(e: MouseEvent): void {
    e.preventDefault()
    readingCursor()?.focus({ preventScroll: true })
  }

  function onpointermove(e: PointerEvent): void {
    if (ui.zen) ui.notePointer(e.clientY, window.innerHeight)
  }

  let zenHintTimer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const on = ui.zen
    untrack(() => {
      clearTimeout(zenHintTimer)
      zenHint = on
      if (on) zenHintTimer = setTimeout(() => (zenHint = false), ZEN_HINT_MS)
    })
    return () => clearTimeout(zenHintTimer)
  })
  const zenHintParts = $derived(splitAround(i18n.t('shell.zen.hint'), 'key'))
  const escapeKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'app.escape')
    return def ? shortcuts.format(def) : 'Esc'
  })
</script>

<svelte:window {onpointermove} ondragover={refuseDrop} ondrop={refuseDrop} />
<svelte:body onpointerleave={() => ui.notePointerLeave()} />

<TooltipProvider>
  {#if app.fatal !== null}
    <FatalScreen />
  {:else}
    <a class="skip-link sr-only-focusable" href="#qd-main" onclick={skipToText}
      >{i18n.t('shell.skipToText')}</a
    >
    <div
      class="app"
      class:zen={ui.zen}
      data-zen-titlebar={ui.zen && ui.zenTitleBar ? '' : undefined}
      data-zen-dock={ui.zen && ui.zenDock ? '' : undefined}
      data-pointer-idle={ui.zen && ui.pointerIdle ? '' : undefined}
    >
      <div
        class="titlebar-slot"
        data-qd-region="titlebar"
        inert={ui.zen && !ui.zenTitleBar ? true : undefined}
      >
        <TitleBar />
      </div>
      <StartupBanner />
      <div class="app-body">
        <nav class="rail" aria-label={i18n.t('shell.landmarks.sections')}>
          <NavRail />
        </nav>
        <PaneLayout {sidebarLabel}>
          {#snippet sidebar()}
            <Sidebar />
          {/snippet}
          {#snippet canvas()}
            <main class="canvas" id="qd-main" tabindex="-1" data-view={ui.view} bind:this={canvasEl}>
              <!-- Settings and About keep the reader mounted under their dialog. -->
              {#if ui.view === 'downloads'}
                <DownloadsView />
              {:else if settings.value.readingMode === 'mushaf'}
                <MushafView />
              {:else}
                <TranslationView />
              {/if}
              <div
                class="dock-region"
                class:lifted={ui.settingsOpen}
                data-qd-region="dock"
                role="region"
                aria-label={i18n.t('shell.landmarks.player')}
                data-dock={reader.dock}
                inert={ui.zen && !ui.zenDock ? true : undefined}
              >
                {#if sideDock}
                  <SideDockCard />
                {:else}
                  <PlayerDock />
                {/if}
              </div>
              <div class="toast-layer">
                <Toaster
                  label={i18n.t('shell.landmarks.toasts')}
                  placement={toastAtTop ? 'top' : sideDock && !ui.zen ? 'end' : 'center'}
                  offset={toastOffset}
                  offsetTop={toastTop}
                  insetInlineEnd={SIDE_CARD_INSET}
                />
              </div>
            </main>
          {/snippet}
          {#snippet pane()}
            <SidePane />
          {/snippet}
        </PaneLayout>
      </div>
      <SettingsDialog />
      <OverlayHost />
      <AyahContextMenu />
      <LiveRegion />
      {#if zenHint && !ui.zenTitleBar}
        <div class="zen-hint" role="status">
          {#if zenHintParts}
            {zenHintParts[0]}<Kbd chord={escapeKey} size="sm" />{zenHintParts[1]}
          {:else}
            {i18n.t('shell.zen.hint', { key: escapeKey })}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</TooltipProvider>

<style>
  /* Rows: title bar, startup banner (renders nothing without a notice), body. The body is pinned to the `1fr` row, so an
     absent banner leaves row 2 empty instead of moving the body into an `auto` row. Overlays, menus, the live region
     and the zen hint are fixed or absolutely positioned and take no row. */
  .app {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    /* The browser mock's CSS-zoom UI scale zooms viewport units too (`--qd-mock-zoom`, settings.applyEffects). */
    block-size: calc(100vh / var(--qd-mock-zoom, 1));
    overflow: hidden;
  }

  .titlebar-slot {
    grid-row: 1;
    z-index: var(--z-chrome);
  }

  .app-body {
    grid-row: 3;
    display: flex;
    min-block-size: 0;
  }

  .rail {
    flex: none;
    inline-size: 52px;
  }

  .canvas {
    position: relative;
    block-size: 100%;
    min-inline-size: 0;
    min-block-size: 0;
    overflow: hidden;
    background-color: var(--surface-app);
    outline: none;
  }

  .dock-region {
    position: absolute;
    inset-inline: 0;
    inset-block-end: 10px;
    z-index: var(--z-player);
    display: flex;
    justify-content: center;
    pointer-events: none;
    transition:
      opacity var(--dur-normal) var(--ease-standard),
      translate var(--dur-normal) var(--ease-decelerate);
  }

  /* Above the Settings dialog (--z-dialog − 1), under every other dialog (later in the document at --z-dialog). */
  .dock-region.lifted {
    z-index: var(--z-dialog);
  }

  .dock-region[data-dock='side'] {
    justify-content: flex-end;
    padding-inline-end: 24px;
  }

  .dock-region > :global(*) {
    pointer-events: auto;
  }

  /* A containing block for the toaster's fixed list (layout containment), exactly over the canvas. */
  .toast-layer {
    position: absolute;
    inset: 0;
    z-index: var(--z-toast);
    contain: layout;
    pointer-events: none;
  }

  .toast-layer :global([data-sonner-toast]) {
    pointer-events: auto;
  }

  .skip-link {
    position: fixed;
    inset-block-start: var(--space-2);
    inset-inline-start: var(--space-2);
    z-index: var(--z-tooltip);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border-radius: var(--radius-md);
    background-color: var(--accent);
    color: var(--accent-ink);
    font-size: var(--text-sm);
    font-weight: var(--weight-label);
    text-decoration: none;
    box-shadow: var(--shadow-2);
  }

  /* --- zen (§9.6) ---------------------------------------------------------------------------------------------------- */

  .zen {
    grid-template-rows: 0 auto minmax(0, 1fr);
  }

  .zen .titlebar-slot {
    position: fixed;
    inset-block-start: 0;
    inset-inline: 0;
    translate: 0 -100%;
    box-shadow: var(--shadow-2);
    transition: translate var(--dur-normal) var(--ease-standard);
  }

  .zen[data-zen-titlebar] .titlebar-slot {
    translate: 0 0;
    transition-timing-function: var(--ease-decelerate);
  }

  /* Opaque while it floats over the page. */
  .zen .titlebar-slot :global(.titlebar) {
    background-color: var(--surface-app);
  }

  .zen .rail {
    display: none;
  }

  .zen .dock-region {
    opacity: 0;
    translate: 0 12px;
  }

  .zen[data-zen-dock] .dock-region {
    opacity: 1;
    translate: 0 0;
  }

  .zen[data-pointer-idle],
  .zen[data-pointer-idle] :global(*) {
    cursor: none !important;
  }

  .zen-hint {
    position: fixed;
    inset-block-start: var(--space-4);
    inset-inline: 0;
    z-index: var(--z-toast);
    inline-size: fit-content;
    margin-inline: auto;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding-block: var(--space-1);
    padding-inline: var(--space-3);
    border-radius: var(--radius-full);
    background-color: var(--glass-fill);
    backdrop-filter: var(--backdrop-dock);
    box-shadow: var(--shadow-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
    pointer-events: none;
    animation: qd-zen-hint var(--dur-slow) var(--ease-decelerate);
  }

  .zen-hint :global(.kbd) {
    margin-inline: var(--space-1);
  }

  @keyframes qd-zen-hint {
    from {
      opacity: 0;
      translate: 0 -6px;
    }
  }
</style>
