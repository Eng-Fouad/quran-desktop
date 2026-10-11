# WP8d deviations (highlights, accessibility and interactions)

Delivered:
- `src/lib/mushaf/layout.ts`: `measure`, `ayahPills`, `wordPill` (§8.7 signatures) and the highlight plan
  (`planHighlights`, one fill per word).
- `src/lib/mushaf/a11y.ts`: `toSpeech` and the spoken page items (§8.15).
- `src/lib/mushaf/interactions.ts`: the delegated pointer action (§8.3, §8.14, §8.17).
- `src/components/mushaf/{HighlightLayer, A11yLayer, WordTooltip, AyahActionBar}.svelte`.
- `src/styles/mushaf/highlights.css`.
- `src/lib/i18n/{en,ar}/interactions.ts`.
- `tests/e2e/scenarios/{S15, S18, S31, S34}.mjs`.

Tests:
- **Unit** (`vitest --project unit`, 477 tests):
  - `src/lib/mushaf/a11y.test.ts` (19): the `toSpeech` vectors 1:1–7, 2:255 and 38:24, written out literally, plus the
    mapping and stripping rules, the page items and the division labels.
  - `src/lib/mushaf/layout.test.ts` (24): `measure` (including an ancestor scale), `ayahPills`, `wordPill`, and
    `planHighlights`. The plan is checked for at most one fill under every word over 72 state combinations. A further
    check keeps the bars below the em box at every style's `--glyph-scale`.
  - `src/lib/mushaf/layout.contrast.test.ts` (434): the §8.7 composites over WP7a's token harness. They run on what
    highlights.css paints, for 6 themes × 6 accents × ink 65/88/100 % × `prefers-contrast`.
- **Browser** (`vitest --project browser`, 25 tests):
  - `src/components/mushaf/HighlightLayer.browser.test.ts` (9): highlight shapes and the spoken list on real fixture
    pages.
  - `HighlightLayer.glide.browser.test.ts` (3, mock playback through `HighlightLayer.test-player.svelte.ts`). The glide
    measured **120 fps, worst frame 8.5–8.9 ms** in headless Edge. It also covers glide vs jump and reduced motion.
  - **How late frames are counted.** Vitest runs each browser test file in an iframe of one page. When the whole
    `src/components/mushaf` folder runs, another file's iframe can hold the compositor for ~240 ms. A heartbeat showed
    this document's main thread idle the whole time, with no long task in any context. The test therefore sets aside a
    late frame only while a main-thread heartbeat kept beating, since script, style, layout and paint all block the
    heartbeat. It requires ≥ 90 % of the frames to count. In the folder run: one frame set aside, 119–120 fps, worst
    8.5–17.5 ms.
  - `src/lib/mushaf/interactions.browser.test.ts` (13): every §8.17 gesture with real pointer input, the dwell rule,
    and the §8.14 rule.

## Deviations from ARCHITECTURE.md

### 1. Pill geometry details (§8.7)

- **No neighbouring word.** §8.7 extends that side "to the line edge". On a centred line that would draw an empty pill
  across the whole line, so the end extends `PILL.edgePad` = 0.2·qfs past the outermost word instead. On a justified
  line the outermost word already sits at the line edge, so this is the line edge plus 0.2·qfs. A pill that ends
  exactly at the glyph's edge cuts its rounded corner behind the outermost stroke.
- **Neighbouring word of another ayah.** The end extends half the gap, but at most `PILL.maxExtend` = 0.6·qfs.
  Sparse justified lines can have 3·qfs gaps, and a highlight would otherwise spill 1.5·qfs into empty paper.
- **Wider highlight layer.** The pills of a justified line's outermost words, and word pills (± 0.10·qfs), reach past
  the 16.5·qfs block. `contain: strict` would clip them, so `.mp-hl` extends `HL_OUTSET` = 0.3·qfs past the block on
  both sides. That is still inside the 0.40·qfs gap before the frame band. Coordinates stay relative to `.mp-block`.
- **Coordinate space.** `.mp-hl` is `direction: ltr`, and every rect is placed with `translate` (no physical
  properties).
- **Line band.** The band is taken from the median vertical centre of the line's word boxes, centre ± 0.38·LH. This
  equals "line top + 0.12·LH, 0.76·LH" and also holds on the opening pages and under the line-fit transform.
- **`ayahPills`.** It keeps its exact signature and derives qfs from `lh`.

### 2. One fill per word: the order of the fills (§8.7)

- **Priority.** A word takes the first fill that covers it: search hit > audio ayah > arrival flash > selection >
  user highlight > hover.
