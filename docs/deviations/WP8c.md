# WP8c deviations (page furniture and margin marks)

Delivered: `src/components/mushaf/{PageFrame, SurahCartouche, HeaderLine, BasmalaLine, RunningHead, PageFooter,
MarginMarkers, MarginMarks, OpeningMedallion, SurahInfoPopover}.svelte`, `src/lib/mushaf/ornaments.ts`,
`src/styles/mushaf/frame.css`, `src/lib/i18n/{en,ar}/furniture.ts`, `tests/e2e/scenarios/{S03, S04, S06, S08, S13,
S33}.mjs` and their shared helper `tests/e2e/scenarios/_furniture.mjs` (the registry skips `_` files, like WP8b's
`_fonts.mjs`).

Tests: `src/lib/mushaf/ornaments.test.ts` (43, unit, self-contained: no fixtures needed) and
`src/components/mushaf/furniture.browser.test.ts` (26, browser, inside a real `MushafPage`: frame and its setting,
spread-only page-stack edges, opening medallion, running heads (quarter, compact prefixes, opening pages, decor juz),
footer, cartouche and decor header, header click → surah info, the popover's facts and "Play surah", basmala fallback,
decor and the audio basmala highlight, markers (placement, labels, click selects), every margin mark, the
`user-data-changed` reload, decorative pages, the ribbon popover's "Move here", and zero layout shift when decor
arrives on a painted page).

All artwork is original and generated from a few parameters in `ornaments.ts` (khatam = two squares at 45°, a
scalloped rosette, a four-petal interlace tile of four half-ellipses, an ogee-ended cartouche and an ogee-arched
medallion built from one mirrored quarter of cubic Béziers). Nothing is traced from the print or from the decor fonts.

## Print-scan verifications (§8.9, §15.3 item 7)

No print scan is available offline in this environment. The reference used instead is the KFGQPC digital edition
itself, i.e. the QCF V2 page fonts and the KFGQPC Hafs face, which reproduce the 1421H Madinah print glyph for glyph:

