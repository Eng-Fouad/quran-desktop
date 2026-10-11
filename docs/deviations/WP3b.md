# WP3b deviations (verify-core gates)

## Delivered

- **`xtask/src/verify.rs`:** 18 gates (G1–G16 plus G5b and G11b), the console summary and the `--report` JSON.
  - `build-core` calls `verify_db(&tmp, None)` before the rename, so a database that fails a gate never replaces
    core.db.
  - `verify_db_with(db, report, tanzil)` also accepts the Tanzil file the build used (see Requests).
- **Result on the M1 qdc core.db:** 18/18 gates and 139 checks pass, with 0 warnings, in 1.5–2.0 s (debug xtask).
  - G15: 2,416 page queries, p99 0.27–0.6 ms.
  - Command: `cargo xtask verify-core --report target/verify-core.json`.
- **Tests:**
  - `xtask/tests/verify_unit.rs`: compiles `verify.rs` by `#[path]`, like `build_*.rs`, and runs its 13 unit tests.
    They need no real data:
    - C15 geometry on synthetic lines;
    - the rub allowlist judge (an exact match, a mismatch, an unlisted difference, a stale entry);
    - space and glyph-code classification;
    - Tanzil lookup by sha256 and the QUL manifest;
    - the G15 plan on a tiny core.sql database;
    - every gate failing cleanly on a 1-ayah database and on an empty file.
  - `xtask/tests/verify_core.rs`: the real core.db passes all 18 gates, the report has its documented shape, and the
    facts below hold.
    - **21 corruption tests.** Each copies core.db, applies one SQL change and requires that exactly the owning
      gate(s) fail (G15 aside, since it measures time), with a failed check that names the damage.
    - **2 CLI tests:** a missing file is an error; the 0-byte `build.rs` placeholder fails 18/18 and still writes the
      report.
    - **Skipping.** Real-data tests print `SKIPPED` and pass when core.db or Tanzil is absent (CI), as `build_qdc.rs`
      does.

### How the gates work

- **Read-only.** The database is opened `SQLITE_OPEN_READ_ONLY` and read once into a snapshot of every table except
  the FTS index. Most gates are pure functions of the snapshot; G12, G14 and G15 also query SQLite.
- **Every gate runs**, even after another one fails. Each gate records named checks, facts and warnings. The run fails
  if any check fails, and the report is written either way.
- **Expected values are restated in `verify.rs`**, independently of the build's constants:
  - counts;
  - the V2 centred lines;
  - the 25 V1/V2 page-start differences;
  - the obligatory sajdas;
  - the header code points;
  - the plan.

  The inputs it reuses are the validated parsers: `Tanzil`, `DivisionExceptions` and `HeaderMap`.
- **Tanzil lookup.** Tanzil `quran-data.xml` is found by **sha256 = `meta.tanzil_sha256`** in these places, in order:
  1. `data/cache/tanzil/`;
  2. the file that `data/sources/qul/manifest.toml` names (a plain file name only);
  3. `data/sources/qul/quran-data.xml`;
  4. `data/sources/tanzil/quran-data.xml`.

  If no file is found, G1, G10 and G11 fail with the paths and hashes it tried.

### Report shape (`--report`)

```
{ tool, spec, db, bytes, sha256, meta{…}, inputs{ tanzil, divisionExceptions, headerMap: {path, value, error} },
  passed, summary{ gates, passed, failed[ids], checks, failedChecks, warnings }, durationMs,
  gates[{ id, title, invariant, passed, durationMs, error, checks[{name, passed, detail}], warnings[], facts{…} }] }
```

A failing check's `detail` gives the count and up to 8 examples.

Facts reported on the qdc build:

| Gate | Facts |
|---|---|
| G4 | 4,580 / 4,517 multi-char codes; 198 / 198 codes with U+0020 |
| G5b | 9 "space + ۩" words; 199 rub-sign words; 4 compound words |
| G8 | surah_name on the previous page: V2 18 surahs, V1 21, V4 0 |
| G9 | 16 / 6 / 14 centred ayah lines |
| G10 | 604/604 Tanzil matches; the 25 differing pages |
| G11 | the rub 106 difference; 199 inline ۞ |
| G11b | the 15 sajda words |
| G12 | hit counts: الرحمن 45, العالمين 61, الصلاه 55, الرح* 79, strict الصلاة 55; vocabulary 14,615 |
| G15 | the plan; p50, p99 and max per style |

## Deviations from ARCHITECTURE.md §4.5

1. **G4 accepts one inner U+0020 in a glyph code, in two cases only.**
   - The case: no leading, trailing or double space, and no other whitespace or control char.
   - Case (a): the word opens with the printed rub sign `"۞ "` (195 codes per column).
   - Case (b): the word is one of three listed words, 8:6:4, 36:52:6 and 37:130:3 (3 codes per column).
   - This corrects WP3a's note. Of the 198 spaced codes per column, 195 are rub-sign words. The other 3 keep the
     printed space between two glyph groups: `بَعۡدَ مَا`, `مَّرۡقَدِنَاۜۗ` and `إِلۡ يَاسِينَ`.
   - Any other whitespace fails.
   - Multi-char counts are reported, with a warning when they differ from FACT C5. D5 is hard.
