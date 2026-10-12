# WP9b deviations (memorisation)

Delivered:
- **Store** `src/lib/stores/memo.svelte.ts`: hide mode with its `.w-hid` class map (`isHidden`), word and ayah
  reveals, peeking, random-start self-tests with hints, mistakes and the rating, memorisation progress (status, review,
  the whole-Quran overview, due runs), loop presets, the `<html>` session attributes and the blank style's SVG filter.
- **Components** `src/components/memo/**`:
  - `MemoToolbar` and `SelfTestBar` (MushafView's overlay slot);
  - `MemoPanel` (the Memorize sidebar tab) with `ProgressHeatmap` (the Mushaf map);
  - three new files: `RangeStatus.svelte` (a status bar plus legend, shared by the panel and the dialog),
    `PresetList.svelte` (the presets and their editor) and `keys.ts` (shortcut labels, the toolbars' roving focus,
    press-and-hold Peek).
- **Dialog** `src/components/dialogs/SelfTestDialog.svelte`: the setup step and the rating step.
- **Shortcuts** `src/lib/shortcuts/memorize.ts`: the five §10.1 rows, the peek release, and the self-test's mistake key.
- **Mock** `src/lib/ipc/mock/handlers/memo.ts`: WP2b's `user_db::memo` and `user_db::presets` semantics.
- **Styles** `src/styles/mushaf/memo.css`.
- **Dictionaries** `src/lib/i18n/{en,ar}/memo.ts` (Arabic plurals with all six categories).
- **Scenario** `tests/e2e/scenarios/S27.mjs`.

Tests:
- **Unit** (`vitest --project unit`):
  - `src/lib/stores/memo.test.ts` (22 tests):
    - the §5.10 schedule for every strength and rating, effective status and "due", summaries over sparse maps, due
      runs per surah, the suggested answer;
    - the class map with end markers kept; reveals by word over the markers, by ayah, to the end; restart; peeking;
    - the `<html>` attributes and the blank filter; range normalisation; leaving translation mode; the page turning
      under a reveal;
    - the keys on US and Arabic layouts: E on the page(s) or the selection, W/Shift+W (with key repeat), the Q
      release by physical key and on window blur, Shift+E's target;
    - the self-test: a random start, hints from W, Shift+W and a peek, M as a mistake that never mutes, E asking for
      the rating, the rating saved, a failed save retried without finishing twice, M in a text field;
    - progress: marking, rating, resetting, the whole-Quran load, the overview and the due list, a change from
      another surface followed through `user-data-changed`;
    - presets: order, validation, applying one (reciter, speed, repeats, gap), deleting with an undo.
  - `src/lib/ipc/mock/handlers/memo.test.ts` (7 tests): the schedule table, manual statuses, sparse reads, `review`
    derived for overdue ayahs, validation without writes, self-tests (random start, finish once, `not_found`),
    preset validation, normalisation and order, and the events of every mutation.
- **Browser** (`vitest --project browser src/components/memo`, 11 tests in two files, the real `App` on the mock):
  - `memo.browser.test.ts` (10):
    - hide mode on page 50 (markers kept, blur computed, W, Shift+W, E back);
    - Q held and released, the reveal on hover, the blank filter;
    - the §8.18 frame budget;
    - the toolbar: keys after a click, press-and-hold Peek, the style toggle, ×, one tab stop, arrows mirrored in
      RTL;
    - the panel: the map, a click opening a page, a typed range, Hide/Show, "Mark as", creating, playing and deleting
      a preset, the map from right to left in Arabic.
  - `selftest.browser.test.ts` (1): Shift+E, setup, start, hints and mistakes, E, "Keep reciting", Finish, rating
    with 3, then a second test discarded.

## Deviations from ARCHITECTURE.md

1. **Ayah-end markers stay visible in hide mode.** `isHidden` is false for them (they are no text to recite, and they
   show where each ayah ends while reciting). Reveals step over them, and word counts leave them out ("3 of 135 words"
   on page 50).

2. **The blank style is drawn by an SVG filter** (`filter: url(#qd-memo-blank)`). §8.16 asks for `opacity: 0` plus an
   inset `box-shadow` underline, but `opacity: 0` also hides the element's own box-shadow, so no underline would show.
   The filter's output is a `--text-faint` rule in the lower part of the word box (x 10–90 %, y 70–73.5 %, flood
   opacity 0.7, `GrayText` in forced colours). It never paints the glyph, so it hides COLR (V4) glyphs too. The store
   inserts the `<svg>` that holds the filter into `<body>` while a session runs in the blank style, and removes it
   afterwards. The rule sits on the baseline in hafs, V1, V2 and V4.

