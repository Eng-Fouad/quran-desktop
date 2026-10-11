# WP5a deviations (Catalog)

Owned and delivered: `crates/quran-packs/src/catalog.rs`, `crates/quran-packs/tests/catalog_{resource,schema,starter}.rs`,
`src-tauri/resources/{catalog.json, catalog.schema.json}`, `xtask/src/catalog.rs`, `xtask/src/fixtures/packs.rs`.
Curated and verified live on 2026-10-10 (every number below was measured, not copied).

## Deviations from ARCHITECTURE.md

1. **`$schema` key in `catalog.json`.** The model gains `Catalog.schema: Option<String>` (serde `"$schema"`, optional,
   skipped when `None`), and the shipped file starts with `"$schema": "./catalog.schema.json"`, so RustRover/VS Code
   validate the file while it is edited. `catalog-check` requires that exact value; the build.rs placeholder (no
   `$schema`) still parses and equals `Catalog::empty()`.
2. **JSON Schema validator in `quran_packs::catalog::schema`.** `catalog-check` must validate against the committed
   draft 2020-12 schema, but xtask has no `regex` dependency and dependencies are frozen. The validator (≈ 250 lines,
   `pub mod schema` inside `catalog.rs`, no new file) supports exactly the keywords the schema uses and reports any
   other keyword as an error, so the schema can never promise more than is checked. LTO drops it from the app binary.
3. **Validation API** (the spec only names `validate`):
   - `Catalog::issues()` — every structural problem at once (`CatalogIssue { pack_id, message }`);
   - `Catalog::starter_issues()` — what onboarding needs on top (decor, a page-font pack per QCF style with exactly one
     recommended, a default translation for `en` and `ar`, `Settings::default().reciter_id` as the one recommended
     recitation, `wbw.en` recommended);
   - `validate()` = structural only (so other packages' tests can build small synthetic catalogs),
     `validate_release()` = both, `load_validated(path)` = load + `validate()`.
   Rules beyond the §2.5.4 text, all enforced by `issues()` and mirrored in the schema where JSON Schema can express
   them: id shape per kind (`mushaf.{variant}`, `decor[.x]`, `tr.{lang}.{name}` with `lang` = the pack language,
   `tafsir.{lang}.{name}`, `audio.qdc.{reciterId}`, `wbw.{lang}`); install mode and item count per adapter (604 pages,
   114 chapters/surahs, 1 zip, N files); `sizeBytes` > 0 and representable as u32 KiB; static files only at the §6.2
   decor routes, unique across packs, URL extension = file extension, sizes summing to `sizeBytes`, lowercase sha256;
   URL templates https with exactly one `{page}` naming a `.woff2`; text packs need `language` + `direction`, the
   direction must match the language (RTL set: ar, ckb, dv, fa, he, ku, ps, sd, ug, ur, yi) and no pack has a direction
   without a language; QuranEnc tokenizer = the §3.4 table for the pack language; QuranEnc `version` = `source.version`;
   WBW language ∈ Quran.com's 9 gloss languages (others silently serve English); QF-sourced packs (Quran.com tafsir,
   WBW, QDC) need `revalidateDays` 1..=7, every other pack must not have it; every `ar` text contains Arabic letters, no
   padding or control characters; titles unique per (kind, language); at most one `recommended` per (kind, language);
   unique source keys (QuranEnc key, tafsir resource, WBW language, reciter, QCF variant); `requires` known, not self,
   no duplicates, acyclic, and every `mushaf.*` requires `decor`; The Clear Quran / Khattab rejected anywhere (BRIEF §4).
4. **Catalog views for WP5e** (all in `catalog.rs`): `CatalogPack::{info(state, installed_kib, job), summary(state),
   size_kib(), reciter(), font_variant(), is_qf_sourced(), language_subtag()}`, `Catalog::{require, of_kind, infos,
   mushaf_pack(style), wbw_pack(lang), reciter(id), reciter_meta(id), reciters(), default_translation(ui)}`, and the
   helpers `is_valid_pack_id`, `language_direction`, `tokenizer_for_language`. `size_kib` rounds **up**.