1. **Sajda overline: dropped as a CSS rule** (§8.9 "otherwise it is dropped"). The print overlines the words of the
   sajda *phrase*, and both renditions already draw exactly that: the QCF V2 glyphs carry the line, and the KFGQPC Hafs
   face draws it from the U+06E4 that the QPC Hafs text puts on those words (38:24 `وَخَرَّۤ رَاكِعٗاۤ`, 7:206
   `يَسۡجُدُونَۤ`). Rendered side by side at zoom 200 on pages 176, 454 and 528: QCF V2 and Hafs show the same overlines.
   A CSS overline on the word that carries ۩ (WP8a's `.w-sajda`) doubled the line on 7:206 and 53:62 and marked the
   wrong word on 38:24 (`وَأَنَابَ ۩` has no overline in print). `frame.css` documents this where the rule would be;
   `.w-sajda` stays a hook.
2. **Running heads hidden on pages 1–2**: as specified; the QCF V2 opening pages carry no head either.
3. **Opening medallion**: the 8 centred lines (header included) sit in a tall ogee-arched field with straight sides,
   12 rosettes on its outline (apex, five per side, foot), and the spandrels between field and frame filled with the
   frame's interlace on `--frame-band`, which reads as the illuminated opening spread. **The lead signed off S03**
   (the first-run look, docs/deviations/LEAD.md item 13, 2026-10-10).

## Deviations from ARCHITECTURE.md

### 1. Decor glyphs are sized by their measured metrics (§8.8, §8.9 tunables)

Measured in Edge with canvas `measureText` (2026-10-10, dev-pack decor fonts):

| glyph | advance | ink | used as |
|---|---|---|---|
| QCF surah header (`qd-surah-header`, any surah) | 3.302 em | 0.40 em, centred on the baseline | `--sh-scale: 4.4` → 14.5 × 1.76 qfs |
| basmala U+FDFD (`qd-quran-common`) | 6.41 em | 0.86 em | `--basmala-scale: 1.4` → 9.0 qfs wide |
| hizb ornaments U+FC23 / U+FC22 | 1 em | 1.01 em, slender frames | drawn 1.45 qfs tall (since 9: 3.56–4.48 qfs) |
| juz calligraphy U+E001… | 3.83 em | 1.17 em | 0.8 qfs tall in the head |
| ۞ U+06DE (`qd-hafs`) | 0.57 em | **0.45 em** | drawn 0.75 qfs tall |
| ۩ U+06E9 (`qd-hafs`) | 0.49 em | 0.63 em | drawn 0.75 qfs tall |

- `--sh-scale` starts at 1.55 in §8.8, which drew the header 5 qfs wide (the glyph is 3.3 em wide, not 1 em). At the
  full 16.5 qfs width it would be 2.0 qfs tall and touch the glyphs of the neighbouring lines (page 604), so the
  header is sized to the line pitch: 4.4·qfs (3.62·qfs on the 12.1 qfs opening lines). `--basmala-scale` is 1.4
  (§8.8 suggests ≈ 1.25: 8 qfs wide, visibly small next to the header).
- **Markers are sized by ink, not em.** §8.9 gives ۞ `max(0.95·qfs, 14px)` as a font size, but the KFGQPC Hafs ۞ has
  only 0.45 em of ink: a 0.43·qfs mark. Markers are drawn with a fixed ink height (0.75·qfs, ≥ 13 px; the decor
  ornaments 1.45·qfs, since 9: 3.56–4.48·qfs) and each glyph's ink is centred in its box from its measured metrics
  (`INK`, `inkShift` in `ornaments.ts`). Labels keep §8.9's `max(0.36·qfs, 11px)` and the `0.36·qfs ≥ 10` rule (since
  9, the Hafs words only: the print's rub labels are drawn at every size).
- **Juz calligraphy: U+E001 + (juz − 1), not U+E900 + (juz − 1).** quran-common has two series (its ligature file:
  `juz001`… → U+E001…, `j001`… → U+E900…; FACT §4.2 lists both under U+E900, which is not what the font maps).
  Rendered: U+E00E reads "الجزء الرابع عشر", U+E90D reads "رُبَمَا" (the juz named by its opening words, an Indo-Pak
  convention the Madani print does not use). The head uses the "الجزء …" series, the word form of the non-decor
  fallback "الجزء ١٤".

### 2. Margin markers

- **Sajda markers sit beside the line where the ayah ends** (the line of its last word on the page), not its first
  line: the ۩ follows the sajda phrase at the end of the ayah, so a long sajda ayah (7:206 starts on line 14, ends on
  line 15) is marked where the sign is. Rub markers stay on the ayah's first line.
- **The opening pages carry no margin markers** (1:1 has `flags = 15`, which would put "الجزء ١" in the margin of
  page 1): their 8 lines sit inside the medallion, as in print, and the running heads are hidden there too.
- A rub start whose ayah began on the previous page (`startsOnPage = false`) and a sajda whose ayah ends on the next
  page are not marked on this page (each is marked once, on the page that shows its sign).
- Marker tooltips show the Arabic label and a description in the UI language ("Three quarters of hizb 27 · 15:49"),
  plus "Click to select the ayah".
- **A quarter is written in words** (owner request, after v1.2): `ربع الحزب ٢٧`, `نصف الحزب ٢٧`,
  `ثلاثة أرباع الحزب ٢٧`, not §8.9's `¼`/`½`/`¾ الحزب N`. The vulgar fractions exist only in Western Arabic numbers (the
  owner reported them as Western digits beside the Eastern `الحزب ٢٧`), and qd-hafs lacks them, so they came from a
  Latin system face. The margin sets the label on two lines, the words over `الحزب ٢٧` (`rubLabelLines`): on one line
  `ثلاثة أرباع الحزب ٢٧` is 6.6 em of qd-hafs, and the 1.9·qfs margin holds 4.8 em of the 11 px label at qfs 28 and
  5.3 em from qfs 30.6; the widest line, `ثلاثة أرباع`, is 3.5 em, narrower than `سجدة واجبة` (3.9 em). The marker's
  height counts both lines, so stacks on a line stay centred; in the real data no sajda sits on a line next to a rub
  start, and the three quarters that share a line with a sajda are label-only (pages 309, 334, 379). The tooltip
  label stays on one line. The U+FC22 ornament's frame, which held ¼ ½ ¾, now holds the hizb number like U+FC23's: the
  words do not fit a frame, and an empty frame reads as unfinished; with the number, every frame names the hizb and
  the words under it say which part of it. (Superseded by 9: the print's label goes inside a larger ornament.) The
  column carries `dir="rtl" lang="ar"` itself, as the running head does.
  `furniture.browser.test.ts` checks the label, its two centred lines and the frame in both UI languages and both
  decor states, and that both lines stay inside the margin column on odd and even pages from qfs 28 to 160.

### 3. Running heads

- **The quarter separator is a small gold khatam, not "·"** (§8.9 example `الجزء ١٤ · ثلاثة أرباع الحزب ٢٧`): a middle
  dot next to Eastern Arabic numbers reads as the digit zero ٠ ("١٤ ٠ الحزب"). The quarter is appended whenever the
  margin labels are not drawn: below qfs 28, and also when `showMarginMarkers` is off. (Since 9 the print's label is
  drawn at every size, so with that face the head appends the quarter only while the markers are off.)
- A juz or hizb start appends `الحزب N` (a juz start is also a hizb start); quarters append their words on the same
  line, `ربع`/`نصف`/`ثلاثة أرباع الحزب N` (§2). A browser test puts the widest of them beside the widest `سورة …` head
  from qfs 18 up, with and without the decor calligraphy: one line, inside the band, never touching the surah name.
- **Below qfs 20 the juz head reads `ج ١٤`**, not a bare `١٤`: a lone Eastern Arabic number in the head reads as a page
  number. `سورة` is dropped as specified. With decor the calligraphy is kept at every size.

### 3a. Furniture text is set in qd-hafs, not `--font-naskh`

§8.9 sets the running heads and the page number in `--font-naskh` (Noto Naskh Arabic, a web font loaded on first
use). That font arrives after the first paint, and the heads reflowed when it swapped in: WP8a's CLS browser test
(`MushafPage.swap.browser.test.ts`) measured a layout shift of 1.2e-5 with the furniture in place, against the CLS 0 of
§8.1. Heads, page numbers and margin labels now use `--mp-furniture-font: 'qd-hafs', system-ui, sans-serif`: the
bundled KFGQPC Hafs face (itself a Naskh, matching the text) that `main.ts` loads before mounting, and the local system
font for the fractions ¼ ½ ¾ that it lacks (Noto Naskh's lazily loaded latin subset would swap again; since the
quarters became words, §2, every furniture string is in qd-hafs and the system font is only a backstop). The test passes
with zero shift. The surah name in the cartouche and the fallback basmala were qd-hafs already (§8.8). Tooltips and
popovers (outside the page) keep the UI and Naskh fonts.

The decor faces also arrive after the first paint (WP8b loads them asynchronously), so a decor switch must only
replace elements, never move surviving ones: the header and basmala line boxes span their line and swap their content
element; the head's juz group is anchored at its physical left edge with a fixed height (`direction: ltr` +
`row-reverse`, the spans stay RTL); markers are keyed by `key|decor|labels` and marks by `key|top`, so restacked items
are re-created. A browser test switches decor on a painted page and asserts zero `layout-shift` (it fails with
4e-5 when the marker keying is reverted).