- **Demotion.** The four state fills demote a user highlight under them to a bar. Hover is not in §8.7's list of state
  fills, so it is the weakest fill and never covers a user fill; that keeps "at most one fill".
- **Flash.** `reader.flash` (§7.3) had no renderer, so it is drawn here as a state fill. It is the audio tint, pulsing
  once and fading out by `flash.until`.
- **Search hits.** Consecutive hit words share one word pill and one underline.
- **Runs.** An ayah-shaped run that meets a search pill ends exactly at the pill's edge, so the two never overlap and
  never leave a gap.

### 3. Bars and paint order

- **Paint order.** Fills, then the audio-word pill (opaque), then rings, then bars. A user highlight's bar must stay
  visible under the opaque word pill and over the selection ring's bottom edge, where it reads as a coloured underline.
- **Position.** Bars sit at the very bottom of the band. Above that they would reach the em box of the V1 glyphs
  (`--glyph-scale` 1.11). Consecutive demoted words of one highlight share one bar.
- **Hairline.** Bars carry a 1 px hairline in page colour (`box-shadow: 0 0 0 1px var(--surface-page)`). Without it,
  some bar/fill pairs are close to invisible: a yellow bar on the amber-accent word pill measures 1.01:1 luminance and
  ΔE 0.09 in OKLab. The contrast test checks the bars against the page with OKLab ΔE ≥ 0.15; the lowest pair is yellow
  on sepia at 0.19. Luminance contrast suits ink, not a saturated colour cue.
- **Contrast test scope.**
  - The selection ring is checked against the page and the state fills its own pills can carry. It never surrounds a
    user fill, which is demoted under it.
  - The cursor outline is checked against the page and the hover tint it runs over.
  - Glyph ink is checked against the page plus every single fill, including the opaque word pill.

### 4. Forced colours (§8.7, §8.15)

- **Layer above the glyphs.** Chromium paints a Canvas backplate behind every text run, which cut the outlines into
  dashes (seen on S31). The layer only holds outlines and bars in this mode, so it moves above the glyphs (`z-index:
  3`).
- **Selection.** Outlined by its ring alone, 2 px Highlight; a second outline read as one heavy band.
- **Hover.** Dotted Highlight.
- **Other fills.** Solid 2 px Highlight; the audio word uses Mark.
- **Bars.** Use `forced-color-adjust: none` in Highlight (user) and Mark (search).

### 5. The audio basmala line is WP8c's

§8.8 says the basmala segment highlights the basmala line with `--hl-audio`. WP8c's `BasmalaLine` draws that pill
itself, inside the line. HighlightLayer therefore draws nothing for the basmala, which avoids two fills on it.

### 6. `toSpeech` (§8.15)

- **Mapping before stripping.** §8.15 both maps U+06E1 to a sukun and strips U+06DF–U+06E4, a range that contains
  U+06E1. Mapping runs first.
- **Open tanween.** The open tanween are mapped to the plain tanween instead of stripped: U+08F0/08F1/08F2 →
  U+064B/064C/064D.
- **KFGQPC's code points.** The QPC Hafs text in core.db encodes the open tanween with KFGQPC's older code points, so
  these are mapped the same way: **U+0657** (`كَثِيرٗا`), **U+065E** (`سِنَةٞ`) and **U+0656** (`بِشَيۡءٖ`), as in 2:255
  and 38:24. The spec's list does not mention them, and stripping them would drop the -an/-un/-in endings.
- **Order of the item text.** End markers are left out of the words and the number follows as ` (٢٥٥)`, so a digit is
  never spoken twice.

### 7. The spoken list (§8.15)

- **Context span.** After the Arabic, a span in the UI language gives:
  - the reference ("Al-Hijr, ayah 1");
  - "continued from the previous page" or "continues on the next page" for split ayahs;
  - the margin markers that start at the ayah ("start of Juz 14", "half of Hizb 27", "place of prostration").

  §8.15 asks for the markers only when they are glyph-only. The margin is always `aria-hidden`, though, so the list is
  the screen reader's only source for them.
