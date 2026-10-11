<!--
  SettingsDialog (§7.4, §9.7; owner request 2026-10-11): the large in-window dialog that shows the `settings` and
  `about` views over the reader, which stays mounted under it. Owner: WP7c. Rendered once by `App`; takes no props.

  - `ui.view` stays the source of truth: the dialog is open while it is `settings` or `about` (Settings › About and the
    palette show About in the same frame), and closing it (Escape, the X, a click outside) returns to the reader. It
    opens only once no other dialog or sheet is up: a deep link that arrives during a confirmation waits for it. As it
    opens, the popovers and menus still open over the reader, the rail or the sidebar close (`ui.dismissFloating`).
  - Frame (`settingsFrame`): centred between the title bar and the player dock (8 px above the dock's top, so the dock
    never lies over it), at most 1040 × 760 with 24 px margins, on the onboarding's faint scrim; under 880 × 560 CSS px
    of room (after the UI zoom) it fills the room under the title bar edge to edge. In zen too it stays
    below the title bar's band, which is the bar's reveal zone: the bar slides in uncovered, and reaching for the X
    never brings it. The scrim covers that band only while the bar is hidden.
  - Layers (`Dialog layer="view"`): just under `--z-dialog`, so every overlay (a confirmation, the shortcut sheet, the
    onboarding, the palette) paints above it. It registers `ui.settingsOpen` instead of a floating or modal layer:
    the caption buttons stay live and only the Settings allow-list of shortcuts runs (§7.7). Clicks on the title bar,
    on the player dock (lifted above the scrim by `App`) and on toasts are not "outside". In the filled frame the dock
    lies over the dialog's bottom, so its views keep the dock's band free at their end (`--qd-dock-reserve`).
  - Header: the views keep their own headings (the navigation's "Settings", About's name); a close X ("Close · Esc")
    sits in the top inline-end corner, and the views keep `--qd-close-room` free for it.
  - Focus: "Search settings" on open (About: "Copy diagnostics"), and again when the view swaps inside the open dialog;
    on close it returns to the opener, unless the view moved on (Settings › Storage "Open downloads"): then the
    destination takes it, and the canvas holds it meanwhile.
