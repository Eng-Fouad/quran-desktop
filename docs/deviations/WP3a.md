# WP3a deviations (qdc build pipeline, M1)

## Delivered

- **M1:** `src-tauri/resources/core.db` is a real qdc build (12.5 MB, schema 1, normalizer 1). To rebuild it, run
  `pnpm core:qdc` (`cargo xtask build-core --source qdc`). With a warm cache a debug build takes 1.2–3.5 s: cache check
  ≤ 1.0 s, parse ≤ 0.9 s, derive ≤ 0.7 s, write ≤ 0.8 s. A cold cache (1,812 requests at 4 at a time) adds about
  90 s. Two builds with the same `SOURCE_DATE_EPOCH` are
  byte-identical.
- **Code:** `xtask/src/build/{mod, model, qdc, tanzil, derive, write}.rs`.
- **Data:** `xtask/data/division_exceptions.toml` (the one D6 entry) and `xtask/data/qcf_surah_header_cmap.json`.
  The map is copied verbatim from the research evidence; only CRLF was changed to LF.
- **Tests:** `xtask/tests/build_pipeline.rs` and `xtask/tests/build_qdc.rs`.
  - `build_pipeline.rs` needs no network and no cache. It covers:
    - the cache against a local HTTP server: fetch, User-Agent, reuse, 7-day expiry, refetch of files in an old request
      shape, retries on 503, no retry on 404, rejection of invalid responses, `--offline`;
    - the deterministic writer and the schema checks.
  - `build_qdc.rs` runs the binary twice on the real cache and requires identical sha256. It then checks the database
    against an independent restatement of G1–G16 and the facts below.
    - It skips (and passes) when the gitignored cache is missing or stale.
  - `xtask` is a binary crate, so the tests compile the pipeline modules by `#[path]`. The modules refer to each other
    only through `super::`. Their unit tests also run in the bin (`cargo test -p xtask --bin xtask build::`).

Every build prints a report. Excerpt of the current one:

```
divisions: juz/hizb/manzil: Tanzil, 6236 ayahs cross-checked against the source, 0 differences
divisions: rub: the mushaf source, 1 start(s) differ from Tanzil, all allowlisted (rub 106: 15:49 / 15:50)
source fix: end marker(s) labelled as words in the source, relabelled: 2:181:14
glyph codes: 4580 V1 / 4517 V2 multi-char words (FACT C5: 4,580 / 4,517); 198 / 198 contain U+0020
text_hafs spaces: 9 before ۩ (…), 199 after ۞, 4 between letters (2:181:3 8:6:4 13:37:8 37:130:3)
inline rub sign: 199 rub start(s) open with "۞ " (kept as printed; all at rub starts)
layout v2: 8820 ayah lines (29 centred), 114 surah_name, 112 basmallah; surah_name on the previous page for 18 surahs
layout v1: … 21 surahs …; page starts equal Tanzil's on 604/604 pages
layout v4: … 0 surahs
wrote core.db.tmp (12228 KiB, 6236 FTS rows, 14615 vocab_loose terms)
```

## Deviations from ARCHITECTURE.md

### 1. Search seed is QDC word-level `text_imlaei`, not `text_imlaei_simple` (§4.2, §3.1.1, C13)

**What the spec's field breaks.** QDC's `text_imlaei_simple` writes the dagger alef as a full alef and pre-folds
hamza seats. Examples: `الرحمان`, `ذالك`, `هاذا`, `اولائك`, `ولاكن`, `الاه`, `يومنون`. `normalize_ar` keeps these
spellings, so the everyday spellings a user types never matched:

- `الرحمن` had **0 FTS hits** for 1:1 and 1:3, so G12 failed.
- In surahs 1–2 alone, 94 of 6,169 tokens differed from the Imla'i text the research FTS experiments used:
  - 18 × `ذالك`/`ذلك`;
  - 18 × `اولايك`/`اوليك`;
  - 15 × `ولاكن`/`ولكن`;
  - and others.
- Exact (Strict) mode could not match `يؤمنون`, because the hamza seat is already folded in the source.

**The fix.** QDC also serves the diacritised word-level `text_imlaei` (= QUL script 54). `normalize_ar` folds it to
exactly the expected forms:

| Query | Hits | Includes |
|---|---|---|
| `الرحمن` | 45 | 1:1, 1:3 |
| `ذلك` | 270 | |
| `هذا` | 182 | |
| `اوليك` | 130 | |
| strict `يؤمنون` | 84 | 2:3 |
| strict `الصلاة` | | 2:3 |

`vocab_loose` has 14,615 terms (G12 range: 14,000–15,500). The changes:

- `word_fields` = `code_v1,code_v2,text_qpc_hafs,text_imlaei,location`.
- `word.text_imlaei` is the diacritised Imla'i. It may contain waqf marks after a space, e.g. `رَيْبَ ۛ`; 4,936 words
  contain a space.
- `norm_*` are `normalize_ar` of it, so G13 holds.