3. **Reveals are instant; only hover fades** (120 ms). With a fade, each revealed word repainted its raster tiles,
   blurred neighbours included, on every frame of the fade. Revealing one word per frame on a spread then measured
   p95 24.9 ms, worst 42 ms (headless Edge, 120 Hz). Without the fade it measured p95 8.5 ms, worst 9 ms, which keeps
   §8.18's ≤ 16 ms. Giving each hidden word its own compositing layer was slower (p95 18 ms). The blur itself is never
   transitioned (§8.16).

4. **`<html>` carries the session** for `memo.css`: `data-memo` (`hide` | `test`), `data-memo-style` (`blur` |
   `blank`) and `data-memo-hover`. `data-memo-hover` is set only in hide mode: in a self-test every hint is counted, so
   hovering reveals nothing there. A peek (Q) during a test counts as a hint.

5. **The mistake key (M) is not a registry definition.** The frozen `shortcuts.*` labels have no "mistake" entry, and
   `m` is WP9a's global mute. While a test runs, a capture-phase listener in `memorize.ts` takes `m` under the
   registry's rules: no open layer, no editable target, the widget guard, the reader view, no auto-repeat, hybrid
   matching. It marks the key handled, so mute does not fire. Outside a test, `m` mutes as before. The bar and the
   dialog show the key.

6. **E and Shift+E during a self-test open its rating** instead of showing the text or starting another test. The
   test ends through the rating, or through × ("Cancel the test").

7. **What a self-test rates.** `memo_test_finish` records the test; then `memo_review` reschedules the recited span
   `[start, to]` with the answer and the mistake count. This follows WP2b: `memo_test_finish` never touches the schedule.
   The rest of the range, before the random start, was not recited.

8. **Hide mode and navigation.**
   - `startHide` never moves the reader; callers that may be off screen move it first (the panel, the index's
     "Memorize ▸ Hide").
   - `startTest` jumps to the start ayah with an arrival flash and pauses a playing recitation (it would give the
     answer away).
   - Both leave translation mode for the Mushaf, keeping the position by ayah.
   - A reveal whose word lies on a page off screen turns to that page.

9. **Shift+E's target**: the selection, else the surah of `reader.actionTarget`. `reader.headSurah` is the surah of the
   first ayah on screen, which on a spread is often the previous surah. The panel's Surah and Juz scopes use the same
   rule.

10. **History.** A finished self-test and a hide session of at least 30 s are recorded as `memorize` history entries
    (the start ayah and its page, the time spent). WP11c's History panel already lists that mode.

