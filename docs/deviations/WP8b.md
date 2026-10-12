# WP8b deviations (fonts, renditions and palettes)

Delivered: `src/lib/stores/fonts.svelte.ts` (§7.3, §8.5, §8.6), `src/lib/mushaf/{fontRegistry, palettes, colrProbe,
metrics}.ts`, `src/components/mushaf/RenditionStack.svelte` (§8.5, D13), `src/lib/ipc/mock/handlers/fonts.ts` (§5.17),
`vite/dev-packs.ts` (§4.8), `scripts/measure-glyph-scale.mjs` (§8.2), `src/lib/i18n/{en,ar}/fonts.ts`,
`tests/e2e/scenarios/{S05, S09, S10, S11, S30}.mjs`.

Tests: `src/lib/mushaf/palettes.test.ts` (45), `colrProbe.test.ts` (12), `fontRegistry.test.ts` (11),
`src/lib/stores/fonts.test.ts` (26), `src/lib/ipc/mock/handlers/fonts.test.ts` (11), and in the browser project
`src/components/mushaf/RenditionStack.browser.test.ts` (10, including CLS 0 on a simulated swap) and
`src/lib/mushaf/colrProbe.browser.test.ts` (the probe on the real V4 and V2 fonts; skipped without dev packs).

## Measured glyph scales (§8.2)

`node scripts/measure-glyph-scale.mjs` over every justified line of all 604 pages (core.db `qdc`, each page's own QCF
font from the QF mirror, 2026-10-10):

| style | lines | median | p99 (em) | max | `--glyph-scale` | fit ≥ 0.98 |
|---|---|---|---|---|---|---|
| qcf_v2 | 8,791 | 15.57 | 15.87 | 17.42 | **1.03** | 99.99 % |
| qcf_v1 | 8,801 | 14.17 | 14.85 | 15.12 | **1.11** | 100 % |
| qcf_v4 | 8,793 | 16.09 | 16.59 | 17.00 | **0.99** | 100 % |
| hafs (gap 0.22 em) | 8,791 | 16.02 | 20.00 | 22.33 | **0.82** | 99.67 % |
| fallback in the V1 / V4 layouts (hafs metrics) | 8,801 / 8,793 | | 20.12 / 20.43 | | 0.82 | 99.48 / 99.17 % |

The values, the date and the statistics live in `metrics.ts` (`STYLE_METRICS`, `GLYPH_SCALE_MEASUREMENT`), written by
`--write` between `// <measured>` markers (re-running it reproduces the file byte for byte).

## Deviations from ARCHITECTURE.md

1. **Hafs `--center-gap` is 0.22 em, not 0.30.** WP8a made `--center-gap` also the *minimum* word gap of justified
   Unicode lines (its deviation 2). 0.22 em is the KFGQPC Hafs V30 face's own space advance (U+0020 = 450/2048 em), so a
   dense line never looks tighter than ordinary text, and it raises the hafs scale from 0.79 (gap 0.30) to 0.82 at the
   same ≥ 99 % fit target. The script prints the alternatives (0.15–0.30) for the record.
2. **QCF scales above 1 are kept** (V2 1.03, V1 1.11): the §8.2 formula is data-driven and does not cap at 1; the V1
   font simply has a smaller em per line. Visually checked on S05 and S11 (no line collisions).
3. **The measurement script does not drive `pnpm dev:web`.** It reads the line data of all 604 pages from core.db
   (`node:sqlite`, read-only; the mock fixtures only cover 47 pages), serves the page fonts itself on 127.0.0.1 and lays
   out each line with the renderer's own rules (a max-content flex row of inline-block word spans) in the installed
   Edge through playwright-core. Fonts default to `data/cache/qcf-all` (fetched once with
   `cargo xtask fetch-dev-packs --all-pages --out data/cache/qcf-all`, gitignored): putting all pages into
   `data/dev-packs` would make the mock serve real fonts for its synthetic pages.
4. **Ink overrides cover every ink-coloured palette entry, not only entry 0 (§8.6).** The plain palettes draw entries
   1–9 and 13–15 in the base ink too (palette 4 is white throughout), so overriding entry 0 alone left tajweed-rule
   letters at full white on a dimmed night page. The rule now gives the theme ink to every entry within 12/255 of the
   palette's entry 0 (palettes 0/1: 0, 13, 14; palette 2: 0, 14; palettes 3/4: 0–9, 13–15; palette 5: 0–9, 14, 15).
   S10 verifies that the drawn ink equals the resolved ink (Δ ≤ 8) at 65 % and 100 %.