**The cache.** The LEAD item 8 prefetch was **refetched once** with the new `word_fields` (1,812 requests, 90 s, same
paths). The cache check now parses every cached file. A file in an old request shape is refetched online and is an
error with `--offline`, so a stale-shaped cache can never feed the build. Reverting this deviation means one constant
(`qdc::WORD_FIELDS`) plus one serde field, and the cache then refreshes itself.

**Requests:**
- **Lead:** fold this into §4.2, §3.1.1 (`text_imlaei` comment) and C13. Choose QUL **54** (Imla'i), not 60.
- **WP3d:** read QUL script 54 for `text_imlaei`.
- **WP1b:** `word.text_imlaei` now carries harakat and waqf marks. Always normalise it; never display it raw.

### 2. C15 header lines can cross a page (FACT C15, §4.4 rule 1, G8)

In V2 and V1 the `surah_name` of some surahs is the **last line of the previous page**, and their basmallah opens the
page of the first ayah. Example: An-Nisa, V2 76:15 `surah_name` (surah 4) / 77:1 `basmallah` / 77:2 = 4:1.

| Layout | Surahs |
|---|---|
| V2 | 4, 10, 22, 23, 24, 26, 27, 32, 33, 37, 38, 45, 47, 53, 60, 64, 65, 80 |
| V1 | the V2 list + 82, 86, 91 |
| V4 | none |

The QDC data is unambiguous: 226 empty slots per layout, which are exactly these header lines. FACT C15 ("no header is
ever orphaned") was measured on the legacy API, whose own count (224) was already inconsistent.

**Rule implemented.** The header slots are the line(s) immediately before the surah's first ayah line *in reading
order*:
- The slot right before the first ayah line must be on the same page. It is the basmallah, or the lone `surah_name` of
  surahs 1 and 9.
- Only the `surah_name` of a two-line header may fall on the previous page's last line.
- Any other empty line fails the build.

**Requests:**
- **WP3b:** G8 must accept this. The `surah_name` may be the previous page's line 15; the basmallah is always on the
  first ayah's page.
- **WP1a:** a page can end with the `surah_name` line of the *next* surah, e.g. V2 p76 line 15 = surah 4. That surah
  has no ayah on that page, so `page.first/last_ayah_id` do not include it. `PageInfo` and the surah running head
  must not assume every `surah_name` line on a page belongs to an ayah on that page.
- **WP8c:** draw a surah cartouche on the last line of a page (V2 p76:15).
- **Lead:** fix FACT C15 and §4.4 rule 1.

### 3. Source fixes and source facts kept verbatim (G4, G5, G5b)

- **2:181:14 end marker.** QDC labels the end marker of 2:181 (`١٨١`) `char_type_name = "word"` in all three
  mushafs, so the API has 77,430 words and 6,235 ends. derive relabels it narrowly:
  - The ayah has no `end` word, and its last word's text is exactly its own number in Arabic-Indic digits.
  - Anything else fails.
  - The report lists the relabelled locations.
  - G1 then holds: 77,429 + 6,236.
- **U+0020 inside glyph codes (G4 says "no whitespace").** 198 words have `code_v1`/`code_v2` = ۞ glyph + U+0020 + word
  glyph. Example: 2:26:1 V2 = U+FC68 U+0020 U+FC69. The longest code is 4 chars with the space, 3 without. The codes
  are kept **verbatim** (they are what the QCF page fonts and quran.com render). derive allows only single inner
  U+0020 spaces.
  - **Requests to WP3b:** G4 should allow single inner U+0020.
  - **Requests to WP8a/WP8b:** a code may contain a space between two glyphs.
- **Spaces inside non-end `text_hafs` (G5b says "every space is followed by ۩").** There are three kinds:
  - 9 before ۩, exactly the G5b list.
  - 199 after ۞: the rub-start words, e.g. `۞ إِنَّ`.
  - 4 between two letters: 2:181:3, 8:6:4 and 13:37:8 `بَعۡدَ مَا`; 37:130:3 `إِلۡ يَاسِينَ`.

  They are kept verbatim; the build report classifies them.
  - **Requests to WP3b:** G5b should accept the ۞-prefix and the 4 compound words, or report them.
- **The ۞ is inline in the text.** The first word of 199 of the 240 rub starts carries the rub sign:
  - `text_hafs` and `text_imlaei` start with `۞ `.
  - In `code_v1`/`code_v2`, 195 codes are `<۞ glyph> U+0020 <word glyph>`.
  - 4 codes are two glyphs with **no** separator (7:47:1, 15:49:1, 22:38:1, 53:26:1), e.g. 7:47:1 V2 = U+FC81 U+FC82.

  The other 41 rub starts are ayah 1 of a surah, and none carries ۞. No ۞ appears anywhere else. So an inline ۞ is
  present exactly when `ayah.flags & 1` and `ayah ≠ 1`. `normalize_ar` deletes it, since U+06DE is in step 1.
- **Answer to WP1a's request** (strip the leading ۞ code + space and `"۞ "` in qdc.rs/derive.rs): **not done; kept
  verbatim, for the lead to decide.** The reasons:
  - The QCF page fonts reproduce the printed page, where the ۞ stands inline before the quarter's first word.
  - The QPC Hafs text and Tanzil's text carry it the same way.
  - For the 4 codes without a separator, the ۞ glyph cannot be told from the word glyph without the page font. A
    strip could delete the word instead of the sign.
  - Nothing is lost either way: the inline ۞ is fully determined by the flags (rule above).

  **WP8c:** in the margin, draw the label or ornament (§8.9; quran-common U+FC23/U+FC22) for those rub starts, never a
  second U+06DE glyph. Draw the U+06DE margin glyph only for the 41 rub starts at ayah 1. (Superseded in the margin by
  WP8c deviation 9, owner request 2026-10-13: every rub start draws its marker, inline ۞ or not.) **WP1a:** copy text
  contains the ۞, as printed. If the lead prefers stripping, it is one rule in `derive.rs`, using the ayah flags plus
  the separator. The 4 unseparated codes then need the page fonts to decide.

### 4. Smaller decisions

1. **`meta.source_manifest_sha256` (qdc):** the sha256 of the text `"<sha256>  <path>\n"`, built from these lines in
   order:
   - one line for `qdc/chapters.json`;
   - one line per page file, in (mushaf 1, 2, 19; page) order.

   Tanzil is hashed separately into `tanzil_sha256`.
2. **`mushaf.name`:** "Madani Mushaf 1421H (QCF V2)", "Madani Mushaf 1405H (QCF V1)" and "Madani Mushaf 1441H tajweed
   (QCF V4)". `pages` and `lines_per_page` are derived from the rows (604, 15).
3. **`licence_note`:** "DEVELOPMENT BUILD, NEVER DISTRIBUTE … QF Developer Terms …", followed by the Tanzil CC BY 3.0
   attribution.
4. **`--offline` and expired files:** with `--offline`, a QDC file older than 7 days is an error (QF terms), not a
   warning. Tanzil (CC BY) never expires.
5. **Extra hard checks in derive:**
   - the source rub lies inside the Tanzil hizb, and the hizb inside the juz;
   - every ruku ends in its own surah;
   - the 3 mushafs agree on every word field and verse division;
   - each listed V2 centred line exists and is an ayah line;
   - pages 1–2 are exactly lines 1..8;
   - the D5 regrouping (§4.3) is applied in shared derive for any source, so WP3d need not repeat it.

   All of these hold on the current data.
6. **`ayah.flags` for ayah 1 (1:1):** it counts as a rub, hizb and juz change (flags = 15), as §3.1.2 implies.
7. **SQLite 3.53 plan details:** `EXPLAIN QUERY PLAN` details for the §3.1.4 page query end with ` LEFT-JOIN` for `w`
   and `a`, e.g. `SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?) LEFT-JOIN`. G15 and WP1a's plan test must
   compare by prefix. There is no other step: no temp B-tree.

## Handoff and requests

- **WP3b (`verify-core`):** `crate::build::{tanzil, derive, model}` are public within the crate. Reuse them for the
  gates:
  - `tanzil::Tanzil::load(path)` (validated; `page_starts` are the V1 starts of G10; `hizb_starts()`; `ayah_id()`);
  - `derive::DivisionExceptions::load(xtask/data/division_exceptions.toml)`;
  - `derive::HeaderMap::load`;
  - `derive::{V2_CENTRED_LINES, arabic_indic, END_OF_AYAH, SAJDA_SIGN, RUB_SIGN, FLAG_*}`;
  - `build::data_dir()`.

  The Tanzil file of a qdc build is `<cache>/tanzil/quran-data.xml`; its sha256 is in `meta.tanzil_sha256`.
  `build_qdc.rs` already restates G1–G16 against the real database, with the adjustments in sections 2 and 3, and can
  serve as a reference. `build-core` calls `crate::verify::verify_db(&tmp, None)` before the rename, so your gates
  decide whether M1 is replaced.
- **WP3d (`qul.rs`):**
  - Implement `pub fn load(qul_dir: &Path) -> anyhow::Result<(SourceQuran, PathBuf /* Tanzil xml */)>`.
  - **Lead:** replace the `Source::Qul => bail!(…)` arm in `build/mod.rs::run` with
    `qul::load(&root.join("data/sources/qul"))?`. That is one line, which WP3d may make with the lead's approval; the
    shared pipeline (`build()`) needs no other change.
  - Model contract (`model.rs`):
    - Give every line, header lines included, with `kind`, `centered` and `surah: Some(surah_number)`. Header lines
      have `words` empty. derive checks that they match C15 (section 2).
    - End markers: `WordKind::End`, `text_hafs` = digits with or without U+06DD.
    - `text_imlaei` from script 54 (section 1).
    - `SourceDivisions { juz, hizb, manzil: Option, rub }`, with rub from metadata 67.
    - `SourceInfo { source: "qul", manifest_sha256: sha256 of manifest.toml, licence_note }`.
- **WP1a:** the M1 core.db is in place. Note section 2 (cross-page headers) and section 4, item 7 (plan suffix).
- **Everyone:** rebuild with `pnpm core:qdc`. The cache refreshes itself after 7 days (network). `--offline` never
  touches the network.