-->
<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import { untrack } from 'svelte'
  import AboutView from '$components/about/AboutView.svelte'
  import SettingsView from '$components/settings/SettingsView.svelte'
  import { SETTINGS_TITLE_ID } from '$components/settings/view.svelte'
  import { Dialog, IconButton } from '$components/ui'
  import { i18n, reader, shortcuts, ui } from '$lib/stores'
  import { FOCUS_TARGETS, inDialog, TITLEBAR_H } from '$lib/stores/ui.svelte'
  import { SETTINGS_FRAME, settingsFrame } from './settingsDialog'

  /** About's visible heading (the app's name, `AboutView`). */
  const ABOUT_NAME_ID = 'about-name'
  /** Clicks here are not "outside": the title bar, the player dock and toasts stay usable over the scrim. */
  const KEEP_OPEN = '[data-qd-region="titlebar"], [data-qd-region="dock"], [data-sonner-toaster]'
  /** Room the views keep free in their top inline-end corner for the close button (12 px inset + 28 px + 8 px). */
  const CLOSE_ROOM = 48

  const uid = $props.id()

  /** The view the dialog shows; kept through the exit transition once the view has moved on. */
  let shown = $state<'settings' | 'about'>('settings')
  let open = $state(false)

  $effect(() => {
    const view = ui.view
    if (!inDialog(view)) {
      open = false
      return
    }
    shown = view === 'about' ? 'about' : 'settings'
    // Never over another dialog or sheet: it would sit under it (just below --z-dialog) yet take the keys and focus.
    if (ui.overlays.length === 0 && ui.modals === 0 && !untrack(() => open)) {
      // A popover or menu left open (a tray link, the palette's About) would stay up, lifted above the dialog with the
      // chrome's floating content, while the dialog takes the keys and the clicks.
      ui.dismissFloating()
      open = true
    }
  })

  $effect(() => {
    if (!open) return
    ui.setSettingsOpen(true)
    return () => ui.setSettingsOpen(false)
  })

  /** The frame stays below the title bar's band, in zen too (its reveal zone, `ZEN_TOP_ZONE_PX`). */
  const insetTop = TITLEBAR_H
  const scrimTop = $derived(ui.zen && !ui.zenTitleBar ? 0 : TITLEBAR_H)
  const frame = $derived(
    settingsFrame({ windowW: ui.windowSize.w, windowH: ui.windowSize.h, insetTop, dock: reader.dock }),
  )
  const labelledBy = $derived(shown === 'about' ? `${uid}-about ${ABOUT_NAME_ID}` : SETTINGS_TITLE_ID)
  const escapeKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'app.escape')
    return def ? shortcuts.format(def) || undefined : undefined
  })

  function close(): void {
    if (inDialog(ui.view)) ui.setView('reader')
  }

  function onOpenChange(next: boolean): void {
    if (!next) close()
  }

  function onInteractOutside(e: PointerEvent): void {
    if (e.target instanceof Element && e.target.closest(KEEP_OPEN) !== null) e.preventDefault()
  }

  /** The control the shown view starts on. */
  function focusStart(view: 'settings' | 'about'): void {
    void ui.focusWhenRendered(
      view === 'settings'
        ? FOCUS_TARGETS.settingsSearch
        : '[data-qd-view="about"] [data-action="copy-diagnostics"]',
    )
  }

  function onOpenAutoFocus(e: Event): void {
    e.preventDefault()
    focusStart(shown)
  }

  // Settings › About (or the palette) swaps the view inside the open dialog: focus moves with it.
  $effect(() => {
    const view = shown
    if (untrack(() => open)) focusStart(view)
  })

  function onCloseAutoFocus(e: Event): void {
    if (ui.view === 'reader') return
    // The view moved on (Downloads): no focus back to the opener, which may be gone with the reader. The destination
    // takes focus (the manager's heading); until it can, the canvas holds it rather than the dialog on its way out.
    e.preventDefault()
    const active = document.activeElement
    if (active === null || active === document.body || active.closest('[data-qd-settings-dialog]') !== null) {
      const target =
        document.querySelector<HTMLElement>(FOCUS_TARGETS.downloads) ?? document.getElementById('qd-main')
      target?.focus({ preventScroll: true })
    }
  }
</script>

<Dialog
  {open}
  {onOpenChange}
  title={i18n.t(shown === 'about' ? 'shell.views.about' : 'settings.title')}
  {labelledBy}
  variant="plain"
  layer="view"
  backdrop="faint"
  width={SETTINGS_FRAME.maxW}
  height={SETTINGS_FRAME.maxH}
  fill={frame.fill}
  {insetTop}
  {scrimTop}
  insetBottom={frame.insetBottom}
  {onOpenAutoFocus}
  {onCloseAutoFocus}
  {onInteractOutside}
>
  <div
    class="host"
    data-qd-settings-dialog={shown}
    style:--qd-dock-reserve="{frame.dockReserve}px"
    style:--qd-close-room="{CLOSE_ROOM}px"
  >
    <IconButton
      class="close-x"
      label={i18n.t('common.close')}
      shortcut={escapeKey}
      icon={X}
      size="sm"
      tooltipSide="bottom"
      data-action="close-dialog"
      onclick={close}
    />
    {#if shown === 'about'}
      <span class="sr-only" id="{uid}-about">{i18n.t('shell.views.about')}</span>
      <AboutView />
    {:else}
      <SettingsView />
    {/if}
  </div>
</Dialog>

<style>
  .host {
    position: relative;
    flex: 1 1 auto;
    min-block-size: 0;
  }

  /* Above the views' sticky navigation. */
  .host :global(.close-x) {
    position: absolute;
    inset-block-start: var(--space-3);
    inset-inline-end: var(--space-3);
    z-index: 3;
  }
</style>