- **One tab stop per view.** It is the cursor's segment on the first visible page that holds it, else the first ayah
  of the first visible page (App's "Skip to Quran text" focuses `li[tabindex="0"]`).
- **Focus moves the cursor.** Focusing an item writes `reader.cursorAyahId`; §7.3 has no setter for it.
- **Layer 7.** It rings the focused item's ayah, and only for keyboard focus (`:focus-visible`), so a mouse user never
  sees a stray ring.

### 8. Interactions (§8.14, §8.17)

- **The dwell rule, exactly.**
  - The pointer must travel ≥ 4 px (path length, including the move that brought it onto the word) while on the word.
  - Then it must rest for 450 ms. Moving ≥ 4 px from the rest point restarts the rest.
  - Synthetic moves at the same position (after a layout change under a parked pointer) count for nothing.
  - End markers get no tooltip.
  - A word without a WBW entry still shows its Arabic, with the line "No word-by-word translation for this word".
- **Header lines.**
  - WP8c's `HeaderLine` handles its own click (the surah info popover) and hover, and stops them before the
    delegation.
  - A basmala line hovers ayah 1 of its surah here.
  - A click on either is never "empty paper".
- **Empty paper.** A click clears the selection when it lands inside `main`, outside any interactive element, a word,
  a header line or `.mp-margin`. A drag, a modified click, a click that ends a native text selection, and a click that
  closes a floating layer never clear it.
- **Other gestures.**
  - Shift+mousedown on a word prevents the native selection from extending.
  - Double-click, an end-marker click, Mod+click and a right-click never show the action bar.
  - A right-click does not change the selection; the menu decides, as §10.3 says.

### 9. WordTooltip and AyahActionBar details (§8.17)

- **WordTooltip.**
  - Order: the Arabic word (qd-hafs 22 px) on top, then the translation (14 px), then the italic transliteration
    (12 px).
  - It is visual only (`aria-hidden`); screen-reader users have the Words tab.
  - It is portalled to `<body>` and placed in viewport px, so no containment can clip it.
- **AyahActionBar placement.** Anchored on the selection ring the highlight layer draws, on the first page that shows
  the selection.
  - Above its first line; else below its last line; else at the top edge.
  - Kept inside the canvas, on the anchor page when it fits, and above the player dock.
  - Re-anchored on a zoom or resize.
- **AyahActionBar actions.**
  - Repeat ▾ offers this ayah ×3/×5/×10/∞, plus selection ×3/∞ for a range: §10.3's list, without "Custom…", which
    belongs to WP9a's RepeatPopover.
  - Translation and tafsir opens the side pane on Tafsir when that is the pane's tab, else on Translation.
  - More opens the context menu under its button.
  - Copy uses WP11a's `translations.copyAyahs` (the user's copy format) and toasts "Copied Al-Hijr 15:9".
- **AyahActionBar dismissal and focus.**
  - Any other selection dismisses it; a new pointer click-selection shows it again 120 ms later.
  - The bar is not a floating layer, so the reader keys keep working while it shows. Its swatch popover and Repeat
    menu are floating layers (§7.4).
  - It is a `role="toolbar"` with one tab stop and ←/→/Home/End, mirrored in RTL. The swatches are a radiogroup.
  - Keyboard focus inside it returns to the ayah's roving item when it closes.

### 10. Wave bridges (self-disabling; the lead may remove them at an integration checkpoint)

WP8e, WP11c and WP9a depend on WP8d, so their stores are still WP0C's placeholders. These bridges keep this package's
behaviour visible and testable now:

1. **Selection.** `selectAyah()` (interactions.ts) calls `reader.select(id, extend)`. If that leaves
   `reader.selection` unchanged (the placeholder does nothing), it applies the same semantics itself: `nextSelection`,
   and the cursor moves to the ayah. It is inert once `reader.select` works.
2. **Marks.** HighlightLayer asks `library.marksFor(layout, [page], from, to)`. While that resolves `null` (the
   placeholder), it calls `user_marks` directly, as WP8c's MarginMarks does.
3. **The view's singletons.** `WordTooltip` and `AyahActionBar` belong in MushafView (WP8e, §7.5). While MushafView is
   the placeholder (`[data-placeholder="MushafView"]`), the HighlightLayer of the first visible page mounts them; both
   portal to `<body>`. Inert as soon as MushafView is real.

### 11. API beyond the §8.7/§8.15 signatures

All additive; the three §8.7 functions keep their signatures.

- **`layout.ts`.** `PILL`, `HL_OUTSET`, `lineBoxes`, `planHighlights` with `HighlightState` / `HighlightShape` /
  `HighlightPlan` / `FillKind`, and `boxOf`.
- **`a11y.ts`.** `ayahNumberSuffix`, `AYAH_FLAG`, `divisionsOf` / `Division`, `pageSegments` / `A11ySegment`, and
  `a11yItemId`.
- **`interactions.ts`.**
  - Constants: `TOOLTIP_MOVE_PX`, `TOOLTIP_DWELL_MS`, `ACTION_BAR_DELAY_MS`.
  - Window events: `WORD_DWELL_EVENT` (`WordDwell | null`) and `ACTION_BAR_EVENT`.
  - Functions: `selectAyah`, `selectFromPointer`, `nextSelection`, `hideWordTooltip` and `dismissActionBar`.

