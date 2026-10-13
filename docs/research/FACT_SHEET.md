# Quran Desktop: Verified Fact Sheet (final, 2026-10-10)

Stack: Tauri 2 (Rust) + Svelte 5 + TypeScript + Vite 8 SPA + pnpm. Offline-first, with a bundled core DB and on-demand packs.
Project path: `C:\Users\fouad\RustroverProjects\quran-desktop`. It exists and is empty (checked 2026-10-10).

**Legend**
- **[V-C]**: re-verified live by the completeness critic in this session.
- **[V-R]**: verified live by a sub-report on 2026-10-10 and not contradicted.
- **[?]**: unverified. The reason is given.
- **Corrected / Added (date, build):** a fact the implementation found wrong or missing, appended where the fact stands. The
  original text is kept as history; the correction wins. Corrections in this file: C5, C13, C15, §1 (`cargo test`
  filters), §2.2, §2.3 (the 2:181 end marker, the inline ۞, spaces in words, C15 derivation), §4.1 (mirror revisions),
  §4.2 (juz ligatures, the margin ۞), §5.2 (reciter 173), §6 (QuranEnc validators, tafsir gaps), §7 (event mock,
  WebKitGTK CORS). ARCHITECTURE.md v1.2 and docs/IMPLEMENTATION_NOTES.md carry the consequences.

