# WP8a deviations (geometry, page and glyph layer)

Delivered: `src/lib/mushaf/geometry.ts` (§8.2 constants, `fitLayout`, `paneCanDock`, the §8.4 bounded line-fit, the page
context), `src/components/mushaf/{MushafPage, GlyphLayer}.svelte` (§8.3), `src/styles/mushaf/{page, lines}.css` (§8.3,
§8.4), `src/lib/stores/pages.svelte.ts` (§7.3), `src/lib/ipc/mock/handlers/mushaf.ts` (§5.17: fixture pages, synthetic pages
outside the list, `quran_copy_text`), `src/lib/i18n/{en,ar}/mushaf.ts`, `tests/e2e/scenarios/{S07, S12}.mjs`.

Tests: `src/lib/mushaf/geometry.test.ts` (the §8.2 acceptance table and more, 38), `src/lib/stores/pages.test.ts` (16),
`src/lib/ipc/mock/handlers/mushaf.test.ts` (13, including the shared `copy_vectors.json`),
`src/components/mushaf/MushafPage.browser.test.ts` (27) and `MushafPage.swap.browser.test.ts` (1, CLS 0 on a simulated
font swap) with its test double `MushafPage.test-stack.svelte`.

## Deviations from ARCHITECTURE.md

### 1. Wave-0 bridge in `MushafPage` (transitional, inert once WP8b/WP8c/WP8d land)

`MushafPage` composes exactly the §7.5 tree: `PageFrame`, `RunningHead`, `.mp-block { HighlightLayer, RenditionStack,
A11yLayer }`, `MarginMarkers`, `MarginMarks`, `PageFooter`. All of these except `GlyphLayer` belong to wave-2 packages
that depend on WP8a, so today they are WP0C's labelled placeholders, and `RenditionStack` (the only thing that mounts
glyphs) draws a dashed box. Composing them plainly would have:

- broken WP13a's `smoke` scenario (it requires `.mp-glyphs .w` on page 1) and with it IC1 (WP6a), and
- covered every Mushaf screenshot of every wave-1/2 package with dashed placeholder boxes.

So, until the real components exist:

- When the block's direct child is `[data-placeholder="RenditionStack"]`, `MushafPage` mounts one Hafs `GlyphLayer` itself
  (the §8.5 (c) fallback rendition: Unicode `text`, family `qd-hafs`, `STYLE_METRICS.hafs`; `rendition="qcf"` for the
  hafs style), runs `fitLines` before the first paint and forwards `measure()` to the highlight layer.
- A scoped rule hides every `[data-placeholder]` inside `.mp` (the attribute stays, so QA still finds them).

