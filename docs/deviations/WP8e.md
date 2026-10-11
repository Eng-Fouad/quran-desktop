# WP8e deviations (reader, spread, turns, zoom, follow-along and copy)

Delivered:
- `src/lib/stores/reader.svelte.ts`: §7.3 reader with §7.8 startup restore, §8.10–§8.15 behaviour, the follow-along
  (§8.12), the reading position and the history dwell.
- `src/components/mushaf/{MushafView, SpreadStage, FollowChip}.svelte`.
- `src/lib/mushaf/{copy, transitions, wheel}.ts`.
- `src/lib/shortcuts/{navigation, view}.ts`.
- `src/styles/mushaf/spread.css`.
- `src/lib/i18n/{en,ar}/reader.ts`.
- `tests/e2e/scenarios/{S28, S29, S32}.mjs`.

Tests:
- **Unit** (`vitest --project unit`, 94 tests):
  - `src/lib/mushaf/copy.test.ts` (27). Every case of the shared `copy_vectors.json` (WP1a) and its reference line,
    plus native-selection cases: a partial ayah, a range across an end marker, a lone marker, no words, an unknown
    surah name, and QCF glyph codes never reaching the text.
  - `src/lib/mushaf/wheel.test.ts` (16). Normalisation, one page per gesture (a 1.2 s inertia stream turns once),
    thresholds, the 400 ms floor, notches, book-order swipes, scrolling past the fit, notch and pinch zoom, ⌘ on
    macOS.
  - `src/lib/mushaf/transitions.test.ts` (5). A stand-in turn host: commit order, one pending turn, superseded and
    cancelled requests, no host.
  - `src/lib/stores/reader.test.ts` (46), on the browser mock:
    - startup restore (first run, same layout, another layout, translation mode);
    - the §8.2 table and the canvas estimate; a spread collapsing to the cursor's page; zoom steps and anchors; page
      mode;
    - turns, quick presses, single mode, announcements, history, back/forward, selection clearing, flipping;
    - jumps (flash, search hit, deep navigation, translation mode), cursor moves across a page, the action target,
      Escape;
    - the follow-along (turn, basmala, hold and chip, dismissal, off);
    - every key of both shortcut files;
    - the position and history writes.
- **Browser** (`vitest --project browser`, 16 tests): `src/components/mushaf/MushafView.browser.test.ts` in the real
  `App` on the mock.
  - The acceptance check: the single-mode `.mp-block` x on 261/262 differs by ≤ 0.5 px, and the paper moves by 1 qfs
    instead.
  - The spread: page order, one book shadow, spine corners, shading and the fold. Book order in the Arabic UI. The bar
    and side-card reserves.
  - The page turn: the view transition on the spread only, then cleanup. No animation with the setting off. CLS 0 of
    the canvas over four turns.
  - Wheel and zoom: a notch turns one page. Ctrl+wheel and the keyboard keep their anchor within 1 px. A new page on
    a scrolled canvas starts at its reading corner.
  - Copy, outside copies, the follow chip above the dock, and the placeholders.

## Deviations from ARCHITECTURE.md

### 1. Copy (§5.5, §8.14)

- **`CopyRefs`** is `{ surah(n) → { nameSimple, nameAr } }`, which the `quran` store satisfies. It replaces the
  placeholder's `refLabel`, because `quran.refLabel` returns UI-language labels wrapped in bidi isolates, not the §5.5
  reference.
- **The translation part.** A `copy` event must fill the clipboard synchronously, and pack text is behind IPC. So:
  - the handler writes the Arabic and the reference at once;
  - with `copy.translationPackId` set, it then completes the clipboard (`navigator.clipboard.writeText`) with the
    `\n\n{translation}` that `quran_copy_text` builds for the touched ayahs;
  - if that step fails, the Arabic copy stays.
- **The reference** spans the first and the last copied word's ayah. A selection made of end markers only, without
  numbers, copies the reference alone, with no leading newline.