**Evidence folder:** `research/critic/` (R = `C:\Users\fouad\AppData\Local\Temp\claude\C--Users-fouad-AppData-Roaming-Claude-scratch-workspaces-6463bc05-45c5-4361-9291-b022ebeed68b-4fedef61-7d08-4bf3-95d0-ddab25699856-scratch-2026-10-09-5aa8bc\ba4e4a3a-7c3b-4454-bc64-bdcdd225f47a\scratchpad\research\`). Sub-report evidence is in `research/<topic>/`.

---

## 0. Critical corrections (read first)

| # | Earlier claim | Verified truth | Evidence |
|---|---|---|---|
| C1 | "v1_page == v2_page on every page" (mushaf-text-layout); "V1 and V2 give identical word→line results on 16 pages" (mushaf-fonts) | **False.** V1 (1405H) and V2 (1421H) **page starts differ on 25 pages**: 121, 122, 123, 145, 532, 533, 534, 565, 568, 570, 576, 584, 586, 588, 589, 590, 592–600. 56 ayahs / 361 words sit on a different page. Line breaks also differ, e.g. 76 of 94 words on p600. | [V-C] `critic/v1v2_summary.json`, `v1v2_page_starts.json`, `p600_*.json` |
| C2 | CI gate "V2 layout page starts == Tanzil" | **Tanzil page starts = V1 (1405H)**: 604/604 match. They match V2 on only 579/604, failing on the 25 pages above. quran_android equals Tanzil, so it is also V1. Gate **V1 layout vs Tanzil**. Gate V2/V4 against their own page-start table (QUL layout 10/19). | [V-C] `critic/tanzil_vs_v1_v2_page_starts.txt` |
| C3 | Legacy `api.quran.com/api/v4/verses/by_page/{p}` is a usable V2 page source | **Inconsistent on those 25 pages.** It selects verses by V1 page but returns V2 `line_number`. For example p600 is missing 100:6–9, so lines 1–2 are empty. `https://api.qurancdn.com/api/qdc/verses/by_page/{p}?mushaf={1\|2\|19}&per_page=all` paginates correctly for each mushaf. | [V-C] `critic/qdc_p600_m1.json`, `qdc_p600_m2.json`, `pg599.json` |
| C4 | V4 tajweed uses the V2 layout | V4 (mushaf 19) has **the same page starts as V2 but its own line breaks**: 0–6 words differ per page (p400:3, p528:6, p586:5, p600:3). Store a separate V4 layout (QUL layout 19). | [V-C] QDC by_page mushaf=19 vs mushaf=1 on 16 pages |
| C5 | "Each word span holds exactly one glyph character" | **False.** 4,517 V2 and 4,580 V1 words have a `code_v*` of **2–4 PUA chars** (waqf/sajda marks are separate glyphs, e.g. 38:24:32 V2 = U+FCBA U+FCBB "وَأَنَابَ ۩"). Store codes as TEXT and render the whole string in one span. **Corrected (2026-10-10, build):** the 4 characters include a space in **198 codes per column**: 195 are `<۞ glyph> U+0020 <word glyph>` (the inline rub sign, see §2.3) and 3 keep a printed space between two glyph groups (8:6:4, 36:52:6, 37:130:3). Without the space the longest code is 3 PUA chars. | [V-C] `critic/critic_analyses.txt`; correction: docs/deviations/WP3b.md deviation 1 |
| C6 | Fallback: build without login from QUL `mini_quran_dev.sql.zip` | **Not viable.** The dump is a **sparse dev subset**: `verses` 1,923 rows (1:1…12:20), `words` 22,221 of ~83.7K, `mushaf_words` only 572 rows (mushafs 2 and 6), and `mushaf_pages.mushaf_id` mostly NULL. | [V-C] streamed the full 201,979,245 B zip; `critic/critic_analyses.txt` |
| C7 | QUL `word_index` = sequential API word order, ~83,664–83,668 | The API has **83,665 word rows** (77,429 words + 6,236 end markers). QUL `word_index` runs **1…83,668** (114:6:4 = 83668), with **3 extra slots** relative to API order (offset +1 by 3:1:1, +2 by 8:7:1, +3 by 14:1:1). **Join scripts on `location` ("s:a:w"), never on a running count.** | [V-C] dump scan vs API |
| C8 | QDC chapter files "probably" have no basmala | **Verified: no basmala.** `qdc/mishari_al_afasy/murattal/112.mp3` = 214,038 B, MPEG1-L3 128 kbps CBR → 13.38 s. EveryAyah 112001–112004 sum to 13.48 s; the basmala 001001 alone is 9.18 s. Every QDC reciter's 112:1 word 1 starts at 0–40 ms. | [V-C] `critic/qdc_basmala_check.txt` |
| C9 | "Cargo not installed" (rust-data-search) | cargo 1.99.0 / rustc 1.99.0 **are installed** in `%USERPROFILE%\.cargo\bin`. That directory is just **not on the Git-Bash PATH**. A rusqlite probe compiled and ran. | [V-C] `critic/ftsprobe/run.log` |
| C10 | AppImage "grows past 70 MB with bundleMediaFramework" vs "+15–35 MB" | Both are partly right. The Tauri docs say AppImage itself goes from 2–6 MB to **70+ MB**. The schema (2.12.2) says `bundleMediaFramework` adds **~15–35 MB** more. Native Rust audio means we do **not** need bundleMediaFramework. | [V-C] schema.tauri.app/config/2, tauri-docs appimage.mdx |
| C11 | Vite `build.target` chrome105/safari13 (Tauri guide) vs Vite 8 default | Keep **Vite 8 default `baseline-widely-available`** (chrome111/edge111/firefox114/safari16.4). The Tauri guide's safari13 is outdated. Set `bundle.macOS.minimumSystemVersion` ≥ `"13.3"`. | [V-R] |
| C12 | Core DB `.zst` + decompress on first run, vs ship uncompressed | **Ship uncompressed, open in place** with `?mode=ro&immutable=1`. The NSIS default compression is `lzma` and dmg/deb/AppImage are compressed containers, so download size stays about 2.5–3 MB. There is no first-run copy and no version-skew logic. | [V-C] schema NsisConfig.compression default "lzma" |
| C13 | Search seed QUL 53 (Uthmani simple) or 60 (Imla'i simple) | Use **Imla'i simple (QUL 60)** or Imla'i (54). `text_uthmani_simple` 1:2 = "…رب العلمين" (Uthmani spelling); `text_imlaei_simple` = "…رب العالمين". **Corrected (2026-10-10, build; LEAD 17):** use **Imla'i (54)** only, which is QDC's word-level `text_imlaei`. "Imlaei simple" (60) writes the dagger alef as a full alef and pre-folds hamza seats (`الرحمان`, `ذالك`, `هاذا`, `يومنون`), so `الرحمن` had 0 hits for 1:1 and 1:3 and strict `يؤمنون` could not match. `normalize_ar` of the diacritised 54 gives exactly the everyday spellings (`الرحمن` 45 hits; `vocab_loose` 14,615 terms). | [V-C]; correction: docs/deviations/WP3a.md §1 |
| C14 | MSRV 1.90 (tauri) vs 1.91 (stream-download) vs 1.95 | Workspace `rust-version = "1.95"` (rusqlite_migration 2.6.0 declares 1.95). Pin `rust-toolchain.toml` → `1.99.0`. | [V-C] crates.io |
| C15 | Header/basmala lines need QUL `mushaf_line_alignments` | **They can be derived exactly.** On every one of the 114 surahs, in **both V1 and V2**, the empty lines directly above a surah's first ayah line, **on the same page**, are `surah_name` and then `basmallah` (1 line for surahs 1 and 9). There are no other empty lines: 224 = 114 + 112 − 2 (page 1/2 line 1). No header is ever orphaned at the bottom of a previous page. **Corrected (2026-10-10, build; LEAD 17):** false for the QDC by_page source. In **18 V2 surahs** (4, 10, 22, 23, 24, 26, 27, 32, 33, 37, 38, 45, 47, 53, 60, 64, 65, 80) and **21 V1 surahs** (those plus 82, 86, 91) the first ayah is on line 2 of page P and the `surah_name` line is **line 15 of page P−1**, with the basmallah on P:1 (e.g. An-Nisa: V2 76:15 surah_name, 77:1 basmallah, 77:2 = 4:1). V4 has none. Each layout has 226 empty slots, exactly the header lines (the "224" above came from the legacy API, which was already inconsistent, C3). This is the printed geometry: keep it. The derivation reads lines in reading order; only a two-line header's `surah_name` may sit on the previous page. | [V-C]; correction: docs/deviations/WP3a.md §2, WP3b.md deviation 3, WP1a.md Requests |

---

## 1. Toolchain and versions (pin exactly)

### Rust (crates.io, read 2026-10-10)
| crate | pin | notes |
|---|---|---|
| tauri | `2.12.2` [V-C] | rust 1.90. 3.0.0-alpha.4 exists: **never use**. Resolves to wry 0.57.0, tao 0.37.1, windows 0.62.2 [V-R] |
| tauri-build | `2.7.1` [V-C] | |
| tauri-plugin-single-instance | `2.5.2` [V-C] | register first; no JS package |
| tauri-plugin-window-state / log / opener / updater | `2.5.0` / `2.10.0` / `2.7.0` / `2.13.2` [V-C] | npm pairs: 2.5.0 / 2.10.0 / 2.7.0 / 2.13.2 |
| other plugins | dialog 2.8.1, fs 2.6.0, store 2.5.0, global-shortcut 2.4.0, os 2.4.0, process 2.4.0, http 2.8.1, notification 2.5.1, clipboard-manager 2.4.1, deep-link 2.6.1 [V-R] | `tauri build` fails if the crate and npm major.minor differ |
| specta / tauri-specta / specta-typescript | `=2.0.0-rc.25` / `=2.0.0-rc.25` / `=0.0.12` [V-C: rc.25 is max_version] | DTOs must use u32/i32, because i64/u64/usize are rejected by the TS export |
| rusqlite | `0.40.2` features `["bundled","functions","backup","serde_json","collation","hooks"]` [V-C] | bundled **SQLite 3.53.2 with FTS5 compiled in**, proven by a compiled probe |
| libsqlite3-sys | 0.38.2 (transitive) [V-C] | `links="sqlite3"`: **no sqlx / tauri-plugin-sql** (they conflict) |
| r2d2 / r2d2_sqlite | 0.8.10 / `0.35.0` [V-C] | |
| rusqlite_migration | `2.6.0` [V-C] | rust 1.95 |
| unicode-normalization | 0.1.25 [V-R] | |
| cpal | `0.18.2` [V-C] | rust 1.85; Linux feature `pulseaudio` |
| symphonia | `0.6.1` `default-features=false, features=["mp3","opt-simd"]` [V-C] | MPL-2.0; **mp3 is not a default feature** |
| stream-download | `0.24.4` `default-features=false, features=["reqwest-rustls"]` [V-C] | rust 1.91 |
| rtrb / rubato / crossbeam-channel / signalsmith-stretch | 0.4.0 / 5.0.1 / 0.5.17 / 0.1.3 [V-R] | signalsmith needs libclang + C++14 [? not compiled] |
| windows / objc2-media-player / mpris-server | 0.62.2 / 0.3.2 / 0.10.0 [V-R] | for the custom `media_session` crate |
| zstd | 0.14.x (BSD-3-Clause; 0.14.1 published 2026-10-09) [V-R] | only for downloadable packs |

- Toolchain: rustc/cargo **1.99.0** [V-C].
- On Windows, call `%USERPROFILE%\.cargo\bin\cargo.exe` or use PowerShell; Git-Bash PATH lacks it.
- **Corrected (2026-10-10, build; LEAD 14, 17):** `cargo test` takes **one** positional TESTNAME. A command such as
  `cargo test -p quran-core --lib content_db pack_db timings` (the form ARCHITECTURE §14.3 v1.1 used in ten acceptance
  lines) is rejected by cargo 1.99's argument parser before anything is built ("unexpected argument 'pack_db' found").
  Several filters go to libtest after `--`: `cargo test -p quran-core --lib -- content_db pack_db timings`. A
  `--test 'glob_*'` filter is fine (cargo expands it).
- Release profile: `codegen-units=1, lto=true, opt-level="s", panic="abort", strip=true` plus `build.removeUnusedCommands=true` [V-R] (probe NSIS installer 1.24 MiB).

### npm (read 2026-10-10)
- svelte `5.57.2` [V-C]
- vite `8.3.4` [V-C]
- @sveltejs/vite-plugin-svelte `7.3.1` [V-C]
- **typescript `~6.0.3`** [V-C]. `latest` is 7.0.2, which svelte-check 4.7.6 and typescript-eslint 8.71.1 reject.
- svelte-check `4.7.6` [V-C]
- @tsconfig/svelte 5.0.8
- @tauri-apps/api `~2.12.2` [V-C] (`next` = 3.0.0-alpha.2: avoid)
- @tauri-apps/cli `~2.12.1` [V-C]
- bits-ui `2.19.5` [V-C] (Command inside Dialog; `vimBindings` defaults true)
- virtua `0.53.3` [V-C]
- @lucide/svelte 1.54.0, paneforge 1.0.2, svelte-sonner 1.2.1, @inlang/paraglide-js 2.26.0 (`setLocale(l,{reload:false})`)
- vitest 5.0.3 + @vitest/browser-playwright 5.0.3 + playwright 1.64.0 + vitest-browser-svelte 3.1.0 [V-R]
- create-vite `9.2.1` [V-C]. Its svelte-ts template pins `typescript ~6.0.2, svelte ^5.57.0, vite ^8.3.0, @sveltejs/vite-plugin-svelte ^7.3.0, svelte-check ^4.7.6` and supports `--no-interactive`, which was checked in the published dist.
- **Do not use** cmdk-sv (archived), lucide-svelte (deprecated), or @tanstack/svelte-virtual (Svelte-4 stores).

### Scaffolding (non-interactive)
```powershell
cd C:\Users\fouad\RustroverProjects
pnpm create vite quran-desktop --template svelte-ts --no-interactive   # flag verified in create-vite 9.2.1 dist [V-C]
cd quran-desktop
pnpm add @tauri-apps/api@~2.12.2
pnpm add -D @tauri-apps/cli@~2.12.1 typescript@~6.0.3
pnpm tauri init --ci -A "Quran Desktop" -W "Quran Desktop" -D ../dist -P http://localhost:1420 --before-dev-command "pnpm dev" --before-build-command "pnpm build"
```
- Then set `identifier` in tauri.conf.json by hand, because init has no flag for it [V-R]. Never change the identifier after release.
- Vite: `server.port 1420, strictPort true`, `host: process.env.TAURI_DEV_HOST || false`, `envPrefix ['VITE_','TAURI_ENV_*']`, `watch.ignored ['**/src-tauri/**']`, keep the default build.target.
- Add plugins with `pnpm tauri add <plugin>` so the crate and npm versions stay paired.
- create-tauri-app's `svelte-ts` template is **SvelteKit**: don't use it [V-R].

---

## 2. Core DB: sources, IDs, derivation rules

### 2.1 Licensing constraints that decide the source
- **QF Developer Terms** (`https://api-docs.quran.foundation/legal/developer-terms/`, "Last updated: 2026-10-04") [V-C]:
  - Definitions:
    - *QF Content* = "Quran text, translations, metadata, audio, reflections, and any other content returned by the APIs".
    - *Derived Materials* include **indexes**.
  - You must not cache QF Content longer than **1 week** unless it comes via **Content Sync**, whose next sync is due **at least every 7 days**. If QF is unreachable for more than 7 days, you may keep using the previously synced copy.
  - "The Content Sync storage exception does not itself authorize distributing a **prepackaged database or build-time bundle** of QF Content."
  - Font files and Mushaf images may be cached or bundled with an active Developer Console account and credit to Quran Foundation. They may be distributed "only as an integrated part of the Application", and **not** via "the Developer's own API, asset package, or standalone download".
  - ⇒ **Do not build `core.db` from api.quran.com / apis.quran.foundation responses.**
  - The live QF API and its glyph data were used only for **verification** in this research.
- **QUL** (qul.tarteel.ai): code is MIT. Data resources show **no copyright info** and the FAQ says to check each resource [V-R]. **All downloads need a logged-in account** [V-C] (layout pages 10/15/19 link only to `/users/sign_in`).
- **Tanzil**: CC BY 3.0, verbatim copies only, attribution plus link [V-R]. The `quran-data.xml` metadata downloads directly [V-C]. The text download form needs `agree=true`, so **the user must accept**.

### 2.2 Source plan (primary)
A human downloads these once from QUL (SQLite where offered), commits them under `data/sources/qul/` with a SHA-256 manifest, and CI builds `core.db` with a Rust `xtask`. The xtask shares `normalize_ar()` with the app.

| Need | QUL resource id | Notes |
|---|---|---|
| V2 1421H layout (also used by bundled Unicode KFGQPC Hafs) | mushaf-layout **10** | `pages(page_number,line_number,line_type 'ayah'\|'surah_name'\|'basmallah',is_centered,first_word_id,last_word_id,surah_number)`; '' instead of NULL [V-R from exporter source] |
| V1 1405H layout | mushaf-layout **15** | page starts must equal Tanzil (C2) |
| V4 1441H tajweed layout | mushaf-layout **19** | needed: line breaks differ from V2 (C4) |
| V2 glyph codes | quran-script **61** | words(id=word_index, location, surah, ayah, word, text); Help text says word_index/word_key, so accept both |
| V1 glyph codes | quran-script **57** | apply the 38:24:32–33 V1 fix if the per-resource export lacks it [V-R] |
| Unicode display text (QPC Hafs) | quran-script **312** | `text_qpc_hafs` encoding (U+06E1 sukun) |
| Search seed | quran-script **60** (Imla'i simple) or **54** (Imla'i). **Corrected:** **54** only (C13) | C13 |
| Surah / ayah / juz / hizb / rub / manzil / ruku / sajda metadata | quran-metadata **70 / 69 / 68 / 67 / 63 / 66 / 65 / 64** | cross-check with Tanzil. (Confirmed by the build on qul.tarteel.ai, 2026-10-10: 67 is "Hizb", 60 records; 63 is "Rub", 240 records. ARCHITECTURE §4.3 v1.1 said rub = 67; corrected there in v1.2.) |
| Independent cross-check | Tanzil `https://tanzil.net/res/text/metadata/quran-data.xml` (77,234 B) [V-C] | 114 sura, 30 juz, 240 quarter, 7 manzil, 556 ruku, 604 page (**V1**), 15 sajda; types: obligatory 32:15, 41:38, 53:62, 96:19, the other 11 recommended [V-C] |

### 2.3 Verified invariants for CI gates [V-C unless noted]
- 6,236 ayahs; **83,665 word rows** in API order (77,429 `word` + 6,236 `end`). QUL max `word_index` = **83,668**, so gate "every word id covered by exactly one ayah line" **without** assuming 1..N contiguity.
- `char_type_name` ∈ {`word`, `end`} only. The rub-el-hizb ۞ is **not** a word, so the app draws it. Sajda ۩ is **inside** the word glyph (e.g. 38:24:32).
  - **Corrected (2026-10-10, build):** QDC labels one end marker a `word`: 2:181:14 (`١٨١`) in all three mushafs, so the
    API has 77,430 "words" and 6,235 ends. The build relabels it by a narrow rule (the ayah has no `end` and its last word
    is exactly its own number), after which the counts above hold.
  - **Corrected (2026-10-10, build; LEAD 17): the ۞ is also inline in the text.** The first word of **199 of the 240
    quarter starts** (every one except the 41 that are ayah 1 of a surah) begins with `۞ ` in `text_qpc_hafs` and
    `text_imlaei` (e.g. 2:26:1 `۞ إِنَّ`). In `code_v1`/`code_v2`, 195 of those words are
    `<۞ glyph> U+0020 <word glyph>` and 4 carry the two glyphs without a separator (7:47:1, 15:49:1, 22:38:1, 53:26:1). The QCF fonts, the QPC
    Hafs text and Tanzil all print it inline, before the quarter's first word. It is kept verbatim; `normalize_ar` deletes
    it (U+06DE is in step 1). The app's margin therefore shows the quarter's **label** for those words and never a second
    ۞ glyph; the margin ۞ is drawn only for the 41 quarters without an inline sign. **Superseded (2026-10-13, owner
    request; WP8c 9):** the margin draws the division's marker for every rub start, inline ۞ or not (the print's lamp
    or medallion with its label, or the ۞ with the label under it without decor); the text keeps its inline ۞.
  - **Added (2026-10-10, build):** other spaces inside non-end `text_hafs` words: 9 before ۩ (17:109:5, 19:58:29,
    22:18:37, 22:77:11, 25:60:13, 32:15:15, 38:24:32, 41:38:12, 84:21:6), 199 after the inline ۞, and 4 inside printed
    compounds (2:181:3, 8:6:4, 13:37:8 `بَعۡدَ مَا`; 37:130:3 `إِلۡ يَاسِينَ`).
- 604 pages × ≤15 lines per layout. Pages 1–2 use lines 1–8 only (line 1 = surah_name; page 2 line 2 = basmallah).
- **Line-type derivation (C15):** for surah s with first ayah line L on page P, line L−1 = `basmallah` and L−2 = `surah_name` (for s ∈ {1, 9}: L−1 = `surah_name` only). This gives 114 surah_name lines and 112 basmallah lines per layout, holds for V1 and V2, and should be gated for V4.
  - **Corrected (2026-10-10, build; LEAD 17):** count the lines in **reading order across pages**. When L is line 2 of
    page P, the `surah_name` is line 15 of page P−1 (18 V2 and 21 V1 surahs, see C15). The slot directly above L is
    always on page P.
- **Centred lines:**
  - Pages 1–2 are fully centred.
  - V2 surah-ending centred lines (quran.com constant) [V-R]: 255:[2], 528:[9], 534:[6], 545:[6], 586:[1], 593:[2], 594:[5], 600:[10], 602:[5,15], 603:[10,15], 604:[4,9,14,15].
  - V1 and V4 centring: take from QUL layouts 15/19 (`is_centered`). There is no other verified source.
- Page starts: V1 == Tanzil (604/604). V2 ≠ V1 on 25 pages (C1).
- quran.com mushaf ids (Mushaf enum): QCFV2=1, QCFV1=2, KFGQPC Hafs=5, QCF Tajweed V4=19 [V-R].

### 2.4 Unified core schema (merges the three proposals; fixes per-mushaf page/line)
```sql
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;      -- source hashes, normalizer_version, build date
mushaf(id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT, pages INTEGER, lines INTEGER, glyph_field TEXT) STRICT;
   -- 1 qcf_v2_1421 (code_v2), 2 qcf_v1_1405 (code_v1), 19 qcf_v4_1441 (code_v2 glyphs, own layout); Unicode Hafs renders with layout 1
surah(id INTEGER PRIMARY KEY, name_ar, name_simple, name_complex, name_en, revelation_place, revelation_order,
      ayah_count INTEGER, bismillah_pre INTEGER, header_cp TEXT /* QCF_SurahHeader map */) STRICT;
ayah(id INTEGER PRIMARY KEY /*1..6236*/, surah INTEGER, ayah INTEGER, juz INTEGER, hizb INTEGER, rub INTEGER, manzil INTEGER,
     ruku INTEGER, sajda_type INTEGER, first_word_id INTEGER, last_word_id INTEGER,
     text_qpc_hafs TEXT, text_imlaei TEXT, norm_loose TEXT, norm_strict TEXT, UNIQUE(surah, ayah)) STRICT;
word(id INTEGER PRIMARY KEY /*QUL word_index*/, ayah_id INTEGER, position INTEGER, is_end INTEGER, location TEXT UNIQUE,
     text_qpc_hafs TEXT, text_imlaei_simple TEXT, norm_loose TEXT, code_v1 TEXT, code_v2 TEXT /* 1–4 PUA chars (C5) */) STRICT;
page(mushaf_id INTEGER, page INTEGER, first_word_id INTEGER, last_word_id INTEGER, PRIMARY KEY(mushaf_id, page)) STRICT, WITHOUT ROWID;
line(mushaf_id INTEGER, page INTEGER, line INTEGER, kind INTEGER /*0 ayah,1 surah_name,2 basmallah*/, centered INTEGER,
     first_word_id INTEGER, last_word_id INTEGER, surah_id INTEGER, PRIMARY KEY(mushaf_id, page, line)) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE ayah_fts USING fts5(loose, strict, content='', tokenize='unicode61');
-- build: INSERT … ; INSERT INTO ayah_fts(ayah_fts) VALUES('optimize'); PRAGMA journal_mode=DELETE; VACUUM; ANALYZE;
```
- Ayah page = look up `page` by mushaf, never a single `ayah.page` column (C1).
- Expected size ≈ 9–10 MB raw, ≈ 2.4 MB zstd-19 [V-R prototype].
- Open read-only: `file:///…/core.db?mode=ro&immutable=1` + `SQLITE_OPEN_READ_ONLY|URI|NO_MUTEX`, through an r2d2 pool of 2–4.
- The user DB is separate: WAL, `synchronous=NORMAL`, rusqlite_migration [V-R].

---

## 3. Arabic search (verified in compiled Rust) [V-C]
- Probe: `critic/ftsprobe` (rusqlite 0.40.2 bundled → `sqlite 3.53.2 fts5_compiled=1`).
- The `unicode61` tokenizer **on raw Uthmani text** gave **0 hits** for الرحيم, الرَّحِيمِ and الرحمن. After `normalize_ar` (NFKC; strip U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED, U+08D3–08FF, U+0640; fold أإآٱٲٳ→ا, ى/ی→ي, ک→ك, ة→ه) **all hit**, and prefix `"الرح"*` works.
- Index Imla'i normalized text in `loose` and `strict` columns.
- Map hits to Mushaf words through `word.norm_loose`; never split ayah text on spaces (يا أيها is 1 Uthmani word) [V-R].
- Translations: one pack DB per translation with external-content FTS5. Use `porter unicode61 remove_diacritics 2` for English and `unicode61 remove_diacritics 2` for other Latin/Cyrillic scripts. Pre-normalize Urdu/Persian text [V-R].

---

## 4. Fonts

### 4.1 QCF per-page fonts (on demand; Rust downloads them, CORS irrelevant)
- Template [V-C]: `https://verses.quran.foundation/fonts/quran/hafs/{v1|v2|v4/colrv1}/{woff2|woff|ttf}/p{N}.{ext}`, with N = 1..604 and no padding.
  - BunnyCDN, `content-type font/woff2`, `access-control-allow-origin: *`.
  - Sizes: V1 p1 15,328 / p604 38,204; V2 p1 40,956 / p604 53,340; V4 p1 27,432 / p604 34,636.
- Mirrors:
  - `https://quran.com/fonts/quran/hafs/...` (same bytes, **no CORS**) [V-C].
  - `https://static.qurancdn.com/fonts/quran/hafs/{v1|v2}/...`: v4/colrv1 returns **404** [V-C].
  - QUL `https://static-cdn.tarteel.ai/qul/fonts/quran_fonts/{v1,v2,v4-tajweed}/{ttf,woff,woff2}/p{N}.{ext}` (v4-tajweed p1 = 27,432 B, same as colrv1) [V-C].
- Totals (604 woff2) [V-R]: V1 45.7 MB, **V2 93.2 MB**, **V4 48.5 MB**. Per-page sizes: `mushaf-fonts/qcf_page_font_sizes_by_page.csv`.
  - **Corrected (2026-10-10, build):** these "MB" are MiB, and the per-page CSV matches the **QUL** mirror. The QF mirror
    (`verses.quran.foundation`, byte-identical to `quran.com/fonts`) is **not** byte-identical to QUL's: it serves newer
    revisions of v1 p94, v2 p72 and p250, and 82 v4 pages (e.g. p4, p153, p506). Exact QF totals: v1 47,949,744 B, v2
    97,748,636 B, v4 50,878,540 B. p1 and p604 agree on both mirrors. (docs/deviations/WP3c.md, data findings)
- V4 `colrv1` files are really **COLR v0 + CPAL** (6 palettes × 16) [V-R]. Palettes: 0/1/2 = tajweed light/dark/sepia; 3/4/5 = plain light/dark/sepia; entries 10–13 = ayah-marker colours.
  - Works in WebView2 and WKWebView (font-palette Safari 15.4+).
  - COLRv0 is broken in Safari 17.0–17.1 [V-R].
  - WebKitGTK is **[?]**.
  - V4 uses `code_v2` glyph codes with its **own line layout** (C4).
- Vertical metrics differ per page and version, so use fixed line boxes. There is no space glyph in V2/V4, so justify with `display:flex; justify-content:space-between` [V-R].

### 4.2 Headers, surah names, juz names, basmala, markers
| Asset | URL | Facts |
|---|---|---|
| Surah header (frame + name, one glyph) | `https://static-cdn.tarteel.ai/qul/fonts/surah-names/surah-header/QCF_SurahHeader_COLOR-Regular.woff2` (118,552 B) [V-C] | Monochrome despite the name. Map `surah-1`=U+FC45 … `surah-114`=U+FBEB, non-contiguous: `mushaf-fonts/qul_ligatures_surah_header_QCF_SurahHeader_COLOR.json`. ©KFGQPC, no licence text. |
| **quran-common** (QUL font 459) | `https://static-cdn.tarteel.ai/qul/fonts/common/quran-common.ttf` (125,444 B, Last-Modified 2025-05-06) [V-C] | Ligatures: `header` → U+E000 empty surah cartouche; `juz001…juz030` and `j001…j030` → U+E900–E91D juz-name calligraphy; **U+FDFD = basmala calligraphy**; `marker-full`/`marker-half` → U+FC23/U+FC22 (hizb ornaments); `makkah`/`madinah` → U+E073/U+E074; `s1open/s1close…s3*` ornament brackets. Name table has **no copyright/licence**. Map: `critic/qul_quran-common_ligatures.txt`; render: `critic/render_quran-common_glyphs.png`. **Corrected (2026-10-10, build):** the two juz series map to different code points: `juz001…juz030` → **U+E001–E01E** ("الجزء الأول" …, the Madani form) and `j001…j030` → U+E900–E91D (the juz named by its opening words, an Indo-Pak convention). The app uses U+E001 + (juz − 1). (docs/deviations/WP8c.md deviation 1) |
| Surah names (compact UI) | `https://quran.com/fonts/quran/surah-names/v1/sura_names.woff2` (88,560 B) [V-C] | liga `001…114` → name; `surah` → سورة [V-R] |
| Surah names v2 (QUL) | `https://static-cdn.tarteel.ai/qul/fonts/surah-names/v2/surah-name-v2.woff2` (211,868 B) [V-C] | ligatures `surah001…` |
| Bismillah SVG (quran.com) | `https://quran.com/bismillah.svg` [V-C] | quran.com repo has **no licence**, so don't copy it. Use quran-common U+FDFD or Unicode text. |

**Offline-first rule:** the installer must work without these KFGQPC/QUL decorative fonts.
- Draw our **own SVG cartouche** and set the surah name in the bundled Hafs font.
- Set the basmala as Unicode text `بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ` in the bundled Hafs font.
- Draw ۞ as U+06DE. **Corrected (2026-10-10, build; LEAD 17):** only for the 41 quarter starts at ayah 1 of a surah. The
  other 199 already carry the ۞ inline in the text (§2.3), so their margin marker is the quarter's label alone.
  **Superseded (2026-10-13, owner request; WP8c 9):** without decor every rub start's margin marker is the ۞ with its
  label, inline ۞ or not; with quran-common it is the print's lamp or medallion with the label inside.
- Upgrade to the QCF header, quran-common and page fonts once they are downloaded (they ship in the same on-demand "Mushaf pack").

### 4.3 Bundled Unicode Quran font (offline core)
- **KFGQPC Hafs V30**: `https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip` (844,410 B, `application/x-zip-compressed`) [V-C]. It contains `KFGQPC Hafs V30.ttf` (301,356 B, family "KFGQPC Hafs V3") [V-R].
  - The EULA allows free use and redistribution, but **no modification**: ship the TTF unchanged, with no woff2 conversion or subsetting.
  - **V30 needs U+06DD before ayah digits.** Convert "space + digits" to "space + U+06DD + digits" at DB-build time.
- Alternative: **V22** `https://static-cdn.tarteel.ai/qul/fonts/UthmanicHafs_V22.woff2` (106,856 B) [V-C]. It auto-encloses bare digits; adding U+06DD gives a double marker.
- Neither V18 nor V22 has U+FDFD [V-C cmap].
- Open-licence fallback: Scheherazade New 4.500 (OFL) [V-R].

### 4.4 UI fonts (OFL, 5.3.0) [V-R]
`@fontsource-variable/inter`, `@fontsource-variable/noto-naskh-arabic`, `@fontsource/ibm-plex-sans-arabic`, `@fontsource-variable/readex-pro`.

---

## 5. Recitation audio and timings

### 5.1 Endpoints [V-C]
- Reciters: `GET https://api.qurancdn.com/api/qdc/audio/reciters?locale=en` → 14 ids: 97, 2, 3, 4, 5, 6, 10, 161, 1, 7, 9, 12, 168, 173.
- Gapless + word timings: `GET https://api.qurancdn.com/api/qdc/audio/reciters/{id}/audio_files?chapter={n}&segments=true` → `audio_files[{id,chapter_id,file_size,format,audio_url,duration(ms),verse_timings[{verse_key,timestamp_from,timestamp_to,duration,segments[[word_pos,start_ms,end_ms]]}]}]`.
- Gapless audio URLs (verified for ch 2 and 112):
  - `https://download.quranicaudio.com/qdc/{slug}/murattal/{n}.mp3`
  - Shuraim (10): `/qdc/saud_ash-shuraym/murattal/{nnn}.mp3`
  - Dussary (97): `/quran/yasser_ad-dussary//{nnn}.mp3`
  - Mujawwad (1): `/qdc/abdul_baset/mujawwad/{n}.mp3`
  - Muallim (12): `/qdc/khalil_al_husary/muallim/{n}.mp3`
  - Tunaiji (161): `/qdc/khalifah_taniji/murattal/{n}.mp3`
- Per-ayah + segments: `GET https://api.quran.com/api/v4/recitations/{id}/by_chapter/{n}?fields=segments&per_page=300`.
  - Segments are 4-tuples `[w_start0,w_end_excl,start_ms,end_ms]`.
  - `url` is relative to `https://verses.quran.com/`, or protocol-relative.
- Word-by-word audio: `https://audio.qurancdn.com/wbw/{sss}_{aaa}_{www}.mp3` (also verses.quran.com) [V-C].
- QUL (undocumented): `GET https://qul.tarteel.ai/api/v1/audio/surah_segments/{id}?surah={n}&per_page=300`.
  - Id 65 (Maher) gives `https://audio-cdn.tarteel.ai/quran/surah/maherAlMuaiqly/murattal/mp3/001.mp3` with segments `[[pos,start,end]]`.
  - Ghamdi is id 13 [V-R].
  - The audio CDN sends **no CORS**.
- EveryAyah per-ayah: `https://everyayah.com/data/{folder}/{SSS}{AAA}.mp3`. Catalog: `https://everyayah.com/data/recitations.js` [V-R].
- quran_android timing DB: `https://android.quran.com/data/databases/audio/{db}.zip` → 301 → `https://files.quran.app/hafs/databases/audio/{db}.zip` (mishari_alafasy.zip = 94,780 B) [V-C]. These pair with QuranicAudio `quran/` files, **not** `qdc/` [V-R]. GPL: reference only.

### 5.2 Rules
- **QDC chapter files have no basmala (C8).** Play a separate basmala clip from the same reciter (EveryAyah `001001.mp3`) before surahs 2–114 except 9.
  - **Added (2026-10-10, build):** the app plays the same reciter's 1:1 segment of its own QDC surah-1 file. Reciter
    **173** (Alafasy, streaming edition) has no basmala there: its 1:1 spans 80–80 ms and the file starts after it, so the
    planner leaves the basmala out for that reciter. All 14 reciters have word segments. (docs/deviations/WP5a.md, data
    findings; INTEGRATION.md "Rust integration")
- Timings belong to **one exact file**. Store `(audio_url, content_length)` with each timing set. QDC `file_size` is unreliable, so use `Content-Length` [V-R].
- Sanitize timings:
  - Drop malformed segments.
  - Coerce strings and floats to integers.
  - Repair negative durations.
  - Choose the active word **by time** (positions repeat or go backwards).
  - Clamp word segments to the ayah range [V-R].
- Hosts: download.quranicaudio.com supports Range (206) with CORS `*`, fallback `download.quranicaudio.org` [V-R]. The file is MPEG1-L3 128k with Xing/LAME headers (Afasy 112) [V-C].
- Engine: native Rust with cpal + symphonia + rtrb + rubato + signalsmith-stretch, in-band markers, and position ticks over `tauri::ipc::Channel` at ~30 Hz [V-R design; cargo-check only].
- Media controls: a custom `media_session` crate (SMTC via windows 0.62.2, MPNowPlayingInfoCenter via objc2-media-player 0.3.2, MPRIS via mpris-server 0.10.0). Call `SetCurrentProcessExplicitAppUserModelID(identifier)` on Windows [V-R].

---

## 6. Translations and tafsir
- Whole-Quran translation dump [V-C]: `GET https://api.quran.com/api/v4/quran/translations/{id}?fields=verse_key&foot_notes=true` → 6,236 rows `{resource_id,verse_key,text,foot_notes{id:html}}`.
  - Saheeh (20) = 1,492,722 B and 1,903 footnotes.
  - `meta.translation_name` is present.
  - Clear Quran **131 is empty** [V-C].
  - Legacy/QF content falls under the 1-week cache rule, so use it for **dev and fallback only**.
- Tafsir: `GET /api/v4/tafsirs/{id}/by_chapter/{ch}?per_page=300`, looping on `pagination.next_page`. `/quran/tafsirs/{id}` is broken (empty) [V-R].
  - **Added (2026-10-10, build):** As-Sa'di (91) has 6,177 rows: 59 ayahs have no row at all (a legitimate "no tafsir
    here"). Ibn Kathir (169) has only empty records for surah 105 (a chapter with no commentary). (docs/deviations/WP5a.md,
    INTEGRATION.md "Rust-app fixes, round 1")
