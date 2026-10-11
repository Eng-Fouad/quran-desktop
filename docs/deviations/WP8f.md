# WP8f deviations (page navigation affordances)

Delivered:
- `src/components/mushaf/PageTurnZones.svelte`: the two click zones (§8.11).
- `src/components/mushaf/FlipHUD.svelte`: the heads-up chip while flipping or previewing on the rail (§8.11).
- `src/components/mushaf/PageRail.svelte`: the 604-step rail (§8.11). Its module script also holds the rail state the
  HUD and the chips read, the shared page label and the pure rail geometry.
- `src/components/mushaf/HintChip.svelte`: the one-time page-turn hint (§8.11).
- `src/components/mushaf/DivisionChip.svelte`: the juz / hizb arrival chip (§8.12).
- `src/lib/i18n/{en,ar}/pagenav.ts`.
- `tests/e2e/scenarios/S35.mjs`.

Tests (new files beside the components; nobody else owns them):
- **Unit** `src/components/mushaf/pagenav.test.ts` (15): the rail's book order and page mapping, juz label thinning,
  the slider keys, the zone geometry (free space, compact chevron, scrollbar clearance, never over the text), the
  Arabic genitive ordinals, the division starts, the forward-step rule, and the page label on the mock's real index in
  both UI languages (bidi-isolated spreads).
- **Browser** `src/components/mushaf/PageRail.browser.test.ts` (11, the acceptance suite) and
  `src/components/mushaf/pagenav.browser.test.ts` (14), in the real `App` on the mock:
  - the slider: `P`, focus, the name and value text, ← next / → previous, ↑ / ↓, Shift ×10, PageDown / PageUp,
    Home / End, a single turn after the last step, one history entry per visit, Enter, Escape before the reader's
    Escape;
  - book order in the English and Arabic UIs: ticks, fill, thumb, labels and the live label;
  - the reveal from the bottom edge above the dock (not over the dock), the drag preview in the HUD and a single
    turn on release, and a click that never takes focus;
  - the zones: placement, never over the text (single page, zoomed), opacity states, ends of the book, the Arabic UI,
    tab order and zen;
  - the HUD: while flipping, centred, fades 600 ms after the last flip, the Arabic form in Naskh 18 px;
  - the division chip: a juz, a hizb, never on a jump, never twice, the follow-along, announcements;
  - the hint: once after onboarding, "Got it", a page turn, never again.

## Deviations from ARCHITECTURE.md

### 1. Shared state lives in component module scripts

- The rail state, the page label and the pure helpers are exported from the components' `<script module>` blocks,
  so the package adds no file outside its §14.3 list:
  - `PageRail.svelte`: `railState`, `pageLabel`, `isolatedRange`, `railFraction`, `pageAtFraction`, `pageAtX`,
    `juzLabelStep`, `juzLabelled`, `railKeyTarget` and the constants;
  - `PageTurnZones.svelte`: `zoneGeometry`;
  - `DivisionChip.svelte`: `arabicOrdinal`, `divisionStarts`, `isForwardStep`;
  - `HintChip.svelte`: `PAGE_TURN_HINT`.
- `railState` holds two fields:
  - `open`: the strip is on screen;
  - `preview`: the page a drag or keyboard steps show and have not turned to yet.

### 2. The page label (§8.11)

- "surah · page · juz" names the surah and juz of the first ayah on the (first) page, as the running head does.
- A spread reads "Pages 261–262" (`ص ٢٦١–٢٦٢`). The range is bidi-isolated like references (§11.3): RLI with
  Arabic-Indic digits, LRI otherwise. Without the isolation, Arabic digits in the English UI showed "262–261".
- **FlipHUD in the English UI:** the Arabic surah name in Naskh (20 px, `--surah-header-ink`) leads, then "Al-Hijr ·
  Page 262 · Juz 14" in the UI font.
  - In the Arabic UI the chip is §8.11's example exactly: `الحجر · ص ٢٦٢ · ج ١٤` in Naskh 18 px.
  - §8.11 shows only the Arabic form; Arabic-Indic page numbers alone are unreadable to many English UI users.
- The HUD is on `--glass-fill` (the overlay surface, or `--surface-raised` where translucency is off, §9.4) with
  `shadow-3`, centred in the page area above the bar dock's reserve. It is `aria-hidden`: the reader announces the
  page it settles on.

### 3. Page rail (§8.11)