5. **High contrast on dark pages lifts two palette-1 entries** (§8.6 says "palette-1 entries are kept"): entry 3
   (#e30000, 4.3:1 on black, 3.5:1 on night) → #ff5a5a and entry 7 (#3c84d5, 4.4:1 on night) → #5b9bea, so every rule
   meets the stated ≥ 4.5:1 goal; `palettes.test.ts` checks all nine rules on white, paper, sepia, night and black. HC
   light vs dark is derived from the resolved ink (light ink = dark page), keeping the frozen `paletteRule` signature.
   `prefers-contrast: more` in sepia uses palette 0 + the light overrides (as §8.6 says), not palette 2.
6. **The COLR probe runs when the first V4 page is about to be shown** (`fonts.probeV4(data)`, called by
   `RenditionStack` before it paints a V4 QCF rendition), rather than on a V4 face that was only prefetched: the probe
   needs the page's ayah-end glyph from `PageData`. A probe that cannot run (no canvas) leaves `v4Supported = null`
   (unknown, not cached) instead of disabling V4. A cached `false` also switches a stored `qcf_v4` style back to V2 at
   start-up (with the same toast `mushaf.v4Unsupported`, WP8a's key made for this).
7. **The font-status dot is drawn by `RenditionStack`**, in the footer band (1.3 qfs from the block centre towards the
   spine, vertically centred in `FOOT`), not inside `PageFooter`: §9.8 assigns the "Mushaf fonts" states to WP8b and
   the rendition stack is what knows that it shows the fallback because of `unavailable`/`failed`. It is a 24 px
   `<button>` with a 6–9 px mark (`--text-faint`; `--warning` when failed; pulsing while retrying, static under
   reduced motion), a tooltip below it ("Offline — showing the Hafs font" / "Couldn't download this page's font" + "Retry"),
   and on `failed` a click or Enter retries. Only on interactive pages.
8. **Decor is requested automatically for QCF styles**, once per session while online (and again after `PacksChanged`
   for `decor` or on coming online): decor is required by every `mushaf.*` pack and ships with it (FACT §4.2). The hafs
   style never asks (no silent network use). Decor faces are unloaded when `PacksChanged` reports decor removed.
9. **Store API beyond §7.3** (all additive): `state(style, page)` (reactive `FontState | null`, hafs → `ready`),
   `track(style, page) → release` (displayed pages: LRU protection ±2, re-ensure on coming online / pack change),
   `probeV4(data)`, `decorReady` (all three decor faces loaded), `contrastMore`, `v4Families` (SvelteSet),
   `dispose()`; `prefetchAround(style, page, spread, dir?)` takes the optional flip direction (±8 pages, §8.5).
   Exported helpers: `pageFamily`, `parseFamily`, `aroundPages`, `DECOR_FACES`, `HAFS_FAMILY`, `ENSURE_BATCH`,
   `PREFETCH_SINGLE/SPREAD`, `FLIP_PREFETCH`, `KEEP_AROUND`.
10. **Request semantics.** An interactive `ensure` overtakes a prefetch already in flight (a second, interactive call);
    a per-family request serial makes sure an older answer never overrides a newer one and nothing overrides a loaded
    face. An IPC error of kind `offline` maps to `unavailable`, any other to `failed`.
11. **Mock behaviour (§5.17).** `data/dev-packs` acts as the CDN and the mock keeps a per-session "disk": a first visit
    downloads after `?mockFontLatency` (default 150 ms, just over the 120 ms wait, so the D13 cross-fade is visible in
    the browser) plus size at 2 MB/s; offline (`networkAllowed = false`) answers `unavailable` unless downloaded this
    session; only pages whose data is a real fixture get `ready` (a synthetic page's glyph codes would draw garbage in
    the real font); `?mockFontFail=262,…` fails those pages once (Retry demo, used by S30). The dev-packs plugin also
    serves `GET /__packs/index.json` (files, sizes, `sha8`), which the handler reads to build Rust-shaped
    `?v=<sha8>` URLs.
12. **Scenario helpers** live in `tests/e2e/scenarios/_fonts.mjs` (the registry skips `_` files), shared by the five
    WP8b scenarios; they read the expected glyph scales from `metrics.ts`, so a re-measurement needs no scenario edit. Scenarios run in both modes; their assertions follow what `mushaf_ensure_page_fonts` answers
    (QCF when `ready`, else the fallback and the dot), so they hold in the real app once WP5c/WP5e implement the
    command. S11 also runs the §8.4 line-fit gate on a hafs sweep of 50 pages (the 47 fixture pages first in the mock).
    S30 additionally shows the Arabic tooltip and, in the mock only, the `failed` → Retry recovery.
13. **A rendition stacked over another is hidden by page.css** (`.mp-glyphs ~ .mp-glyphs { opacity: 0 }`), not only by
    the stack's inline `opacity: 0`. On a same-page style change with the new face ready, the refit effect laid the
    page out before that inline 0 was written, so the new rendition's first style was at full opacity and the 0 started
    a fade-out: for a frame or two both fonts were drawn at once (found by the CI pass, round 2). After a cross-fade
    the shown rendition keeps its inline opacity until the older ones have left the DOM. The browser tests drive the
    120 ms and glyph waits on a fake clock and check each fade by its opacity transition (CI pass, round 2).

## Data findings

- **V2 page 27, line 14** is the one outlier of the V2 measurement: 17.42 em natural width (the next widest line is
  16.23 em) with ordinary, consecutive glyph codes (`FCB8…FCC3`), so the QF-mirror font of that page draws those words
  wider. At `--glyph-scale` 1.03 the line-fit scales it uniformly to 0.92 (legible, never squashed). **WP3a/WP5a**: worth
  comparing that page's font between the two mirrors (WP3c found revision differences on other pages).

## Requests

- **WP8c (PageFooter):** do not draw an offline/failed dot in `PageFooter` (RenditionStack draws it, deviation 7), and
  keep `footer.mp-foot` `pointer-events: none` (it is decorative and `aria-hidden`), or at least leave the spine side of
  the band at 1.3 qfs from the block centre free, so the dot stays hoverable. Decor: use the families `qd-surah-header`,
  `qd-quran-common`, `qd-sura-names` once `fonts.decorReady` (or per face `fonts.status.get(family) === 'ready'`);
  `fonts.decor.installed` alone only says the files exist.
- **WP8e (reader):** call `fonts.prefetchAround(reader.style, page, reader.spread)` at the first idle after a page
  settles (next to `pages.prefetch`), and `fonts.prefetchAround(style, page, spread, dir)` while flipping. Displayed
  pages need no extra call: `RenditionStack` tracks them. A style change can keep the same `MushafPage` (only `data`
  changes); RenditionStack cross-fades it. Until the new style's `PageData` arrives, keep rendering the old data rather
  than unmounting the page (the placeholder `MushafView` unmounts it, which skips the cross-fade).
- **WP12b (Settings › Mushaf):** `fonts.v4Supported === false` means this webview cannot draw V4; disable or annotate
  the V4 option (selecting it is switched back to V2 with the toast).
- **WP5c / WP5e:** the frontend expects `mushaf_ensure_page_fonts` to answer every requested page (a page missing from
  the reply is marked `failed`) and `decor_ensure` to download decor when allowed and not installed.
- **WP13a:** `pnpm exec tsc -p tests/e2e/lib/tsconfig.json` only covers `smoke.mjs`; the WP8b scenarios and
  `scripts/measure-glyph-scale.mjs` type-check cleanly when added to its `include`.
- **Lead:** fold deviations 1–8 into §8.2 (hafs gap, scales above 1), §8.5 (dot placement, request semantics, decor
  policy) and §8.6 (ink entries, HC dark overrides, probe timing).

## How the package was run

- Ports 1716–1719 for `web-shot`; Rust target `C:\qdt\WP8b` (only for `cargo xtask fetch-dev-packs --all-pages`).
- Whole-repo `pnpm check`/unit runs during the session showed failures only in files of packages being edited
  concurrently (`src/lib/stores/app.svelte.ts`, `ui.test.ts`, `settings.test.ts`); every WP8b file is clean.