- **QuranEnc** (licence-clean, republish allowed unmodified with attribution) [V-C]:
  - List: `https://quranenc.com/api/v1/translations/list/{iso}`. en → `english_rwwad@1.0.19`, `english_saheeh@1.1.2`, `english_hilali_khan@1.1.2`.
  - SQLite: `https://quranenc.com/downloads/sqlite/{key}.zip` (english_saheeh 518,866 B).
  - Table: `translations(id,sura,aya,translation,footnotes)` [V-R].
  - **Added (2026-10-10, build):** every QuranEnc zip answers the constant `Last-Modified: Thu, 26 Mar 2000 17:35:45 GMT`,
    so update checks must use the ETag (`If-None-Match`; nginx `"<mtime hex>-<size hex>"`). The exports differ per
    translation: HTML fragments, `(n) ` or `n. ` number prefixes, `[n]` notes (some mid-line), Indonesian `n)` notes and
    general notes before the first marker. (docs/deviations/WP5a.md, WP5c.md deviation 1)
- Tanzil translations: `https://tanzil.net/trans/?transID={id}&type=txt-2`. Non-commercial; link back if more than 3 translations are used [V-R].
- QF Content API (compliant offline path for QF-only items: Ibn Kathir 169, Ma'arif 168, Sa'di 91, Muyassar 16, WBW):
  - Base `https://apis.quran.foundation/content/api/v4`; token `POST https://oauth2.quran.foundation/oauth2/token` (client_credentials, scope=content); headers `x-auth-token`, `x-client-id`.
  - Unauthenticated calls return 400 [V-R].
  - The secret **must not** be embedded in the app, so run a backend proxy (Cloudflare Worker) for `/resources/sync` and `/resources/snapshots/{group}/{id}`. Re-sync every 7 days or less [V-C terms].
