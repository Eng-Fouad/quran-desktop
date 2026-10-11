# WP0E deviations (working L0 stores)

## Deviations from ARCHITECTURE.md

1. **`settings.update(patch)` resolves `Promise<boolean>` and never rejects** (§7.3 "revert + toast on error"). Writes are
   serialised and coalesced: one `settings_set` in flight; patches made meanwhile ride on the next write with the whole
   current value; the validated result is adopted only when nothing newer is queued. A failed write reverts to the last
   confirmed value, skips the writes queued behind it and reports once. `resetToDefaults()` is optimistic the same way.
   `SettingsChanged` is adopted only while no write of ours is pending. `value` is `$state.raw` (immutable; deep-frozen
   in development so an in-place mutation, which would never persist, throws at the culprit).
2. **Error reporting hook.** `settings` cannot import `ui` (both L0; `ui` imports `settings`), so `ui.init` installs
   `settings.setErrorReporter(ui.toastError)`; before that, failures go to `console.error`.
3. **Chrome (§9.6).** `settings.applyEffects()` also sets `html[data-chrome="vibrant"]` (not Linux, `chromeEffect =
   auto`, resolved paper or night, no `prefers-reduced-transparency`), and `window_set_chrome` receives `effect: 'off'`
   whenever the frontend draws opaque chrome, so Rust never enables Mica under opaque chrome.
4. **i18n.** Numeric `t()` parameters are formatted with the UI digits (`t('common.pageNumber', { page: 262 })` →
   "الصفحة ٢٦٢"); strings pass through. `ref(s, a, toAyah?, toSurah?)` returns LRI/RLI…PDI-isolated text (the string
   form of `<bdi dir>`). `bytes()` uses `Intl` unit labels (kB/MB/GB, localised; values are binary). Extra: `date()`,
   `intlLocale`, `relTime(secs, nowMs?)`; the runtime adds `isTextKey`, `isPluralKey`, `pluralCategory`, `LOCALES` and a
   once-per-key development warning for a missing message.
5. **quran.** `pageRange(layout, p)` is every ayah with at least one word on the page (from the word tables; the
   page-start ayahs only when the index has none). Lookups return neutral values for invalid input (`{ from: 0, to:
   -1 }`, `0`, `undefined`, page 1). Extra lookups: `ayahCount`, `isAyahId`, `ayahOfWord`, `layout`, `pageCount`,
   `rubOf`, `manzilOf`, `hizbRange`, `surahName`; `refLabel(id, style, toId?)` formats ranges.
6. **ui.**
   - The §9.6 docking rule lives in the pure `shellLayout()`, fed by the window size and the fixed shell measures
     (`TITLEBAR_H` 40, `RAIL_W` 52, sidebar overlay below 900 px). It derives `sidebarOpen` (with auto-collapse),
     `sidebarOverlay`, `sidebarAutoCollapsed`, `paneDocked` and `paneWidthPx` (the shrunk width).
   - Reopening the sidebar while it is auto-collapsed keeps it open; the pane then shrinks or overlays.
   - Deep navigation: `navigate(target)` and `onNavigate(handler)`. View targets are routed by `ui`; ayah, page, surah
     and search targets go to handlers that L1/L2 stores register. A target that arrives before any handler exists is
     delivered when the first handler registers.
   - Toasts pass through to svelte-sonner (5 s, ≥ 10 s with an action, `danger` → `important`); `toastError` stays
     silent for `cancelled`.
   - Extra methods: `dismissLayer`, `isOpen`, `open/closeContextMenu`, `resolveConfirm`, `setZen/toggleZen`,
     `setFullscreen/toggleFullscreen` (the document Fullscreen API in the mock), `open/close Sidebar|SidePane`,
     `reset{Sidebar,SidePane}Width`, `focusSearch`, `focusWhenRendered`, `dismissToast`.
