# WP1b deviations (SearchEngine, search commands, search fixtures)

Status: complete. Owned paths: `crates/quran-core/src/search/{mod,query,typo,highlight}.rs`,
`crates/quran-core/tests/search_{quran,packs,notes,core}.rs`, `src-tauri/src/commands/search.rs`,
`xtask/src/fixtures/search.rs`. No §2.2.5 signature changed and no `///` doc was added to a command, so `bindings.ts` is
unaffected. `lib.rs` (frozen) is untouched; the additions below are reached through `quran_core::search::…`.

## Deviations from ARCHITECTURE.md

1. **Additive public items** in `quran_core::search`: `MAX_LIMIT` (2000), `MAX_QUERY_CHARS` (2000), `MAX_QUERY_TOKENS`
   (200), `MAX_SUGGEST_LIMIT` (100), `MIN_FTS_QUERY_CHARS` (3), `Column::{name, level}`, `impl Debug for SearchEngine`.
   `SearchEngine` keeps `new(core)`; it also holds a private `Arc` cache shared by clones: the search geometry (surah and
   juz ayah ranges, first word per ayah, page starts per layout, read once from `CoreDb::index`) and the typo
   vocabulary (read on the first typo fallback). A failed load is not cached.
2. **Query parsing** (§2.2.5 step 1, decisions where the spec is silent):
   - Phrase delimiters are `"` and the typographic `“ ” „ « »` (Arabic keyboards type guillemets).
   - An unterminated quote is a phrase still being typed: in smart mode its last token is a prefix (`"يا اي"*`). A
     closed quoted term is matched as written (a quoted single word is an exact word, never a prefix).
   - After folding, tokens are split where FTS5's `unicode61` splits (every character that is not a letter, number or
     private-use), so the FTS expression, word matching and snippet marks agree (`الله♥رب` → `الله`, `رب`).
   - A query over 2000 characters or 200 tokens is `InvalidArgument`. A query that folds to nothing is answered with an
     empty result **before any IO** (also on an unavailable core); `limit` (1..=2000) and the query length are checked
     first, the surah/juz filters are validated against the index only when there is something to search.
3. **FTS5 rendering.** Terms are joined by spaces (implicit AND) as specified. Once a typo group has alternatives the
   groups are joined by an explicit `AND`: FTS5's implicit AND only joins phrases, and `("a" OR "b") "c"` is a syntax
   error (found on the real core.db with `الحمد لله العلمين`). A unit test runs every rendered shape on an in-memory
   FTS5 table.
4. **Typo fallback** (§2.2.5 step 5) refinements:
   - Only bare tokens that are **not** vocabulary terms (for the last token in smart mode: not the start of one) are
     expanded; a correct word next to a typo stays as typed, so suggestions name only real fixes.
   - Only the **nearest distance tier** is kept (then `doc_count` desc, then term, at most 8). With all 8 terms within 2
     edits OR-ed, `الرحمان` pulled in `الايمان`, `للرحمن`, `الراحمين`, `الرحمه`, `بالرحمن`, `والرمان`, `الاحسان`
     (measured on the qdc core.db); with the nearest tier it is exactly `الرحمن`.
   - `suggestions` lists the replacement terms, nearest first, and only when the fallback found hits; `normalized`
     stays the typed query. A token shorter than 3 characters anywhere in the query (phrases included) disables the
     fallback, as specified (`… رب العلمين` is not corrected because of `رب`).
5. **`SearchGroup.count`** is the number of matches in that surah within the filters, also when the hit list was cut at
   `limit`: only the last group can be partial, and its count comes from one more `count(*)` with the same predicate
   restricted to that surah. Groups exist only for surahs with returned hits (so `Σ count ≤ total`). `total` is a
   `count(*)` with the same predicate (step 4); the quran path runs it first and skips the hit query when it is 0.
6. **Hit fields outside the quran scope:** translation and note hits carry `first_word_id` = the ayah's first word (useful
   for jumping) and empty `words`/`matched_word_ids`.
7. **Notes** (step 8): only live notes (`deleted_at IS NULL`; tombstones stay in `note_fts` until purged). A note
   overlapping the filter range is a hit at its **first ayah inside the range** (`max(from_ayah_id, range start)`), so a
   note on 1:5–2:2 searched with "surah 2" is grouped under Al-Baqarah at 2:1. Order: `from_ayah_id, to_ayah_id, rid`.
   The query is folded like `body_search` (`fold_latin(normalize_ar(…, Loose))`, identical to WP2a's
   `note_body_search`); substring mode is `LIKE` on `body_search`.
8. **Pack scope** (step 7):
   - Query folding per tokenizer: `arabic_normalized` → `normalize_ar(Loose)`; `like_fallback` → `fold_latin`;
     `porter_unicode61` / `unicode61_remove_diacritics` → **no folding in Rust** (whitespace only; the FTS5 tokenizer
     folds case and diacritics). This answers WP0B's request: `fold_latin` drops the Mn viramas/nuktas that `unicode61`
     treats as separators, so a folded Devanagari query would not match.
   - `LIKE` (via `PackDb::like_search_in`/`like_count`) serves substring mode, `like_fallback` packs and queries whose
     folded form has fewer than 3 characters. The needle is the folded query with quote marks removed; for packs whose
     `fold` is `plain`, `LIKE` is case-insensitive for ASCII only (SQLite).
   - Exact mode on a pack is "no prefix" (a pack has a single `fold` column).
   - `search_pack` requires the request's (trimmed) pack id to equal the pack's `meta.pack_id`, and a translation scope.
