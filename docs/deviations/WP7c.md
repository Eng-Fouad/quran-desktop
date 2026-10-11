# WP7c deviations (shell, L0 store completion, shortcut runtime)

Delivered:
- **Shell**: `src/App.svelte` and `src/components/shell/**`: `TitleBar`, `WindowControls`, `NavRail`, `Sidebar`,
  `PaneLayout`, `OverlayHost`, `LiveRegion`, `OfflineBadge`, `FatalScreen`, `StartupBanner`, plus the browser-test helper
  `testing/boot.ts`.
- **Dialogs**: `src/components/dialogs/{ShortcutSheet, ShortcutTable, ConfirmDialog}.svelte`.
- **L0 stores** `app`, `settings`, `ui`, `shortcuts`, `i18n`. WP0E left them working; WP7c completed them and fulfilled
  the WP0E, WP2b, WP6a, WP7a, WP7b and WP13a requests addressed to WP7c (listed at the end).
- **Shortcut runtime and app definitions**: `src/lib/shortcuts/{index, app}.ts`.
- **i18n**: the §11 runtime (`src/lib/i18n/index.ts`) and the `shell` domain in en and ar.
- **Utilities**: `src/lib/util/**`.
- **Mock handlers**: `src/lib/ipc/mock/handlers/{app, settings}.ts`.
- **Scenario**: `tests/e2e/scenarios/S26.mjs`.

Tests:
- **Unit**:
  - `src/lib/stores/{app, settings, ui, shortcuts, i18n}.test.ts` and `ui.svelte.test.ts` (that one needs runes in the
    test itself).
  - `src/lib/util/*.test.ts` (6 files).
  - `src/lib/ipc/mock/handlers/{app, settings}.test.ts`.
  - The existing `src/lib/shortcuts/index.test.ts` and `src/lib/i18n/*.test.ts`.
- **Browser**:
  - `src/components/shell/shell.browser.test.ts` (16 tests): landmarks and skip link, title bar per platform,
    PaneLayout, zen, shortcut sheet, confirm, placeholder overlays, fatal screen, banner, offline badge, toasts, and the
    Arabic mirror.
  - `src/lib/shortcuts/shortcuts.browser.test.ts` (9 tests): §7.7 with real focus and real keys.

## Deviations from ARCHITECTURE.md

1. **Overlay contract (§7.4).**
   - `OverlayHost` mounts only the top overlay, and each overlay component renders its own bits-ui `Dialog`. The Dialog
     uses `open={ui.isTop(kind)}` and `onOpenChange={(o) => { if (!o) ui.close(kind) }}`.
   - When the stack empties, the host keeps the last overlay mounted for 260 ms (0 under reduced motion). Its Dialog
     then animates out and bits-ui restores focus.
   - Every `ui.open` creates a new stack entry. A new entry remounts the overlay, so a second `ui.confirm` right after
     the first gets fresh initial focus.
   - Overlays that are still wave-0 placeholders, with no Dialog yet, show in a centred card. Escape still closes them
     (`ui.dismissLayer`).
   - New store API: `ui.isTop(kind)`.

2. **The sidebar heading belongs to the shell.**
   - `Sidebar` draws a 48 px heading with the tab name (`shell.tabs.*`) and a hide button. It is vertically centred with
     the rail's first item.
   - Panels render their body only and own their scrolling. The `<aside>` landmark is named after the tab.

3. **Narrow windows (< 900 px, §9.6).**
   - The floating sidebar is session state (`ShellInput.overlaySidebarOpen`, default closed), so a small window never
     starts with the page covered. In that mode only `sidebar.tab` is persisted, and `sidebar.open` stays the
     docked-window preference.
   - The floating sidebar sits over the canvas and the dock, with a scrim. It closes on a scrim click, on Escape, or
     when the reader's visible pages change (a surah, bookmark or hit was opened).
   - The app `Escape` chain is now: layer → floating sidebar → non-reader view → zen.