### 4. Page frame details

- Corner blocks are the 0.85 qfs squares of the frame band at each corner; the bands and the inner rule stop at them,
  and their inner edges are drawn with the inner-rule stroke.
- Band tiles are stretched by at most 2 % so whole tiles fill each band exactly (52 × 82 tiles at every qfs): no cut
  tile at a corner. Each band has its own origin (a translated group), so top/bottom and left/right match.
- The page-stack hairlines (`div.mp-edges`, owned by `PageFrame`) stay when `showPageFrame` is off (they are paper,
  not frame) and show only under a `.spread` ancestor. Count: `1 + round(4 · fraction)` (1–5). Pitch 2.5 px (1 px
  lines, 1.5 px apart), each receding 1.5 px at both ends.
- **The footer medallion's tint is the rosette's own fill** (owner request, after v1.2). The medallion was a 12-lobed
  rosette filled with opaque paper around a separate tinted disc of 0.8·r, so about 30 % of its interior stayed
  untinted: a paper band under the valleys (≈ 1 px at qfs 24) widening into every lobe (≈ 2.6 px at the crests), which
  read as a circle shaded inside a scalloped shape. It is now one path, filled with `--frame-gold` at 10 % and stroked
  in it: fill and outline share the path at every qfs, in every theme and in forced colours (CanvasText at 10 % over
  Canvas). The tint and every box are unchanged (CLS 0); the tinted area grows by about 43 %, so the S03 first-run look
  (LEAD 13) and the local baselines of scenarios that show a footer change. Nothing is drawn behind the medallion, so
  dropping its paper fill uncovers nothing. `furniture.browser.test.ts` screenshots the medallion in each theme (and in
  forced colours emulated in Chromium) and checks every pixel: the tint inside the outline, the paper outside it, the
  gold on it; the old drawing fails with about 2,250 of the 10,436 interior pixels it checks untinted (qfs 120).

