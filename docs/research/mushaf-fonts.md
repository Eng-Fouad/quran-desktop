# mushaf-fonts

## Mushaf and Arabic fonts for Quran Desktop: verified findings (2026-10-10)

Samples are saved under R = `C:\Users\fouad\AppData\Local\Temp\claude\C--Users-fouad-AppData-Roaming-Claude-scratch-workspaces-6463bc05-45c5-4361-9291-b022ebeed68b-4fedef61-7d08-4bf3-95d0-ddab25699856-scratch-2026-10-09-5aa8bc\ba4e4a3a-7c3b-4454-bc64-bdcdd225f47a\scratchpad\research\mushaf-fonts\`.
- The quran.com source I read is `quran/quran.com-frontend-next`, branch **`production`** (the default branch), tree sha `aff1a035b09b66f28047b3216edcae4c5c949a49`.
- Fonts were inspected with fontTools 4.63 and rendered with Pillow + FreeType 2.14.1 + libraqm (HarfBuzz).

### 1. QPC per-page fonts (V1 = 1405H, V2 = 1421H, V4 = tajweed)

**URL template.** The page number has no zero padding: `p1`…`p604`.
`{HOST}/fonts/quran/hafs/{VARIANT}/{FMT}/p{page}.{FMT}`
- `FMT` is one of `woff2`, `woff`, `ttf`.
- `VARIANT` is one of `v1`, `v2`, `v4/colrv1`, `v4/ot-svg/light`, `v4/ot-svg/dark`, `v4/ot-svg/sepia`.

| HOST | Notes |
|---|---|
| `https://verses.quran.foundation` (also `https://verses.quran.com`) | BunnyCDN, `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=25600000`. Serves all variants. |
| `https://quran.com` | Cloudflare, `public, max-age=31536000, immutable`, **no CORS header**. These are the files quran.com itself loads (`fontFaceHelper.ts` uses relative `/fonts/quran/hafs/...`). |
| `https://static.qurancdn.com` | Serves v1 and v2 only (Last-Modified 2022, CORS `*`). `v4/colrv1` and `v4/ot-svg` return **404**. It also has an older `v4/{ttf,woff2}/p{n}` from 2022 (`QCF4001`) with **no colour tables**. |
| QUL: `https://static-cdn.tarteel.ai/qul/fonts/quran_fonts/{v1,v2,v4-tajweed}/{ttf,woff,woff2}/p{n}.{ext}` | `v4-tajweed` has the same bytes and sizes as `v4/colrv1`. |

The same file has the same SHA-256 on quran.com, static.qurancdn.com and verses.quran.foundation (checked v1, v2 and v4 for p1 and p604). File sizes from the repo's git tree match the CDN `Content-Length` (checked on p300).

**Download totals per variant (604 files each)** (`qcf_page_font_size_totals.csv`; per-page sizes in `qcf_page_font_sizes_by_page.csv`):

| Variant | woff2 | woff | ttf | woff2 avg/page (min to max) |
|---|---|---|---|---|
| v1 | **45.7 MB** | 50.8 MB | 90.5 MB | 77.5 KB (15 KB p1 to 95 KB p552) |
| v2 | **93.2 MB** | 102.9 MB | 198.5 MB | 158 KB (41 KB p1 to 227 KB p559) |
| v4/colrv1 | **48.5 MB** | 65.3 MB | 159.3 MB | 82 KB (27 KB p1 to 114 KB p30) |
| v4/ot-svg/{light, dark, sepia} | ~190 MB each | ~207 MB | ~245 MB | ~323 KB |

**Internal font names and code points**
- **V1:** names are `QCF_P001`…; UPM 2048; glyf-only (no GSUB/GPOS); cmap is U+FB51… (plus U+0020–0044); vendor "Harf".
- **V2:** names are `QCF2001`…`QCF2604`; UPM 2500; cmap is U+FC41…, and there is **no space glyph**.
- **V4:** name is `QCF4001_COLOR` and so on; UPM 2500. V4 uses the **`code_v2`** word codes (quran.com maps TajweedV4 to the `code_v2` field and uses mushaf id 19).
- The `local()` names quran.com uses (`QCF_P001`, `QCF2001`, `QCF4_P001`) are only a cache hint.

**V4 colour format.** The files in the folder named **`colrv1` are actually COLR version 0 + CPAL v0.**
- I checked the raw header (version field = 0) on pages 1, 2, 50, 300 and 604. Each has 36–153 base glyphs, up to 6 layers per glyph, and **6 palettes × 16 entries**.
- The `ot-svg/*` files have an `SVG ` table, no COLR, and the colours baked in per theme.