4. **PaneLayout (§9.5 Splitter, §9.6).**
   - Widths are pixels. The paneforge layout is recomputed from the pixel widths whenever the group resizes, so panes
     keep their width when the window changes size.
   - Dragging updates the width live and persists it when the drag ends. Arrow keys on a focused splitter move it 16 px
     and persist at once (Shift jumps to the limit, paneforge's behaviour). Double-click resets the width.
   - Drag limits come from the new `ui.paneLimits` (`paneLimits()` in `ui.svelte.ts`): the sidebar and side-pane ranges,
     narrowed while the pane docks, so neither splitter can push the pane past `paneCanDock` mid-drag.
   - Docked panes have no border of their own: the splitter's 1 px line is the separator.
   - The side pane is a `Sheet` (title "Study pane") whenever `ui.paneDocked` is false.

5. **Window chrome (§9.6; WP7a and WP6a requests).**
   - `html[data-platform]` is set in `app.init` and removed in `reset`.
   - `html[data-chrome="vibrant"]` is set only after `window_set_chrome` with `auto` succeeds (`settings.chromeActive`).
     It is removed at once when the chrome turns opaque.
   - An `unsupported` answer (Windows 10, Linux) sets `settings.chromeUnsupported` for the session. The chrome stays
     opaque, and Rust is told once more with `effect: off`, so it still learns the light/dark appearance.
   - Other failures are logged and retried on the next appearance change. Only the newest answer counts (a sequence
     number).

6. **Window controls (Windows).**
   - The group sits at the inline end. In the Arabic UI it is therefore on the left, with close at the outer edge, as in
     a mirrored Windows window (§9.6 does not say).
   - The glyphs come from Segoe Fluent Icons, else Segoe MDL2 Assets, detected once with canvas text measurement
     (`captionGlyphFont()`). Without either font, 10 px SVG glyphs are drawn.
   - The caption buttons are not tab stops, like native ones, and keep their labels.
   - The maximise tooltip reads "Maximize · Win+Z for snap layouts", and the button carries `data-qd-snap` for WP6b.
   - In Tauri only, the glyphs and the title dim while the window is in the background.

7. **Startup banner action (§9.8).**
   - The banner offers **"Show files…"** (`system_reveal_data_dir`: the data folder, which holds the kept
     `user.db.corrupt-*` copy and `backups/`) and Dismiss, instead of "Restore from backup…".
   - The IPC contract has no restore command (WP2b asked the lead for `user_backup_restore`). Once it exists, the
     action becomes a file picker plus that command, a change local to `StartupBanner.svelte`.

8. **Fatal screen (§9.8).**
   - Three variants, chosen by the new `app.fatalReason`:
     - `core_missing`: `not_found` mentioning core.db; shows the `pnpm core:qdc` command.
     - `no_backend`: `unsupported` with no IPC; the browser preview of a production build.
     - `error`: anything else; shows the localised `errors.<kind>` message.
   - The raw message appears only in Details.
   - Actions: Try again (reload), Quit (`app_quit`, only with a backend) and Copy details. The root carries
     `data-qd-fatal` (WP13a request).

9. **Toasts (§9.5).**
   - The toaster lives in a layer over the canvas that is a containing block for svelte-sonner's fixed list (CSS layout
     containment). Toasts therefore centre on the canvas, the dock bar's centre, rather than on the window, whatever the
     sidebar and side pane take.
   - With the side dock card the placement is `end`, 146 px up, 24 px from the inline end.
   - New `ui.toastUndo(message, undo)`: the undo toast of every library change. It always names the action Undo. A newer
     undo toast replaces the previous one, so the stack never fills with stale Undo buttons; `Mod+Z` still reaches them.
     A rejected undo becomes an error toast.