9. **Snippets** (HTML: escaped `& < > " '`, whitespace collapsed, only `<mark>`):
   - `fold = plain` packs: FTS5 `snippet()` with U+E000/U+E001 turned into marks; unbalanced or empty delimiters are
     dropped, so the markup is always balanced.
   - Otherwise (Arabic-script packs, `LIKE` hits, notes): built in Rust from the display text. The text is folded per
     segment (a character with its combining marks), every folded byte remembering its source bytes, so a match found in
     folded text marks the original vocalised word (`اللہ`, `الرَّحْمَٰنِ`), never the punctuation glued to it. Window:
     ±12 words around the first match; text without spaces (CJK, Thai) is cut by characters (320 at most, 120 before
     the match), each cut moved to a gap between words when one is within 24 characters; `…` marks cuts. A hit whose
     match cannot be placed gets the start of the text.
   - Notes: the body's Markdown subset is reduced to text first (headings, quotes, bullets, task boxes,
     emphasis/code/strike markers, link targets); the title is used when only the title matches.
10. **Word mapping in substring mode:** every word that overlaps an occurrence of the needle in the words' joined loose
    text (the ayah's `norm_loose`), so a needle may span words (`رحمن الرح` marks الرحمن and الرحيم in 1:1).
11. **`suggest`:** completes the last token of the normalised prefix; empty when the prefix is empty or ends with
    whitespace, punctuation or a quote mark (nothing is being typed); `limit` 1..=100 else `InvalidArgument`; ties
    ordered by term.
12. **Commands:** `search_query` dispatches by scope inside `blocking()`; a blank translation pack id is
    `InvalidArgument` before the pack manager is asked; the pack id is trimmed. The bodies live in `query`/`suggest`
    (no tauri state) for tests.
13. **Fixtures (`export-fixtures --only search`):**
    - `search/vocab.json` = `Vec<SearchSuggestion>` (the `search_suggest` DTO), the 2,000 most frequent terms, ties by
      term. `search/ayahs.json` = `[[id, normLoose], …]` for all 6,236 ayahs.
    - `search/results/{slug}.json` = `search_quran`/`search_pack` output for smart mode, limit 500, layout v2, no
      filters; `manifest.queries` records `{ slug, request }` (the frozen `Manifest`). `tookMs` is the real measurement.
    - Translation queries run on the first `tr.en.*` translation pack under `--packs` (`tr.en.saheeh` preferred), else
      on WP1c's synthetic `tr.en.saheeh` written through `PackDbWriter` (a note is printed when `--packs` has no English
      pack). A fixture query with no hits fails the export (it would mean a placeholder core.db).
    - The `search/` directory is recreated on every run. The exporter's tests include WP1a's `mini_core.rs` a second
      time (`fixtures::mushaf` includes it privately), under `#[allow(clippy::duplicate_mod)]`.

## Measurements (qdc core.db, this machine, while other packages were building)

`tests/search_core.rs::budgets_of_section_3_5`: p99 over 60 runs after one warm-up. The test asserts the §3.5 budgets
(×4 in debug, where quran-core is unoptimised and SQLite optimised).

| Query | Hits | p99 release | p99 debug | Budget (release) |
|---|---|---|---|---|
| smart `الله` (500 returned, word mapping) | 1,573 | 8.2 ms | 18.5 ms | 25 ms |
| smart `من` (500 returned) | 2,328 | 6.9 ms | 24.0 ms | 25 ms |
| smart `ال` (500 returned) | 4,694 | 8.7 ms | 15.0 ms | 25 ms |
| smart `الذين امنوا` | 203 | 2.5 ms | 6.0 ms | 25 ms |
| smart `الرحمن الرحيم` | 6 | 0.07 ms | 0.25 ms | 25 ms |
| typo `الرحمان` → `الرحمن` | 45 | 0.92 ms | 11.6 ms | 60 ms |
| typo `العلمين` → `العالمين` | 61 | 0.95 ms | 16.7 ms | 60 ms |
| substring `رحم` | — | 5.1 ms | 13.4 ms | (25 ms) |
| suggest `ال` (10 terms) | — | 0.13 ms | 0.14 ms | — |

## Requests

- **WP10b (search store and mock handler):** fixture shapes as in item 13; mirror items 2–11 in the mock (empty query →
  empty result, group `count` semantics, typo `suggestions` nearest first — the banner can show `suggestions[0]`,
  empty `words` for translation/notes hits, snippet HTML with `<mark>` only). `search/ayahs.json` plus the TS
  `normalize.ts` give the mock ad-hoc substring search; `search/vocab.json` serves `searchSuggest` by prefix.
- **WP0C / lead (frozen `src/lib/ipc/mock/fixtures.ts`):** `FixtureManifest.queries` is typed `string[]`, but the frozen
  Rust `Manifest` writes `[{ slug, request: SearchRequest }]`. Suggested type: `{ slug: string; request: SearchRequest
  }[]`.
- **WP5e:** `PackManager::translation_db(pack_id)` should answer `PackError::NotFound` for a pack that is not installed
  (WP1a asked the same): `search_query` then reports `not_found`. Until WP5e lands, a translation search returns that
  stub's `Unsupported`.
- **Lead:** fold items 2–11 into §2.2.5 (notably the explicit `AND` of item 3 and the nearest-tier typo rule of item 4).