- **Placement.**
  - The strip floats 8 px above whatever sits at the bottom of the page area under its span: the bar dock (any
    mode: idle pill, bar, collapsed, error), and the follow chip or the memorisation bars in the slot. Otherwise it
    sits 8 px above the canvas bottom (the side card is beside the page area, not under it).
  - §8.11 does not say where the revealed strip goes. At the very bottom it would cover the bar dock, which floats
    10 px above the edge.
  - While open it rises when something appears under it (zen showing the dock) and never drops under the pointer.
    In zen the dock hides as soon as the pointer moves up onto the rail.
  - Width: the page area minus 24 px each side, at most 1120 px, centred.
- **Reveal and leave.**
  - The reveal zone is the bottom 24 px of the page area, outside the dock.
  - The pointer must rest there 90 ms, so leaving the window through the bottom edge does nothing.
  - Nothing reveals the rail while a mouse button is held (a text selection), a menu or dialog is open, or the reader
    flips.
  - The rail stays while the pointer is on it or in the band between it and the canvas bottom, the dock excepted. It
    leaves 450 ms after the pointer, which covers crossing the dock from the edge up to the rail.
  - Touch pointers never reveal it, but a touch drag on an open rail works (`touch-action: none`).
- **The live label** is a small label above the thumb. It names the page under the pointer while hovering, else the
  value. It stays inside the track at the ends. Its box keeps the track's right-to-left direction and its text the
  UI's.
  - Chromium resolves `inset-inline-*` with the element's own direction, so a `dir` on the box itself moved it.
- **Juz labels** (Arabic-Indic, always) show while the rail is hovered, focused or dragged. They are thinned so they
  stay ≥ 22 px apart: every juz at ≥ 660 px of track; else 1, 3, 5, … (step 2 or 3); else 1, 5, 10, …
- **The fill** runs from page 1 (the right end) to the value: progress through the book. A thin mark shows the
  hovered page.
- **Keyboard** (beyond ← / → and Shift ×10):
  - ↑ / ↓ are +1 / −1 (the ARIA slider convention; up is "more", the next page);
  - PageDown / PageUp go to the next / previous juz start (book order, like the reader's PageDown = next page);
  - Home / End go to pages 1 / 604.
- **Steps preview, then turn.**
  - Each key step previews at once: `aria-valuenow`, the thumb and the HUD.
  - The rail turns 350 ms after the last step: one turn however many steps, never a page per key repeat.
  - Enter turns at once and gives focus back to where it was before `P`.
  - Escape drops an untaken preview, gives focus back and closes the rail (unless the pointer holds it). Leaving with
    Tab takes the preview.
- **A focused rail is a floating layer** (`ui.pushFloating()` while it has focus).
  - The capture-phase Escape (the reader's "clear the selection", the app's "leave zen") is therefore deferred, and
    the rail's own Escape wins (§7.7 rule 1, as a popover).
  - Hovering never registers a layer, so the wheel still turns pages while the rail shows.
- **A pointer never takes focus.**
  - `pointerdown` is cancelled, so after a drag or a click ← → keep turning pages instead of moving the rail.
  - Keyboard users reach the rail with `P`.
- **History.** The first turn of a visit (rail shown → hidden) is a jump in the navigation history; later turns of
  the same visit are not, so Alt+← returns to where the visit started.
- The thumb waits on a turned-to page until the reader arrives (at most 1.5 s), instead of jumping back during the
  readiness wait.
- Not specified, added for the high-contrast audit: forced colours draw the track marks in `CanvasText` and the
  fill and thumb in `Highlight`.

### 4. Page-turn zones (§8.11)

- **Placement.**
  - With room, a zone hugs the paper with a 16 px gap, rather than sitting at the far canvas edge. On a wide canvas
    the chevron then stays near the book.
  - With less free space it starts at the page-area edge, narrowed to the free space minus 4 px. It never covers the
    paper.
  - Below 36 px of free space only a 32 px chevron stays, centred on the book, over the outer paper margin and never
    over the text block. A full-height strip there would block the margin markers' clicks. A zone that would reach
    the text block is not drawn.
  - While the canvas scrolls, 12 px at the canvas edges stay clear for the overlay scrollbars.
- The chevron sits at the vertical middle of the book's visible part. It is 40 px (28–40 px when the zone is
  narrower).
- The zone is a `<button>` the full canvas height. Its press cancels `mousedown`, so it never takes focus and ← →
  keep turning pages after a click.
- A zone with nothing to turn to (the first or the last spread) is not drawn.
- The wheel over a zone scrolls a zoomed canvas as it would over the pages.
- **Zen:** hidden from zen's start until the pointer moves, and again while it rests (`ui.pointerIdle`). A
  keyboard-focused zone always shows.
- Measured from the DOM (the `section.mp` and `.mp-block` boxes), again on resize (the canvas and the book), scroll,
  page, `qfs`, spread, dock and direction changes; at most once per frame.