5. **Starter set definition** (`Catalog::starter_set(&StarterChoices) -> StarterSet`, `StarterChoices::defaults(catalog,
   ui)`), items in §2.5.4 order with `StarterFetch::{Now, OnDemand, TimingsOnFirstPlay}` and `bytes_now`:
   1. `decor`, Now (every style, hafs included);
   2. the chosen translation: Now for a whole pack; an on-demand Quran.com tafsir chosen there is OnDemand (onboarding
      never bulk-downloads QF content). `None` = no translation. **The UI-language default is the recommended
      translation in that language, else the recommended tafsir in it**: `en` → `tr.en.saheeh`, `ar` →
      `tafsir.ar.muyassar` (§2.5.4 "recommended when the UI is Arabic");
   3. the style's page fonts OnDemand, or Now with "Download all pages" (hafs: none);
   4. `wbw.{ui}` OnDemand when it exists — **none for the Arabic UI** (Quran.com has no Arabic gloss);
   5. the reciter's `audio.qdc.{id}`, TimingsOnFirstPlay, 0 bytes.
   Packs required by a Now item are added as Now (transitively). Exact totals on the shipped catalog: en 851,422 B
   (decor 332,556 + Saheeh 518,866); ar 1,144,830 B (decor + Muyassar 812,274); "Download all pages" adds 97,748,500 B
   (v2), 47,952,076 B (v1) or 50,877,636 B (v4). The TS side (WP12a `packs.starterSet`, WP12c) can derive the same set
   from `PackInfo` alone: style → `mushaf.{v1|v2|v4}`, WBW → `wbw.{ui}`, reciter → `audio.qdc.{id}`, default translation
   = recommended translation, else tafsir, with `language === ui`.
6. **`sizeBytes` semantics.** Files: exact download bytes — QCF = Σ of the 604 woff2 (FACT per-page CSV; the spec's
   "93.2 / 45.7 / 48.5 MB" are MiB), decor files, QuranEnc zip `Content-Length`, recitations = Σ `Content-Length` of the
   114 files (HEAD of all 1,596 files on 2026-10-10; e.g. Afasy 1,680,759,654 B). Content.db packs: measured storage
   estimate from a full fetch on 2026-10-10 — tafsir = Σ HTML bytes + 32 B per stored row; WBW = Σ gloss +
   transliteration bytes + 24 B per word (77,429 words).
7. **Versions.** Upstreams without a version use the curation month `2026.10`. QuranEnc `http_validators` packs use the
   `YYYY.MM` of their nginx ETag mtime (`"<mtime hex>-<size hex>"`): `bengali_zakaria` 2025.03, `russian_rwwad` 2026.03,
   `arabic_moyassar` 2025.03 (`catalog-check --online` recomputes it). `decor.nastaliq` uses its npm package version.
8. **`decor.nastaliq` source.** The Noto release (`notofonts/nastaliq` v4.000, and notofonts.github.io) ships TTF/OTF
   only, no woff2, while the §6.2 route and the integrity rule need a woff2. The catalog uses the Google Fonts build of
   Noto Nastaliq Urdu as packaged by Fontsource, `@fontsource/noto-nastaliq-urdu@5.3.0`
   `files/noto-nastaliq-urdu-arabic-400-normal.woff2` (OFL-1.1; the arabic subset covers every Urdu letter):
   159,368 B, sha256 `fecd45d6…a7d15c`, from two immutable npm CDNs (jsDelivr, unpkg; byte-identical, fastly.jsdelivr
   too). `language: "ur"` (no direction) so the Downloads language filter shows it with Urdu packs.
9. **Recitation packs** carry `language: "ar"` (Quran recitation; no direction) and a `source.style` for all 14
   reciters. Titles disambiguate editions of one reciter: Abdul Basit (Murattal)/(Mujawwad), Al-Husary
   (Murattal)/(Muallim), Al-Minshawi (Murattal)/(with children), Alafasy and Alafasy (streaming edition). Catalog order
   puts the recommended reciter (7) first, so `reciters()[0]` is the default.
10. **Decor mirrors.** `sura-names.woff2` has three byte-identical mirrors (verses.quran.foundation,
    static.qurancdn.com, quran.com). QCF_SurahHeader and quran-common exist only on the QUL CDN (the QF host returns 404
    for both, verified). All three decor files are sha256-pinned.