7. **Shortcuts (§7.7).**
   - **Precedence** when several definitions match one event: an exact chord beats punctuation matched by character,
     then the more specific scope wins (mushaf/translation > reader > global), then the most recent registration.
   - Rule 6: a key auto-repeat that a definition does not allow is still consumed (`preventDefault`), so a held Space
     never scrolls.
   - Punctuation written with an explicit `Shift+` (`Mod+Shift+=`, `Mod+Shift+.`) matches the physical US key
     (`e.code`). AltGr (Windows/Linux) and Option (macOS) count as character modifiers for punctuation matched by
     character. `NumpadN` matches `DigitN` only while it types the digit. `Mod+Ctrl+…` chords exist only on macOS.
   - Rule 2 "editable" means text-taking inputs (a checkbox, radio, range or button input is guarded by rule 3
     instead). The widget guard skips Escape and the F-keys but covers `ContextMenu` and `Shift+F10` (they open the
     focused widget's own menu).
   - Escape with a layer open is decided after propagation: the app definition acts only if nothing called
     `preventDefault()` (bits-ui's escape layer does).
   - The app `Escape` closes layers, then leaves a non-reader view (§7.4), then leaves zen. Clearing the selection or
     the search hit is a reader-scoped `Escape` that WP8e owns, and it wins by precedence.
   - The `shortcuts` store registers `appShortcuts` in `init` (`app.ts` imports L0 stores only, by file).
   - `byGroup` lists every group. Extra API: `formatAll`, `isAvailable`, `refreshLayoutMap` (re-read on window
     focus). The layout map labels only physical-key chords; character chords print their character.
8. **`listenEvent(event, handler)`** (synchronous unsubscribe over the async `listen`) is exported from
   `app.svelte.ts`, the base of the store graph, because `$lib/ipc` is frozen.
9. **Acceptance port.** The orchestrator assigned this session ports 1530–1539, so the web-shot ran on `--serve 1530`
   (§14.3 says 1520). The every-tab evidence was a scenario outside the repo, which sent the real `Ctrl+1…7`,
   `Ctrl+B`, `?`, `Esc`, `Ctrl+K` and `Ctrl+Shift+L` keystrokes and loaded the Arabic UI.

## Requests

- **WP7c (`App.svelte`): layout bug, visible in `artifacts/shots/web/shell-stores-tab-{2..7}-*.png`.** `.app` uses
  `grid-template-rows: auto auto minmax(0,1fr)`, but `StartupBanner` renders nothing without a notice. `.app-body`
  then lands in an `auto` row and the always-rendered `AyahContextMenu` placeholder takes the `1fr` row. With a short
  sidebar panel the canvas is cut at about 450 px (measured: app-body 412 px tall, the placeholder at y = 452). Pin
  `.app-body` to row 3 (or use grid areas) and keep overlays and menus out of flow.
- **WP7c:**
  - Use `ui.paneWidthPx`, `ui.paneDocked` (dock the pane, else show it as a `Sheet`) and `ui.sidebarOverlay`.
  - Mount the svelte-sonner `Toaster` (`ui.toast` already feeds it).
  - `ConfirmDialog` answers through `ui.resolveConfirm(ok)`.
  - Splitter double-click calls `ui.reset{Sidebar,SidePane}Width()`.
  - The mock `settings` handler should emit `network-changed` when `networkAllowed` changes (§5.14).
- **WP11c:** `AyahContextMenu` should render only while `ui.contextMenu !== null` (`ui.openContextMenu` /
  `closeContextMenu`).
- **WP8e:**
  - Register a reader-scoped `Escape` with `capture: true` and `when: () => reader.selection !== null ||
    reader.searchHit !== null`, without `allowInInput`.
  - Register `ui.onNavigate()` for ayah, page and surah targets in `reader.init`.
  - Register `navigationShortcuts` and `viewShortcuts` with `shortcuts.register` (the view `z` key calls
    `ui.toggleZen()`).
- **WP10b:** mark the search input `data-qd-focus="search"` (the target of `Mod+F`), and register `ui.onNavigate()`
  for `search` targets.
- **WP7b:** the floating wrappers call `ui.pushFloating()/popFloating()`, and any custom floating layer that handles
  Escape calls `preventDefault()`.
- **WP9a, WP9b, WP11c:** register your shortcut files with `shortcuts.register(defs)` (it returns the unregister
  function).
- **Lead:**
  - Fold the precedence rule, the rule-6 consumption and the `settings.update` contract (1, 7) into §7.3 and §7.7.
  - Consider moving `listenEvent` into `$lib/ipc` in a contract PR (8).
  - `pnpm lint:css` cannot run until WP7a adds `scripts/check-logical-css.mjs`. WP0E owns no CSS.