### 5. First-run hint (§8.11)

- **When.**
  - After the welcome flow (`settings.onboardingDone`), in the Mushaf with no dialog open.
  - 1.2 s after the reader has settled, never during a turn or a flip.
  - So it never lands on top of the onboarding dialog, and stays out of other packages' scenario shots and tests,
    which run with `onboardingDone: false`.
- **Gone for good** (`hintsSeen` gets `"page_turn"`):
  - after showing for 12 s;
  - on "Got it";
  - when a page is turned while it waits or shows: that is the lesson learnt. A turn is a change that keeps none of
    the pages shown before, so a spread folding to one of its pages on a resize does not count.
- It steps aside (without being marked seen) while the rail is open or a dialog opens.
- The ← → keycaps sit in one left-to-right group, so they read ← → in the Arabic sentence too.
- It is a polite `role=status` with a plain-text sentence for screen readers.

### 6. Division arrival (§8.12)

- **Reading.** A forward step to the next page or spread (the new pages start right after the old ones; not a jump,
  not flipping, Mushaf mode) that shows a division's first ayah.
- **Follow-along.** With `followAlong` on and the recitation playing, the heard ayah moving on by one (the basmala
  between surahs keeps the step) onto a division's first ayah.
- **Juz and hizb.** Both are greeted. A hizb that opens a juz is greeted as the juz, so each juz has one extra
  mid-juz greeting.
- **"First enters"** is once per division per app session. The record lives in the module, so leaving the Mushaf and
  coming back does not greet a division again.
- **Text.**
  - The Arabic heading uses the genitive ordinal in every UI language (`بداية الجزء الحادي والعشرين`). The phrase
    is the Arabic `pagenav.division.*` string (`translate('ar', …)`); the ordinals (1–99) are code.
  - The English UI adds "Juz 15" / "Hizb 30" (the frozen `common.juzNumber` / `common.hizbNumber`).
  - An eight-point star in `--frame-gold` leads.
- **Announcement.** The UI-language text is announced politely ("Beginning of Juz 15"), 900 ms after the arrival, so
  the reader's own "Pages 281 and 282" is spoken first. The chip itself is `aria-hidden`.
- It carries `data-qd-keep-selection`, so a click on it does not clear the reader's selection.

### 7. S35

- **The reading position** is written by the reader itself. The scenario opens page 297, then waits until the
  bootstrap's `mushaf` position says page 297 (ayah 2168, 18:28, the first visible ayah).
- **The audio position** (18:45, ayah 2185, on page 298 of the same spread) is stored with `positionSet`, the
  command the player sends at a stop (WP9a's suggestion).
  - §7.8's example "Al-Kahf · 18:45 · p 297" holds for the spread: 18:45 is on its left page.
- **Asserts after the relaunch:**
  - the reader view in Mushaf mode;
  - page 297 and the spread 297–298;
  - the cursor on ayah 2168 with no selection;
  - the idle dock reading "Resume Al-Kahf · 18:45";
  - nothing playing;
  - no HUD, rail or arrival chip left over.
- **Shots:** `S35.png` and `S35-dock.png`.
- **Mode `both`.** It passes in the browser mock and in the real app on the real core.db. The app was built with
  `pnpm tauri build --debug --no-bundle` into `C:\qdt\WP8f`, then run with `node scripts/qa/app-driver.mjs --exe
  C:\qdt\WP8f\debug\quran-desktop.exe --only S35`; there `ctx.relaunch()` restarts the process on the same data
  dir.
- Web shots on ports 1732–1735 (the orchestrator's range for this package), not 1520.

## Requests

- **WP7c (`App.svelte`):** please open the onboarding on first run, as WP12c's request suggests
  (`if (!settings.value.onboardingDone && !app.testMode) ui.open('onboarding', {})`). The first-run hint waits for
  `onboardingDone`, so the real app never shows it until something sets that flag.
- **WP8e / WP9a (observation):** in zen at 1920 × 1080 with the side card, the book centres in the whole canvas
  (WP8e deviation 3). When the pointer reaches the bottom 80 px, the revealed side card covers the book's bottom
  corner. The rail is unaffected: it spans the page area beside the card.
- **WP13a / WP8d (observation, harness):** in one full `vitest run --project browser` (38 files),
  `src/lib/mushaf/interactions.browser.test.ts` failed 3 of its hover / WBW dwell cases. Alone, and alongside this
  package's two pointer suites, all 13 pass. Real-pointer tests in files that run in parallel share one mouse; such
  suites may need to run without file parallelism.
- **Lead:** fold deviations 1–7 into §8.11, §8.12, §9.7 and §12.6.
