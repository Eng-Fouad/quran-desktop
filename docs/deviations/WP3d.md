# WP3d deviations (qul adapter)

## Delivered

- **`xtask/src/build/qul.rs`**, the release-grade adapter of §4.3:
  - `pub fn load(qul_dir: &Path) -> anyhow::Result<(SourceQuran, PathBuf /* Tanzil xml */)>` is the signature WP3a's
    handoff asked for. It prints a `build-core: qul: …` report.
  - `pub fn read(qul_dir) -> QulLoad { source, tanzil, report }` does the same without printing.
  - Its reading rules and checks are documented in the module docs and in `data/sources/README.md`.
- **`data/sources/qul/manifest.toml`** is valid TOML. It lists every input with its QUL resource id. The Tanzil hash is
  pinned; the QUL hashes stay empty until a person places the files.
- **`data/sources/README.md`** covers how to obtain each file, the steps, what the build checks, what to do when it
  stops, and the licensing status ("permission not obtained yet").
- **Tests** (both test crates compile the build modules by path, as WP3a's do):
  - `xtask/tests/qul_adapter.rs`: 39 tests on synthetic SQLite/JSON, including qul.rs's own unit tests. They cover:
    - the §4.3 snippet, parsed verbatim with `toml` and with the adapter's manifest type, plus the snippet as it
      currently appears in ARCHITECTURE.md;
    - the committed manifest and the README;
    - input verification;
    - both script column variants and both JSON shapes;
    - canonical words and the FACT C7 diagnosis;
    - QUL word ids;
    - layouts with `''` placeholders and a surah_name on the page before its surah;
    - surah names and division metadata as JSON (object and array) and SQLite;
    - the error message of every rejection path.
  - `xtask/tests/qul_roundtrip.rs` runs at full scale. It writes QUL-format exports of the M1 core.db in every
    documented shape:
    - QUL `word_index` numbering with the 3 FACT C7 slots, max id 83,668;
    - V4 with its own `words` table in another id space;
    - end markers as bare digits;
    - V1 in the combined 38:24:32–33 grouping;
    - metadata as keyed JSON, array JSON and SQLite.

    It then requires:
    - `qul::read` followed by the shared `derive` reproduces **every row of M1**: surah, juz, hizb, rub, manzil,
      ruku, sajda, ayah, word, page and line;
    - the rows written by the shared writer give a `source = qul` database with M1's `vocab_loose`;
    - **the real `xtask verify-core` passes 18/18 gates** on that database;
    - adding the 3 extra rows stops the build and names them.

    The test skips (and passes) when the gitignored M1 core.db or the Tanzil cache is missing. CI has neither.

## Deviations from ARCHITECTURE.md

### 1. `meta.rub` is QUL resource **63**, not 67 (§4.3, D6, §14.3)

QUL's metadata 67 is the **Hizb** file. The rub el hizb quarters are resource **63**. Evidence:

- **Live check on qul.tarteel.ai (2026-10-10).**
  - `/resources/quran-metadata/67` is titled "Hizb". Its fields are `hizb_number`, `verses_count`,
    `first_verse_key`, `last_verse_key` and `verse_mapping`, and it has 60 hizbs.
  - `/resources/quran-metadata/63` is titled "Rub". Its fields are `rub_number`, `verses_count`, `first_verse_key`,
    `last_verse_key` and `verse_mapping`, with 1–240 records, as JSON or SQLite.
  - The sample rub 1 on that page is 1:1–2:25, 32 verses. That is exactly M1's `rub` 1 (ayah ids 1–32).
- **The research catalog** (`research/mushaf-text-layout/qul_catalog_and_metadata_help.txt`) lists "67 | Hizb" and
  "63 | Rub".
- **QUL's exporter** (`qul_src_lib_exporter_export_quran_meta_data.rb`) writes `rub_number` from `RubElHizb` and
  `hizb_number` from `Hizb`.

So the manifest says `meta.rub = { …, resource = 63 }`. The adapter rejects 67 and explains why. A hizb file placed in
the rub slot is also rejected by its contents: it has 60 records with `hizb_number`, and the error names it as QUL's
"Hizb" metadata, resource 67.

### 2. `script.imlaei` is QUL resource **54**, not 60 (§4.3; follows docs/deviations/WP3a.md §1)

The manifest names `script-54.sqlite`, resource 54. Resource 60 is rejected, and the message explains that "Imlaei
simple" breaks search for the everyday spellings.

### 3. Optional D6 cross-check inputs `meta.juz` (68), `meta.hizb` (67), `meta.manzil` (66)

§4.4 rule 3 hard-checks juz, hizb and manzil per ayah "against the mushaf source (qdc verse fields / QUL metadata)".
The §4.3 manifest lists no such metadata, so a qul build could never run that check.

These three entries are optional:

- They are in the committed manifest. Delete a line to skip that check.
- Present files fill `SourceDivisions.{juz, hizb, manzil}`, so `derive` reports "6236 ayahs cross-checked against the
  source, 0 differences".
- When a file is absent, the report says that division was not cross-checked.

### 4. Manifest values are checked, and problems are reported together

- **`resource`** is checked against the expected id of each key. Tanzil must have none.
- **`file`** must be a relative path inside `data/sources/qul/`. It may not contain `..`, a root, a drive or `\`, and
  no two entries may name the same file (compared case-insensitively).
- **`sha256`** must be 64 hex digits, in either case (PowerShell's `Get-FileHash` prints upper case), or `""`. An empty
  value means **not recorded yet**: the build stops and prints the file's actual hash, to be checked and pasted. The
  spec's `"…"` placeholder is rejected as "neither 64 hex digits nor empty".
- Every problem is listed in one error, with each file's actual hash: manifest values, missing files, hashes not
  recorded, hashes that differ.
- The Tanzil hash is pinned to `8867c1d8…5c7a`, a 77,234-byte file. That is the LEAD item 8 cache file and M1's
  `meta.tanzil_sha256`.

### 5. `meta.source_manifest_sha256` for qul hashes a canonical text, not the file

WP3a's handoff suggested "sha256 of manifest.toml". That hash depends on comments, formatting and whether the checkout
has LF or CRLF line endings. The working tree here is CRLF; git stores LF. It would make core.db differ across operating
systems.

It is defined instead as the sha256 of one line per input, in manifest order: `"<file sha256>  <key>  <file>\n"`. That
form pins every input byte, the key each file fills, and the file names, and nothing else.

### 6. Formats accepted beyond §4.3 (the real exports have not arrived)

- **Scripts** are read from SQLite `words` with either column variant. A `word_key` of the form `s:a` is completed with
  `word`. The adapter also reads QUL's two JSON shapes:
  - the exporter's, keyed by location: `{id, surah, ayah, word, location, text}`, numbers possibly as strings;
  - the resource pages', keyed by ayah: `{verse_key, words: [{position, text, location}]}`, with no ids.

  When script 61 has no ids, every layout must have its own `words` table.
- **Metadata** may be JSON, as an object keyed by number or as an array, or SQLite: tables `chapters`, `rub`, `juz`,
  `hizbs` and `manzil`, with `verse_mapping` as JSON text. The number may come from the field
  (`rub_number`/`rub_el_hizb_number`, `hizb_number`, …) or from the key. When both are present they must agree.
- **Layouts** must be SQLite, because QUL's JSON layout export is a folder of pages. A layout DB's own `words` table is
  used for its ids when present, as §4.3 says ("via the layout DB's own words, or script 61").

### 7. Checks the adapter adds before `derive`

- Every page has exactly lines 1..=15, or 1..=8 on pages 1–2. Otherwise `derive` would treat a missing line as an
  empty slot and try to explain it as a header.
- `info`, if present, must say 604 pages and 15 lines per page.
- An ayah line carries no `surah_number`, and a header line carries no word ids.
- A basmallah's `surah_number`, if given, must equal the surah of the next ayah line. That line is found in reading
  order, so a basmallah that opens a page after a cross-page `surah_name` works (WP3a deviation 2).
- A script's `surah`/`ayah`/`word` columns must agree with its location.
- **`word_index` order must equal location order**, and every canonical word has exactly one id in the mapping table.
  The line ranges depend on both.
- Script 57/312/54 ids that disagree with script 61's are counted and reported as a warning. Joins are by location, so
  such a disagreement does not change the result.

### 8. FACT C7 (the 3 extra `word_index` slots)

Line ranges are mapped by walking the ids that exist, so unused ids inside a range are skipped. If QUL's numbering
merely has gaps, the build works and reports the unused ids. In the full-scale test these are 6439, 23789 and 34411.

If the scripts have extra **rows**, so the canonical set is not 83,665, the build stops (§4.3) and lists the candidates:

- unparsable locations, with their `word_index`;
- locations outside their surah's ayahs;
- ayahs whose positions are not 1..n;
- locations after their ayah's end marker, judged by `text_hafs`;
- ayahs with no end marker or with several;
- ayahs without words.

When nothing stands out structurally, the message suggests comparing per-ayah word counts with QUL metadata 69.

### 9. Smaller decisions

- **End markers.** The last location of every ayah is `WordKind::End`, with `text_imlaei = None`. `derive` ignores
  that field for markers anyway, and core.db stores NULL there.
- **Report printing.** `load` prints its own report, because the handoff signature returns only the model and the
  Tanzil path.
- **Licence note.** `meta.licence_note` names the QUL resources actually used and their KFGQPC origin. It says that
  distribution needs the permission recorded in `data/sources/README.md`, and it carries the Tanzil CC BY 3.0
  attribution.
- **Dead code.** `#![allow(dead_code, reason = …)]` sits at the top of qul.rs until request 1 is done. `mod qul;` is
  private in `build/mod.rs`, and nothing in the binary calls it yet. WP0B used the same precedent for its §4.6
  constants.
- **Rub 106, for the human who places the files.** If QUL 63 starts rub 106 at 15:50 (Tanzil) rather than 15:49 (QDC
  and the printed page), `derive` stops with "division_exceptions.toml lists rub 106 …, which no longer differs". That
  is the D6 design working; the lead then decides.

## Requests

1. **Lead → `xtask/src/build/mod.rs` (WP3a's file): wire `--source qul`.** Replace the `Source::Qul => bail!(…)` arm
   with:
   ```rust
   Source::Qul => {
       eprintln!(
           "build-core: source qul (release-grade; distribution needs the permission recorded in \
            data/sources/README.md)"
       );
       qul::load(&crate::cli::workspace_root().join("data").join("sources").join("qul"))?
   }
   ```
   `--cache`, `--offline` and `--jobs` don't apply to qul. Then delete the `#![allow(dead_code, …)]` block at the top
   of `xtask/src/build/qul.rs`; WP3d or the lead can make that one-line deletion.

   The rest of the path is already proved: `qul_roundtrip` runs `qul::read`, then `derive`, then `write`, then
   `verify-core`, and gets 18/18 gates. So `pnpm core:qul` works as soon as the arm is replaced.
2. **Lead: fold this file into the spec.**
   - In §4.3: resource 63 for the rub; 54 for the Imla'i seed; the optional `meta.juz/hizb/manzil`; `sha256 = ""` as
     "not recorded yet"; the canonical manifest hash.
   - In §14.3, WP3d's line ("rub from metadata 67").
   - In BRIEF §4: "scripts 61/57/312/60" becomes 54.
   - In FACT §2.2: the search seed becomes 54.
3. **WP3b (note only).** `verify.rs::qul_manifest_tanzil_file` reads `tanzil.file` from this manifest. The committed
   manifest is compatible: `tanzil = { file = "quran-data.xml", sha256 = "…" }`, with no `resource`.
4. **WP-CI / WP13b.** A qul `core.db` can't be built in CI until a person has placed the files and the permission in
   `data/sources/README.md` exists. Whether the QUL files may be committed, or stored as a CI secret, is the lead's call
   under that permission. `qul_adapter` always runs in CI. `qul_roundtrip` skips there, because CI has no M1 core.db.

## Acceptance (run on 2026-10-10, `CARGO_TARGET_DIR=C:\qdt\WP3d`)

- `cargo test -p xtask --test 'qul_*'` passes:
  - `qul_adapter`: 39 passed;
  - `qul_roundtrip`: 22 passed, including the full-scale round trip and the run of the real `xtask verify-core`
    binary on the qul-built database (18/18 gates, 139 checks).
- `cargo clippy -p xtask --all-targets -- -D warnings` is clean.
- `cargo test -p xtask --bin xtask`: 64 passed (the 5 `build::qul` unit tests among them).
- `rustfmt --check` is clean on the owned Rust files.
- No `NotImplemented`, `not implemented`, `todo!` or `TODO` remains in the owned paths.