Both stop applying by themselves when the placeholders are replaced; no WP8a file has to change. The lead may delete
the bridge (the `bridge` derived, the second `$effect`, the `{#if bridge}` branch and the `:global([data-placeholder])`
rule) at an integration checkpoint. Consequence for screenshots until WP8c lands: header lines (surah name, basmala),
frame, running heads, margins and footer are blank paper (S07's three header pairs are empty line slots).

### 2. Unicode renditions keep a minimum word gap (§8.4)

§8.4 justifies with `space-between` and no gap, which is right for QCF (each word glyph carries its side bearings) but
not for Unicode text in the Hafs face: on dense lines (natural width > 16.5 qfs) the words ran together with zero space
(visible on pages 50 and 262 before the fix). `GlyphLayer` marks Unicode renditions (`data-unicode`: the hafs style and
every fallback rendition) and `lines.css` gives their `.lw` `column-gap: calc(1em * var(--center-gap))`, i.e. the style's
centred-line gap is also the minimum gap of a justified line. QCF renditions are unchanged.

Measured with the Hafs face at `--glyph-scale: 1` over the 47 exported hafs pages (596 justified lines, 1920×1080):
natural width median 16.73 em, p90 19.08 em, p99 20.95 em, max 23.30 em (p600 l14); only 52.9 % of lines fit at
`--fit ≥ 0.98`. The §8.2 formula then gives `glyphScale(hafs) ≈ floor2(16.5 / 20.95) = 0.78`. **WP8b** owns that number
(`metrics.ts`) and should measure it over all 604 pages with this gap in place, tuning `centerGap(hafs)` (0.30) and
`glyphScale(hafs)` together; until then dense lines are scaled uniformly by the bounded line-fit (legible, never
squashed).

### 3. Additions to the §8.2/§8.4 API (`geometry.ts`)

- Constants beyond the table: `LINES`, `BLOCK_TOP` (2.85), `BLOCK_OUTER` (2.75), `BLOCK_INNER` (1.75),
  `OPENING_LAST_PAGE`, `OPENING_LINES`, `OPENING_TOP_LINES` (3.5), `OPENING_INSET` (2.2), `PAGE_COUNT`, and the fit
  constants by name (`BAR_RESERVE`, `COMPACT_BAR_RESERVE`, `COMPACT_BELOW_H`, `SPREAD_PREFERENCE`, `QFS_ZOOM_MIN`,
  `QFS_STEP`, `PANE_DOCK_SLACK`).
- `fitLayout` treats non-finite or negative canvas sizes as 0 and a non-positive or NaN zoom as 100 % (an unmeasured
  canvas yields `QFS_MIN` and scrolling, never NaN). The quarter-px floor uses a 1e-9 tolerance (`snapQfs`) so 22.75
  stays 22.75. `barReserve(h)` is exported. The function and `paneCanDock` keep their exact §8.2/§9.6 signatures.
- Page boxes: `pageSide(page)`, `isOpeningPage(page)`, `pageBox(qfs)`, `blockBox(qfs, side)`, `lineBox(qfs, line, opening)`.
- Line-fit: `lineFit(lineWidth, naturalWidth)` (pure) and `fitLines(rendition): LineFitReport` (one read pass, one write
  pass; leaves a rendition that is not laid out untouched; logs lines with fit < 0.98 through `console.debug`).
- Page context: `setPageContext`/`getPageContext` (`{ page, qfs, side, interactive }`). `GlyphLayerProps` has no `qfs` or
  `interactive`, and `RenditionStack` sits between the page and its glyph layers, so `GlyphLayer` reads them from the
  context (it falls back to the inherited `--qfs` when mounted outside a page).
- `SYNTHETIC_PAGE` / `isSyntheticPage(data)`: the browser mock tags the `PageData` it invents with this registered symbol
  (non-enumerable, not serialised); `MushafPage` shows the §4.6 "synthetic" badge under `__MOCK_IPC__` only (the badge
  markup is compiled out of production builds; `check:dist` passes).

### 4. `GlyphLayer` details beyond §8.3

- Attributes on `.mp-glyphs`: `data-r` is a rendition serial (unique per mounted layer), `data-interactive` while the page
  is interactive, `data-unicode` (deviation 2), and its own `dir="rtl" lang="ar"` (it is RTL Arabic wherever it is mounted).
- `use:interactions` (WP8d) is installed on each rendition only while the page is interactive.
- The memo class map (§8.16): one `$effect` per rendition toggles `.w-hid` from `memo.active`, `memo.revealedThrough`,
  `memo.peeking` and `memo.isHidden(id)`; no per-word derivation.
- `.w-sajda` marks the word whose text carries ۩ (U+06E9), a hook for WP8c's §8.9 overline decision.
- The Hafs face falls back to `var(--font-naskh)` for Unicode text; QCF families have no fallback (PUA codes).
- `element` is `$bindable()` **without** a fallback value, so a parent may bind slots that start out undefined
  (`bind:element={layers[i]}`); with a fallback Svelte throws `props_invalid_value`.

### 5. `page.css` / `lines.css` details

- `.mp` exposes the page geometry as `--mp-*` custom properties (`--mp-pw`, `--mp-ph`, `--mp-tb-w`, `--mp-lh`, `--mp-tb-h`,
  `--mp-fr`, `--mp-head`, `--mp-foot`, `--mp-m-out`, `--mp-m-in`, `--mp-m-tb`, `--mp-block-top`, `--mp-block-outer`,
  `--mp-block-inner`, `--mp-opening-inset`) for the frame, heads, margins and highlights; a unit test keeps them equal to
  the TS constants. `--lh` (§8.4's name) is kept.
- `contain: layout paint style` clips descendants at the page box, which hid the paper's own shadow; `.mp` therefore has
  `overflow-clip-margin: 40px` (Chromium/WebView2; elsewhere the shadow is clipped, nothing else changes).
- `.mp-block` has `isolation: isolate`, so the highlight (z 1) and glyph (z 2) layers never interleave with furniture.
- In forced colours the paper gets a 1 px `CanvasText` outline (the page shadow is dropped there).
- `lines.css` also carries the §8.17 cursor rule (pointer on end markers and surah headers of interactive pages) and the
  §8.14 `.mp-glyphs ::selection` tint. The V4 `font-palette` applies to `qcf` renditions only, never to the Hafs fallback.

### 6. `MushafPage` behaviour

- `interactive={false}` renders an `inert`, `aria-hidden` page with no accessible name, no `HighlightLayer` and no
  `A11yLayer` (a decorative thumbnail; the surrounding card carries the label). `furniture={false}` leaves out the frame,
  heads, margins, marks and footer.
- The accessible name is `mushaf.page.label` and `aria-roledescription` is `mushaf.page.roleDescription` (localised;
  Arabic UI: "الصفحة ٢٦٢ · سورة الحجر · الجزء ١٤").
- `performance.measure('qd:page', { detail: { page, style, interactive } })` spans from receiving the page data to the
  committed DOM (the font wait of §8.5 is RenditionStack's and is not included).

### 7. `pages` store

- Extra API: `has(style, p)` (reactive, no LRU touch), `pending(style, p)`, `size`, and the exported `prefetchSet()`,
  `PAGE_CACHE_SIZE` (48), `MAX_BATCH` (8), `FLIP_PREFETCH` (8).
- `ensure()` ignores page numbers outside 1..=604 and duplicates, and rejects with the failed batch's `IpcError` (the next
  call retries). Results of requests started before `reset()` are discarded.
- `prefetch(style, pages, dir?)`: without `dir` it waits for `requestIdleCallback` (1 s timeout; a 50 ms timer where the
  API is missing); with `dir` it starts on the next microtask and extends the set by 8 pages in the flip direction,
  nearest first. A newer prefetch replaces one that has not started. Failures go to `console.debug`, never to the user.

### 8. Mock handler

- Every `mushaf_get_pages` call returns fresh objects (`structuredClone` of the cached fixture), in the requested order,
  after the 2–8 ms jitter; the style is validated like the command's argument.
- `quran_copy_text` follows WP1a's Rust implementation exactly (same reference table, ` ﴿N﴾`, `\n{reference}`,
  `\n\n{translation}`). Arabic text comes from the exported ayah windows, else from the hafs fixture pages holding the
  ayah, else the synthetic placeholder words. A translation is appended only when the mock's `packs` slice lists the pack
  as installed (read only; `packs.ts` owns the slice), from the exported translation windows, else a one-line synthetic
  text; otherwise the Arabic is copied alone with a warning, as the real command logs. The shared `copy_vectors.json`
  passes for every case whose ayahs are exported (8 of 9; 22:77 lies on page 341, which is not a fixture page).

### 9. i18n

`mushaf.v4Unsupported` is defined (en/ar) because §8.6 names that key for WP8b's one-time toast; §11.1 otherwise keeps each
package in its own domain.

### 10. Scenarios and acceptance runs

- S07 and S12 run in both modes (`meta.mode = 'both'`). S07 uses `pageMode: 'single'`; S12 the default `auto` (a 255–256
  spread at 1600×1000) and asserts both pages. Each writes the viewport shot and a page close-up (`-page`).
- Port: `pnpm shots:web --serve 1640 --only S07,S12` (the orchestrator assigned 1640–1643; §14.3 says 1520).

## Requests

- **WP8b (RenditionStack, metrics):**
  - Mount the `GlyphLayer`s so that their `.mp-glyphs` (absolutely positioned, `inset: 0`) resolve against `.mp-block`:
    no positioned wrapper, or one with `position: absolute; inset: 0`.
  - After a rendition's font is ready, call `fitLines(element)` (geometry.ts), then `measure()`, then `onmeasure(boxes)`;
    again after a `qfs` change. Cross-fade through the layer's `opacity` (`.mp-glyphs` already transitions it over
    `--dur-glyph-swap`).
  - Fallback rendition: `rendition="fallback"`, `family="qd-hafs"`, `STYLE_METRICS.hafs`. Hafs style: `rendition="qcf"`,
    `family="qd-hafs"`.
  - Measure `glyphScale` and `centerGap` per style with deviation 2 in place (hafs starting point ≈ 0.78 / 0.30).
  - The MushafPage bridge switches itself off once RenditionStack is no longer the placeholder.
