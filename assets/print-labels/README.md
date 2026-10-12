# Quran Print Labels

The generator of `public/fonts/QuranPrintLabels.woff2`, the bundled font (CSS family `qd-print-labels`) that draws the
1441H Madinah print's own furniture calligraphy: the running heads «سُورَةُ name» and «الجُزۡءُ …» and the stacked hizb
labels in the margin (owner decision, [LEAD 25](../../docs/deviations/LEAD.md)). **The font is committed**, so a build
never runs this script; run it only to change or verify the font.

| File                     | What it is                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `build_print_labels.py`  | The generator (Python 3, fontTools). Deterministic: the same inputs give the same file, byte for byte. |
| `requirements.txt`       | Its dependencies, pinned (`fonttools==4.66.1`; `brotli==1.2.0` for the WOFF2).                         |
| `pages.txt`              | The 123 printed pages it reads, one page number per line.                                              |
| `print_label_metrics.py` | Prints the numbers-only metrics table of `src/lib/mushaf/printLabels.ts` from the committed font.      |

## What the font holds

| Code points   | Glyphs                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| U+0660–U+0669 | The print's Eastern Arabic digits                                                                                      |
| U+F500–U+F505 | The words رُبُع، نِصۡف، ثَلَاثَةُ أَرۡبَاعِ، الحِزۡبُ، الجُزۡءُ، سُورَةُ, at the size of the margin labels' «الحِزۡبُ» |
| U+F600 + n    | The running head «سُورَةُ name» of surah n (2–114; pages 1–2 carry no running head)                                    |
| U+F700 + j    | The running head «الجُزۡءُ …» of juz j (1–30), its ordinal in words                                                    |
| U+F800 + r    | The stacked margin label of rub r (1–240)                                                                              |

Every glyph keeps the print's scale (40 font units per unit of the source page, UPM 1000). The header glyphs share the
running-head baseline; the margin labels, words and digits share the baseline of their «الحِزۡبُ». No glyph holds
Quranic text. The app's use of it is described in `src/lib/mushaf/printLabels.ts` and ARCHITECTURE §8.9 (v1.2).

## Provenance and licence

- **Source:** the Mushaf Database "Ligature-Based SVG Mushaf", version 1.01
  (<https://github.com/mushafdatabase/MushafDatabase-Ligature-Based-SVG>, folder `SVG V1.01`): one SVG per printed page,
  whose `md-non-quranic-header-surah-name`, `md-non-quranic-header-juz-name` and `md-non-quranic-margin-juz-hisb`
  groups hold the furniture. The outlines are cut, not redrawn. 64 margin labels are the print's own; the other 176,
  on pages not among the inputs, are set from the cut words and digits with the layout measured on the printed labels
  (the generator compares the two on the 64 real ones).
- **Licence:** the dataset's open permission (Sadaqa-e-Jaria): use, copy, modify, publish, distribute and create
  derivative works, commercial use included, without altering the Quranic content. Its text is reproduced verbatim in
  `public/fonts/QuranPrintLabels.LICENSE.txt` and in the font's name table (ID 13).
- **KFGQPC:** the dataset's artwork derives from the printing-use Madinah Mushaf of the King Fahd Glorious Qur'an
  Printing Complex, whose files may be used free of charge in computer programs (<https://dm.qurancomplex.gov.sa/rights/>).
- **Not GPL:** the font is a separate work under those terms, not covered by the repository's GPL, and ships
  unmodified, exactly as the generator writes it.

## Regenerating

You need Python 3.10 or later, the 123 pages and a `core.db` (`pnpm core:qdc` or `pnpm core:qul`). The generator opens
`core.db` read-only, only to know which surahs, juz and rubs each page carries; nothing from it goes into the font.

```sh
# 1. The pages listed in pages.txt, from the dataset's "SVG V1.01" folder, in a directory of their own, named by page
#    number (003.svg or p3.svg); the dataset's LICENSE beside them.
git clone --depth 1 --filter=blob:none --sparse https://github.com/mushafdatabase/MushafDatabase-Ligature-Based-SVG mdb
git -C mdb sparse-checkout set "SVG V1.01"
#    …copy each page of pages.txt from "mdb/SVG V1.01" to pages/ (renamed NNN.svg if needed).

# 2. fontTools in a virtual environment outside the repository.
python3 -m venv /path/to/venv && /path/to/venv/bin/pip install -r assets/print-labels/requirements.txt

# 3. Build into a scratch directory and compare.
/path/to/venv/bin/python -I assets/print-labels/build_print_labels.py --pages pages --license mdb/LICENSE \
  --db src-tauri/resources/core.db --out /path/to/scratch/print-labels
shasum -a 256 /path/to/scratch/print-labels/QuranPrintLabels.woff2 public/fonts/QuranPrintLabels.woff2
```

The generator writes the font twice: `QuranPrintLabels.otf` (CFF OpenType, 1,235,388 B, sha256
`6b86a924466abf981a55130e10b1683b50c6da41c77f6f460af57ff533790cbc`) and the same tables in a WOFF2 container,
`QuranPrintLabels.woff2` (111,228 B, sha256 `67062851e94137deb06a6adfa893e72842565e018993f21eeaa9c900d0991ab7`). Only
the WOFF2 is committed and shipped: every webview reads it, it is a tenth of the OTF in `dist/`, and inside the app
binary (tauri embeds `dist/` Brotli-compressed, once per architecture of the universal macOS app) it is 16 KB smaller
than the OTF. Both were built on 2026-10-11 from these 123 pages and a development (qdc) `core.db`; any `core.db` whose
mushaf-1 page ranges and rub flags agree gives the same files. Besides the font, the generator writes `map.json` (every
glyph's code point, advance, ink box and source), `report.json` (its checks and measurements) and `qa-*.html` sheets
that set every glyph beside `core.db`'s names. **Those stay in the scratch directory and are never committed:** they
carry surah names and ayah references read from `core.db`, which is development data (QF terms, BRIEF §4).

After a change, copy the WOFF2 to `public/fonts/`, update both files' sizes and sha256 here and in its LICENSE.txt,
regenerate the metrics table (`/path/to/venv/bin/python -I assets/print-labels/print_label_metrics.py public/fonts/QuranPrintLabels.woff2`, pasted over
`PRINT_METRICS`), and look at the furniture in both engines (`src/components/mushaf/furniture.browser.test.ts`).