### 5. Margin marks

- **Data path (as §1.2 step 4): `library.marksFor(layout, [page], first, last)`**, WP11c's `user_marks` cache. The
  highlight layer (WP8d) asks with the same key, so one request serves both layers of a page. `MarginMarks` reloads
  whenever the store replaces its `bookmarks` or `notes` list: the store empties its marks cache before it does, both
  after its own mutations (at once, before the command's event) and after the re-read that a `user-data-changed` from
  another surface triggers; a re-read that brings nothing new keeps the array, so nothing reloads needlessly. No
  listener of its own (an earlier version listened to `user-data-changed` too and asked the command directly, which
  cost a second request per page and change). A store without a cache (it resolves `null`) falls back to the command.
  Note previews come from `library.notes` when it holds the notes, else one `note_list` for the page's ayah range. The
  reading ribbon reads `library.readingBookmark` (it carries `updatedAt` for "moved 3 days ago"). Decorative pages
  (`interactive = false`) load and draw no marks.
- A note is marked on the first line of its first ayah on the page (a note on 15:3–7 that began on an earlier page is
  marked at the page's first ayah of the range). Bookmarks precede notes on a line.
- **The ribbon's shadow is a drop-shadow, not `--shadow-1`**: `--shadow-1` is a box-shadow list (a 1 px ring in the
  dark themes) and would be clipped by the V-notch; the ribbon uses an equivalent `filter: drop-shadow()` that follows
  the notch, a 1 px darker edge drawn as a second clipped layer, and a silk sheen. It is centred in the 0.9 qfs spine
  margin.
- The ribbon popover: the title, the reference, "Moved {time}", **Move here** with the reading-bookmark shortcut's
  keycaps (from the registry when WP11c registers `shortcuts.study.readingBookmark`, else `Shift+B`), and a hint
  naming the target ("Moves it to Al-Hijr 15:1": `reader.actionTarget`, §8.15). Neither popover restores focus to its
  `aria-hidden` anchor on close.
- The dog-ear: the folded-away corner shows `--surface-app`; the flap is `--accent` at 14–30 % over the page (an
  opaque `--accent-soft`) with a lit crease and a soft shadow. A click opens the Bookmarks panel.

### 6. Surah header and the surah info popover

- `SurahInfoPopover` takes no props (§7.9) and is opened through a controller exported from its module script:
  `import { surahInfo } from './SurahInfoPopover.svelte'`; `surahInfo.show(surah, anchor, layout)`, `hide()`,
  `reset()`, state `open/surah/layout/anchor`. A second click on the same header closes it. It closes on a page
  change and when its header leaves the document (a page turn or a rendition swap).
- Contents: number badge (khatam), name (UI language) and meaning (en) / transliteration (ar), the Arabic name in the
  `qd-sura-names` calligraphy when loaded, revealed (Meccan/Medinan · revelation order), ayahs, pages (in the layout
  of the header), juz; **Play surah** = `player.playFrom({ ayahId: first }, { to: last })` (WP9a's id form; repeats and gap from settings);
  **Download recitation** = `packs.install(reciter.packId, { type: 'items', data: { items: [surah] } })` with a
  toast, shown as "Recitation downloaded" when `packs.items` has it pinned, disabled while downloading, offline or
  with network downloads off.
- `HeaderLine` handles its own click and hover with native listeners and stops nothing: WP8d's delegated word
  interactions already leave header clicks to it, treat header lines as "not blank" (no selection clearing), and tint
  ayah 1 on hover in the same way, so both are idempotent.
- The audio basmala highlight (§8.8) is a pill (the §8.7 ayah-pill geometry) behind the basmala text inside the
  rendition, shown while `player.currentRef` is `{ surah, ayah: 0 }`.

### 6a. The ornaments can be turned off (owner 2026-10-11)

The decor ornaments follow the new `ornateHeaders` setting (default on) in every style, or a page's
`MushafPageProps.ornaments` (the onboarding's preview): `HeaderLine`, `BasmalaLine`, `RunningHead`, `MarginMarkers` and
`MarginMarks` each combine it, read from the page context, with the face's readiness. Off, the page draws the plain look
even with decor loaded: the cartouche, the Unicode basmala, الجزء ١٤ in the head, and the solid ۞ without a frame in
the margin (a quarter keeps its words in the label, so the margin still names it). `MarginMarks` places its marks with
the same decor flag as the markers, so nothing shifts when the setting flips (a CLS test covers it). S03 is now the
plain look; online, a first run preselects the 1421 AH print with its ornaments.

### 7. i18n

The `furniture` domain covers only the UI around the furniture (tooltips, the two popovers, the toast). The furniture
drawn on the page (heads, labels, numbers, سورة / الجزء / الحزب / سجدة) is always Arabic with Eastern Arabic numbers
(§0.2) and lives in `ornaments.ts`, not in the dictionaries. `ar` mirrors every `en` key.

### 8. QA runs

- Ports **1721–1723** (the assigned range starts at 1720, but 1720 is on Chromium's unsafe-port list:
  `net::ERR_UNSAFE_PORT`). Acceptance: `pnpm shots:web --serve 1721 --only S03,S04,S06,S08,S13,S33`.
- Scenarios run in mode `both`. S33 seeds its marks with the user commands; where they are not implemented (the
  browser mock before WP11c's mutation handlers) it writes the mock's `user` slice and relaunches. S08 shoots the
  surah info popover when `MushafView` mounts it (WP8e) and logs that it skipped the shot otherwise.
- **Real app verified too** (2026-10-10, `pnpm tauri build --debug --no-bundle` into `C:\qdt\WP8c`, then
  `pnpm shots:app --exe C:\qdt\WP8c\debug\quran-desktop.exe --only S03,S04,S06,S08,S13,S33`): 6 passed, with the
  same geometry reports as the mock. In the app S33 seeds through the real user commands. Until `decor_ensure` and
  `mushaf_ensure_page_fonts` exist in Rust, S04/S06/S08 wait 15 s for decor and run with the fallback furniture.
- **The pointer is parked before every inspection** (`restPointer` in `_furniture.mjs`, called by `furniture()`): on
  empty canvas just above the first page. In the real app the OS cursor can rest over the window where it opens (the
  first app run of S03 showed WP8d's hover tint on 2:4), and a click leaves the pointer on its target (the ribbon
  stayed lit in S33's night shot); the lead's review shots now show every page at rest.
- `pnpm shots:app` must keep its default CDP port here: `--port 1723` made WebView2's CDP endpoint never come up
  (30 s timeout), and the driver then failed to remove its temp data dir (`EPERM`). Not a WP8c problem; noted for
  WP13a.

### 9. One family of margin markers (owner request 2026-10-13)

The owner, with a photo of a printed Mushaf page and then four more: "I want to always show it" (the margin label, which
vanished below qfs 28, a size a Mac window reaches); pages 531, 534 and 536 "looked random" (531, a hizb start at a
surah start, drew U+FC23 with ٥٤ in its frame; 534, a quarter at a surah start, drew U+FC22; 536, a half whose first
word carries the inline ۞, drew the label alone) and "it should be consistent"; U+FC22 for every quarter, U+FC23 for a
hizb start, a symbol for a juz start too, and the label inside the symbol as in the photo. The lead matched the printed
pages with mockups drawn from the real fonts and set the build spec; delivered as follows.

- **Every rub start draws its ornament at every page size, inline ۞ or not** (`markerInk(m, decor, print)`): the lamp
  (U+FC22) at a quarter, a half and three quarters, the medallion (U+FC23) at a hizb start and, larger, at a juz start,
  each with the print's stacked label (U+F800 + rub, LEAD 25) inside its box. The inline ۞ stays in the text: it no
  longer changes what the margin draws, so the label-only marker of LEAD 17 is gone (`markerDrawn` too: every marker is
  drawn; `MarginMarker.inline` stays as data, `data-inline` on the marker).
- **Sizes, measured in the real faces** (quran-common, UPM 1024, fontTools bounds checked: U+FC22 278…746 × −192…832,
  U+FC23 387…637 × −192…832, both centred on x = 512; the free boxes rasterised): both ornaments' ink is one em,
  0.1875 em below to 0.8125 em above the baseline. The lamp is drawn at 3.56·qfs (0.457 em ≈ 1.63·qfs wide), its box
  0.387 × 0.255 em centred 0.025 em below the baseline; the medallion at 3.72·qfs (0.244 em ≈ 0.91·qfs), 4.48·qfs at a
  juz start, its frame 0.203 × 0.234 em centred 0.3125 em above the baseline. One label size for the whole margin,
  `MARGIN_LABEL_EM` = 0.88·qfs (`printLabels.ts`; the running heads keep `PRINT_EM`): a quarter's label fills 80 % of
  the lamp's box height, the hizb and juz labels 84 % of the frame's width (first 0.96·qfs, 88 % and 92 %, which left
  no air at the rules once drawn; see the lead's tuning below). Each label's box is the ink of its kind of
  label (`marginLabelBox`, no px floor, so the size is the same at qfs 18).
- **Placement**: a marker alone on its line meets it at its anchor (`markerAnchor`): the ornament's box, where the
  label's ink centre is, on the line's centre (lamp top = line − 0.8375·G, medallion top = line − 0.5·G), the lamp's
  crest rising above it. Every ornament stays inside the paper at lines 1 and 15 (the lamp beside line 1 starts
  0.74·qfs below the top edge). The ornament's advance (1 em) is wider than the 1.9·qfs margin, so the marker's box is
  the ink's width and the glyph is centred on it (`.mk-glyph[data-ornament]`: a flex row, no pointer events beyond the
  marker). Its ink is drawn over the page bookmark's dog-ear (z 2 over z 1): the lamp beside line 1 starts 0.74·qfs
  below the paper's top, inside the 1.2·qfs corner, and the flap hid its finial and the top of its crest (23 quarter
  starts sit on line 1: pages 17, 27, 49, …). On its axis the finial falls on the flap's side of the fold, never the
  cut-away corner that shows the canvas; the dog-ear keeps the pointer there.
- **Fallbacks**: without decor (not installed, or the page's ornaments off) every rub start draws the solid ۞ with the
  print label under it at the same size, at every size; the label's box sits on the line and the ۞ stands above it, as
  the crest does (`markerAnchor`), so decor arriving after the first paint swaps the ۞ for the ornament without moving
  the label (it moved 0.4·qfs before). Without the print face no ornament: ۞ with the Hafs words (`rubLabelLines`) from
  qfs 28, the ۞ alone below, as before, the two centred on the line; the sajda keeps ۩ with «سجدة» from qfs 28. The
  running head keeps the first step's rule: no quarter while the margin names it. The ۞'s label sits `LABEL_GAP`
  (0.08·qfs) under it, the gap `.mk` now uses too (it had 0.06·qfs, 0.02·qfs off the model).
- **Deviations from the build spec**, from the visual check against the mockup and the review that followed:
  - The hairline thickening keeps `decorStroke` and its 0.5 px floor, but its em share drops from 0.018 to 0.0025: at
    the new sizes 0.018 em (1.9 px for the lamp at qfs 30) filled the crest's filigree solid and merged the box's double
    rule, unlike the mockup and the print. Half a pixel draws the ≈0.01 em hairlines in the ink at qfs 18 and leaves the
    filigree open; the em share only matters from qfs 45 (a juz's medallion) and 57 (the lamp). Measured as
    INTEGRATION.md did (the darkest pixel of the crest on 1× shots, paper): the ink itself, 5.9:1, for the lamp and both
    medallions at qfs 18.
  - A rub start and a sajda on one line stack 0.2·qfs apart, the rub start first (`pageMarkers`), centred on the line
    as the spec says, but never with the rub start's anchor below the line (`placeMarkers`). The real data has four
    such lines (pages 272, 309, 334, 379: a sajda ayah ends where the next division starts; no rub start and sajda sit
    on adjacent lines). With the sajda first, the lamp's crest pushed its box a full line below its line on page 309 and
    the sajda a line above. Rub first but centred, the lamp's anchor (near its foot) hung its box 0.72·qfs below the
    line at qfs 18 (0.45 at qfs 30) and the ۩ 1.9·qfs below it, beside the next line: the spec's "keep today's
    stacking" did not foresee a 3.56·qfs ornament, and its first rule, the box on the line, wins. So on 309, 334 and 379
    the lamp keeps its box on the line and the ۩ hangs right under it, its glyph 1.15·qfs below the line, beside the
    top half of the next line. The medallion's anchor is its middle, so on 272 the stack stays centred: its frame
    0.48·qfs (qfs 18) to 0.75·qfs (qfs 30, «سجدة» under the ۩) above the line, the ۩ 1.96 to 1.69·qfs below it,
    beside the next line; anchoring the medallion would push the ۩ 2.4·qfs down. The print hangs a lamp with «سجدة»
    inside at a sajda, a look the owner kept out of this request (sajda unchanged); the lead may want it for these four
    lines. `ornaments.test.ts` pins both cases.
  - **The marks keep clear of the ornaments** (`placeMarks`; the spec kept the marks' rule, which knew only the line
    above's bottom). The ornaments now reach lines beyond their own: on a line under a hizb or juz medallion
    (29 of the 59 hizb starts have an ayah starting on the next line) its marks and the medallion line's own landed on
    the same spot, one hiding the other; on the line above a lamp or medallion (63 of the 240 rub starts) a mark sat in
    the crest, its accent reading as filigree. Now each line's marks are one stack, after its own markers or centred on
    it, and a stack that would meet a marker stack (`placeMarkers` returns each line's extent, `stacks`) moves to the
    nearest place 0.2·qfs clear of it, above or below (a tie goes below); a stack that would meet an earlier line's
    marks goes on after them unless lifting those (each only as far as its own place allows) lets it stand nearer its
    line; none goes above the dog-ear's corner. The marks are drawn over the markers (`.mp-marks`, z 2). The cost is
    distance: with every ayah within two lines of a marker bookmarked (all 604 pages, decor on), a mark's centre lies a
    median 0.6 line from its line's centre, a third of them more than a line (the ornaments take the margin beside up to
    three lines); none overlaps (0 of 957).
  - **The print label gets a hairline too**: 0.4 px of the ink under its fill (halved at 2 dppx, like the ornament's).
    On 1× screens at qfs 18 its stacked lines are 5 px tall and antialiased to a tint, the faintest thing in the
    ornament while the crest filled in: 11 % of its inked pixels reached 3:1 on paper (night 18 %), 36 % (night 52 %)
    with the hairline (page 534, Edge). The ornament keeps its 0.5 px floor: 0.35 px left the crest as solid at 1× (86 %
    of its pixels over half covered either way) and only made it fainter.
  - **Not changed: the label still meets the box's rule at 1× on the smallest pages.** The spec's sizes fill 88 % of
    the lamp's box height and 92 % of the medallion's frame width, as the print does. Rasterised from the faces, the
    worst label of each kind keeps 0.059·qfs from the lamp's rules and 0.040·qfs (juz 0.048) from the medallion's sides
    before the thickening: 1.1 and 0.7 px at qfs 18, so at 1× the two share or touch a pixel up to qfs 20 (lamp) and 24
    (medallion); from qfs 24 the lamp shows 2 clear pixels, and at 2 dppx or qfs 30 both do. Raising the lamp's label
    into the arch does not help: its first quarter word meets the arch (0.052·qfs at a 0.036·qfs raise, 0.038 at 0.053;
    the best, 0.018·qfs, gains 0.007·qfs). A paper halo under the label cut the medallion's thin side rule and fringed
    it with the label's subpixel colours. Only a smaller label or larger ornaments would part them, which the spec
    fixed; for the lead.
- **The lead's tuning after the review** (comparison renders at qfs 30): the label down to 0.88·qfs, so the print's air
  shows between the text and the rules at every size; the ornament's thickening only up to a pixel
  (`decorStroke` = max(0, 1 px − 0.01 em): 0.36 px for the lamp at qfs 18, none from about qfs 28), since the fixed
  0.5 px filled the crests and merged the box's double rule at qfs 30 at 1×; the label's hairline fading from 0.4 px to
  none at a 32 px label (`marginLabelStroke`). The notes above on the 0.5 px floor and the 0.4 px hairline describe the
  state before this tuning.
- **This overrides LEAD 17's "no second ۞ beside an inline one"** for the no-decor fallback, as the spec decided: the
  margin's ۞ (with its label) now stands beside a line whose text starts with ۞. With decor the margin draws the
  ornament, as the print does.
- Removed: `markerInset`, `insetBox` and the frame-number constants, `markerDrawn`, `DECOR_MARKER_INK` /
  `DECOR_HIZB_INK` (now `DECOR_LAMP`, `DECOR_MEDALLION`, `DECOR_MEDALLION_JUZ`), and `.mk-inset`.
- Tests: `ornaments.test.ts` (the ornament per kind at every size, inline or not; sizes that fit the label of each kind
  in its box less the thickening; every ornament's box on its line and inside the paper for every kind at qfs 18–160
  and lines 1, 8, 15; the ۞ fallback's label on the line; the line-1 lamp in the dog-ear; the shared lines of pages
  309 and 272, pinned; the marks after a medallion and the next line's, above a crest, lifted to make room, and, for
  every ornament alone or over a sajda on every line at qfs 18, 30 and 60 with every mix of marks on the five lines
  around it, never over a marker, another mark or the dog-ear), `printLabels.test.ts` (`MARGIN_LABEL_EM`,
  `marginLabelBox`), `layout.contrast.test.ts` (no `.mk-inset`), and `furniture.browser.test.ts`: the lamp or
  medallion, its font size, its box's width, its free box on the line and the label's ink inside it, on pages 262, 42,
  51, 534, 529 and 415 at qfs 18, 24, 30 and 60; the label at one size in both UIs, decor on and off; the ۞ with the
  print label on the line while the ornaments are off; the label inside its box from qfs 18 to 160, and the marks after
  the marker; the label's hairline at qfs 18 in paper and night; the marks around page 262's medallion and above page
  529's lamp; a line-1 lamp over the dog-ear. These need no decor face (the ornament's size is set inline, the label's
  ink is measured in the bundled face), so CI, which has none, runs them; only `measures the real ornaments…` reads the
  dev packs' quran-common (`pnpm dev-packs`) and skips without it: it rasterises U+FC22 and U+FC23 and checks the ink
  extents, widths and free boxes `INK` holds (each box empty, its rules within 0.02 em). The two running-head tests of
  the print's calligraphy that the first step broke (they expected
  the quarter in the head at qfs 20–27) now turn the markers off. The two sub-pixel failures the spec mentions
  (`labels the margin…`, `stacks exactly…`) did not occur on this machine (Edge on Windows), neither with only the
  first step in the tree nor after this change; both tests are rewritten for the new geometry. S06, S08 and
  S13 assert the new look (`expectRubMarker` in `_furniture.mjs`, which now reports a marker's ornament, whether its
  label is inside, and the label box's middle, on the line either way, and checks the ornament's height: 3.56, 3.72 or
  4.48·qfs by kind); S06 broke too, its head no longer carrying the hizb.
- Visual QA (browser mock, real fonts, temporary test, PNGs in `artifacts/margin-check/`, not committed): pages 531,
  534, 536, 542, 262, the sajda page 176 and the shared lines of 309 and 272, at qfs 18, 24, 30 and 60 in the en and
  ar UIs, plus 262, 534 and 536 with decor off and with the print face off. The margin is pixel-identical in en and ar.
  After the review: page 17 (a quarter on line 1) with its dog-ear, the marks on 531, 262, 529 and 536 around their
  ornaments, the shared lines of 309 and 272, and the label's hairline at qfs 18 and 24 in paper and night
  (`artifacts/margin-fix/`).

## Requests

- **WP8e (MushafView):** render `<SurahInfoPopover />` once (it takes no props and reads its controller); keep the
  `.spread` class on the spread container (`frame.css` shows the page-stack hairlines only under `.spread`). The ribbon
  hangs in the spine margin: the spine shading of §8.10 may sit under it unchanged.
- **WP11c (library):** keep `bookmarks`, `notes` and `readingBookmark` replaced (not mutated) on every change, and keep
  emptying the marks cache before a list is replaced (`MarginMarks` reloads through `marksFor` on exactly that
  signal). The ribbon's "Move here" calls `moveReadingBookmark(reader.actionTarget, reader.layout, page)`; its popover
  shows the keys of the shortcut registered with `labelKey 'shortcuts.study.readingBookmark'` (both now exist).
  Note: there is no getter command for the reading bookmark, so the store cannot re-read it on a `reading_bookmark`
  event; harmless while every move goes through the store (one window), worth a getter if that ever changes.
- **WP8d:** `.mp-margin`, `.mp-ribbon` and `.mp-dogear` are already "not blank" in your selection-clearing test
  (`.mp-margin` and buttons); nothing else needed. Marker clicks call `reader.select(ayahId)`.
- **WP11a (SurahCard):** `SurahCartouche` outside a page is 16.5·qfs wide and 1.55·qfs tall with the name at
  0.85·qfs; pass the reduced `qfs` (e.g. 0.6 × the reading size). The name is real text; the artwork is `aria-hidden`.
- **WP0D / lead:** vitest browser failure screenshots land in `.vitest/attachments/failure-screenshots/` (not under
  `artifacts/`, despite `screenshotDirectory`), and `.vitest/` is not in `.gitignore`. Mushaf images must never be
  committed (§12.6): add `.vitest/` to `.gitignore`. Accepted: collected as an integration follow-up (LEAD.md item 15).
- **Lead:** fold deviations 1–6 into §8.8/§8.9 (glyph metrics and tunables, juz series, sajda line, opening pages
  without markers, head separator and compact form, sajda overline dropped, data path of the marks).