- **WP8c:** render the furniture as direct children of `section.mp` (`svg.mp-frame`, `header.mp-head`, `div.mp-margin`,
  `footer.mp-foot`) and position them with the `--mp-*` properties. `HeaderLine`/`BasmalaLine` receive `qfs` from
  `GlyphLayer` (page context). `.w-sajda` marks the ۩ word for the §8.9 overline decision.
- **WP8d:** `GlyphLayer` installs `use:interactions` on each rendition while the page is interactive
  (`.mp-glyphs[data-interactive]`); `HighlightLayer` gets `boxes` from `MushafPage` (fed by `onmeasure`).
- **WP8e:**
  - In a spread, the later page's `--shadow-page` falls on the right page's spine edge (paint order of two sibling
    stacking contexts), which reads as a one-sided spine shadow. Suggest `.spread .mp-paper { box-shadow: none }` plus the
    page shadow on the spread container, with your §8.10 spine gradients on both pages.
  - Single-mode `translate` goes on `.mp` (page.css sets none). `pages.prefetch(style, around, dir)` extends flips by 8;
    `pageSide()` and `blockBox()` help the 261/262 block-x test.
- **WP9b:** `memo.isHidden(id)` should read `active`, `revealedThrough` and `peeking` reactively; `GlyphLayer` re-applies the
  class map whenever any of them changes.
- **WP3a / WP1a:** the QDC `"۞ "` prefix on rub-start words (WP1a's request) is visible in the hafs and fallback renditions
  (e.g. page 256, line 11).
- **Lead:** fold deviations 2–6 into §8.3/§8.4 (the Unicode word gap, the page context, the `--mp-*` properties,
  `overflow-clip-margin`, the non-interactive mode), and remove the wave-0 bridge (deviation 1) at an integration
  checkpoint if desired.
