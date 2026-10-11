# WP5c deviations (Fonts, static files and QuranEnc)

Owned and delivered:
- `crates/quran-packs/src/fonts.rs`;
- `crates/quran-packs/src/adapters/{qcf_font_pages, static_files, quranenc_sqlite}.rs`;
- `crates/quran-packs/src/transform/{mod, html, translation}.rs`;
- tests: `crates/quran-packs/tests/{fonts_pages, fonts_decor, fonts_jobs, quranenc_install, quranenc_updates,
  quranenc_real, transform_html, transform_translation}.rs`, plus their helper modules `tests/fonts_support/mod.rs` and
  `tests/quranenc_support/mod.rs` (directories named after the owned prefixes; they are not test targets).

WP5c is Rust-only: it has no i18n dictionary, mock handler or scenario PNG.

## Deviations from ARCHITECTURE.md

1. **QuranEnc exports differ per translation, so the §2.5.6 transform is data-driven.** The 14 real exports behind
   every QuranEnc pack in the catalog (downloaded 2026-10-10) were inspected and built. Rules beyond the spec text:
   - **Number prefix.** Saheeh uses `(n) `, but Hilali-Khan and García use `n. `. Both are stripped, and only when
     `n` is the row's ayah number (digits of any script). Any other leading number is content.
   - **Markup.** Text and footnotes are HTML fragments, not plain text. Zakaria's Bengali has 332 `<b>` pairs and a
     bold heading as the whole of 18:32, and Junagarhi has stray `>`. They go through the ammonia policy.
     Line breaks become `<br>`.
   - **Bracket notes.** A note starts at a line beginning with `[n]` (optionally `[n]-`) after optional leading spaces;
     Rowwad indents every note.
     - It also starts mid-line at ` [n]` when `n` is referenced in the text and not yet defined, because Rowwad puts
       several notes on one line. Without this, 331 Rowwad ayahs lost their notes.
     - Lines without a marker continue the current note, as in Hilali's numbered lists and Zakaria's paragraphs.
   - **Parenthesis notes (Indonesian Affairs).** These exports have no `[n]` anywhere. Notes start with `*n)` or `n)`,
     and the text marks them as `…pembalasan.1)`.
     - A text marker becomes `sup.fn` only for numbers this row defines, and never after `(` or another digit. So
       `(5)`, and a `22)` whose note sits in another row, stay text.
     - Result: 825 markers, all with a note (the spec's bracket-only rule would have left all 826 notes unlinked).
   - **Preamble.** Footnote text before the first note is kept as a general note with id `{s}:{a}:0` and an
     **empty marker**. Zakaria opens 272 surahs with an introduction this way.
   - **Duplicates and empties.** A number defined twice in one row is merged into one footnote. Empty notes are dropped.
   - **Marker digits.** `data-fn` keeps the marker's source digits (`1:1:১`), as `FOOTNOTE_PATTERN` in
     `src/lib/text/html.ts` expects. Markers are 1–4 digits; a longer bracketed number stays text.
   - **Upstream gaps are kept as published** (QuranEnc's terms forbid changes):
     - text markers without a note: Saheeh 1 (7:143 `[403]`), Zakaria 38, Russian 1;
     - notes no marker references.

   Build results (`tests/quranenc_real.rs`, debug build):

   | Export | Footnotes | Markers | Markers without a note |
   |---|---:|---:|---:|
   | Saheeh | 1,903 | 1,904 | 1 |
   | Rowwad | 2,639 | 2,639 | 0 |
   | Hilali-Khan | 760 | 760 | 0 |
   | Junagarhi | 7,604 | 7,603 | 0 |
   | Zakaria | 5,559 | 5,301 | 38 |
   | Indonesian | 826 | 825 | 0 |
   | Hindi | 2,386 | 2,386 | 0 |
   | French | 1,633 | 1,633 | 0 |
   | García | 1,190 | 1,190 | 0 |
   | Russian | 76 | 76 | 1 |
   | Turkish | 29 | 29 | 0 |
   | Muyassar, Bubenheim, Persian | 0 | 0 | 0 |

   - No `[n]` is left as text in any export.
   - Each export builds in 0.2–1 s.
   - `QD_NET_TESTS=1 cargo test -p quran-packs --test quranenc_real -- --ignored` installs `tr.en.saheeh` and
     `tafsir.ar.muyassar` from quranenc.com through the production adapter. On 2026-10-10 that gave list version
     1.1.2 and ETag version 2025.03, both equal to the catalog, and an immediate `check_update` found nothing.
2. **The ammonia policy runs as two passes** (`transform::html::sanitize`):
   - **Pass 1** normalises arbitrary upstream markup. It allows the policy tags plus `h1`, and `href`/`data-ref`
     verse references only.
   - **A tokenizer** over html5ever's well-formed serialisation then rewrites `a` to `a[data-ref]` or unwraps it, and
     renames `h1` to `h2`. `ammonia::Document::to_dom_node` needs `--cfg ammonia_unstable`, so the DOM cannot be
     edited directly.
   - **Pass 2** is exactly the final policy.

   Additions to the spec:
   - **`data-ref`** is also checked against the Hafs counts: the surah is 1..=114 and the ayah or range lies inside it.
     The value is normalised (`/002:005` → `2:5`, `2:255-255` → `2:255`). A reference to a non-existent ayah is
     unwrapped, because the reader could not go there.
   - **`data-fn`** must match the webview's `FOOTNOTE_PATTERN` (`s:a:n`), so the Rust and DOMPurify passes agree. As a
     result, Quran.com's numeric `foot_note` ids and the `foot_note` attribute itself are not part of the policy.
   - **Idempotent.** Sanitising twice gives the same output (pass 1 also accepts `data-ref`). This is tested on 300
     generated markup soups.
   - **`plain`** (`plain_text`): one line per block (`p`, `br`, `li`, headings, `blockquote`), source line breaks
     as spaces, whitespace collapsed, entities decoded (a no-break space becomes a space), and `sup.fn` content
     dropped. Other `sup` text, such as Bridges' `pl`, stays.
3. **Export check.** The `translations` table must have the five columns. Extra columns are tolerated and ignored,
   reading "with that column set" as "has these columns", so a column QuranEnc adds later does not break installs. Rows
   are accepted as follows:
   - the `sura`/`aya` value may be an INTEGER, a TEXT holding digits, or an integral REAL;
   - a `NULL` text is read as empty;
   - before reading, `PRAGMA quick_check` must pass.

   The count must be exactly 6,236, with every ayah exactly once.
4. **Versions and `source_version`.**
   - **`versionSource: list` packs record the list API's version**, not the catalog's, because the zip actually
     downloaded is the list's current one. Recording the catalog version would make `check_update` offer the same file
     forever. The catalog version is the fallback when the list is unreachable or lacks the key; `Offline` and cancel
     still end the install.
   - **`http_validators` packs** are versioned by the zip's nginx ETag (`"<mtime hex>-<size hex>"`), as `YYYY.MM`.
     - This matches WP5a's catalog versions.
     - An update within the month of the installed version becomes `YYYY.MM.DD`, then `YYYY.MM.DD.HHMM`.
     - Reinstalling the same ETag keeps the installed version.
     - An opaque ETag falls back to the catalog version.
     - `check_update` names the latest version exactly as the install will.
   - **`installed_pack.source_version`** is one JSON shape for both sources (`SourceVersion`):
     `{key, version?, lastUpdate?, etag, lastModified, contentLength}`.
   - **`PackMeta`**, since the adapter only sees `AdapterCtx` and the source config:
     - `lang`: the pack id's language segment;
     - `dir`: `catalog::language_direction`;
     - `name`: the list title, else the key;
     - `author`: the list description;
     - `source`: the zip URL;
     - `licence`/`attribution`: QuranEnc's terms;
     - `meta.source_sha256`: the zip's hash.
5. **Staging use.** The verified zip stays in `packs/.staging/{packId}/` as `{key}.zip`, with `{key}.zip.json`
   (`{url, bytes, sha256, validators}`).
   - A resume (after a pause, or after a build or flip failure) reuses it when its length and hash still match and the
     catalog pin (if any) agrees. The reused bytes count as job progress.
   - An integrity failure of the zip or the export deletes both files, so "Retry" downloads again.
   - The extracted `{key}.sqlite` is deleted right after the build.
   - Limits: the zip must start with `PK\x03\x04` and be at most 128 MiB; the export unpacks to at most 512 MiB and its
     CRC is checked.
   - The entry name never becomes a path.
6. **Update checks** send `If-None-Match` only, never `If-Modified-Since`, because QuranEnc's `Last-Modified` is a
   constant (WP5a). They compare ETags without the weak prefix.
   - A listed key that left the list falls back to the validators check.
   - A row without stored validators reports no update, with a warning, until the pack is reinstalled.
   - Without a job, the checks (list and `HEAD`) take the interactive lane. They are a few small requests someone may
     be waiting for, and the background lane can be held for minutes by audio jobs.
7. **Testable endpoints.** `quranenc_sqlite::{install_from, check_update_from}` take `Endpoints { zip, list }`. The
   frozen `install`/`check_update` call them with QuranEnc's URLs. Tests and the job-queue test use a local server.
8. **Font lane API: `fonts::Fonts`** (cheap clone), built with
   `Fonts::new(FontsConfig::new(packs_root, http, user), &catalog)`.
   - It serves `ensure_page_fonts`, `ensure_decor` and `decor_status` for `PackManager`.
   - `fonts::PROTOCOL_BASE` repeats `src-tauri/src/protocol.rs`'s value, because quran-packs cannot depend on
     src-tauri; a unit test pins the platform form. `FontsConfig.protocol_base` can be overridden (tests use
     `quran://localhost/`).
9. **Interactive writes use lane-private temps** (`p{N}.woff2.i.tmp` / `.b.tmp`, and `{file}.i.tmp` for decor), each
   written through its own `.part`, then renamed into place.
   - So the reader and a "download all" job writing the same page never share a temp file; the last rename wins with
     identical, verified content.
   - If the rename fails because Windows holds the destination while a valid file is already there, that file wins.
   - The startup sweep's `*.tmp`/`*.part` rule removes leftovers.
   - In-flight dedupe is keyed by `(variant, page, lane)`, so an interactive request never waits behind a prefetch
     queued on the background lane.
10. **Files on disk are the truth for readiness**, not registry rows, so a `QD_PACKS_DIR` copy works.
    - URLs carry `?v=<sha256[0..8]>` of the actual bytes. Hashes are cached by path, length and modification time.
    - A font file with the wrong magic is deleted, so it is fetched again: woff2 must start with `wOF2`, TTF/OTF with
      an sfnt tag.
    - `decor_status()` is synchronous (frozen signature). It reads at most the three decor files, once.
11. **Registry writes on the interactive lane.**
    - **On-demand pages** become `pack_item` rows `p{N}` with `pinned = 0`; an existing pin is kept.
    - **`ensure_decor`** records the decor files it fetched as **pinned** rows, and adopts the decor files already on
      disk the same way. It then writes the `decor` pack as `installed`/`partial` with the job runner's policy. A pack
      being removed is left alone.
    - **`DecorStatus`** sets each URL when its file is present; `installed` is true when all three are.
    - **`ensure_decor` fails** with `Offline` when the network is off or offline, with `NotFound` without a catalog
      `decor` pack, and otherwise with the first download error, after keeping the files that did arrive.
    - **The listener.** `Fonts::set_listener` hears the pack ids whose rows changed: once per `ensure_page_fonts` call
      that downloaded something, and after a decor install.
    - **Residual race.** A page row could lose a pin if a job records the same page in the microseconds between this
      lane's read and write of that row. It is self-healing: the next "download all" pins the page without a request.
12. **Adapters.** A page or static file already on disk is `Present`, so "download all" after reading on demand
    downloads nothing for those pages. For static files, "on disk" means the catalog's length, pinned hash and magic;
    an older decor version is replaced. A catalog template list or URL list that is empty is a `Catalog` error.

## Requests

- **WP5e (manager)**:
  - **Wiring.** Build the font lane:

    ```rust
    let fonts = Fonts::new(FontsConfig::new(packs_root.clone(), http.clone(), user.clone()), &catalog);
    fonts.set_listener(move |ids| events.packs_changed(ids));
    ```

    The listener may be coalesced: prefetch can download several pages per call. Then delegate
    `ensure_page_fonts`/`ensure_decor`/`decor_status`.
  - **Eviction.** `UserDb::pack_items_evictable` returns `pinned = 0` rows of **every** pack. On-demand font pages are
    such rows, so `enforce_stream_cache_cap`/`clear_stream_cache` must keep only recitation packs.
  - **`items()`** shows on-demand pages with `pinned: false`.
  - **`check_updates`** can use `Adapter::check_update` (WP5d's revalidator already does).
- **WP6a**: `protocol.rs` can use `quran_packs::fonts::PROTOCOL_BASE` (same value); `PageFontStatus.rel` is the
  `font_bytes` argument.
- **WP1c**: `PackDb::footnotes_for` orders by `CAST(marker AS INTEGER), marker, id`.
  - For Bengali (and any non-ASCII) markers the cast is 0, so `১০` sorts before `২`.
  - Suggest ordering by insertion (rowid of an ordinary table) or a numeric value computed in Rust.
  - The empty preamble marker correctly sorts first.
- **WP11a (translation view / `FootnotePopover`)**:
  - A footnote with an empty `marker` is a general note on the ayah (render it without a number).
  - Some markers have no footnote upstream (see item 1); render them without a popover.
- **WP5d**: `transform::html::sanitize` is the policy; `plain_text` gives a `plain` view of sanitised HTML. Quran.com's
  `<sup foot_note=ID>` loses `foot_note` (map it to `data-fn="{s}:{a}:{n}"` first if tafsir footnotes are ever
  needed).
- **Lead**: fold items 1–12 into §2.5.5–§2.5.6, §3.4 (preamble notes) and §5.7 (empty footnote markers).