11. **Extra fixture** `packs/reciters.json` (`Vec<ReciterInfo>` from `Catalog::reciters()`, nothing downloaded) next to
    the specified `packs/list.json`. The packs exporter leaves `manifest.json` alone (its `packs` field is WP1c's).
12. **`catalog-check --online` outcome policy.** Errors: any non-200 after retries, mirrors/hosts that disagree on a
    length, static-file length/sha256/magic mismatch, a missing QuranEnc key for `versionSource: list`, a missing ETag
    for `http_validators`, language/direction disagreeing with QuranEnc or Quran.com, a WBW language that falls back to
    English, a QDC reciter missing from the API, and `wordLevel`/`basmalaInFile` contradicting the probes. Warnings:
    upstream drift the curator should pick up (newer QuranEnc version, changed zip size, an unlisted key that became
    listed, unpinned file) and the reciter-173 basmala finding below. Retries: 3 attempts (0.5 s, 2 s) on connect
    errors, timeouts, 429 and 5xx; `Accept-Encoding: identity` so `Content-Length` is the file's.

## Data findings (handoff)

- **QuranEnc `Last-Modified` is useless**: every zip answers `Last-Modified: Thu, 26 Mar 2000 17:35:45 GMT`. A
  conditional HEAD with `If-Modified-Since` would get 304 forever and never detect an update. **WP5c**
  (`quranenc_sqlite::check_update`) must send `If-None-Match` with the stored ETag and compare ETag + `Content-Length`,
  never rely on `Last-Modified`.
- **QDC reciter 173 (Alafasy, streaming edition)**: in its surah-1 file, 1:1 spans 80–80 ms and the file is 39 s
  (id 7: 46.5 s), i.e. the file starts after the basmala. Playing other surahs' basmala from 1:1 (§2.3.3) gives an
  empty segment for this reciter. **WP4b/WP4d**: fall back (e.g. skip with `basmalaSkipped`-style handling or use
  another edition's basmala); `catalog-check --online` keeps warning about it.
- Probes for all 14 reciters (2026-10-10): every one has word segments (`wordLevel: true`), and 112:1 starts at 0–40 ms
  everywhere (`basmalaInFile: false`, FACT C8), including Dussary (97), whose files are on `quran/…//NNN.mp3`.
  `download.quranicaudio.org` serves byte-identical files for every reciter.
- **Quran.com tafsir 91 (As-Sa'di) has 6,177 rows**: 59 ayahs have no row at all (2:107, 2:109, 2:111, 2:286,
  6:105–107, 12:111, 16:64, 19:81–82, 21:110, 22:18, 26:144, 26:180, 26:183, 29:18, 37:82, 37:96, 37:176, 37:179,
  38:85, 43:14, 44:14, 44:44, 44:46–48, 50:43, 53:12, 54:26, 54:39–40, 55:22, 56:30, 56:48, 56:60–61, 64:15, 69:15,
  74:17, 74:36, 77:4, 77:9, 77:14, 77:37, 77:47, 78:11, 79:10, 79:33, 79:46, 83:19–20, 86:2, 88:18, 89:3, 91:8,
  96:10, 109:4). **WP5d**: chapter completeness must not require 6,236 coverage for this pack; a lookup there is a
  legitimate "no tafsir for this ayah", not a failed chapter.
- Quran.com WBW tr/fa/hi/ta glosses mix in some English (`language_name: "english"`) words upstream; ur/id/bn/en are
  pure.
- QCF page-font mirrors (QF and QUL) return identical lengths for p1 and p604 of v1, v2 and v4.

## Requests

- **WP1c:** `xtask/src/fixtures/content.rs:432` `a % 10 == 0` → `a.is_multiple_of(10)`; it is the only diagnostic
  of `cargo clippy -p xtask --all-targets -- -D warnings` (`clippy::manual_is_multiple_of`).
- **WP5e:** `PackManager::new` can use `Catalog::load_validated(&cfg.catalog_path)` (log `starter_issues()` as
  warnings); `list()`/`summaries()`/`reciters()`/`reciter_meta()` can build on `CatalogPack::{info, summary}` and
  `Catalog::{reciters, reciter_meta}`; `ensure_page_fonts` on `Catalog::mushaf_pack(style)`.
- **WP5c:** static files are sha256-pinned, so a changed upstream file must surface as `Integrity` (then the catalog is
  updated); see the QuranEnc validator note above.
- **WP12a / WP12c:** mirror the starter-set rule of item 5 (the Rust tests pin the totals: en 851,422 B, ar 1,144,830 B).
- **WP0C / WP9a (mock):** `fixtures/packs/reciters.json` carries the real names, styles and `wordLevel`; the mock's
  `recitersFromPacks` currently derives reciters from the synthetic seed.
- **Lead:** fold items 1–12 into §2.5.4 (notably `$schema`, the starter-set API and the Arabic default), and the
  QuranEnc/Sa'di/173 findings into §2.5.6–§2.5.7 and FACT.