Palette meanings (`v4_colr_check.txt`; meanings matched to quran.com's TajweedBar legend colours):
- **Palettes:** 0 = light tajweed, 1 = dark tajweed (white base), 2 = sepia tajweed, **3 = light plain** (all black except the ayah-marker colours), **4 = dark plain** (white), **5 = sepia plain**. quran.com uses 0, 1 and 2 through `@font-palette-values --Light{base-palette:0}`, `--Dark{1}` and `--Sepia{2}`, and sets `font-palette:` per theme.
- **Entry indices:** 0 = base ink; 1 and 2 = idgham / silent (grey); 3 = madd 6; 4 = madd 2-4-6; 5 = madd 2; 6 = ikhfa; 7 = tafkhim; 8 = qalqala; 9 = madd 4-5; **10–13 = ayah-end ornament + digit** (verified that every end glyph on p50 uses layers 10, 11, 12, 13); 14 and 15 = auxiliary marks.
- **One V4 download (48.5 MB) therefore gives six reading modes:** tajweed or plain, in light, dark or sepia. `override-colors` allows custom themes. Rendered proof is in `render_v4_p50_palettes_3_1_4.png`.

**Webview support** (caniuse and MDN browser-compat-data, read live):

| | COLRv0 | COLRv1 | `@font-palette-values` / `font-palette` | `ascent-override` |
|---|---|---|---|---|
| Chromium (WebView2) | 71+ | 98+ | 101+ | 87+ |
| Safari / WKWebView | 11+ (broken in 17.0–17.1) | **No** (WebKit bug 233496 still NEW) | 15.4+ | **not in a stable release** |

- OT-SVG is not supported in Chromium (the feature request was closed as WontFix), so the ot-svg files would not render on Windows.
- **Conclusion:** the `v4/colrv1` (really COLRv0) files are the portable choice for WebView2 and WKWebView. WebKitGTK support was **not verified**.

### 2. Surah names, header frames, Bismillah, ayah-end markers

**Ayah-end marker.** Each marker is **its own glyph, with the number drawn inside it**.
- The API returns it as a word with `char_type_name:"end"`. For example, 1:1 gives `code_v1` U+FB55 and `code_v2` U+FC45 (`api_by_page1.json`; renders in `render_v1_p1.png`, `render_v2_p1.png`).
- Lines in the API data are only for ayah text. On page 50 the words start at line 3, so the surah header and Bismillah are not words in the QCF data.

**Surah-name fonts**

| Font | URL | Size | How to use it |
|---|---|---|---|
| quran.com `surahnames` (family `sura_names` v1.1) | `https://quran.com/fonts/quran/surah-names/v1/sura_names.woff2` (also on static.qurancdn.com) | 88,560 B | GSUB `liga`: the text `001`…`114` becomes the name glyph and `surah` becomes the word "سورة" (U+E000). Also mapped directly to PUA U+E001–E114. quran.com renders `<span>{id.padStart(3,'0')}</span>` in this font. |
| `static.qurancdn.com/fonts/quran/surah-names/v2/sura_names.woff2` | same host | 211,372 B | Older v2; has no `surah` ligature. |
| QUL `surah-name-v2` | `https://static-cdn.tarteel.ai/qul/fonts/surah-names/v2/surah-name-v2.{ttf,woff2}` | ttf 580,388 B; woff2 211,868 B | Ligatures `surah001`…`surah114` and `s001`…; the "سورة" prefix is part of each glyph. |
| QUL `surah-name-v1` | `https://static-cdn.tarteel.ai/qul/fonts/surah-names/v1/surah-name-v1.ttf` | 153,660 B | |
| QUL `surah-name-v4` | `https://static-cdn.tarteel.ai/qul/fonts/surah-names/v4/surah-name-v4.ttf` | 215,592 B | Also has a `surah-icon` ligature. |
| QUL **Surah header**, `QCF_SurahHeader_COLOR` (KFGQPC, 2025-09-08) | `https://static-cdn.tarteel.ai/qul/fonts/surah-names/surah-header/QCF_SurahHeader_COLOR-Regular.{ttf,woff2}` | ttf 1.83 MB; woff2 118,552 B | **One glyph = ornamental frame + surah name.** The map is in `qul_ligatures_surah_header_QCF_SurahHeader_COLOR.json` (surah-1 = U+FC45 … surah-113 = U+FBE9, surah-114 = U+FBEB). Despite the name it has **no colour tables**, so it can be tinted with `color`. Render: `render_QCF_SurahHeader_surah1_2.png`. |
| QUL V4 colour surah names, `QCF_FullSurah_HD_COLOR-v1` | `https://static-cdn.tarteel.ai/qul/fonts/surah_names_v4/surah_names.ttf` | 1.1 MB | Uses **OT-SVG + CPAL**, so it does not render in WebView2. Avoid. |

**Bismillah**
- quran.com uses `https://quran.com/bismillah.svg`: 17,812 B, one `<path fill="currentColor">`, viewBox `0 0 176 36`, so it can be themed.
- The QCF page fonts have no standalone Bismillah glyph. A `QCF_BSML` font exists in the third-party `nuqayah/qpc-fonts` repo, but I did not verify it.

### 3. Single-font Hafs rendering (offline core font)

Coverage over the full Quran was computed from `https://api.quran.com/api/v4/quran/verses/{uthmani|qpc_hafs}`. Renders: `render_single_font_compare.png`, `render_kfgqpc_v18_v22_v30.png`, `render_ayah_marker_v22_vs_v30.png`.

| Font | Source / URL | Version, size | License | Text it expects |
|---|---|---|---|---|
| **KFGQPC Hafs V30** (family "KFGQPC Hafs V3", full name "KFGQPC HAFS Uthmanic Script Regular") | `https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip`, linked from `/ten-readings`. The zip is 844,410 B (Last-Modified 2026-09-13) and contains `KFGQPC Hafs V30.ttf` (301,356 B) and a .docx of the matching text. | 3.0 | KFGQPC EULA (nameID 13): "Free of Cost … Use, Copy, Distribute", but it cannot be "Sold, Modified, Altered…". fsType 0. | Standard Unicode. **It needs U+06DD before the ayah digits**: bare digits render as plain numerals. It adds U+08F0–08F2 (open tanween) and also keeps the legacy QPC code points (U+0656, U+0657, U+065E, U+06EA). 0 missing code points for both text encodings. |
| KFGQPC HAFS Uthmanic Script **V22** | `https://static-cdn.tarteel.ai/qul/fonts/UthmanicHafs_V22.ttf` (297,700 B) or `.woff2` (106,856 B) | 2.2 | same EULA | `text_qpc_hafs`. Bare Arabic-Indic digits are **automatically drawn inside the ayah ornament**; adding U+06DD gives a **double marker**. No U+08F0–08F2. |
| UthmanicHafs1 **Ver18** (what quran.com uses) | `https://quran.com/fonts/quran/hafs/uthmanic_hafs/UthmanicHafs1Ver18.woff2` (87,760 B) | 0.18 | same EULA | Same behaviour as V22. |
| **Amiri Quran** | `https://github.com/aliftype/amiri/releases/download/1.003/Amiri-1.003.zip` (`AmiriQuran.ttf` 136,920 B; `AmiriQuranColored.ttf` 158,336 B, COLRv0); npm `@fontsource/amiri-quran@5.3.0` (Arabic subset 45,680 B, version 1.003) | 1.003 (released 2025-06-13) | **OFL-1.1** | `text_uthmani` with U+06DD + digits. Missing U+065E, which appears 1,807 times in `text_qpc_hafs`. |
| **Scheherazade New** | `https://github.com/silnrsi/font-scheherazade/releases/download/v4.500/ScheherazadeNew-4.500.zip` (Regular ttf 331,504 B; woff2 124,783 B); npm `@fontsource/scheherazade-new@5.3.0` | 4.500 (released 2026-04-15) | **OFL-1.1** (Reserved Font Names "Scheherazade", "SIL") | `text_uthmani` with U+06DD; covers both encodings fully. |
| me_quran | quran.com `me_quran-2.woff2` (AAT `morx` only); QUL `me_quran_volt_newmet.ttf` (OpenType) | 2.00 / 1.003 | Not free: "unlawful distribution prohibited" / "Free for non commercial use" | `text_uthmani` |
| DigitalKhatt V2 | `https://static-cdn.tarteel.ai/qul/fonts/dk/DigitalKhattV2.otf` (521,832 B, CFF2) | 0.1 | **OFL-1.1** | Needs its own justification engine (`jalt`). Missing the QPC legacy code points. |

The two texts use different code points. `text_qpc_hafs` uses U+06E1 for sukun, U+06E4, U+0656, U+0657, U+065E and Arabic-Indic digits. `text_uthmani` (Tanzil) uses U+0652, U+06DF, U+06E3, U+06EB and U+06D9.

**Best fallback for browser shaping:** a KFGQPC Hafs font with `text_qpc_hafs` gives the most Mushaf-faithful result, and it is also the same face quran.com uses as its fallback for V1/V2.
- If you pick V30, convert "space + digits" to "space + U+06DD + digits".
- If you pick V22, keep bare digits.
- Scheherazade New is the best fully open (OFL) alternative.

### 4. UI fonts (OFL-1.1, checked live with `npm view`)

- `@fontsource-variable/inter@5.3.0` (wght and opsz axes; the latin wght woff2 is 48 KB). Upstream is `rsms/inter` v4.1.
- `@fontsource/ibm-plex-sans-arabic@5.3.0`
- `@fontsource-variable/noto-naskh-arabic@5.3.0` (arabic wght woff2 94 KB)
- `@fontsource-variable/noto-sans-arabic@5.3.0`, `@fontsource-variable/noto-kufi-arabic@5.3.0`
- `@fontsource-variable/readex-pro@5.3.0` (arabic 23 KB, latin 31 KB)
- `@fontsource-variable/vazirmatn`, `cairo`, `rubik`, `geist`: all 5.3.0, OFL-1.1

All fontsource packages were modified 2026-07-19 (`npm_ui_fonts.txt`).

### 5. How quran.com renders a V1/V2/V4 page (exact approach; excerpts in `qurancom_frontend_rendering_excerpts.txt`)

**Loading** (`useQcfFont`):
- For every page in view it creates `new FontFace('p{page}-{v1|v2|v4}', "local(QCF_P001|QCF2001|QCF4_P001), url(woff2), url(woff), url(ttf)")`, sets `fontFace.display='block'`, calls `document.fonts.add`, then `.load()`, and records the loaded faces in Redux.
- Until a page's font has loaded, each word renders `qpc_uthmani_hafs` text in the `UthmanicHafs` font, with a separate size scale (`fallback_qpc_uthmani_hafs`) so the layout shift is small.
- For V4 it uses `v4/colrv1`, except Firefox dark mode, which uses `v4/ot-svg/{theme}`. It also emits a per-page `<style>@font-palette-values --Light/--Dark/--Sepia {font-family:'p{n}-v4'; base-palette:0|1|2}`.

**Structure**
- Words are grouped by `Page{page}-Line{line}`.
- Line: `div.container{direction:rtl}` > `div.line{text-align:center; margin-inline:auto; inline-size:var(--line-width)}` > VerseText.
- VerseText is `div.verseText{display:flex; line-height:var(--line-height); justify-content:space-between}`. It uses **`justify-content:center` for pages 1–2 and for listed surah-ending lines**: 255:[2], 528:[9], 534:[6], 545:[6], 586:[1], 593:[2], 594:[5], 600:[10], 602:[5,15], 603:[10,15], 604:[4,9,14,15].
- Each word is a `span.container{display:inline-block; white-space:nowrap}` containing a span whose innerHTML is the one-character `code_v1` or `code_v2`, styled `font-family:'p{n}-v2'`.
- **There are no spaces between words.** Justification comes only from flex `space-between`. quran.com does not use `text-align-last`, `font-feature-settings` or kashida.

**Sizing**
- Ten font scales, set through CSS custom properties.
- At ≥768px, `--font-size` and `--line-width` are in `vh`. For example, scale 3: V2 font 3.2vh with line width 56vh (about 17.5 em); V1 4vh with 59.5vh (about 14.9 em).
- On mobile, font sizes are in `vw`.

**Tricks**
- Highlighting a colour-font word uses `color:transparent; text-shadow:0 0 var(--color-success-medium)`, because COLR layers ignore `color`.
- Firefox V1 at scale <6 gets an extra leading space, `word-spacing:4px; margin-inline-end:-5px; white-space:pre`.

**Line widths I measured on p50** (`natural_line_widths_p50.txt`):
- V2 and V4 lines are almost uniform: 15.46–15.98 em and 16.15–16.47 em. The glyphs already include kashida, so a container about 16.5 em wide with space-between gives print-like lines.
- V1 lines vary: 12.1–17.2 em.

**Vertical metrics differ between pages and versions** (`qcf_vertical_metrics.txt`): for example, V2 p1 hhea is 2809/-1301, other V2 pages 3000/-1500, and V4 3940/-2520. Use explicit, fixed line boxes.

### Licensing context

- The quran.com repo README claims MIT, but the production branch has no LICENSE file. The fonts are not covered by that code license in any case.
- Quran Foundation Developer Terms (last updated 2026-10-04; `qf_legal_mushaf_fonts_and_images.txt`): "A Developer may cache or bundle font files and Mushaf images obtained through QF APIs or documented CDN URLs … if the Developer maintains an active account in the Developer Console and credits Quran Foundation…". The files "may be distributed only as an integrated part of the Application" and "may not be offered separately to others".

## Facts
- [V] quran.com loads QCF fonts from relative paths /fonts/quran/hafs/{v1|v2|v4/colrv1|v4/ot-svg/<theme>}/{woff2,woff,ttf}/p{page}.{ext} (no zero padding), via the FontFace API with display='block' and local(QCF_P%03d | QCF2%03d | QCF4_P%03d) first. — https://raw.githubusercontent.com/quran/quran.com-frontend-next/production/src/utils/fontFaceHelper.ts and src/hooks/useQcfFont.ts (saved excerpt: research/mushaf-fonts/qurancom_frontend_rendering_excerpts.txt)
- [V] These hosts return HTTP 200 for v1, v2 and v4/colrv1 pages 1 and 604: https://quran.com/fonts/quran/hafs/... (no CORS header, max-age=31536000 immutable) and https://verses.quran.foundation/fonts/quran/hafs/... (BunnyCDN, Access-Control-Allow-Origin *). The bytes are identical across quran.com, verses.quran.foundation and static.qurancdn.com. — curl -sI and GET with sha256sum; research/mushaf-fonts/headers_font_cdn.txt
- [V] static.qurancdn.com serves v1 and v2 but returns 404 for v4/colrv1 and v4/ot-svg. Its v4/ttf/p1.ttf is an older 2022 QCF4001 build with no color tables. — curl status codes plus fontTools inspection; research/mushaf-fonts/inspect_old_v4_p1.json
- [V] Total woff2 download size: v1 45.7 MB, v2 93.2 MB, v4/colrv1 48.5 MB, v4/ot-svg about 190 MB per theme (604 files each). Git-tree blob sizes match the CDN Content-Length. — GitHub git trees API for the production branch, plus CDN Content-Length on p300; research/mushaf-fonts/qcf_page_font_size_totals.csv and qcf_page_font_sizes_by_page.csv
- [V] The files in v4/colrv1 contain COLR table version 0 (not v1) with CPAL v0: 6 palettes of 16 entries each. The v4/ot-svg files contain an SVG table and no COLR. — Raw COLR header check on p1, p2, p50, p300 and p604; research/mushaf-fonts/v4_colr_check.txt and inspect_v4_otsvg_dark_p1.json
- [V] V4 CPAL palettes: 0 = light tajweed, 1 = dark, 2 = sepia, 3, 4 and 5 = plain (no tajweed) light, dark and sepia. Entries 1–9 are tajweed rules (mapping inferred by matching colours to the TajweedBar legend). Ayah-end glyphs use layers 10, 11, 12 and 13. — fontTools CPAL/COLR dump, TajweedBar.module.scss colours, render research/mushaf-fonts/render_v4_p50_palettes_3_1_4.png
- [V] quran.com selects V4 palettes with @font-palette-values (base-palette 0, 1, 2) and font-palette: --Light/--Dark/--Sepia set on the theme root. — src/components/Verse/TajweedFontPalettes.tsx and src/styles/themes/_light.scss, _dark.scss, _sepia.scss
- [V] V4 words use the code_v2 glyph codes (TajweedV4 maps to the code_v2 word field; mushaf id 19). — src/utils/api.ts and types/QuranReader.ts (Mushaf enum: QCFV2=1, QCFV1=2, KFGQPCHAFS=5, QCFTajweedV4=19); p50 rendering with codes from mushaf=19
- [V] The ayah-end marker (with its number) is a single glyph in the QCF fonts. The API returns it as char_type_name 'end'; for 1:1 the code is code_v1 U+FB55 and code_v2 U+FC45. — https://api.quran.com/api/v4/verses/by_page/1?words=true&word_fields=code_v1,code_v2,...; research/mushaf-fonts/api_by_page1.json, render_v2_p1_end_markers.png
- [V] Color-font support: COLRv0 in Chrome 71+ and Safari 11+ (regressed in Safari 17.0–17.1). COLRv1 in Chrome 98+ and Firefox 107+, but never in Safari. font-palette in Chrome 101+, Safari 15.4+ and Firefox 107+. ascent-override is only in Safari preview. — caniuse JSON (research/mushaf-fonts/caniuse_colr.json, caniuse_colr-v1.json, caniuse_css-font-palette.json) and MDN browser-compat-data font-face.json and font-palette-values.json
- [V] WebKit COLRv1 support bug 233496 is still NEW (last changed 2024-09-18). — https://bugs.webkit.org/show_bug.cgi?id=233496&ctype=xml
- [?] WebKitGTK (Tauri on Linux) renders COLRv0 and honors font-palette. — No runtime test was run on Linux; it is only inferred from FreeType/Skia support.
- [?] Chromium does not support OpenType-SVG fonts (the feature request was closed as WontFix). — WebSearch results: FontCreator guide, MPEG-OTSPEC list, Microsoft Edge forum (secondary sources only)
- [V] The quran.com surah-name font is at https://quran.com/fonts/quran/surah-names/v1/sura_names.woff2 (88,560 B). Its GSUB liga maps '001'…'114' to the name glyphs (PUA U+E001–E114) and 'surah' to U+E000. quran.com renders the zero-padded chapter id in font-family 'surahnames'. — curl -sI; fontTools GSUB dump research/mushaf-fonts/surah_names_v1_ligatures.txt; src/components/chapters/ChapterIcon/index.tsx
- [V] QUL serves QCF_SurahHeader_COLOR (frame plus surah name in one glyph; surah-1 = U+FC45 … surah-114 = U+FBEB) at https://static-cdn.tarteel.ai/qul/fonts/surah-names/surah-header/QCF_SurahHeader_COLOR-Regular.woff2 (118,552 B). Despite its name it has no color tables. — curl -sI, fontTools inspection, QUL page https://qul.tarteel.ai/resources/font/458; research/mushaf-fonts/qul_ligatures_surah_header_QCF_SurahHeader_COLOR.json, render_QCF_SurahHeader_surah1_2.png
- [V] quran.com draws the Bismillah from /bismillah.svg (17,812 B): a single path with fill=currentColor and viewBox 0 0 176 36. — src/components/dls/Bismillah/Bismillah.tsx plus curl of https://quran.com/bismillah.svg
- [V] KFGQPC Hafs V30 is downloadable at https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip (844,410 B, Last-Modified 2026-09-13). The zip contains 'KFGQPC Hafs V30.ttf' (301,356 B, version 3.0, family 'KFGQPC Hafs V3') and a .docx of the matching text. — curl -sI and download; fontTools name table
- [V] V30 needs U+06DD before ayah digits (bare digits render as plain numerals) and supports U+08F0–08F2. V18 and V22 auto-enclose bare digits after a space, and U+06DD gives a double marker. — Pillow+raqm renders research/mushaf-fonts/render_ayah_marker_v22_vs_v30.png and render_kfgqpc_v18_v22_v30.png; cmap checks
- [V] The KFGQPC Hafs EULA (nameID 13) allows free use, copying and distribution, but forbids selling, modifying, altering or reverse-engineering the font. — research/mushaf-fonts/UthmanicHafs1Ver18_license_name_table.txt (same text in V22 and V30)
- [V] text_qpc_hafs and text_uthmani use different code points. qpc_hafs only: U+0655, U+0656, U+0657, U+065E, U+06E1, U+06E4, Arabic-Indic digits and NBSP. uthmani only: U+06D9, U+06DF, U+06E3, U+06EB. Amiri Quran lacks U+065E; Scheherazade New 4.500 and KFGQPC V18, V22 and V30 cover both. — https://api.quran.com/api/v4/quran/verses/uthmani and /quran/verses/qpc_hafs plus fontTools cmap; research/mushaf-fonts/text_encoding_font_coverage.txt
- [V] Amiri 1.003 (released 2025-06-13, OFL-1.1) contains AmiriQuran.ttf and AmiriQuranColored.ttf (COLRv0). Scheherazade New v4.500 (released 2026-04-15) is OFL-1.1 with Reserved Font Names 'Scheherazade' and 'SIL'. — github.com releases/latest redirect, expanded_assets page, OFL.txt raw files, zip listing
- [V] me_quran is not openly licensed: quran.com's me_quran-2 says 'unlawful distribution prohibited', and QUL's me_quran_volt_newmet says 'Free for non commercial use'. quran.com's me_quran-2.woff2 is AAT-only (morx, no GSUB/GPOS). — fontTools name and tables dump; research/mushaf-fonts/inspect_me_quran-2.json
- [V] DigitalKhatt V2 (https://static-cdn.tarteel.ai/qul/fonts/dk/DigitalKhattV2.otf, 521,832 B, CFF2) is licensed OFL-1.1. — fontTools name table nameID 13 and 14
- [V] These UI font npm packages are at 5.3.0 under OFL-1.1: @fontsource-variable/inter, @fontsource/ibm-plex-sans-arabic, @fontsource-variable/noto-naskh-arabic, @fontsource-variable/noto-sans-arabic, @fontsource-variable/noto-kufi-arabic, @fontsource-variable/readex-pro, @fontsource/amiri-quran, @fontsource/scheherazade-new. Inter upstream is v4.1. — npm view (research/mushaf-fonts/npm_ui_fonts.txt); unpkg ?meta listings
- [V] quran.com justifies Mushaf lines with flexbox: .verseText{display:flex; justify-content:space-between}, or center for pages 1–2 and listed surah-ending lines. Words are inline-block nowrap spans with no spaces between them. The line has inline-size:var(--line-width) set in vh per font scale; font-size is in vh at ≥768px and in vw on mobile. — VerseText.module.scss, Line.module.scss, QuranWord.module.scss, pageUtils.ts, _utility.scss (saved in qurancom_frontend_rendering_excerpts.txt)
- [V] Natural line widths on page 50: V2 15.46–15.98 em, V4 16.15–16.47 em, V1 12.09–17.16 em. — fontTools hmtx sums for API word codes; research/mushaf-fonts/natural_line_widths_p50.txt
- [V] On 16 sampled pages, the API returns identical word-to-line assignments for mushaf=1 (V2) and mushaf=2 (V1). — api.quran.com by_page with words=true and word_fields=line_number for both mushaf ids; output in session (raw files under scratchpad/w/pages)
- [V] The Quran Foundation Developer Terms (updated 2026-10-04) allow caching or bundling font files and Mushaf images only as an integrated part of the app. This requires an active Developer Console account and credit to Quran Foundation, and the files may not be offered separately. — https://api-docs.quran.foundation/legal/mushaf-fonts-and-images/; research/mushaf-fonts/qf_legal_mushaf_fonts_and_images.txt
- [V] The quran.com-frontend-next README says MIT, but the production branch has no LICENSE file. — git tree listing and README.md raw

## Recommendations
- Use `v4/colrv1` (actually COLRv0 + CPAL) as the main high-fidelity on-demand download. It is 48.5 MB for all 604 woff2 files and needs `code_v2` codes. The CPAL palettes give six modes: 0/1/2 for tajweed in light/dark/sepia and 3/4/5 for plain light/dark/sepia. Offer V2 (93.2 MB) as the monochrome fallback for any webview that fails COLR (check WebKitGTK at runtime), and V1 (45.7 MB) as an optional 1405H style.
- Download from `https://verses.quran.foundation/fonts/quran/hafs/{v1|v2|v4/colrv1}/woff2/p{page}.woff2` using reqwest in Rust (CORS doesn't matter there). Use `https://quran.com/fonts/quran/hafs/...` as a mirror and verify the expected sizes from `qcf_page_font_sizes_by_page.csv`. Store files under app data, for example `fonts/qcf/{v1,v2,v4}/p{n}.woff2`. Allow a resumable 'download whole Mushaf' as well as lazy per-page fetching (prefetch the current page ±2, and ±4 for two-page spreads).
- Register page fonts in the webview with `new FontFace('qcf-v4-p'+n, arrayBuffer, {display:'block'})`, using bytes read through a Tauri command or the fs plugin, then `document.fonts.add(face)` and `await face.load()`. Don't use network URLs or `local()`. Keep an LRU of about 20 loaded FontFaces and remove the rest with `document.fonts.delete`.
- V4 theming: create one `@font-palette-values --qd-<theme>-<p> { font-family: 'qcf-v4-p<p>'; base-palette: N; override-colors: ... }` per loaded page, or define a palette per family. Set `font-palette` on the page container. For highlighting, use `color: transparent; text-shadow: 0 0 <color>` or a background highlight, because COLR layers ignore `color`.
- Page layout: each line should be a fixed-height row, `display:flex; justify-content:space-between; direction:rtl`, with one `<span>` per word holding exactly one glyph character and no spaces (V2 and V4 have no space glyph). Use `justify-content:center` on pages 1–2 and on quran.com's list of surah-ending lines, or better, take alignment from the layout DB. Size everything in em of one root `--qfs` computed from the available height: page height = 15 × line pitch, and line width about 16.5 em for V2/V4 (measure the per-page maximum for V1). This keeps a crisp vector two-page spread at any zoom without vh breakpoints.
- Don't rely on the fonts' ascent/descent values; they differ by page and by version. Give each line an explicit height and `line-height`, and center the glyph inside it. `ascent-override` cannot be used for this because WKWebView stable doesn't support it.
- Bundle the offline core font as KFGQPC Hafs V30 TTF, unmodified (301 KB), and add a credit and the EULA text in About. Feed it `text_qpc_hafs` with ' <digits>' converted to ' ۝<digits>', or use the V30 .docx text. If you would rather keep the API text unchanged, bundle V22 (bare digits are auto-enclosed). Ship Scheherazade New 4.500 (OFL) as the open fallback with `text_uthmani` plus U+06DD.
- Surah headers: for a print-like frame plus name, use QCF_SurahHeader_COLOR woff2 (118 KB, one glyph per surah; map in `qul_ligatures_surah_header_QCF_SurahHeader_COLOR.json`). For compact lists and the command palette, use the quran.com `sura_names.woff2` (88 KB), whose liga turns '001'…'114' into names and 'surah' into the word سورة. Use a themable currentColor SVG for the Bismillah, similar to quran.com's /bismillah.svg, or draw it from the bundled Hafs font.
- UI fonts: use `@fontsource-variable/inter@5.3.0` for Latin and `@fontsource-variable/noto-naskh-arabic@5.3.0` or `@fontsource/ibm-plex-sans-arabic@5.3.0` for Arabic UI text; Readex Pro is an alternative for a modern geometric look. Import only the subsets you need (the latin, arabic and opsz CSS files) and pin exact versions in pnpm.
- Licensing: register a Quran Foundation Developer Console account and credit Quran Foundation in the app, which the terms make a condition of bundling or caching QCF fonts. Keep QCF fonts out of any separately downloadable asset pack that other apps could consume. Have someone review the surah-name font licenses, since those font files carry no license statement.
- Build a small Rust `fonts` module that sniffs each downloaded font's COLR version and records its size and SHA-256 in SQLite. It can also expose a 'repair' action that re-downloads mismatched files.

## Risks
- Licensing: the QCF page fonts, QCF_SurahHeader and V4 surah names are 'King Fahad Complex, All rights reserved'. QF terms allow bundling or caching only inside the app, with an active QF Developer Console account and attribution. The surah-name fonts (sura_names, surah-name-v2/v4) have no license statement in their name tables. Get explicit permission or legal review before shipping them in the installer, rather than downloading on demand.
- KFGQPC Hafs EULA forbids 'Modified, Altered'. Converting the TTF to woff2 or subsetting it may count as modification, so ship the original TTF unchanged.
- The V30 ayah-number change is breaking: bare digits are no longer enclosed. If you swap V22 for V30 without converting the text to U+06DD + digits, the numbers render as plain digits. With V22, adding U+06DD gives a double marker.
- WebKitGTK (Linux) support for COLRv0 and font-palette was not verified. If it fails, V4 renders monochrome or wrong, so fall back to V2 based on a runtime canvas test (draw one V4 glyph with palette 0 and check that the pixels have colour).
- The folder name 'colrv1' is misleading. Upstream may later replace the contents with real COLRv1 files, which WKWebView cannot render. Record the COLR version per downloaded file and cache the files locally; don't hotlink.
- quran.com's own CDN (quran.com/fonts) sends no Access-Control-Allow-Origin header. Fetching it from webview JS would be blocked, so do downloads in Rust.
- Font vertical metrics differ between pages and versions (for example V2 p1 hhea 2809/-1301 against 3000/-1500 on other pages; V4 3940/-2520). Lines will jump unless line boxes are fixed-height.
- V1 natural line widths vary from 12 to 17 em, and quran.com's fixed width (about 14.9 em at scale 3) can overflow. Compute the width from the widest line on each page for V1.
- Only 16 pages were compared, all with identical line layout for V1 and V2 (mushaf ids 2 and 1). Undetected per-page layout differences between the 1405H and 1421H prints are possible, so store line layout per Mushaf version in the core DB.
- Chromium does not support OT-SVG, so the ot-svg V4 files and QCF_FullSurah_HD_COLOR (SVG table) would show as monochrome or blank on Windows. Avoid them.
- The api.quran.com v4 endpoints worked without authentication on 2026-10-10. They fall under the Quran Foundation terms (1-week cache limit for non-font content and a Content Sync requirement), which affects how the core DB text is sourced. That is outside the scope of this font research but relevant.