10. **Zen (§9.6).** §9.6 says zen hides all chrome. WP7c also brings the title bar back as an overlay while the pointer
    is at the top edge, because on Windows it holds the only caption buttons (`decorations: false`).
    - A short hint names the key that leaves zen ("Zen mode · press Esc to leave"). It hides while the title bar shows.
    - New store state: `ui.pointerIdle` (2.5 s without movement; the cursor hides), `ui.zenDock` (bottom 80 px, or for
      3 s after an audio key) and `ui.zenTitleBar`.
    - New store methods: `ui.notePointer(y, h)`, `ui.notePointerLeave()` and `ui.pokeDock()`.
    - The shortcuts store pokes the dock for every definition in the `audio` group, so WP9a needs no code for this.

11. **Store API additions.**
    - `ui.draft/setDraft/clearDraft`: unsaved editor text, for the note editor's autosave (§10.1). Kept in memory and
      mirrored to `localStorage` key `qd-drafts-v1` as a per-viewer convenience.
    - `ui.paneLimits` and `ui.isTop`.
    - `untrack` inside `pushFloating/popFloating/toast/toastUndo/dismissToast`, so a call from an `$effect` cannot loop
      (WP7b request).
    - `app.fatalReason`, `app.revealDataDir()` and the exported `hasIpc()`.
    - `settings.chromeActive`, `settings.chromeUnsupported`, and the exported `RESET_PRESERVED` and `resetValue()`.

12. **`settings.resetToDefaults()` keeps `uiLanguage`, `onboardingDone`, `hintsSeen` and `closeToTrayAsked`**,
    optimistically too, like the Rust reset (WP2b deviation 5 and request). The mock's `settings_reset` does the same.

13. **Title bar.**
    - The palette button is a centred "command centre" with its shortcut on a three-column grid. In windows under 860 px
      it shrinks to its icon.
    - The breadcrumb opens Go to. Outside the reader it reads "← Reading / Settings" and returns to the reader.
    - The breadcrumb names a spread "Pages 261–262" ("ص ٢٦١–٢٦٢"), new key `shell.titleBar.pages`.
    - macOS keeps 78 px free on the *physical* left (`/* physical-ok */`), because the traffic lights never mirror.
    - Windows and macOS use `data-tauri-drag-region="deep"`. With tauri 2.12's `drag.js`, the bar's non-interactive
      parts drag and a double-click maximises. Linux gets no drag region.

14. **NavRail.**
    - Tooltips carry the shortcut.
    - A 3 px indicator pill marks the shown tab or view on the rail's inline-start edge, and it mirrors.
    - Downloads shows a pulsing activity dot while `packs.activeJobs` is non-empty, and its tooltip gives the count
      (`shell.rail.downloadsActive`).

15. **`ShortcutTable`.**
    - It takes an optional `query` prop beyond the §7.9 `ShortcutTableProps`, used by the sheet's filter field. Settings
      › Keyboard can ignore it.
    - Rows with the same label merge, groups with nothing registered are left out, and a container query flows the
      groups into two columns from 640 px.

16. **Dock region.** The App's dock container is `div.dock-region[data-qd-region="dock"]`. `.dock` is WP9a's own class
    and collided in QA selectors. The landmark name is "Recitation player" (`shell.landmarks.player`).

17. **Mock handlers.**
    - `window_set_chrome` answers `unsupported` for `auto`, because a browser page has no backdrop. This keeps the mock's
      chrome opaque, as on Windows 10 or Linux; `?mockMica` simulates Windows 11.
    - `settings_set` also emits `network-changed` when `networkAllowed` flips (WP0E request).
    - Development URL switches: `?mockNotice=user_db_recovered` (or `content_db_recovered`), and `?mockFatal=core`
      (or `?mockFatal=<AppError kind>`), so the banner and the fatal screens can be seen in a browser.

18. **Utilities.**
    - `format.ts`: `splitAround(text, name)` (markup in place of a placeholder) and `baseName(path)`. `clock()` treats
      NaN as 0.
    - `platform.ts`: `titleBarKind()`, `captionGlyphFont()`, `CAPTION_GLYPHS`, `CAPTION_FONTS` and
      `TRAFFIC_LIGHT_INSET`.