- `selectedPageWords(selection, root, pageData)` is exported from `copy.ts`. It takes the words of every rendition a
  range intersects; a word drawn by two stacked renditions counts once.

### 2. Page turns (§8.11; `transitions.ts`)

- **No reader import.** The reader registers itself as the turn host (`setTurnHost`), so `transitions.ts` never imports
  the reader. `turnTo(page, dir, opts)` keeps the §8.11 signature.
- **The pending turn.**
  - A turn requested while one runs replaces the waiting one; the replaced request resolves without committing.
  - It also skips the running animation (`skipTransition`), so quick presses turn at once and count on from the turn
    still on its way.
  - A turn superseded during its 120 ms readiness wait never commits.
  - `cancelTurns()` (used by flipping) drops everything.
- **When turns do not animate.**
  - When the canvas scrolls (zoom > 100 % or `QFS_MIN`): a view-transition snapshot is drawn unclipped, so a zoomed
    spread would spill over the sidebar and the dock for 260 ms.
  - When the stage is not mounted.
  - In both cases the turn commits directly after the readiness wait.
- **Single-page mode animates too.** `.single` carries the same `view-transition-name: qd-spread`.
- **Keyframes.** The group animation is 0 s (the book never moves); the old/new keyframes are §8.11's.
- **Rejections.** A skipped transition's `ready` rejection is handled, so a turn never leaves an unhandled rejection.

### 3. Spread and stage (§8.10)

