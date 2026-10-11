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
