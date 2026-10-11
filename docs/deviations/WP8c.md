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
| hizb ornaments U+FC23 / U+FC22 | 1 em | 1.01 em, slender frames | drawn 1.45 qfs tall |
| juz calligraphy U+E001… | 3.83 em | 1.17 em | 0.8 qfs tall in the head |
| ۞ U+06DE (`qd-hafs`) | 0.57 em | **0.45 em** | drawn 0.75 qfs tall |
| ۩ U+06E9 (`qd-hafs`) | 0.49 em | 0.63 em | drawn 0.75 qfs tall |

- `--sh-scale` starts at 1.55 in §8.8, which drew the header 5 qfs wide (the glyph is 3.3 em wide, not 1 em). At the
  full 16.5 qfs width it would be 2.0 qfs tall and touch the glyphs of the neighbouring lines (page 604), so the
  header is sized to the line pitch: 4.4·qfs (3.62·qfs on the 12.1 qfs opening lines). `--basmala-scale` is 1.4
  (§8.8 suggests ≈ 1.25: 8 qfs wide, visibly small next to the header).
- **Markers are sized by ink, not em.** §8.9 gives ۞ `max(0.95·qfs, 14px)` as a font size, but the KFGQPC Hafs ۞ has
  only 0.45 em of ink: a 0.43·qfs mark. Markers are drawn with a fixed ink height (0.75·qfs, ≥ 13 px; the decor
  ornaments 1.45·qfs) and each glyph's ink is centred in its box from its measured metrics (`INK`, `inkShift` in
  `ornaments.ts`). Labels keep §8.9's `max(0.36·qfs, 11px)` and the `0.36·qfs ≥ 10` rule.
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

### 3. Running heads

- **The quarter separator is a small gold khatam, not "·"** (§8.9 example `الجزء ١٤ · ¾ الحزب ٢٧`): a middle dot next
  to Arabic-Indic digits reads as the digit zero ٠ ("١٤ ٠ الحزب"). The quarter is appended whenever the margin labels
  are not drawn: below qfs 28, and also when `showMarginMarkers` is off.
- A juz or hizb start appends `الحزب N` (a juz start is also a hizb start); quarters append `¼/½/¾ الحزب N`.
- **Below qfs 20 the juz head reads `ج ١٤`**, not a bare `١٤`: a lone Arabic-Indic number in the head reads as a page
  number. `سورة` is dropped as specified. With decor the calligraphy is kept at every size.

### 3a. Furniture text is set in qd-hafs, not `--font-naskh`

§8.9 sets the running heads and the page number in `--font-naskh` (Noto Naskh Arabic, a web font loaded on first
use). That font arrives after the first paint, and the heads reflowed when it swapped in: WP8a's CLS browser test
(`MushafPage.swap.browser.test.ts`) measured a layout shift of 1.2e-5 with the furniture in place, against the CLS 0 of
§8.1. Heads, page numbers and margin labels now use `--mp-furniture-font: 'qd-hafs', system-ui, sans-serif`: the
bundled KFGQPC Hafs face (itself a Naskh, matching the text) that `main.ts` loads before mounting, and the local system
font for the fractions ¼ ½ ¾ that it lacks (Noto Naskh's lazily loaded latin subset would swap again). The test passes
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

### 7. i18n

The `furniture` domain covers only the UI around the furniture (tooltips, the two popovers, the toast). The furniture
drawn on the page (heads, labels, numbers, سورة / الجزء / الحزب / سجدة) is always Arabic with Arabic-Indic digits
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