- **One shadow for the book** (WP8a's request). The spread draws one book shadow (`.spread { box-shadow: var(--shadow-page) }`)
  and the pages none, so the spine has no one-sided seam. Single pages keep their own shadow and four rounded corners.
- **Spine shading.** It follows a gutter curve (alpha × 1 → 0.42 → 0.12 → 0 over 1.2 qfs) rather than a two-stop
  linear fade, which looked flat at the fold.
- **The fold.** A 1 px `--border` hairline (`CanvasText` in forced colours).
- **Keying.** Pages are keyed by page number. Keying by slot moved the old page's furniture (heads, markers) to new
  places, which the layout-shift metric counts. A style change keeps the page, so the rendition stack cross-fades the
  two styles (§8.5). Until the new style's `PageData` arrives, the slot keeps showing the old style's data (WP8b's
  request).
- **Blank paper.** A slot whose data is still loading shows blank paper in the final geometry (`.mp.mp-blank`, §9.8:
  never a skeleton).
- **Reserves.**
  - The stage reserves the bar dock under the book (`BAR_RESERVE` 84 / `COMPACT_BAR_RESERVE` 64) and the side card at
    the inline end (`SIDE_DOCK_W` 288).
  - It centres the book in what is left (auto margins: centred while it fits, pinned to the start once it overflows).
  - **Zen** drops both reserves, so the book centres in the whole canvas (WP7c's request). Nothing moves when the
    dock is revealed.
- **Scrolling.**
  - The canvas scrolls inside the design system's `ScrollArea` (overlay scrollbars, both axes, shown while
    scrolling). bits-ui sets `position: relative` inline, so the area is sized rather than inset.
  - A new page on a scrolled canvas starts at its top, on the reading side (the right edge).
- **DOM hooks.**
  - The book container is `[data-qd-stage]` (`.spread` or `.single`), inside the padded `.mv-stage`.
  - The wrapper is deliberately not `.stage`: WP8c's S03 shoots `.mushaf-view .stage, .spread`, which must resolve
    to the book alone.
  - The view root is `.mushaf-view[data-qd-view="mushaf"]`; the scroll viewport is its `[data-scroll-area-viewport]`.

### 4. Zoom (§8.13)

- **The anchor.** It is measured on the book (`[data-qd-stage]`): the book point under the pointer (or the canvas
  centre) is captured before `qfs` changes and restored after it. This is §8.13's formula, made immune to the stage
  padding and centring.
  - When the book is barely larger than the canvas, the anchor is limited by the scroll range (the scroll position
    cannot go negative).
  - Window resizes keep the centre the same way.
- **The indicator.** A small indicator ("150%", "Fit to window" at 100 %) shows at the top of the page area for 0.9 s
  after each zoom change, and the change is announced politely. §8.13 has no indicator; without one, a keyboard zoom
  of 10 % is easy to miss.
- **`Mod++`.** Zoom in also accepts `Mod++`: the numeric keypad, and layouts where `+` has its own key (German). There,
  `Ctrl+=` is `Ctrl+Shift+0`, which the app's exact UI-scale chord takes. On US keyboards the app's exact `Mod+Shift+=`
  still wins (§7.7 precedence).

### 5. Wheel (§8.13)

- **One notch, one page.** A gesture that *opens* with a single large event (≥ 50 px, or a line/page-mode event) turns
  at once.
  - Chromium reports one wheel notch as 100 px on Windows, below the 120 px gesture threshold, so a single notch would
    otherwise never turn a page.
  - Touchpad streams open with small deltas and keep the §8.13 thresholds (120 px vertical, 80 px horizontal per
    gesture, one turn per gesture, 400 ms floor).
- **Zoom by wheel.**
  - A wheel notch is one 10 % step, whatever its size.
  - A pinch (small Ctrl+wheel deltas) accumulates: one step per 60 px.
  - `⌘`+wheel zooms on macOS; a pinch always arrives as Ctrl.
- The wheel does nothing while a menu, popover or dialog is open (`ui.layerOpen`).

### 6. Follow-along (§8.12)

- **Target.** `reader.followTarget` is the recitation's page in Mushaf mode with `followAlong` on:
  - the recited word's page;
  - else the page of the ayah's first word;
  - during the basmala, the page of the surah's first ayah.
- **When the recitation reaches a new page off screen:**
  - it turns there (animated), unless the user navigated in the last 4 s or is flipping;
  - otherwise `followChip` is set.
- **When the user navigates away** from the recitation's page, the chip shows at once. It is the same "Return to
  recitation" offer that WP11a's translation view makes after a manual scroll.
- **The chip.**
  - It hides when the recitation's page is on screen again or the recitation stops.
  - × or Escape dismisses it until the recitation reaches another page.
  - A click turns to the recitation and lifts the hold.
  - Its arrow points the way the book turns to get there (physical book order, never mirrored), and a small counter
    names the page.
- **Translation mode.** The reader never turns in translation mode: WP11a's view follows the recitation itself.

### 7. Reader API beyond §7.3 (all additive)

- **Exports:**
  - `spreadPages(page, spread, last?)`;
  - `nextSelection` (WP8d's semantics, exported here too, so the store does not import `interactions.ts`);
  - `STAGE_SELECTOR`;
  - the constants `FLIP_INTERVAL_MS` (70), `FLIP_SETTLE_MS` (250), `FLASH_MS` (1200), `MANUAL_HOLD_MS` (4000),
    `POSITION_DEBOUNCE_MS`, `HISTORY_DWELL_MS`, `HISTORY_FLUSH_MS` and `NAV_HISTORY_MAX` (50).
- **State:** `followChip`, `railRequest` (bumped by `P`), and `revealRequest` (scrolls an ayah into view on a scrolled
  canvas).
- **Derived:** `scrolls`, `visibleRange`, `followTarget`.
- **Methods:**
  - pages: `pagesFor`, `isVisible`, `setPageNow` (the turn host's commit);
  - steps: `surahStep(±1)`, `edgePage`, `cursorToEdge`;
  - `escape()`;
  - follow-along: `returnToRecitation`, `dismissFollowChip`;
  - `takeZoomAnchor`, `toggleReadingMode`, `revealRail`.
- **`currentAyahId`** is a number: in translation mode the view's top verse (WP11a's `topAyahId`), else the first
  ayah of the first visible page. `headSurah`, `juz` and the `actionTarget` fallback follow it (WP11a's request).
- **The canvas estimate.** Until `MushafView` measures the canvas, and while it is not mounted (translation mode,
  other views), the fit uses the canvas computed from the shell layout:
  - the window minus the title bar, the rail, a docked sidebar and a docked side pane;
  - the whole window in zen.

  So the dock placement and `qfs` follow the window in every view. `MushafView` reports `0 × 0` when it unmounts.

### 8. Selection, cursor and jumps (§8.15, §7.4)

- **`select(id, extend)`** follows `nextSelection` and moves the cursor. It pins the side pane (`paneFollow =
  'selection'`). `clearSelection()` and `followRecitation()` set `paneFollow = 'audio'`; `followRecitation` keeps the
  visible selection.
- **Cursor keys from off screen.** A cursor that is off screen starts from the visible pages: ↓ the first visible
  ayah, ↑ the last. Shift extends only a visible selection, or a visible cursor; it never extends from off screen.
- **`Home`/`End`** select the first/last ayah of the visible pages, like a cursor move.
- **Visible.** "Visible" means sharing words with the visible pages. In translation mode the view keeps the cursor and
  the selection on screen, so they always count as visible.
- **Jumps.**
  - The navigation history records where a jump started (the cursor still on its old ayah), at most 50 entries per
    direction. Sequential turns are not jumps.
  - A jump to a page already on screen records nothing.
  - The flash is set once the page is on screen, so the highlight layer plays it in full.
  - `focus` moves focus to the ayah's roving item (Mushaf) or verse (`#tv-a{id}`, translation), and announces
    "{surah} {ref}, page {n}".
- **Announcements.**
  - Mushaf page changes are announced as "Page n", or "Pages n and m" for a spread.
  - During flipping only the settled page is announced.
  - A jump with focus announces the ayah instead.
- **Deep navigation** (`ui.onNavigate`):
  - ayah: `goToAyah(id, { flash, focus })`;
  - page: `goToPage(p)`;
  - surah: its first ayah with `{ flash, focus }`.
- **A layout change** (style v2 ↔ v1 ↔ v4) keeps the reading place by ayah, not by page number.
- **A spread collapsing to a single page** keeps the page the reader is on: the visible cursor's, else the visible
  selection's. Opening the side pane, narrowing the window or `D` can collapse a spread. Before, the anchor page was
  kept, so a selection on the even page vanished with the other half of the book and the study keys silently moved
  to the first visible ayah.

### 9. Shortcuts (§10.1)

- **Registration.** The reader registers `navigationShortcuts` and `viewShortcuts` in `init`. Both files import the
  reader only inside their handlers.
- **Always handled:** `Alt+←/→` (back/forward) and `F3`/`Shift+F3` (search hits) carry no `when()`. Otherwise the
  webview's own Alt+← (history) or F3 (find bar) would run whenever there is nothing to go back to. The palette
  therefore always lists them; they do nothing without history or results.
- **The reader's Escape** (`nav.escape`, capture, reader scope, label `shortcuts.app.escape`, so the sheet shows one
  row) clears the selection *and* the search hit together, else dismisses the follow chip. With focus on the chip,
  it dismisses the chip first.
- **`D`** toasts the new page mode ("Page mode: single page"): in auto mode the layout may not change visibly.
- **`T`** announces the new reading mode. Returning to the Mushaf puts the cursor and the page on the translation
  view's top verse.
- **Mouse buttons 4/5** go back/forward in the reader. Their default action is cancelled, so the webview never
  navigates.

### 10. Persistence (§7.3, §7.8)

- **The reading position** of the current mode is written 1 s after it settles: the visible cursor, else the first
  visible ayah.
  - Translation mode writes WP11a's anchor (`page`, `scrollPx`).
  - The restored position is not rewritten at startup.
  - A pending write is flushed when the window is hidden or the page unloads.
- **The history.**
  - A place read for 3 s of visible time is recorded (`history.record`, mode `read`).
  - The dwell is topped up every minute and when leaving the place; `history_record` adds dwells within its
    10-minute dedupe window.
  - Turns and flipping do not count.

### 11. Canvas overlay slot (§7.5)

- **Position.** The slot sits at the bottom centre of the page area: 14 px above the bar (88 / 80 px from the bottom),
  or 24 px from the bottom beside the side card.
- **Order:** FollowChip, MemoToolbar, SelfTestBar, DivisionChip, HintChip, in a centred column with an 8 px gap.
- **Wave bridge.** Other packages' wave-0 placeholders inside `MushafView` (WP8f's zones, HUD, rail and chips; WP9b's
  bars) are hidden (`[data-placeholder] { display: none }`). This stops by itself as they land.

### 12. Scenarios

- **S28** sets 200 % after the fit and scrolls into page 262.
  - It asserts: the doubled `qfs` (within a quarter step of 2 × the floored fit); scrolling on both axes; overlay
    scrollbars taking no space; the page sized from `--qfs` with no CSS zoom or transform; the glyph size; and the
    wheel scrolling.
  - It waits for the zoom indicator to fade before its shots.
- **S29.** §12.6 expects "single page, qfs = 18" at 1024×700 and 130 %. The browser mock and the real app differ:
  - *Browser mock.* The mock's CSS zoom leaves `innerWidth` at 1024, so the sidebar docks. The 436×660 canvas then
    fits a single page below `QFS_MIN`, and `qfs` is held at 18.
  - *Real app.* The CSS viewport is 788×538, so the sidebar floats (§9.6) and the canvas is 736×498. There
    `fitLayout` (WP8a) picks a **spread** at qfs 18: the spread and the single page are both height-limited at
    12.6 px, and §8.2 prefers the spread at ≥ 0.85 ×. That spread then also scrolls horizontally.
  - The scenario therefore asserts the fit rule for the measured canvas, `qfs = 18`, the vertical scroll and the
    wheel scrolling in both modes. It asserts the single page in the mock only. See the WP8a request below.
- **S29's screenshot** is a full-page capture in the mock: the mock's CSS zoom makes the 100vh app taller than the
  window (see the WP7c request below).
- **S32** asserts:
  - the 784×824 canvas, single page at qfs 22.75, compact bar;
  - the sidebar and the docked pane beside the canvas, the page inside it;
  - the dock clear of the text block;
  - the single-page footprint (`SINGLE_W`) centred in the canvas.
- **Modes and ports.**
  - All three run in mode `both`. In the real app they pass too (`pnpm tauri build --debug --no-bundle` into
    `C:\qdt\WP8e`, then `app-driver.mjs --exe C:\qdt\WP8e\debug\quran-desktop.exe --only S28,S29,S32`).
  - Ports 1728–1730.

## Requests

- **WP8a (`geometry.ts`, `fitLayout`):** when the fit falls below `QFS_MIN`, compare the candidates at the floor. A
  spread that no longer fits the width at 18 px should lose to a single page that does. Today the real app at
  1024×700 / 130 % shows a spread that scrolls on both axes, where §12.6 (S29) expects a single page.
- **WP7c (title bar):** the breadcrumb's segments move when the surah name changes width on a page turn. Measured:
  layout shifts of 7e-6 to 3e-5 per turn from `.meta`/`.sep` spans. The Mushaf canvas itself shifts nothing, but
  WP13b's "CLS = 0 over a 20-page session" metric counts the whole document. Suggest a layout that does not move the
  following segments, for example the variable part last or in its own fixed box.
- **WP7c (browser mock UI scale):** under the mock's CSS `zoom` on `<html>`, `.app { block-size: 100vh }` renders
  1.3 × the window height. At 130 % the dock and the bottom of the canvas fall below the window. Something like
  `calc(100vh / <zoom>)` in mock mode would keep the preview inside the window.
- **WP8f (page navigation):**
  - **Rail.** `P` bumps `reader.railRequest`; the rail should show and take focus when it changes.
  - **Turns.** Use `reader.next()/prev()` for the zones (animated, manual), `reader.goToPage(p)` for a rail release,
    and `reader.flipping` (true until 250 ms after the last flip) for the HUD.
  - **Placement.** Render the zones, HUD and rail as direct children of `.mushaf-view` (positioned absolutely), and
    the chips inside the overlay slot (`.mv-slot`, a centred column). Keep `pointer-events` on the chips themselves.
  - Placeholders are hidden until you land.
- **WP9b:** `MemoToolbar` and `SelfTestBar` render in the overlay slot (`.mv-slot`) between the follow chip and
  WP8f's chips.
- **WP10b:**
  - F3/Shift+F3 call `search.move(±1)` when `search.flatHits` is not empty.
  - Opening a hit should call `reader.goToAyah(id, { highlightWords, flash: true, focus: true })`. The reader keeps
    `searchHit` until Escape or the next hit.
- **WP11b (side pane):**
  - `reader.paneFollow` is `'selection'` while an explicit selection pins the pane, `'audio'` otherwise.
  - `reader.followRecitation()` lifts the pin (the selection stays visible).
  - `reader.actionTarget` is the ayah to show without a pin.
- **WP11c (`AyahContextMenu.browser.test.ts`, part of your acceptance):** "bookmarks, highlights and moves the reading
  bookmark on the action target…" sets `reader.cursorAyahId = 262` while pages 1–2 are on screen, then expects `B`
  to bookmark 262.
  - §8.15 makes the action target the *visible* cursor, and the placeholder reader ignored visibility. With the real
    reader, the target is the first visible ayah (1).
  - Please put the cursor's page on screen first: `reader.goToAyah(262)`, then wait until `reader.visiblePages`
    includes 42.
  - The test's other cases pass.
- **WP8c (`furniture.browser.test.ts`):** "opens the reading-bookmark popover and moves the ribbon to the action target"
  renders page 262 standalone and sets `reader.selection` to 1810, but `reader.page` stays 1. The selection is
  therefore off screen and the action target is ayah 1. Please set `reader.page = 262` before `show(262)`.
- **WP7c (`shortcuts.browser.test.ts`):** "ArrowRight in the speed slider moves the slider and leaves the page
  alone" registers a `global` spy for ←/→ and expects it to run once focus leaves the slider. The real `nav.prevPage`
  (scope `mushaf`) is registered now, so by §7.7 precedence the narrower scope takes the key and the spy never runs.
  The guard itself holds: the page stays put while the slider has focus. Please either assert on the real definition
  (`reader.visiblePages` turns), or give the spy scope `mushaf` and a chord no reader key uses.
- **WP8d / WP9a / WP11a (observation, not caused by this package):** two tests set `player.snapshot.currentAyahId`,
  `HighlightLayer.browser.test.ts` "tints the recited ayah…" and `TranslationView.browser.test.ts` "highlights the
  recitation verse…". WP9a's `player.currentAyahId` derives from `player.heard`, so neither test sees a recited ayah.
- **WP8d:** the wave bridges are inert now. `MushafView` mounts `WordTooltip` and `AyahActionBar`, and `reader.select`
  applies `nextSelection`. `HighlightLayer`'s singleton bridge and `selectAyah`'s fallback can go at an integration
  checkpoint (lead).
- **WP8a:** the `MushafPage` wave-0 bridge is inert too (RenditionStack is real); it can go at an integration checkpoint.
- **Lead:** fold deviations 1–11 into §7.3, §8.10–§8.15 and §12.6, and decide the S29 expectation together with the
  WP8a request.