- Storage: `content.sqlite` / per-pack DB. Footnotes are normalized to `<sup class="fn" data-fn>`, sanitized with ammonia 4.2.1 in Rust and DOMPurify 3.4.16 in the webview [V-R].

---

## 7. Tauri platform facts (verified on Windows/WebView2 154 by the probe) [V-R]
- **Custom protocol** `register_asynchronous_uri_scheme_protocol("quran", …)`. URL is `http://quran.localhost/<path>` on Windows and `quran://localhost/<path>` on macOS/Linux. The app origin on Windows is `http://tauri.localhost`.
  - The handler must implement Range (206) and send `Access-Control-Allow-Origin: *`, otherwise FontFace fails.
  - Use exact MIME types (`font/woff2`, `audio/mpeg`).
  - Allow only `Component::Normal` path components.
  - Use `convertFileSrc(rel,'quran')` to build URLs.
- The asset protocol sniffs MIME (woff2 → `application/font-woff`, unknown → `text/html`) and caps responses at 1000 KiB per range. **Keep it disabled.**
- CSP must list both scheme forms in font-src, media-src, img-src and connect-src (`quran: http://quran.localhost`), plus `ipc: http://ipc.localhost`.
- `ipc::Channel` is ordered. For binary data use `Channel<InvokeResponseBody>` with `Raw`, never `Channel<Vec<u8>>` (that becomes a JSON array). Events are low-throughput only.
- `backgroundThrottling` **cannot** be disabled on Windows or Linux, which is why audio and memorization logic live in Rust.
- Resources: `"bundle":{"resources":{"resources/core.db":"data/core.db"}}`, then `app.path().resolve("data/core.db", BaseDirectory::Resource)`. On Windows the path comes back with a `\\?\` prefix: strip it (dunce) before handing it to JS.
- Windows chrome: `decorations:false, transparent:true, windowEffects mica, noRedirectionBitmap:true, visible:false` (window-state shows it).
- macOS: `titleBarStyle:"overlay", hiddenTitle:true, trafficLightPosition`.
- Per-OS conf files merge with RFC 7396, so arrays are replaced whole.
- Testing: `@tauri-apps/api/mocks` (`mockIPC(cb,{shouldMockEvents:true})`, `mockWindows`, `mockConvertFileSrc`). E2E: `@wdio/tauri-service` 1.5.0, cross-platform.
  - **Corrected (2026-10-10, build):** in @tauri-apps/api 2.12.2 the built-in event mock removes listeners by `args.id`
    while `unlisten` sends `eventId`, so unlistened handlers stay registered. The app's mock uses
    `shouldMockEvents: false` and answers `plugin:event|listen/unlisten/emit` itself (docs/deviations/WP0C.md deviation 8).
    The QA harness drives the real app over CDP with playwright-core instead of WebdriverIO.
  - **Added (2026-10-10, build):** WebKitGTK (2.52.6, Ubuntu 24.04) applies **no CORS check** to custom-scheme loads, so
    `FontFace(url(quran://…))` loads on Linux even without `Access-Control-Allow-Origin`; macOS is unverified at runtime and
    ships the bytes transport (docs/deviations/WP6a.md, font-transport spike).

---

## 8. Remaining gaps (not closable by research alone)
1. **Licence/permission for QUL layout and glyph-code data** (layouts 10/15/19, scripts 57/61/312/60; **Corrected:** the
   search seed is script 54, not 60, C13). No licence is published, and the data originates from QF/KFGQPC. Get written permission from Tarteel/QUL, and ideally QF, before shipping `core.db`.
2. **Human QUL login** is required to obtain those files. There is **no complete no-login source** (C6). The ISC-licensed npm `quran-madina-html@1.0.1` has a V1 (1405H) line-by-line layout keyed by sura/aya/page/line with Tanzil text. It is usable only as a V1 cross-check, and its provenance is unclear.
3. **Centring flags for V1 and V4** exist only in QUL layouts 15/19. For V2, quran.com's constant list plus pages 1–2 is verified.
4. **WebKitGTK** COLRv0 + `font-palette` rendering is untested. Add a runtime canvas probe that falls back to V2 monochrome.
5. **Licences of decorative fonts:** QCF_SurahHeader (©KFGQPC), quran-common (no licence string) and sura_names (none). Download them on demand together with the QCF pack, with our own SVG/Unicode fallback in the installer.
6. **QF Developer Console account + backend proxy** are needed for any QF Content Sync (QF-only tafsir and WBW). Production use needs QF approval.
7. **Audio rights:** no source grants redistribution (QuranicAudio says personal use only). Stream and cache per user inside app storage only; never offer a self-hosted mirror.
8. **Tanzil text download** requires accepting Tanzil's terms (`agree=true`). The user must do this, not an agent.
9. **Not researched:** code signing (Authenticode, Apple notarization), updater signing keys, Linux packaging CI (Ubuntu 22.04 base).

## 9. Open risks
- QF terms (changed 2026-10-04) bind anything obtained from QF APIs, including **indexes** (Derived Materials). Legacy `api.quran.com` is QF-operated (`x-qf-origin: qf-nonfaceing-data-legacy-api-quran`) [V-C] and may be shut off.
- The 3 extra QUL word_index slots are unexplained (C7). Mixing word ids from API and QUL corrupts highlighting; always join on `location`.
- Mixing V1/V2/V4 glyph codes, page starts or line numbers breaks pages (C1, C4). Every layout-dependent table must be keyed by `mushaf_id`.
- Multi-glyph word codes (C5): a renderer that assumes one char per word will misplace waqf marks and highlights.
- tauri-specta and specta are RC (rc.25). Tauri 3 alpha exists. Pin everything exactly.
- signalsmith-stretch needs libclang and was not compiled. Keep the WSOLA fallback. macOS/Linux runtime has not been exercised (all probes ran on Windows 11).
- Safari 17.0–17.1 COLRv0 regression (macOS 14.0/14.1), and WKWebView has no COLRv1. If upstream replaces `v4/colrv1` with real COLRv1, macOS breaks, so record each downloaded file's COLR version.
- panic="abort" in release: no `unwrap()` in commands or protocol handlers.
- MAX_PATH: SQLite's Windows VFS fails at 260-char paths. Native tools (curl.exe, link.exe) failed in the long scratchpad path, so build in short directories.

## 10. Evidence index (critic)
`research/critic/`:
- `v1v2_summary.json`, `v1v2_page_starts.json`, `tanzil_vs_v1_v2_page_starts.txt`
- `p600_default.json`, `p600_m1.json`, `p600_m2.json`, `pg599.json`, `qdc_p600_m1.json`, `qdc_p600_m2.json`
- `critic_analyses.txt` (header derivation, multi-glyph counts, dump scan, word_index offsets, V4-vs-V2 diffs)
- `url_head_checks.txt`, `qdc_reciters.json`, `a_7_2.json`, `qdc_basmala_check.txt`
- `qf_terms_key_clauses.txt`, `qf_terms_context.txt`
- `qul_quran-common_ligatures.txt`, `render_quran-common_glyphs.png`
- `ftsprobe/` (Cargo.toml, src/main.rs, run.log)