11. **Store API beyond §7.3** (additive; every §7.3 name is kept, and `active` stays writable for WP8a's test):
    - State: `presets`, `loaded`, `testReveals`, `testMistakes`, `testStartedAt`, `clock` (Unix seconds, ticking
      every 30 s, so "due" follows the time).
    - Derived: `firstWord`, `lastWord`, `wordCounts {total, revealed}`, `nextHidden`, `overview` (a whole-Quran
      `ProgressSummary`), `due` (`DueRange[]`).
    - Methods:
      - `restart()`, `addMistake()`, `undoMistake()`, `cancelTest()`;
      - `loadAll()`, `loadPresets(force?)`, `savePreset(input)`, `deletePreset(id)` (an undo toast re-creates it);
      - `label(from, to?)`, `minStrength(from, to)`, `lastWordOf(ayahId)`.
    - Return values: `startTest`, `finishTest`, `rate`, `setStatus` and `loadProgress` resolve a boolean.
    - Mutations never reject: failures are toasted (`ui.toastError`). The `.catch(ui.toastError)` that WP10a and WP11c
      add is harmless.
    - Module exports: `schedule`, `suggestRating`, `summarize`, `dueRanges`, `effectiveStatus`, `isDue`, `isRating`,
      `RATINGS`, `RATING_NAMES`, `QURAN_WORDS`, `BLANK_FILTER_ID`, `DAY_S`, `AGAIN_S`, …
    - Progress is a sparse map. A read replaces its span and a mutation merges its rows; `new` rows drop out.
    - `user-data-changed` (`memo`) re-reads the loaded span after 150 ms; (`presets`) re-reads the presets.
    - Reads are sequenced per span. A read that a mutation overtook is repeated.

12. **The self-test dialog has two steps**, fixed when it opens (`OverlayProps['self-test']` is unchanged):
    - **Setup**: the range and its status, how hidden words look (`memoHideStyle`), the keys, and Start.
    - **Rating**: what was recited, the time, hints and mistakes, and the four §5.10 answers. Each answer shows the
      interval for the weakest ayah. The suggested answer is marked: none → easy; up to 3 % of the words → good; up to
      15 % → hard; else again. Keys 1–4 answer.
    - "Keep reciting" closes the rating dialog; "Discard the test" ends the test unrated.

13. **Surfaces §9.7 leaves open.**
    - **Toolbar** (hide mode): a pill in the dock's glass with the status, Next word (W), Next ayah (Shift+W), Peek
      (hold Q, or hold the button), the style toggle (blur ↔ blank), Hide again, and Show the text (E).
    - **Self-test bar**: "Recite from {ref}", then "to {ref} · time · hints · mistakes", with Reveal, Mistake (with a
      tally and a −), Finish and ×.
    - **Shared toolbar behaviour**:
      - Both are `role="toolbar"` with one tab stop and ←/→/Home/End, mirrored in RTL.
      - A mouse press never takes focus, so W/Q/M keep working after a click (§7.7 widget guard).
      - Labels give way to icons on a narrow canvas.
    - **Panel**, top to bottom:
      - Progress (the empty state teaches E).
      - Practise: Selection / Page / Surah / Juz, or a typed range parsed by `parseReference`; Hide, Self-test,
        Listen ×3, and "Mark as" (resetting asks first).
      - Due for review.
      - The Mushaf map.
      - Loop presets.
    - **Mushaf map**:
      - One square per page, one row per juz (rows follow the UI direction).
      - Shade = (memorized + overdue + 0.4 × learning) ÷ ayahs, in four steps; pages with due ayahs carry a dot, and
        the pages on screen a ring.
      - A tooltip, keyboard navigation (`role="grid"`, `aria-activedescendant`) and a spoken label per page.
    - **Presets**:
      - Play, an editor (name, each ayah ×N with ∞, the whole range ×N, a pause of none/×½/×1/×2 of the ayah's
        length) and Delete with an undo.
      - The dock's repeat popover (WP9a) uses the same `loop_preset_*` rows.

14. **Linux hide style.** §8.16 makes `blank` the Linux default if WebKitGTK misses the budget. This machine has no
    WebKitGTK, so it could not be measured. The default stays `blur`; the WP13b smoke list should check it.
    - Playwright's WebKit on Linux without a GPU (the CI runner, 2026-10-12) misses it badly: it paints CSS filters
      on the CPU, about 1 s a frame for the hidden spread (`blank`: about 50 ms), mostly on the main thread; 300 spans
      under `blur()` on an empty page take 100–450 ms a frame. Chromium on the same machine keeps 16.7 ms, and
      reveals cost 1–2 ms of script, style and layout in both. WebKitGTK with a GPU is still unmeasured.
    - So the browser test's frame-rate half (§8.18) does not run there: on WebKit under Linux the W presses come back
      to back and only their work is checked (`memo.browser.test.ts`), and hide mode's tests get 45 s (pointer
      actions wait for frames). The frame-budget test is retried twice everywhere, since the other test files share
      the runner's CPUs. The self-test's browser test hides with `blank`.