2. **G5b classifies every U+0020 inside a non-end `text_hafs`.** Three kinds pass:
   - a space before ۩ (9 words, the §4.5 list; any other list is a warning, not a failure);
   - the `"۞ "` prefix (199 words);
   - the single space that joins one of the listed compound words: 2:181:3, 8:6:4, 13:37:8 (`بَعۡدَ مَا`) and
     37:130:3 (`إِلۡ يَاسِينَ`).

   Any other space fails. So "words with a space ⊆ words with ۩" becomes "⊆ ۩ words ∪ rub-sign words ∪ listed
   compounds".

   The lists in G4 and G5b say which words *may* carry a space; listing them does not *require* one. A QUL source
   without these spaces passes. A source with a new one fails and names the word for a human decision.
3. **G8 applies C15 in reading order.** The basmallah (or the lone surah_name of surahs 1 and 9) must sit directly
   above the first ayah line, on the same page. The surah_name of a two-line header may instead be the **last line of
   the previous page**, as WP3a deviation 2 documents (V2 18 surahs, V1 21, V4 none, listed in the report). Any other
   cross-page header fails. G8 also checks `surah.bismillah_pre = (id ∉ {1, 9})`.
4. **G9, V1 and V4 on a qdc build:** the §4.2 approximation is checked exactly, not only reported. Past pages 1–2, the
   centred ayah lines are exactly the lines whose word range equals a centred V2 line. On a qul build they are "as
   provided", with a count.
5. **G14** reads "< 16 MB" as < 16 MiB (16,777,216 B), as `build_qdc.rs` does. It adds these hard checks:
   - `page_size = 4096`;
   - the schema equals `quran_core::CORE_SQL`, compared object by object against a fresh in-memory database; ANALYZE's
     `sqlite_stat*` tables are ignored;
   - `meta` has exactly the 10 §3.1.1 keys;
   - `schema_version = CORE_SCHEMA_VERSION`;
   - `source` is qdc or qul;
   - `built_at` is RFC 3339 UTC;
   - the two sha256 fields are 64 lowercase hex characters;
   - `licence_note` is set.

   These are warnings only:
   - free pages (the VACUUM was skipped);
   - no `sqlite_stat1` (the ANALYZE was skipped);
   - a qdc licence note without "NEVER DISTRIBUTE".
6. **G15** checks the plan of `quran_core::core_db::PAGE_SQL`, the exact statement the app runs, for each of the 3
   layouts.
   - The plan must equal the three §3.1.4 steps, in order and with nothing else, after SQLite 3.53's ` LEFT-JOIN`
     suffix is removed.
   - Timing covers **4 × 604** queries, one per style (hafs shares the v2 layout with qcf_v2), not 3 × 604.
   - Every page is warmed once and then timed while every column is read, as `CoreDb` does.
   - p99 < 5 ms is required per style and overall.
   - Each query must also return one row per header line and one per word of the page.
7. **Extra hard checks in the other gates:**

   | Gate | Extra checks |
   |---|---|
   | G2 | every ayah has a word before its marker |
   | G3 | `word.ayah_id` names the ayah of the word's (surah, ayah) |
   | G5 | `ayah.text_hafs` = word texts joined by U+0020; no stray whitespace in word texts |
   | G11 | per-ayah division columns match their range tables; rub ⊂ hizb ⊂ juz; every ruku stays inside its surah; `surah.rukus`, `name_en` and sajda kinds equal Tanzil's; `ayah.sajda` is correct; `ayah.flags` follows §3.1.2 (no other bit set); the inline ۞ appears only as the `"۞ "` prefix of a rub-start ayah's first word |
   | G12 | `vocab_loose` equals the index vocabulary (fts5vocab `col`); the index holds exactly the `norm_loose`/`norm_strict` tokens of every ayah, in order (fts5vocab `instance`) |
   | G13 | `word.norm_loose`; NULL Imla'i text on markers; `ayah.text_imlaei` is its words joined |
   | G16 | every `header_cp` equals the map; with the map absent, all are NULL plus a warning |

## Requests

- **WP3a (`build/mod.rs`):**
  - **Change.** In `build()`, call `crate::verify::verify_db_with(&tmp, None, Some(tanzil_path))` instead of
    `verify_db(&tmp, None)`.
  - **Why.** Today the lookup finds `data/cache/tanzil/quran-data.xml` by sha256, so every default build is verified.
    A build with a custom `--cache` and no copy of Tanzil under `data/` would fail G1, G10 and G11 with
    "no Tanzil quran-data.xml with sha256 …".
  - **Scope.** The change is one line.
- **Lead:**
  - fold deviations 1–3 into §4.5 (G4, G5b, G8), together with WP3a's C15 correction;
  - note the 195 + 3 split of the 198 spaced codes;
  - note "16 MiB" in G14 and "4 styles × 604" in G15.
- **WP3d (qul):**
  - **G4 and G5b.** If the QUL scripts carry spaces in other words, G4 or G5b fail and name them. Send the list to
    WP3b or the lead to extend `CODE_SPACE_WORDS`/`COMPOUND_WORDS` after a human check.
  - **G9.** On a qul build, V1/V4 centring is "as provided" (reported).
- **WP-CI / WP13b:** `verify-core` needs a built core.db and the Tanzil file. CI has neither (QF content), so run it
  where the release qul build happens; the build itself always runs it.