19. **Test helper outside a test file.**
    - `src/components/shell/testing/boot.ts` boots the stores and mounts `App` for both browser suites.
    - ESLint forbids mock imports outside `*.test.ts` (D29), so it reaches the mock state through `window.__QD_MOCK__`.

20. **Ports.** Web shots and scenarios ran on `--serve 1636`/`1637` (orchestrator assignment; §14.3 says 1520).

21. **S26** runs in mode `both`, in hafs (no dev packs needed), with `pageMode: 'spread'`. It asserts the mirror
    geometry, the Arabic-Indic breadcrumb and the unmirrored Mushaf (odd page on the right), and writes `S26.png` and
    `S26-dock.png` (the dock region's child).

### Owner request 2026-10-11: Settings as a dialog over the reader

The owner asked to show the Settings and Downloads panels "in a different way" and approved the plan ("Do all, with
your recommendations"). The shell's part of Settings:

22. **The Settings dialog** (`src/components/shell/SettingsDialog.svelte`, `settingsDialog.ts`). `App` keeps the reader
    mounted while `ui.view` is `settings` or `about` (`inDialog`) and hosts both views in one dialog. `ui.view` stays the
    source of truth, so the Rust `AppView`, deep links, the tray, the palette, `Mod+,` and the offline badge are
    unchanged. It is not a `ui.overlays` kind: `OverlayHost` renders only the top overlay, and every confirmation would
    unmount Settings.
    - `Dialog` gains `layer="view"` (drawn at `--z-dialog − 1`, no floating or modal registration, no body lock),
      `variant="plain"`, `insetTop` / `scrimTop`, `insetBottom`, `height`, `fill`, `labelledBy` and
      `onInteractOutside`.
    - Frame: 1040 × 760 at most, 24 px margins, centred between the title bar and the player dock (8 px above the
      dock's top: `insetBottom` is the dock's reach plus 8 px, less the margin) on the faint scrim. Centred in the
      whole room, the 150 % frame (S24) reached 60 px under the lifted dock, which covered the theme cards'
      captions; now the dock never lies over a floating frame, in zen too, where the dock slides in like the bar.
      Under 880 × 560 CSS px
      of room it fills the room edge to edge (`settingsFrame`, from `ui.windowSize`, so the browser mock's CSS zoom and
      the app's webview zoom agree). In zen the frame stays below the title bar's band too: the band is the bar's
      reveal zone, so a frame reaching into it would hide the bar that slides in (and its caption buttons, whose Snap
      Layouts target stays live) or, moving with it, run from the pointer reaching for the X. The scrim covers the band
      only while the bar is hidden, and the dialog never moves.
    - It opens only while no overlay, dialog or sheet is up. bits-ui's escape, outside-click and focus stacks follow
      registration order, so a dialog registered under a visible confirmation would take its keys and focus; a deep
      link that asks for Settings during a confirmation waits for it instead.
    - As it opens it closes the context menu and every popover, menu or listbox left open (`ui.dismissFloating`, which
      `trackFloating` relays to the `ui` wrappers that pass a closer; dialogs and sheets pass none). The reader's
      popovers used to unmount with the reader; now the reader stays, and `App`'s modal layer would lift one above the
      dialog, where the dialog, registered last, would take its clicks and Escape.
    - The dock stays usable: `.dock-region.lifted` sits at `--z-dialog` (above the dialog, under every overlay), and
      `App` gives the chrome's floating content the dialog's modal layer while it is open (`setModalLayer` now takes
      `null` for "none"), so the dock's popovers stack above it. Clicks on the title bar (`data-qd-region="titlebar"`),
      the dock and toasts are not outside clicks. In the filled frame, where the dock lies over the dialog's bottom, the
      views keep `--qd-dock-reserve` free at their end; and `--qd-close-room` in their top inline-end corner for the X.
    - Focus: "Search settings" (About: "Copy diagnostics") on open and when the view swaps inside the dialog; back to
      the opener on close, except when the view moved on (Downloads): then the close auto-focus is prevented and the
      canvas holds focus until the destination takes it.

23. **Keys while it is open** (`SETTINGS_ALLOWED`, `allowedInSettings` in `app.ts`; the store's step 7). Only the audio
    group, `app.palette`, `app.search`, `app.escape`, `app.settings`, `app.downloads`, `view.theme`, `view.uiScale*`
    and `view.fullscreen` run; any other global match is consumed without running (`Mod+B`, `Mod+1…7`, F6, `?`, and
    `Mod+G`, which would otherwise reach the webview's find). Reader-scoped definitions (`Mod+I`, the page keys) never
    match outside the reader (step 4), so they are not consumed. `view.fullscreen` is an addition to the approved
    list: it acts on the window only.
    - `Mod+F` focuses "Search settings" (`FOCUS_TARGETS.settingsSearch`). About has no such field, so there it turns
      the dialog back to Settings first; a palette or Go to on top closes first, as `ui.focusSearch` does.
    - `Mod+,` is `allowInInput` and toggles the dialog (from About too). Its `when` keeps it from acting over another
      layer, except the palette when it is the only one (`paletteAlone`: its own dialog is one floating and one modal
      layer): there the key, or the palette's "Settings" row, closes the palette first (as `Mod+F` does). The row runs
      after the palette has closed and checks `when` again, so the palette offers it only where it will act: not over
      a popover or sheet left under the palette, nor while the dialog shows. A plain `!layerOpen` guard would also
      have hidden "Settings" from the palette, which is itself a layer while it lists commands.
    - The theme and UI-scale chords are `allowInInput` (they type nothing), so they work from "Search settings",
      where the dialog opens, and the rows that show these keys hold true.
    - The palette's `runShortcut` returns to the reader first for a command off the list (the sidebar toggles), as it
      already did for reader commands.

24. **NavRail.** The pill and the 3 px indicator follow `data-active` instead of `[aria-pressed]`. The tabs keep
    `aria-pressed`; Settings is a dialog trigger (`aria-haspopup="dialog"`, `aria-expanded`, no `aria-pressed`) and
    closes the dialog when it shows (`toggleSettings`). Downloads is the flyout's trigger (26).

25. **Tests and scenarios.** `SettingsDialog.browser.test.ts` (14 tests, among them `Mod+F` from About and over the
    palette, the palette's "Settings" row alone and over the Downloads flyout, the flyout and the context menu closing
    as the dialog opens, and zen at 1600 × 1000 and 900 × 540 with the title bar's buttons on top),
    `settingsDialog.test.ts`, a `layer="view"` test in `Dialog.browser.test.ts`, the allow-list, `Mod+F` and `Mod+,`
    (over a popover and over a sheet too) in `shortcuts.test.ts`, the palette's return and its "Settings" row in
    `palette-providers.test.ts`, `dismissFloating` in `ui.test.ts`. `shortcuts.browser.test.ts` finds the Settings
    search field in the dialog. The macOS app-menu "Settings… ⌘," came later (28).

### Owner request 2026-10-11: the rail's Downloads flyout and the manager

The shell's part of the Downloads change (WP12a 12–15):

26. **NavRail's Downloads button** is the trigger of `DownloadsFlyout`: `aria-haspopup="dialog"` and `aria-expanded`
    from the popover, `aria-current="page"` and the pill (`data-active`) while the manager shows, no `aria-pressed`.
    Where the click navigates instead (the manager shows, or the window is under 480 × 400) it drops the popup
    attributes, so it never announces a dialog it will not open.
    - Its own handler runs before the popover's: while the manager shows it returns to the reader, and in a window
      under 480 × 400 CSS px it opens the manager; either way it cancels the popover's toggle (`preventDefault`, which
      bits-ui's composed handlers honour), for the click and for Enter and Space.
    - The pulsing dot became marks on a disc of the app surface: a 16 px `Progress` ring of the running jobs' aggregate
      progress at the bottom inline-end corner, else the number of downloads waiting for a connection; a red mark at
      the top inline-end corner when one failed. A bottom mark moves the icon 3 px towards the other corner. The ring
      has no eased steps (progress arrives at 10 Hz).
    - Tooltip and accessible name: "Downloads", then the active, waiting and failed counts. No key: `Mod+Shift+D`
      opens the manager, and the flyout's footer names it. The tooltip is off while the flyout is open.
    - Addition: in a window too short for every button (760 × 600 at 150–200 % UI scale: 300–400 CSS px of height)
      the tab group scrolls (no scrollbar) and Downloads and Settings stay at the foot. They were cut off before, so
      the small-window fallback could not be reached by the pointer. The buttons are `flex: none`: as flex items of the
      shrinkable group they would otherwise squash to their 20 px icon (a 40 × 20 pill, under the 24 px target size)
      before the group overflowed.

27. **The manager in the shell.**
    - `shellLayout` takes `manager` (`ui.view === 'downloads'`): the sidebar is hidden, docked or floating, and its
      preference kept. `openSidebar` sets the view to the reader first, so `toggleSidebar` (a rail tab, `Mod+1…7`,
      `Mod+B`) and `focusSearch` (`Mod+F`) lead back to the reader with that panel.
    - `readingCursor()` (the "Skip to Quran text" target, now shared with `App`) and `ui.focusReader(from)`: the reader
      that just came back focuses its cursor once it renders, unless focus moved on meanwhile. The manager calls it
      from its teardown, and the store checks the view after a tick, because a teardown still reads the old state.
      The cursor is the Mushaf's roving ayah item or translation mode's roving verse (it used to be the canvas there),
      so the skip link, the manager's close and Escape on the "Aa" button (WP8e 13) all land on the same element.
    - `FOCUS_TARGETS.downloads` (the manager's heading). The Settings dialog's close, when the view moved to Downloads,
      now focuses that heading rather than only the canvas.
    - `shortcuts.matches(id, e)`: whether an event presses a registered shortcut, for a layer that runs one itself.
    - Tests: `shellLayout`, `openSidebar` and `readingCursor` (both reading modes) in `ui.test.ts`, the manager's keys
      and `matches` in `shortcuts.test.ts` (the floating-sidebar Escape test now opens the sidebar from About, since
      the manager has none), the heading focus in `SettingsDialog.browser.test.ts`, and in `flyout.browser.test.ts`
      the rail button's attributes where it navigates and the rail's 40 px buttons with scrolling tabs at 507 × 400 and
      380 × 300.

### Owner request 2026-10-11: "Settings…" in the macOS app menu

28. **The app menu's "Settings…" (⌘,).** `window::install_app_menu` inserts it after About and its separator, with a
    separator of its own before Services (Apple's order: About, Settings…, Services, Hide, Quit). Choosing it shows the
    window (it may be hidden in the tray, still reciting) and emits the new `settings-requested` event
    (`contract-changes.md`); the `shortcuts` store hears it and runs `settingsFromMenu` (`app.ts`).
    - Same rule as `Mod+,` (`settingsKeyHolds`): never over another layer, the palette alone closing first. Unlike the
      key it never toggles: with Settings open it does nothing, from About it turns to Settings.
    - No double action: WKWebView offers ⌘, to the page first and resends it to the menu only if the page left it
      unhandled (not `preventDefault`ed). `Mod+,` consumes the key wherever it acts and declines exactly where
      `settingsFromMenu` declines too.
    - The menu code is compiled on every OS (`#[cfg_attr(not(target_os = "macos"), allow(dead_code))]`, as
      `tray::macos`), so the Windows and Linux builds type-check it; it is installed on macOS only.
    - Tests: `shortcuts.test.ts` (the request opens Settings, never closes it, turns About to Settings, declines over a
      confirmation, the onboarding and a popover, closes the palette alone first); the contract test in `ipc/mod.rs`
      lists the event. The menu itself needs a Mac (RELEASE_CHECKLIST).

## Requests

- **WP10a, WP10b, WP11c, WP9b (sidebar panels).** The shell draws the panel heading (deviation 2). Render the panel
  body only (no top-level title), fill the height and scroll inside. WP10a's IndexPanel already fits this way.
- **WP10a (Go to), WP10c (palette), WP11d (note editor), WP9b (self-test), WP12c (onboarding).**
  - Render a `Dialog` with `open={ui.isTop('<kind>')}` and `onOpenChange={(o) => { if (!o) ui.close('<kind>') }}`
    (deviation 1).
  - WP11d: keep the unsaved body in `ui.setDraft(key, text)`, restore it with `ui.draft(key)` on mount, and clear it
    after a save or a discard. The editor is unmounted while a confirm is on top of it.
- **WP11c (library undo toasts).** Use `ui.toastUndo(message, () => library.undo())`.
- **WP8f (PageTurnZones).** Stay hidden while `ui.zen && ui.pointerIdle` (§9.6).
- **WP8e.** In zen the dock is hidden until revealed, yet `fitLayout` still reserves the side card. At 1536 × 864 the
  zen spread sits off-centre toward the reserve. Consider centring the stage in zen, or confirm that this is intended
  (nothing moves when the dock appears).
- **WP9a.**
  - The shell positions the dock: a centred bar 10 px above the canvas edge, or the side card at the inline end 24 px
    in. `PlayerDock`/`SideDockCard` should not position themselves against the canvas.
  - Toasts follow `reader.dock` automatically.
- **WP11b (SidePane).** It renders in two hosts: a docked `<aside>` on `--surface-raised`, and a `Sheet` body when the
  pane cannot dock. Fill the height in both.
- **WP6b (Snap Layouts).** The maximise button is `[data-qd-snap]`, 46 × 40 CSS px. In the English UI it spans
  x = W−92 … W−46; in the Arabic UI x = 46 … 92. Both span y = 0 … 40, in CSS px times the UI zoom (D27). The
  maximise tooltip mentions Win+Z until the hit-test exists.
- **Lead.**
  - Add `user_backup_restore` (WP2b's suggested command) in a contract PR; the banner then offers
    "Restore from backup…" (deviation 7).
  - Fold deviations 1–17 into §7.3, §7.4, §9.5, §9.6 and §9.8.

## Requests from other packages, done here

| From | Request | Where |
|---|---|---|
| WP0E | `.app-body` pinned to the `1fr` row; overlays and menus out of flow | `App.svelte` (WP0-GATE fix kept) |
| WP0E | Use `ui.paneWidthPx`, `ui.paneDocked` (Sheet otherwise), `ui.sidebarOverlay` | `PaneLayout` |
| WP0E, WP7b | Mount the svelte-sonner `Toaster` once, with the placement following `reader.dock` | `App.svelte` |
| WP0E | `ConfirmDialog` answers through `ui.resolveConfirm(ok)` | `ConfirmDialog` |
| WP0E | Splitter double-click resets the width | `PaneLayout` |
| WP0E | Mock `settings` emits `network-changed` when `networkAllowed` changes | `handlers/settings.ts` |
| WP7b | `<TooltipProvider>` around the app | `App.svelte` |
| WP7b | `untrack` in `ui.toast`/`pushFloating`/`popFloating` | `ui.svelte.ts` |
| WP7a | `html[data-platform]` | `app.init` |
| WP7a, WP6a | `data-chrome="vibrant"` only after `window_set_chrome` succeeded; dropped on `unsupported` | `settings.svelte.ts` |
| WP2b | Keep the four preserved keys in the optimistic reset | `settings.resetToDefaults` |
| WP13a, WP6a | `installQdTest()` after mounting in test mode (own chunk) | `App.svelte` |
| WP13a | `data-qd-fatal` on the fatal screen | `FatalScreen` |
| WP-Brand | `app-icon-small.svg` in the title bar; the app icon on the fatal screen | `TitleBar`, `FatalScreen` |