### 12. Screen-reader record (§8.15, §12.6)

NVDA is not installed on this machine, and VoiceOver needs macOS, so neither screen-reader check could run here. What
could be measured: the OneCore voice **Microsoft Naayf (ar-SA)** through SAPI, synthesised to WAV files (never played),
for 1:1–7, 2:255 and 38:24. In seconds:

| ayah | QPC text | `toSpeech` text (without the ` (n)` suffix) |
|---|---|---|
| 1:1 | 4.53 | 3.86 |
| 1:2 | 4.44 | 4.44 |
| 1:3 | 3.49 | 3.04 |
| 1:4 | 3.51 | 3.07 |
| 1:5 | 4.95 | 4.77 |
| 1:6 | 4.09 | 3.99 |
| 1:7 | 8.41 | 7.67 |
| 2:255 | 37.38 | 37.49 |
| 38:24 | 27.96 | 26.94 |

What this shows:
- The marks are not read aloud. Naayf passes over a lone U+06D6/06D7/06DA/06DE/06E9/06E1/0671/0657/065E/0656/06E5/06E6
  between two letters in silence: the same 1.58 s as the letters alone.
- Without its number suffix, the `toSpeech` text never reads longer than the QPC text by more than 0.11 s (2:255),
  and it is shorter for seven of the nine ayahs.
- The ayah number suffix adds ~1 s per item, the expected "(٢)".
- This covers the voice alone. The names §8.15 guards against come from the screen reader's own symbol processing
  (NVDA's symbol dictionary, VoiceOver's punctuation verbosity), which only the real screen readers can show.

**Request (lead / WP13b smoke):** run NVDA + OneCore Arabic and VoiceOver "Majed" over the three passages in the real
app and add the result to §12.6.

### 13. Scenarios

- **Modes.** S31 and S34 run in both modes (they use only the real commands). Both pass in the real app too:
  `app-driver.mjs --exe C:\qdt\WP8d\debug\quran-desktop.exe --only S31,S34`. The only console warnings there come from
  other packages' stubs (`packs_list`, `packs_subscribe`). S15 and S18 run in the mock: S18 seeds the mock library
  through `window.__QD_MOCK__`, and S15 needs the mock's WBW pack.
- **S15 glosses.** S15's tooltip shows the exported fixtures' placeholder glosses ("gloss 11", "translit-11"): the
  fixture export writes synthetic word-by-word text. The real app shows the pack's data.
- **Ports.** 1724–1725, as assigned by the orchestrator.

## Requests

- **WP8e (reader, MushafView).**
  - Mount `<WordTooltip />` and `<AyahActionBar />` once in MushafView (the bridge in deviation 10 then switches off).
  - `reader.select(id, extend)` should follow `nextSelection` (interactions.ts) and move `cursorAyahId`.
  - The reader-scoped Escape clears the selection. The bar also closes itself on Escape.
  - When the cursor moves by keyboard, focus `#a11y-{page}-{ayahId}` (`a11yItemId`) with `preventScroll`; layer 7
    follows DOM focus.
  - Set `reader.flash = { ayahId, until }` for arrival flashes, about 1.2 s; HighlightLayer draws and expires it.
  - The tooltip already hides on a page turn, zoom or style change; nothing to call.
- **WP8c (margin markers and marks).** A marker or mark click that selects an ayah should call
  `selectFromPointer(ayahId)` (interactions.ts) instead of `reader.select`. It is a pointer click-selection (D26), so
  it also brings the action bar, and it works before WP8e lands.
- **WP11c (library).**
  - HighlightLayer calls `library.marksFor(layout, [page], firstAyahId, lastAyahId)` once per page on mount, again
    when `library.highlights` changes, and again on `user-data-changed` with `highlights`. Keep it cached and cheap,
    and resolve the marks, not `null`, on success.
  - The action bar reads `library.highlights`, `bookmarkedAyahs` and `notes` for its pressed states, and calls
    `toggleBookmark`, `setHighlight` and `clearHighlight` (each toasts, §7.3).
- **WP9a (player).** Layers 5 and 6 read `player.isActive`, `isPlaying`, `currentAyahId`, `currentRef` and
  `activeWord`. Hold `activeWord` through inter-word gaps (§7.3); a `null` hides the pill.
- **Lead.**
  - Fold deviations 1–11 into §8.7, §8.15 and §8.17.
  - Remove the wave bridges (deviation 10) at an integration checkpoint, once WP8e and WP11c have landed.
  - Run the screen-reader check (deviation 12).