15. **Ports**: shots and scratch servers on 1740–1741 (the orchestrator's range); §14.3 says 1520.

## Requests from other packages, answered

- **WP9a**: `loop_preset_upsert` (and the rest of `loop_preset_*`) works in the mock. The dock's "Save as preset" saves,
  and presets saved in the Memorize panel show up in the repeat popover (they are the same rows).
- **WP8a**: `memo.isHidden(id)` reads `active`, `revealedThrough` and `peeking` (all `$state`), so `GlyphLayer`'s
  class-map effect re-runs on each change. It is O(1) per word: a range check and one `Set` lookup for end markers.

## Requests

- **WP7c (OverlayHost), a real bug outside this package.** If an overlay opens within `OverlayHost`'s 260 ms exit
  window after another one closed, bits-ui's body scroll lock stays behind. `<body>` keeps `pointer-events: none;
  overflow: hidden` for good, and the app takes no more clicks until a reload. Reproduction (any overlay kind) is
  `ui.confirm(…)`, `ui.close('confirm')`, wait 230 ms, `ui.confirm(…)` again, `ui.close('confirm')`. After 800 ms
  `body.style` still holds the lock. With 600 ms between the two, it is released. The `{#key shown}` swap probably
  destroys the closing instance while bits-ui's presence and lock bookkeeping are mid-exit. WP9b's browser test waits
  out the window (`selftest.browser.test.ts`).
- **WP8d (WordTooltip).** With `memoRevealOnHover` off, the word-by-word tooltip still shows a hidden word's Arabic
  after the 450 ms dwell, which gives the word away. Please skip the tooltip while `memo.isHidden(wordId)` is true.
- **Lead / contract PR (`src/lib/i18n/{en,ar}/shortcuts.ts`).** Add `shortcuts.memorize.mistake` ("Count a mistake (in a
  self-test)" / "احتساب خطأ (في الاختبار الذاتي)"). The `m` key could then become a registry definition (`scope:
  'reader'`, `when: memo.test !== null`) and appear in the shortcut sheet, and the listener of deviation 5 could go.
- **WP12b (Settings › Memorization).** Bind `memoHideStyle` and `memoRevealOnHover`; the store and `memo.css` follow
  both live. The toolbar and the self-test dialog edit `memoHideStyle` too.
- **WP11c / WP10a.** `memo.setStatus` now toasts the change ("Marked Al-Mulk 67:1–30 as memorized") and never rejects.
  The context menu's and the index's "Memorize ▸" items need nothing more.
- **WP13a (observation).** `src/lib/testing/qdtest.test.ts` "opens overlays with QA defaults" expects the note-editor
  default `{8, 8}` and gets `{1, 1}`. `reader.actionTarget` now uses the visible cursor only. This is unrelated to WP9b
  and was seen in the full unit run.
- **Lead.** Fold deviations 1–13 into §7.3, §8.16, §9.7 and §10.1, and the measured budget (deviation 3) into §8.18.

## Verification (this machine, Windows 11)

| Command | Result |
|---|---|
| `pnpm exec vitest run --project unit src/lib/stores/memo` | 22 passed |
| `pnpm exec vitest run --project unit src/lib/ipc/mock/handlers/memo` | 7 passed |
| `pnpm exec vitest run --project browser src/components/memo` | 11 passed (headless Edge), four runs in a row |
| `pnpm shots:web --serve 1740 --only S27` | passed, no page or console errors: `S27.png`, `S27-page.png`, `S27-toolbar.png` |
| `node scripts/qa/app-driver.mjs --exe C:\qdt\WP9b\debug\quran-desktop.exe --only S27` | passed in the real app (`meta.mode = 'both'`) |
| `pnpm check` | no error in the owned files (other packages' files were mid-edit during the run) |
| `eslint` / `prettier --check` on the owned files; `pnpm lint:css` | clean; 0 violations in 201 files |
| DoD grep `NotImplemented\|not implemented` on the owned paths | no match |

**Real app** (`pnpm tauri build --debug --no-bundle` into `C:\qdt\WP9b`, app-driver with `QD_AUDIO_SINK=null`, a scratch
scenario): the WP2b commands answered the store as the mock does. `memo_set_status` and `memo_progress` returned 574
rows with `review` derived. `loop_preset_upsert` saved a preset. Shift+E, Enter, W, M, E and 3 ran a self-test of
Al-Mulk from a random 67:17. The panel showed "574 ayahs memorized", the due run and the map. After the rating,
`memo_progress` held 67:17–30 as `learning`, strength 1, due in a day.
