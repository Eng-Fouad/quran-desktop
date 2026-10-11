# Quran for Desktop: Architecture & Engineering Spec

> **v1.2 (2026-10-11): read this document together with [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md).** All 46
> work packages are built. Their accepted deviations, the lead's decisions ([`deviations/LEAD.md`](deviations/LEAD.md)) and
> the integration phase are folded into those notes, organised by this document's sections; where the two disagree, the
> notes win. The few corrections made here in place are marked **(v1.2)**: the search seed and QUL resource ids (§3.1,
> §4.2, §4.3), cross-page surah headers and the inline ۞ (§4.2, §4.4, §8.9), the gates that follow from them (§4.5 G4, G5b, G8,
> G14, G15), and the §14.3 acceptance lines with several test filters (now
> `cargo test -p <crate> --lib -- <filter> <filter>`). Contract changes since the freeze are listed in
> [`contract-changes.md`](contract-changes.md).

> Status: **authoritative** (v1.1, 2026-10-10; revision pass after three reviews, see the Review log at the end).
> This is the spec that about 50 session-sized work packages (§14), run by up to 12 agents in parallel, implement from.
> Inputs: `docs/BRIEF.md` (decided product, stack, layout, data and licensing) and `docs/research/FACT_SHEET.md`
> (verified facts). This document does not re-open BRIEF decisions. Where it adds a decision, §0.3 lists it and the
> section gives the reason. If code and this document disagree, the code is wrong unless the lead changes this document.
> Change process (§14.2): packages never edit this file. A package records any deviation in its own
> `docs/deviations/WPxx.md`, and the lead folds those into this document between waves. Contract sections (§3 DDL, §5 IPC)
> change only through a contract PR that touches the frozen contract files (§14.2) plus the regenerated `bindings.ts` and appends an entry to
> `docs/contract-changes.md`.
>
> **Identity (Changed by LEAD 16, 2026-10-10; docs/deviations/LEAD.md item 16).** The app adopts the github.com/quran
> (Quran.com) identity: product name **Quran**, full name **Quran for Desktop** (Arabic **قرآن** / **قرآن لسطح المكتب**),
> bundle identifier and AUMID `com.quran.labs.desktop`, licence **GPL-3.0-or-later** (`LICENSE`), User-Agent
> `QuranForDesktop/<version>`, and the Quran.com mark as the icon (§9.9). Crate, binary and repository names stay
> `quran-desktop`. The sections below carry the new values.

## 0. How to read this document

### 0.1 Normative words
**MUST**, **MUST NOT**, **SHOULD** and **MAY** are used in the RFC 2119 sense. "Tunable" marks a constant that implementers
calibrate against screenshots (§12.6), and record in the single file named for it.

### 0.2 Global conventions (apply everywhere)
| Topic | Rule |
|---|---|
| Ayah id | `AyahId = u32`, 1..=6236, canonical Hafs order. The `(surah, ayah)` pair is `AyahRef`. |
| Word id | `WordId = u32`, 1..=83,665. It is **our own** sequential index in (surah, ayah, position) order, end markers included (BRIEF §4). Sources are joined on location `s:a:w`, never on source ids (FACT C7). |
| Layout vs style | A **layout** (`MushafLayout`: `v2`, `v1`, `v4`, i.e. DB `mushaf_id` 1, 2, 19) is page and line geometry. A **style** (`MushafStyle`: `hafs`, `qcf_v2`, `qcf_v1`, `qcf_v4`) is a glyph source plus a layout: hafs→v2, qcf_v2→v2, qcf_v1→v1, qcf_v4→v4. Every page/line query is keyed by layout (FACT C1, C4). |
| Integers over IPC | DTOs use only `u32`, `i32`, `String`, `bool`, `Option<T>`, `Vec<T>` and other DTOs. **No floats** (specta-typescript maps `f64` to `number \| null`), and no `u64`/`i64`/`usize` (the exporter rejects them). Fractions use integer percent or permille (`speed_pct: 125`). Byte sizes use `u32` bytes per file and `u32` KiB (`*_kib`) for aggregates. Timestamps are `u32` Unix **seconds** (`*_at`). Positions are `u32` milliseconds. |
| serde casing | Structs: `#[serde(rename_all = "camelCase")]`. Unit-only enums (TS string unions): `#[serde(rename_all = "snake_case")]`. Data enums: **adjacently tagged** `#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]` (the form verified in the tauri-specta probe). `AppError` is the only exception (`tag = "kind", content = "message"`). **`Settings` and every nested settings struct are camelCase over IPC**, so TypeScript always uses the generated names (`settings.value.pageTurnAnimation`, `settings.update({ uiLanguage: 'ar' })`). The user.db `setting.key` is the Rust field name in snake_case, taken from the explicit `SETTING_FIELDS` table in `user_db/settings.rs` (§3.2), independent of the serde rename. |
| Errors | Each crate has one `thiserror` enum. Every IPC command returns `Result<T, AppError>` (§5.2). Tauri itself rejects with a plain **string** for argument-deserialisation and unmanaged-state errors, so the frontend `call()` normalises both shapes (§5.16). |
| Panics | Release uses `panic = "abort"`, so any panic is a crash. `unwrap()`, `expect()`, indexing/slicing that can panic, `panic!`, `todo!`, `unimplemented!` and `unreachable!` are **forbidden** in command handlers, the protocol handler, audio threads and download tasks. Lints: `[workspace.lints.clippy]` denies `unwrap_used`/`expect_used` everywhere (§2.1). `quran-audio`, `quran-packs` and `src-tauri` additionally put `#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::panic, clippy::todo, clippy::unimplemented, clippy::unreachable))]` at the crate root (test modules and `tests/` are exempt). Threads are spawned with `std::thread::Builder::new().name(..).spawn(..)?`, never `std::thread::spawn` (which panics when the OS refuses a thread). The audio host is chosen with `cpal::available_hosts()` + `cpal::host_from_id()`, never `cpal::default_host()` (it calls `.expect` on Linux and macOS). |
| Threads | A plain `#[tauri::command] fn` runs on the main thread. Every command that touches SQLite, disk or network MUST be `async` and do the work in `tauri::async_runtime::spawn_blocking` (blocking IO) or `async` (reqwest). **Never call `Handle::block_on`/`block_on` from a command, an `async fn`, or any tokio worker thread** (tokio panics there, which aborts the process). The only allowed `block_on` sites are the `TimingsSource`/`SourceProvider` impls running on the `qd-audio-ctl` thread (§2.3.2), each guarded by `debug_assert!(tokio::runtime::Handle::try_current().is_err())`. |
| Logging | The `log` crate everywhere (tauri-plugin-log collects it). No `println!`. Never log user note bodies or file paths that contain a user name at info level. |
| Paths | All app data lives under `app_local_data_dir()` (§2.8.3). Paths sent to JS are `dunce::simplified` (no `\\?\` prefix). |
| Digits | Mushaf furniture always uses Eastern Arabic numbers (`ar-u-nu-arab`). UI numbers follow the UI language (§11). **(v1.2)** The two systems are called Western Arabic and Eastern Arabic numbers, never "Indic" (IMPLEMENTATION_NOTES §13). |
| Text direction | The Mushaf is always `lang="ar" dir="rtl"`. The UI follows the UI language. |

### 0.3 Decisions made here, beyond BRIEF (with reasons)
| # | Decision | Why |
|---|---|---|
| D1 | Add a **contract crate `crates/quran-types`** (serde + specta DTOs only, no logic). | One owner (WP0A) freezes the IPC contract before wave 1. Other crates return DTOs directly, so there's no mapping layer to drift. It depends on neither tauri nor SQLite. |
| D2 | **No floats in IPC** (percent/permille integers; KiB for aggregates; Unix seconds). | specta exports `f64` as `number \| null`, which leaks nulls into every TS consumer. |
| D3 | App data root is `app_local_data_dir()`, not `app_data_dir()`. | On Windows `app_data_dir` is *Roaming*, which is wrong for GB-sized audio and unsafe for SQLite WAL under folder redirection. On macOS and Linux the two are identical. |
| D4 | The QDC dev adapter subtracts **7 from `line_number` on pages 1 and 2**. | Verified live on 2026-10-10 for mushaf 1, 2 and 19: QDC returns lines 9–15 (p1) and 10–15 (p2) where the layout has 2–8 and 3–8 (`line_v2` confirms). Without the fix the C15 header derivation breaks. |
| D5 | Canonical V1 grouping for 38:24:32–33 is `code_v1 = U+FBE9 U+FBEA` / `U+FBEB`. | Verified live on QDC (mushaf 2, page 454, lines 11 and 12). This matches the V2 structure (word + ۩ in :32, marker alone in :33). The qul adapter normalises to it. |
| D6 | Division metadata has **one source per field**: juz, hizb-of-60 and manzil from **Tanzil `quran-data.xml`**, hard cross-checked against the mushaf source (0 differences, verified 2026-10-10). **Rub** (and the `ayah.flags` bits 0/1 and the ۞ margin marker that depend on it) from the **mushaf source** (QDC `rub_el_hizb_number` in the qdc adapter, QUL metadata 67 in the qul adapter), cross-checked against Tanzil with the committed allowlist `xtask/data/division_exceptions.toml` (exactly one entry: `rub 106: source 15:49 / tanzil 15:50`). **Ruku** from Tanzil only (556 rows; the Madani print has no ruku marks; no per-ayah cross-check). **Sajda** from Tanzil only (15, with kinds); QDC `sajdah_number` is never used. English surah meanings from Tanzil `ename`. | Verified against all 114 QDC `verses/by_chapter` responses: juz/hizb/manzil 0 mismatches; rub 1 (106 starts at 15:49 in QDC/KFGQPC, 15:50 in Tanzil); ruku 2,904 ayahs differ (QDC numbers 558 rukus); QDC `sajdah_number` misses 22:77 although that word's glyph text carries ۩. Tanzil is the only verified, directly downloadable CC BY source; the ۞ must sit where the printed page puts it. |
| D7 | `word.location` is **not stored** in the shipped core.db (it's derivable from surah/ayah/position). | Saves ~2 MB and an index. xtask keeps it in a temp table. |
| D8 | Bindings are exported only by `cargo test export_bindings`, **never** at app start. | Avoids HMR reload loops and dirty working trees in dev. CI checks for drift. |
| D9 | The browser mock replaces the **typed `commands` object** (`mockCommands satisfies typeof commands`), and `mockIPC` only provides the runtime (events, channels, windows). | The TS compiler then enforces that the mock implements exactly the generated contract. Raw `mockIPC` handlers keyed by snake_case strings can't be type-checked. |
| D10 | Fixtures are **generated, never committed** (`src/lib/ipc/mock/fixtures/` is gitignored). WP0C ships a synthetic generator so UI work starts before WP3a/WP1a deliver. | Fixtures are a subset of core.db, which is never committed (BRIEF §4). |
| D11 | **Hybrid key matching** (§7.7): letters and punctuation match `e.key` when it is printable ASCII; when `e.key` is non-ASCII (Arabic, Persian, Cyrillic, … layouts) they fall back to `e.code`; digits always match `e.code`; named keys (arrows, Page*, Home/End, Space, Enter, Escape, F-keys) match `e.key`/`e.code` names. Labels come from `navigator.keyboard.getLayoutMap()` where available (WebView2), else the US label. | Pure `code` matching breaks AZERTY/QWERTZ/Dvorak/Turkish users (`?` is Shift+, on AZERTY = code `KeyM`, so the sheet never opened and Mute fired). Pure `key` matching breaks Arabic layouts. The hybrid works for both. |
| D12 | Highlight rectangles are computed once per rendition from word boxes (one layout read in `rAF`) and drawn in a layer under the glyph layer. Glyph colours are never changed for highlights. | Diacritics stay readable. The method works for COLR (V4). It gives 60 fps transforms. |
| D13 | QCF font swap = **two stacked renditions with an opacity cross-fade** (fallback Hafs → QCF). A page whose font file is already on disk waits for `FontFace.load()` (a few ms) before its first paint and never shows the fallback. | This is the only way to get CLS = 0 when word boxes change. |
| D14 | One shared V4 palette rule: `@font-palette-values --qd-v4 { font-family: <all loaded v4 families>; base-palette; override-colors }`, regenerated on theme or family-set change. | `var()` is invalid inside `@font-palette-values`, and one rule covers every page. |
| D15 | Speed changes **flush and re-seek** at the audible position. Repeats, A-B wraps, gaps and ayah boundaries are in-band markers (no flush). | An in-band speed change would lag by the whole ring (≈750 ms). |
| D16 | The audio ring is **750 ms** (the sketch used 1.5 s). | Halves seek and flush latency. Streaming stalls are absorbed by the stream-download buffer, not the ring. |
| D17 | The Mushaf text block is **16.5 qfs wide × 15 × 1.75 qfs tall** for every style. Only `--glyph-scale` varies per style. | Switching style never moves the frame (CLS 0). The aspect matches the printed Madani text block (≈0.63). |
| D18 | Translation-mode Arabic uses the bundled Hafs font only (no per-verse QCF fonts in v1). | Cuts font churn in a virtualised list. Stretch goal. |
| D19 | No output-device picker in v1. The engine follows the system default device and survives device changes. **cpal 0.18.2 WASAPI does not follow the default device: it reports `StreamInvalidated` (or `DeviceNotAvailable` when no default remains) and the engine rebuilds.** CoreAudio and PipeWire default-device streams report `DeviceChanged`, which means "already rerouted, no rebuild" (§2.3.6). | Scope. Verified in cpal-0.18.2 `error.rs` (DeviceChanged: "no rebuild is required") and `host/wasapi/stream.rs` ("WASAPI never rebinds the IAudioClient"). |
| D20 | QF-sourced runtime content (QDC timings, Quran.com tafsir, WBW) goes in **`content.db`** with `fetched_at` and a per-row **`pinned`** flag. Rows that back an installed pack or a pinned (explicitly downloaded) audio file are `pinned = 1` and survive "Clear cache"; stream-only rows and the `kv` table are disposable. Licence-clean packs (QuranEnc) go in versioned pack DBs. | Keeps the QF 7-day revalidation rule mechanical (§2.5.7) without letting "Clear cache" silently break installed packs or offline playback of pinned audio (the previous "disposable cache" design did). One DB with a pinned flag instead of two DBs avoids migrating rows when a surah is pinned. |
| D21 | Audio files live in `packs/audio/` (data dir), not the OS cache dir. Streamed files are LRU-evictable (`pinned = 0`). Explicit downloads are pinned. | macOS may purge `~/Library/Caches`, and explicit downloads must survive. |
| D22 | `tauri-plugin-os` (BRIEF §2, already in the scaffold) is registered and used **from Rust only**: `AppInfo.os_version` and the first-run UI-language guess come from `tauri_plugin_os::version()` / `tauri_plugin_os::locale()` in `app_bootstrap`/setup. The frontend never calls the plugin (platform comes from `app_bootstrap`), so no `os:` permission is granted. | Keeps BRIEF's plugin list; gives `os_version` and the locale a defined source without extra crates. |
| D23 | The KFGQPC Hafs V30 TTF is fetched by `cargo xtask fetch-assets` (size-checked, sha-locked) into `public/fonts/KFGQPC-Hafs-V30.ttf` (gitignored; its licence text beside it is committed). It is still bundled in installers. **Changed by LEAD 24:** the unmodified pinned TTF is also committed at `xtask/assets/KFGQPC-Hafs-V30.ttf`, and fetch-assets falls back to it when the download fails (§4.7). | The EULA allows unmodified redistribution. GitHub's runners cannot connect to fonts.qurancomplex.gov.sa, so CI needs a copy it can reach. Open question 5 in §15.3 is answered. |
| D24 | Debug builds honour `QD_TEST=1` (exposes `window.__QD_TEST__`, sets `AppInfo.testMode`), `QD_DATA_DIR` (overrides the data root), `QD_CORE_DB` (core.db path; default `$CARGO_MANIFEST_DIR/resources/core.db`) and `QD_AUDIO_SINK=null\|wav:<path>` (null or WAV-file output plus a marker/tick log). Release builds compile all of them out (`#[cfg(debug_assertions)]`). The scaffold's `QURAN_DESKTOP_QA`/`QURAN_DESKTOP_DATA_DIR` names are renamed to these in `scripts/qa/*` (WP0D). | Deterministic CDP screenshot, metric and audio runs (§12.6) without test-only code in release. |
| D25 | Memorisation scheduling is a deterministic Leitner-style table (§5.10), not FSRS. | Predictable, explainable, testable. FSRS can replace it later without a schema change (`strength`/`due_at` are generic). |
| D26 | **Click selects and shows the `AyahActionBar`; the side pane opens from the bar, a double-click or Enter** (BRIEF §1.1.1 says "click → select (opens side pane)"). | Reading flow: a pane popping open on every click covers text and shifts attention. The action bar makes play/repeat/bookmark/highlight/note/copy/tafsir discoverable for mouse users, which the right-click menu alone did not. `settings.ayahActionBar = false` restores a bar-less click. |
| D27 | **UI scale = webview zoom** (`WebviewWindow::set_zoom`, applied from Rust), range 80–200 %. | Every type and component token is in px, so a root `font-size` scale was a no-op. Zoom scales chrome uniformly; `fitLayout` measures CSS px, so the Mushaf still fits the canvas. |
| D28 | The **player dock placement is chosen from geometry only** (side card vs bottom bar, §8.2), never from playback state. | Reserving an 84 px bar while idle shrank glyphs 12–14 % on common laptops; placing it by geometry means nothing shifts when playback starts. |
| D29 | The browser mock is selected by the **compile-time** constant `__MOCK_IPC__` (`vite --mode mock`), never by a runtime check. | Rollup then drops the mock, synthetic generator and fixture chunks from production `dist/`, so a local `pnpm app:build` can never bundle QF-derived fixtures into an installer (FACT §2.1). |
| D30 | QCF page and decor fonts load **by URL** (`quran://`) or **by bytes** (`new FontFace(family, ArrayBuffer)` from a raw IPC response), chosen per platform by `AppInfo.fontTransport` (§5.3, §8.5). Default `url`; WP6a's day-1 spike decides Linux and macOS. | `FontFace` URL loads are CORS-mode; wry registers custom schemes on WebKitGTK only as secure, never as CORS-enabled, and only WebView2 was probed. |

### 0.4 Glossary
- **qfs**: Quran font size in CSS px, the unit of all Mushaf geometry (§8.2).
- **Rendition**: one rendered glyph layer of a page in one font (fallback Hafs or QCF).
- **Segment**: one playable audio range: an ayah, or a basmala before a surah (§2.3).
- **Generation**: the audio flush counter. Ring frames from an older generation are discarded (§2.3.4).
- **Pack**: an installable content unit from `catalog.json` (§2.5).
- **Pinned**: explicitly downloaded content (audio file, pack chapter, timings) that survives "Clear cache" (D20).
- **Reading cursor / action target**: `reader.cursorAyahId`, the single keyboard position in the Mushaf; the action target is
  the visible selection, else the visible cursor, else the first visible ayah (§8.15).
- **Dock placement**: `side` (card beside the pages), `bar` or `compact` (bottom pill), chosen from geometry only (D28, §8.2).
- **Inert handle**: a wave-0 constructor result that does no IO, so the skeleton app boots (§14.2).
- **IC1 / IC2**: the integration checkpoints in the real app (§12.6, §14.1).

---

## 1. System overview

### 1.1 Process and thread model
```
┌──────────────────────────── OS process: quran-desktop (Rust) ─────────────────────────────────────┐
│ main thread ........ tao event loop: windows, tray, menus; macOS media-session calls (run_on_main)  │
│ tokio runtime ...... tauri::async_runtime (multi-thread): async commands, reqwest downloads,        │
│                      stream-download tasks, revalidator, pack job workers                           │
│ blocking pool ...... spawn_blocking: every SQLite query, custom-protocol file reads, zip/sha256     │
│ qd-audio-ctl ....... engine control loop: commands → planner → timings/sources → decode commands    │
│ qd-audio-decode .... symphonia → WSOLA (speed) → rubato (rate) → channel map → rtrb ring + markers  │
│ qd-audio-out ....... owns cpal::Stream; rebuilds it on StreamInvalidated/DeviceNotAvailable (§2.3.6)│
│ qd-audio-tick ...... 30 Hz: atomics → Channel<AudioTick>; marker edges → events, tray, media session │
│ qd-media ........... media-session backend (Windows SMTC on an MTA thread, §2.4; Linux MPRIS executor)│
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ invoke (JSON)  │ Channel<T> (ordered)  │ events (low-rate JSON)  ▲ quran:// GET (fonts, Range)
        │                ▼                      ▼                         │
┌──────────────────────── WebView process (WebView2 / WKWebView / WebKitGTK) ─────────────────────────┐
│ Svelte 5 SPA: rune stores (*.svelte.ts) → components; rAF interpolation of audio position;          │
│ FontFace registry (QCF page fonts via quran://); no network access except quran:// and ipc:         │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
Ownership: AppState (Tauri managed, Send + Sync) holds CoreDb (r2d2 pool, immutable RO), UserDb (Mutex<Connection>, WAL),
ContentDb (Mutex<Connection>, WAL), PackManager (Arc), PackEventsImpl, AudioService (engine handle), MediaSession (OnceLock).
```
Real-time rules: the cpal callback MUST NOT allocate, lock, log or block. It reads `rtrb` consumers and atomics
only. The decode thread MUST NOT do network IO directly. It only reads `MediaSource`s handed over by the control
thread. Its reads may block on stream-download, but those reads are prefetched.

### 1.2 Data flow: open a page
1. `ReaderStore.goToPage(262)` (or a key, palette or search jump) sets `page` and pushes nav history.
2. `PageCache.ensure(style, visiblePages ∪ prefetch)` calls `api.mushafGetPages(style, [262, 263])` if they aren't cached.
   Rust: `spawn_blocking` → `CoreDb::pages(style, &pages)` → **one SQL query per page** (§3.1.4) → `Vec<PageData>`.
3. `FontManager.ensure(style, pages)`:
   - If the page font is on disk (from the `mushafEnsurePageFonts` result, cached), create `FontFace(url quran://…)` and
     `await load()` (≈2–10 ms). The page's first paint uses QCF directly.
   - Otherwise render the Hafs fallback rendition now. In parallel, `api.mushafEnsurePageFonts(style, pages, "interactive")`
     → PackManager interactive lane downloads the woff2 → returns the URL → load → cross-fade (D13).
4. `LibraryStore.marksFor(layout, ayahRange)` calls `api.userMarks(...)` → the user-highlight layer and the margin marks
   (bookmarks, notes, reading ribbon, page dog-ear; §8.9).
5. When WBW is on, `api.wbwGetRange(packId, firstWord, lastWord)` (fetched on demand per chapter if missing and online).
6. `requestIdleCallback`: prefetch PageData and fonts for ±2 pages (±4 in a spread).
7. 1 s after settling, `api.positionSet(...)`. After 3 s dwell, `api.historyRecord(...)`.

### 1.3 Data flow: play a recitation with highlighting
1. `PlayerStore.playFrom({ayahId})` calls `api.audioPlay(PlayRequest)` → `AudioService::play` → crossbeam → `qd-audio-ctl`.
2. The control thread resolves timings: `TimingsSource::surah_timings(reciter, s)` reads content.db and, if missing or stale and
   online, runs the QDC fetch → sanitise → store (a blocking call that is legal only on `qd-audio-ctl`, §0.2). It also loads
   surah 1 timings for the basmala segment (§2.3.3).
3. The planner builds `Vec<Segment>`: basmala (surah 1 file, 1:1 range; skipped with a notice when offline and not cached) +
   ayah segments + repeat and gap policy.
4. `SourceProvider::open(FileKey)` returns the cached `.mp3`, reuses a live stream for the same key, or starts a
   stream-download reader filling `packs/audio/{r}/{sss}.stream.part` (§2.3.7).
5. The decode thread gets `Load{queue, source}`, decodes, stretches and resamples into the ring, and pushes a `Marker`
   at each segment start.
6. The cpal callback consumes frames, applies the marker at its exact frame, and publishes `file_pos_us`,
   `seg_index`, `generation` and `latency`.
7. `qd-audio-tick` (30 Hz) sends `AudioTick` over the Channel. When the segment changes it emits `AudioAyahChanged`, updates the
   tray label and calls `MediaSession::set_metadata`/`set_state`.
8. UI: `PlayerStore` interpolates `fileMs` each rAF and binary-searches the word timings (fetched once per surah via
   `api.audioGetTimings`). `ReaderStore` follow-along turns the page when the active **word**'s page ≠ the visible pages.
   `HighlightLayer` draws the ayah rects and glides the word box with a `Spring`.

### 1.4 Data flow: download a pack
1. `PacksStore.install("tr.en.saheeh")` calls `api.packsInstall(id, {type:"all"})` → `PackManager::install` → enqueue a `Job`.
2. A worker takes the job: adapter `quranenc_sqlite` → HTTP GET (Range resume) into `packs/.staging/{job}/` → sha256 +
   structural checks → transform into a pack DB (`entry` + FTS5 build) → atomic flip of the `installed_pack` row → delete the
   previous version directory.
3. Progress is sent to the `packs_subscribe` Channel at most every 100 ms per job. `PacksChanged` is emitted on completion.
   The UI updates the downloads view and enables the translation in settings.

### 1.5 Data flow: search
1. `SearchStore.query = "الرحمن"` → debounce 120 ms → `api.searchQuery({query, scope:{type:"quran"}, mode:"smart", ...})`.
2. Rust (`spawn_blocking`, core pool): `normalize_ar(q, Loose)` → `build_match` → FTS5 `ayah_fts MATCH 'loose : ("الرحمن"*)'`
   → hit ayah ids → per-hit word match mapping through `word.norm_loose` (§2.2.5) → `SearchResults` grouped by surah.
   If there are 0 hits, Smart mode expands typos against `vocab_loose` and runs the query again.
3. UI: virtualised grouped list. Enter calls `reader.goToAyah(hit.ayahId, { select: true, highlightWords: hit.matchedWordIds })`.
   The page opens with the search-hit layer on the matched words and the ayah selected.

---

## 2. Workspace and crate design

### 2.1 Workspace
```
quran-desktop/
├─ Cargo.toml                 # workspace (owner WP0A; every dependency final after wave 0, §14.2)
├─ rust-toolchain.toml        # [toolchain] channel = "1.99.0", components = ["rustfmt","clippy"]
├─ .cargo/config.toml         # aliases (§13.2)
├─ assets/brand/              # icon master SVG + exports (WP-Brand, §9.9)
├─ crates/
│  ├─ quran-types/            # D1: IPC contract DTOs (serde + specta), AppError, Settings defaults/validation
│  ├─ quran-core/             # normalize_ar, CoreDb, SearchEngine, UserDb (+migrations), ContentDb, PackDb, timings
│  ├─ quran-audio/            # engine: control/decode/output/ticker threads, WSOLA, planner, streaming sources
│  ├─ quran-packs/            # catalog, PackManager, download jobs, adapters, installers, revalidator
│  └─ media-session/          # MediaSession + backends: SMTC (windows), Now Playing (macos), MPRIS (linux)
├─ xtask/                     # build-core, verify-core, export-fixtures, fetch-assets, fetch-dev-packs, licenses, catalog-check
└─ src-tauri/                 # crate `quran-desktop`, lib `quran_desktop_lib` (thin app shell)
```
The scaffold sets `default-members = ["src-tauri"]`, so a bare `cargo build`/`cargo test` covers only the app crate. Every
command in this document therefore passes `--workspace` or `-p <crate>` explicitly.
Dependency graph (no cycles; only `src-tauri` depends on tauri):
```
quran-types ◄── quran-core ◄── quran-packs ◄──┐
     ▲    ▲                                   ├── src-tauri ──► media-session
     │    └──────── quran-audio ◄─────────────┘
     └──── xtask ──► quran-core, quran-packs (catalog model only)
```
`quran-audio` depends on `quran-types` only. It talks to storage through the traits it defines (§2.3.2).

Root `Cargo.toml`. Every version is pinned here and crates use `{ workspace = true }`:
```toml
[workspace]
resolver = "3"
members = ["src-tauri", "crates/*", "xtask"]
default-members = ["src-tauri"]          # scaffold choice; commands always pass --workspace or -p

[workspace.package]
version = "0.1.0"
edition = "2024"
rust-version = "1.95"
publish = false
license = "GPL-3.0-or-later"             # Changed by LEAD 16 (was MIT OR Apache-2.0)

[workspace.dependencies]
quran-types   = { path = "crates/quran-types" }
quran-core    = { path = "crates/quran-core" }
quran-audio   = { path = "crates/quran-audio" }
quran-packs   = { path = "crates/quran-packs" }
media-session = { path = "crates/media-session" }

tauri         = { version = "=2.12.2", features = ["tray-icon", "image-png"] }
tauri-build   = { version = "=2.7.1", features = [] }
tauri-plugin-single-instance = "=2.5.2"
tauri-plugin-window-state    = "=2.5.0"
tauri-plugin-log             = "=2.10.0"
tauri-plugin-opener          = "=2.7.0"
tauri-plugin-dialog          = "=2.8.1"
tauri-plugin-os              = "=2.4.0"   # Rust-side only (D22)
specta            = { version = "=2.0.0-rc.25", features = ["derive"] }
specta-typescript = "=0.0.12"
tauri-specta      = { version = "=2.0.0-rc.25", features = ["derive", "typescript"] }

rusqlite           = { version = "=0.40.2", features = ["bundled", "functions", "backup", "serde_json", "collation", "hooks"] }
r2d2               = "=0.8.10"
r2d2_sqlite        = "=0.35.0"
rusqlite_migration = "=2.6.0"
unicode-normalization = "=0.1.25"

cpal              = "=0.18.2"
symphonia         = { version = "=0.6.1", default-features = false, features = ["mp3", "opt-simd"] }
rtrb              = "=0.4.0"
rubato            = "=5.0.1"
crossbeam-channel = "=0.5.17"
stream-download   = { version = "=0.24.4", default-features = false, features = ["reqwest-rustls"] }

reqwest      = { version = "=0.13.5", default-features = false, features = ["rustls", "http2", "json", "stream", "gzip", "charset", "system-proxy"] }
tokio        = { version = "1.53.2", features = ["rt", "rt-multi-thread", "sync", "time", "fs", "io-util", "macros"] }
futures-util = "0.3.34"
serde        = { version = "1.0.229", features = ["derive"] }
serde_json   = "1.0.151"
thiserror    = "2.0.21"
log          = "0.4.34"
uuid         = { version = "1.27.0", features = ["v7"] }
sha2         = "0.11.0"
hex          = "0.4.3"
zip          = { version = "9.0.0", default-features = false, features = ["deflate"] }
ammonia      = "4.2.1"
regex        = "1.13.1"           # QuranEnc footnote patterns (§2.5.6)
url          = "2.5.8"
percent-encoding = "2.3.2"        # protocol path decode (§6.3, verified probe)
dunce        = "1.0.5"
parking_lot  = "0.12.5"
time         = { version = "0.3.55", features = ["formatting", "parsing", "macros"] }
fastrand     = "2.5.0"
tempfile     = "3.27.0"
toml         = "1.1.8"            # xtask manifest + division_exceptions.toml (already in the scaffold's Cargo.lock via tauri)

windows            = { version = "=0.62.2", features = ["Foundation", "Media", "Media_Playback", "Storage_Streams", "Win32_Foundation", "Win32_System_WinRT", "Win32_System_Com", "Win32_UI_Shell"] }
objc2              = "0.6.5"
objc2-foundation   = "0.3.2"
objc2-media-player = { version = "=0.3.2", features = ["MPNowPlayingInfoCenter", "MPRemoteCommandCenter", "MPRemoteCommand", "MPRemoteCommandEvent", "MPMediaItem", "block2"] }
block2             = "0.6.2"
mpris-server       = "=0.10.0"
async-channel      = "2.5.0"
async-executor     = "1.14.0"
futures-lite       = "2.6.1"

clap      = { version = "4.6.7", features = ["derive"] }
anyhow    = "1.0.104"
quick-xml = "0.42.0"

[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
panic = "abort"
strip = true

[profile.dev.package."*"]
opt-level = 2          # symphonia, WSOLA and SQLite must run at speed in debug builds
[profile.dev.package.quran-audio]
opt-level = 3

[workspace.lints.clippy]
unwrap_used = "deny"   # every crate opts in with [lints] workspace = true; test modules use #[allow]
expect_used = "deny"
```
Crate-specific denials that must not apply workspace-wide (Cargo forbids extra `[lints]` keys next to `workspace = true`) are
crate-root attributes (§0.2): `#![cfg_attr(not(test), deny(clippy::indexing_slicing, clippy::panic, clippy::todo,
clippy::unimplemented, clippy::unreachable))]` in `quran-audio/src/lib.rs`, `quran-packs/src/lib.rs` and
`src-tauri/src/lib.rs`.

Versions not already in FACT_SHEET were read from crates.io on 2026-10-10: thiserror, reqwest, tokio, uuid, sha2, zip,
ammonia, url, dunce, fastrand, tempfile, objc2*, block2, async-*, futures-*, clap, anyhow, quick-xml and serde*. The
scaffold's additions (hex, regex, percent-encoding, parking_lot, time) are kept. Feature names for reqwest 0.13.5 (`rustls`,
`system-proxy`; the crate's `default` is `["default-tls", "charset", "http2", "system-proxy"]`, so `default-features = false`
would otherwise drop Windows/macOS system and PAC proxy support for every download and for stream-download, which shares the
client), zip 9.0.0 (`deflate`) and mpris-server 0.10.0 (default async-io runtime; `tokio` optional) were checked in the
published metadata. WP6d finalises the `objc2-foundation` feature list for macOS on the macOS CI runner. **Every crate's
`[dependencies]`/`[dev-dependencies]` (including symphonia `wav`/`pcm` dev features and `tempfile`) is written in full by WP0B,
so `Cargo.lock` is final after wave 0** (§14.2).

### 2.2 `quran-core`
No tauri dependency. It depends on quran-types, rusqlite, r2d2, r2d2_sqlite, rusqlite_migration, unicode-normalization,
serde, serde_json, thiserror, log, uuid and url.

#### 2.2.1 Module tree
```
crates/quran-core/
├─ Cargo.toml
├─ schema/core.sql            # §3.1 DDL (consumed by xtask via include_str!)                      (WP0B, frozen)
├─ schema/content.sql         # §3.3 (applied through rusqlite_migration)                          (WP0B, frozen)
├─ schema/pack.sql            # §3.4                                                               (WP0B, frozen)
├─ migrations/user/0001_init.sql        # §3.2                                                     (WP0B, frozen)
├─ tests/data/normalize_vectors.json    # shared with vitest (§12.3)                               (WP0B)
├─ tests/data/copy_vectors.json         # shared with vitest (§5.5)                                (WP1a)
├─ tests/support/{mod.rs (WP0B), mini_core.rs (WP1a), user.rs (WP2b)}
└─ src/
   ├─ lib.rs                  # declares every module; CORE_SCHEMA_VERSION = 1; NORMALIZER_VERSION = 1 (WP0B, frozen)
   ├─ error.rs                # CoreError + From<CoreError> for AppError                            (WP0B, frozen)
   ├─ normalize.rs            # normalize_ar, fold_latin, tokens                                    (WP0B)
   ├─ core_db/{mod.rs, index.rs, page.rs, text.rs}                                                  (WP1a)
   ├─ search/{mod.rs, query.rs, typo.rs, highlight.rs}                                              (WP1b)
   ├─ user_db/{mod.rs, migrations.rs, positions.rs, history.rs, search_history.rs, memo.rs,
   │           presets.rs, settings.rs, packs.rs, backup.rs}                                        (WP2b)
   ├─ user_db/{bookmarks.rs, highlights.rs, notes.rs, collections.rs, tags.rs, marks.rs}            (WP2a)
   ├─ content_db/{mod.rs, timings.rs, wbw.rs, tafsir.rs, kv.rs, clear.rs}                           (WP1c)
   ├─ pack_db/{mod.rs, reader.rs, writer.rs}                                                        (WP1c)
   └─ timings.rs              # timing model + QDC sanitiser                                        (WP1c)
```
`UserDb` methods live in `impl UserDb` blocks spread over the `user_db/*` files, so WP2a and WP2b never share a file.

#### 2.2.2 Errors
```rust
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("sqlite: {0}")]            Sqlite(#[from] rusqlite::Error),
    #[error("pool: {0}")]              Pool(#[from] r2d2::Error),
    #[error("migration: {0}")]         Migration(#[from] rusqlite_migration::Error),
    #[error("io: {0}")]                Io(#[from] std::io::Error),
    #[error("json: {0}")]              Json(#[from] serde_json::Error),
    #[error("not found: {0}")]         NotFound(String),
    #[error("invalid argument: {0}")]  InvalidArgument(String),
    #[error("schema mismatch: expected {expected}, found {found}")] SchemaMismatch { expected: u32, found: u32 },
    #[error("corrupt data: {0}")]      Corrupt(String),
    #[error("not implemented: {0}")]   NotImplemented(&'static str), // wave-0 stubs only; must not survive in an owner's merged package
}
pub type Result<T> = std::result::Result<T, CoreError>;
impl From<CoreError> for quran_types::AppError { /* §5.2 mapping table */ }
```

#### 2.2.3 `normalize_ar` (exact rules; FACT §3, rust-data-search §4.3)
```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)] pub enum Level { Strict, Loose }
pub const NORMALIZER_VERSION: u32 = 1; // bump ⇒ core.db rebuild + pack/notes FTS rebuild (startup check)
pub fn normalize_ar(s: &str, level: Level) -> String;
pub fn fold_latin(s: &str) -> String;     // NFKD, drop Mn, Unicode lowercase, collapse spaces
pub fn tokens(normalized: &str) -> impl Iterator<Item = &str>; // split on ' ', skip empty
```
Steps, applied in order to each char of `s.nfkc()`:

| Step | Input | Action | Levels |
|---|---|---|---|
| 0 | whole string | Unicode **NFKC** (ﷲ → الله; ا+U+0653 → آ; ا+U+0654 → أ; و+U+0654 → ؤ; ي+U+0654 → ئ) | both |
| 1 | U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED, U+08D3–08FF, U+0640, U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF | delete | both |
| 2 | أ U+0623, إ U+0625, آ U+0622, ٱ U+0671, ٲ U+0672, ٳ U+0673 | → ا U+0627 | both |
| 3 | ى U+0649, ی U+06CC | → ي U+064A | both |
| 4 | ک U+06A9 → ك U+0643; ہ U+06C1, ھ U+06BE → ه U+0647; ۃ U+06C3 → ة U+0629 | map | both |
| 5 | ة U+0629 | → ه U+0647 | Loose |
| 6 | ؤ U+0624 → و U+0648; ئ U+0626 → ي U+064A | map | Loose |
| 7 | ء U+0621 | delete | Loose |
| 8 | U+0660–0669, U+06F0–06F9 | → ASCII 0–9 | both |
| 9 | whitespace, ASCII punctuation, ، U+060C, ؛ U+061B, ؟ U+061F, ۔ U+06D4 | → one space; collapse runs; trim | both |

Golden vectors live in `tests/data/normalize_vectors.json` as `[{"in","strict","loose"}]`. The TS port
(`src/lib/text/normalize.ts`) MUST pass the same file. Minimum set:

| in | strict | loose |
|---|---|---|
| `بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ` | `بسم الله الرحمن الرحيم` | same |
| `ٱلرَّحۡمَٰنِ` (QPC, U+06E1 sukun) | `الرحمن` | same |
| `الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ` | `الحمد لله رب العالمين` | same |
| `الصَّلَاةَ` | `الصلاة` | `الصلاه` |
| `شَيْءٍ` | `شيء` | `شي` |
| `يُؤْمِنُونَ` | `يؤمنون` | `يومنون` |
| `شَاطِئِ` | `شاطئ` | `شاطي` |
| `إِبْرَاهِيمَ` | `ابراهيم` | same |
| `الْقُرْآنُ` | `القران` | same |
| `مُوسَىٰ` | `موسي` | same |
| `ﷲ` | `الله` | same |
| `کتابہ` | `كتابه` | same |
| `٢٥٥` | `255` | same |
| `كتاب، كتب؟  ` | `كتاب كتب` | same |

#### 2.2.4 `CoreDb`
```rust
#[derive(Clone)]
pub struct CoreDb { pool: Option<r2d2::Pool<SqliteConnectionManager>> /* None = unavailable() */, meta: Arc<CoreMeta>,
                   index: Arc<OnceLock<QuranIndex>> }
pub struct CoreMeta { pub schema_version: u32, pub normalizer_version: u32, pub source: String, pub built_at: String, pub word_count: u32 }
impl CoreDb {
    /// Opens `file:///…/core.db?mode=ro&immutable=1` (url::Url::from_file_path + query) with
    /// SQLITE_OPEN_READ_ONLY|URI|NO_MUTEX. Pool size available_parallelism().clamp(2,4).
    /// with_init: PRAGMA query_only=1; mmap_size=268435456; cache_size=-8192; temp_store=MEMORY;
    /// also registers ar_norm(text) (deterministic).
    /// Errors with SchemaMismatch if meta.schema_version != CORE_SCHEMA_VERSION. A 0-byte file (the build.rs placeholder,
    /// §5.15) or a missing `meta` table maps to `SchemaMismatch { expected: CORE_SCHEMA_VERSION, found: 0 }`.
    pub fn open(path: &Path) -> Result<Self>;
    /// Debug builds only (setup degrade path, §2.8.2): a handle whose every method returns
    /// `CoreError::NotFound("core.db missing — run pnpm core:qdc")`. Never constructed in release.
    pub fn unavailable(reason: String) -> Self;
    pub fn is_available(&self) -> bool;
    pub fn meta(&self) -> &CoreMeta;
    pub fn conn(&self) -> Result<r2d2::PooledConnection<SqliteConnectionManager>>;
    pub fn index(&self) -> Result<QuranIndex>;                                        // built once, cloned
    pub fn pages(&self, style: MushafStyle, pages: &[u32]) -> Result<Vec<PageData>>;  // 1..=8 pages, §3.1.4
    pub fn ayahs(&self, layout: MushafLayout, from: u32, to: u32) -> Result<Vec<AyahText>>; // to − from < 300
    pub fn copy_text(&self, from: u32, to: u32, opts: &CopyOptions) -> Result<String>;     // Arabic part only
    pub fn page_of_ayah(&self, layout: MushafLayout, ayah_id: u32) -> Result<u32>;
    pub fn word_range_of_ayah(&self, ayah_id: u32) -> Result<(u32, u32)>;
    pub fn word_ids_by_location(&self, locs: &[(u32, u32, u32)]) -> Result<Vec<Option<u32>>>; // WBW/timings mapping
}
```
`CoreDb` is `Clone + Send + Sync`. Call it from `spawn_blocking`.

**Page assembly:** run the §3.1.4 query and iterate rows in `(line, word id)` order.
- A new `line` value pushes a `PageLine`. A row with a non-null word id pushes a `PageWord`.
- Ayahs are collected into `PageAyah` in order of first appearance:
  - `flags` comes from `ayah.flags`.
  - `starts_on_page` is true when the first word seen has position 1.
  - `ends_on_page` is true when an `is_end` word is seen.
- `PageInfo` is built from the first and last ayah on the page and from the `surah_name` lines.

#### 2.2.5 `SearchEngine`
```rust
#[derive(Clone)] pub struct SearchEngine { core: CoreDb }
pub enum Column { Loose, Strict }
pub struct MatchExpr { pub fts: String, pub tokens: Vec<String>, pub prefix_last: bool }
impl SearchEngine {
    pub fn new(core: CoreDb) -> Self;
    pub fn search_quran(&self, req: &SearchRequest) -> Result<SearchResults>;
    pub fn search_pack(&self, pack: &PackDb, req: &SearchRequest) -> Result<SearchResults>;  // scope = translation
    pub fn search_notes(&self, user: &UserDb, req: &SearchRequest) -> Result<SearchResults>;
    pub fn suggest(&self, prefix: &str, limit: u32) -> Result<Vec<SearchSuggestion>>;
}
pub fn build_match(user_query: &str, column: Column, prefix_last: bool) -> Option<MatchExpr>;
pub fn levenshtein_bounded(a: &str, b: &str, max: u32) -> Option<u32>; // char-level, early exit
```
Algorithms:
1. **Tokenising.**
   - Split the raw query into phrase groups (`"…"`) and bare tokens.
   - Normalise each with the column's level and drop empty tokens.
   - If nothing is left, return an empty result (not an error).
2. **`build_match`.**
   - Each token becomes `"tok"`, with embedded `"` doubled.
   - A phrase becomes `"t1 t2"`.
   - In smart mode, `*` is appended to the last bare token.
   - Result: `{loose|strict} : (<terms joined by space>)`, which is an implicit AND.
3. **Modes.**
   - `smart`: Loose column, prefix on the last token, typo fallback.
   - `exact`: Strict column, no prefix.
   - `substring`: `SELECT id FROM ayah WHERE norm_loose LIKE '%'||?1||'%' ESCAPE '\' AND id BETWEEN ?3 AND ?4 ORDER BY id LIMIT ?2`,
     with `%`, `_` and `\` escaped in the needle.
4. **Query (quran scope).** Filters are pushed into SQL as an ayah-id range, because a surah and a juz are each one contiguous
   ayah-id range (from the index). With no filter the range is `1..=6236`; with both, the intersection (empty ⇒ empty result).
   - `SELECT rowid AS id FROM ayah_fts WHERE ayah_fts MATCH ?1 AND rowid BETWEEN ?3 AND ?4 ORDER BY rowid LIMIT ?2`
     (mushaf order; FTS5 handles rowid constraints natively).
   - `total` comes from `SELECT count(*) FROM ayah_fts WHERE ayah_fts MATCH ?1 AND rowid BETWEEN ?3 AND ?4` (the same predicate),
     and `truncated = total > limit`.
5. **Typo fallback** (smart mode, total = 0, every token ≥ 3 chars).
   - For each token, scan `vocab_loose` (≈14,650 terms) with `levenshtein_bounded(tok, term, if len ≥ 6 {2} else {1})`.
   - Keep up to 8 terms by `doc_count` desc, OR them (`("t1" OR "t1'" …)`) and re-run the query.
   - `suggestions` lists the terms used.
6. **Word match mapping (for highlighting).**
   - For each hit ayah: `SELECT id, norm_loose, text_imlaei FROM word WHERE id BETWEEN ?first AND ?last AND is_end = 0`.
   - A word matches if any space-split part of its `norm_loose` equals a query token, or starts with the last token in prefix mode.
   - Exact mode compares `normalize_ar(text_imlaei, Strict)`. Substring mode uses `contains`.
   - Phrase tokens are matched individually. Never split ayah or word text on spaces (FACT §3; a word's `text_hafs` can itself
     contain U+0020 before ۩, §3.1.1).
   - `SearchHit.words` is the hit ayah's per-word `text_hafs` (end marker last) and `SearchHit.first_word_id` its first word id,
     so the UI wraps `words[id − first_word_id]` for each matched id without splitting any string (§5.6).
7. **Pack scope.**
   - Normalise the query to match the pack's tokenizer: `arabic_normalized` → `normalize_ar(Loose)`, otherwise `fold_latin`.
   - Query: `SELECT rowid, snippet(entry_fts, 0, char(57344), char(57345), '…', 16) FROM entry_fts WHERE entry_fts MATCH ?1
     AND rowid BETWEEN ?3 AND ?4 ORDER BY rowid LIMIT ?2` (same id-range filter and count predicate as step 4).
   - `snippet()` returns text of the indexed column `fold`. That is the display text only when `fold == plain`
     (`porter_unicode61`, `unicode61_remove_diacritics`). For `arabic_normalized` packs (fold = `normalize_ar(plain, Loose)`:
     ة→ه, hamza dropped, harakat stripped) the snippet is **built in Rust from `plain`**: tokenise `plain` on whitespace,
     normalise each token with the pack's level, mark the tokens whose normalised form matches a query token (prefix rule as
     step 6), and cut a ±12-token window around the first match. The same Rust builder serves `like_fallback` packs and queries
     under 3 chars (`WHERE fold LIKE … AND ayah_id BETWEEN ?3 AND ?4`).
   - Snippets are HTML-escaped in Rust, then U+E000/U+E001 are replaced with `<mark>`/`</mark>`.
8. **Notes scope:** `note_fts MATCH` over `body_search`, where `body_search = fold_latin(normalize_ar(body, Loose))`, with
   `AND note.from_ayah_id <= ?4 AND note.to_ayah_id >= ?3` for the filter range.
9. **Suggest:** `SELECT term, doc_count FROM vocab_loose WHERE term >= ?1 AND term < ?1 || char(1114111) ORDER BY doc_count DESC LIMIT ?2`.

#### 2.2.6 `UserDb`
```rust
#[derive(Clone)] pub struct UserDb { conn: Arc<Mutex<rusqlite::Connection>> }
impl UserDb {
    /// journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000, MIGRATIONS.to_latest,
    /// PRAGMA optimize=0x10002, register ar_norm(). Runs purge_tombstones(30) once at open.
    pub fn open(path: &Path) -> Result<Self>;
    /// open(); on SQLITE_CORRUPT/NOTADB, a failed `quick_check`, or a failed migration: close, rename the file (and -wal/-shm)
    /// to `user.db.corrupt-{unix_ms}`, open a fresh DB, and return the quarantined path so the UI shows a recovery banner
    /// (§9.8). Never fatal. Same contract for ContentDb::open_or_recover (no banner; packs re-sync, §2.5.5).
    pub fn open_or_recover(path: &Path) -> Result<(Self, Option<PathBuf>)>;
    pub fn with<T>(&self, f: impl FnOnce(&rusqlite::Connection) -> Result<T>) -> Result<T>;
    pub fn with_tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>) -> Result<T>;
    // bookmarks
    pub fn bookmarks_list(&self, f: &BookmarkFilter) -> Result<Vec<Bookmark>>;
    pub fn bookmark_upsert(&self, input: &BookmarkInput) -> Result<Bookmark>;
    pub fn bookmark_delete(&self, id: &str) -> Result<Bookmark>;      // tombstone; returns row for undo
    pub fn bookmark_restore(&self, id: &str) -> Result<Bookmark>;
    pub fn reading_bookmark_get(&self) -> Result<Option<ReadingBookmark>>;
    pub fn reading_bookmark_set(&self, input: &ReadingBookmarkInput) -> Result<ReadingBookmarkMove>;
    pub fn reading_bookmark_clear(&self) -> Result<Option<ReadingBookmark>>;  // returns the removed row (undo of a first set)
    // highlights
    pub fn highlights_list(&self, color: Option<HighlightColor>) -> Result<Vec<Highlight>>;
    pub fn highlight_set(&self, input: &HighlightInput) -> Result<Highlight>; // overlapping ranges are split/replaced
    pub fn highlight_delete(&self, id: &str) -> Result<Highlight>;
    pub fn highlight_restore(&self, id: &str) -> Result<Highlight>;
    // notes
    pub fn notes_list(&self, f: &NoteFilter) -> Result<Vec<Note>>;
    pub fn note_get(&self, id: &str) -> Result<Note>;
    pub fn note_upsert(&self, input: &NoteInput) -> Result<Note>;     // computes body_search
    pub fn note_delete(&self, id: &str) -> Result<Note>;
    pub fn note_restore(&self, id: &str) -> Result<Note>;
    // collections & tags
    pub fn collections_list(&self) -> Result<Vec<Collection>>;
    pub fn collection_upsert(&self, input: &CollectionInput) -> Result<Collection>;
    pub fn collection_delete(&self, id: &str) -> Result<()>;
    pub fn tags_list(&self) -> Result<Vec<Tag>>;
    pub fn tag_upsert(&self, input: &TagInput) -> Result<Tag>;
    pub fn tag_delete(&self, id: &str) -> Result<()>;
    // marks for rendering
    pub fn marks(&self, layout: MushafLayout, from_ayah: u32, to_ayah: u32, pages: &[u32]) -> Result<UserMarks>;
    // positions & history
    pub fn positions(&self) -> Result<Vec<ReadingPosition>>;
    pub fn position_set(&self, p: &ReadingPosition) -> Result<()>;
    pub fn history_record(&self, h: &HistoryInput) -> Result<()>;      // dedupes same page within 10 min
    pub fn history_list(&self, limit: u32, before_id: Option<u32>) -> Result<Vec<HistoryEntry>>;
    pub fn history_clear(&self) -> Result<()>;
    pub fn search_history_add(&self, query: &str, scope: &SearchScope) -> Result<()>; // scope stored as serde JSON text
    pub fn search_history_list(&self, limit: u32) -> Result<Vec<SearchHistoryEntry>>;
    pub fn search_history_clear(&self) -> Result<()>;
    // memorisation
    pub fn memo_progress(&self, from: u32, to: u32) -> Result<Vec<MemoProgress>>;
    pub fn memo_set_status(&self, from: u32, to: u32, status: MemoStatus) -> Result<Vec<MemoProgress>>;
    pub fn memo_review(&self, input: &MemoReviewInput) -> Result<Vec<MemoProgress>>;
    pub fn memo_test_start(&self, from: u32, to: u32, start_ayah: u32) -> Result<MemoTest>;
    pub fn memo_test_finish(&self, input: &MemoTestResult) -> Result<MemoTest>;
    pub fn loop_presets(&self) -> Result<Vec<LoopPreset>>;
    pub fn loop_preset_upsert(&self, input: &LoopPresetInput) -> Result<LoopPreset>;
    pub fn loop_preset_delete(&self, id: u32) -> Result<()>;
    // settings (typed JSON per top-level key; keys from the SETTING_FIELDS table, §3.2)
    pub fn settings_load(&self) -> Result<Settings>;                 // missing or invalid keys → Settings::default() value
    pub fn settings_save(&self, next: &Settings) -> Result<Settings>; // next.validated(); writes changed keys only
    pub fn first_run(&self) -> Result<bool>;                         // true until onboarding_done is set
    // pack registry (used by quran-packs only)
    pub fn packs_installed(&self) -> Result<Vec<InstalledPackRow>>;
    pub fn pack_upsert(&self, row: &InstalledPackRow) -> Result<()>;
    pub fn pack_delete(&self, pack_id: &str) -> Result<()>;
    pub fn pack_items(&self, pack_id: &str) -> Result<Vec<PackItemRow>>;
    pub fn pack_item_upsert(&self, row: &PackItemRow) -> Result<()>;
    pub fn pack_item_delete(&self, pack_id: &str, item: &str) -> Result<()>;
    pub fn pack_item_touch(&self, pack_id: &str, item: &str) -> Result<()>;
    pub fn pack_items_evictable(&self, limit: u32) -> Result<Vec<PackItemRow>>; // pinned=0 ORDER BY last_used_at
    // maintenance
    pub fn purge_tombstones(&self, older_than_days: u32) -> Result<u32>;
    pub fn backup_to(&self, dest: &Path) -> Result<()>;              // VACUUM INTO
}
```
`InstalledPackRow` and `PackItemRow` are plain Rust structs that mirror §3.2 (not IPC types). There is a single writer behind a
`Mutex`, so there is no `SQLITE_BUSY`. Every write is its own transaction. Multi-row writes use `with_tx`.

#### 2.2.7 `ContentDb`, `PackDb`, timings
```rust
#[derive(Clone)] pub struct ContentDb { conn: Arc<Mutex<rusqlite::Connection>> } // WAL, NORMAL; own migrations (D20)
impl ContentDb {
    pub fn open(path: &Path) -> Result<Self>;
    pub fn open_or_recover(path: &Path) -> Result<(Self, Option<PathBuf>)>; // as UserDb::open_or_recover; never fatal
    pub fn timings_get(&self, reciter: u32, surah: u32) -> Result<Option<StoredTimings>>;
    pub fn timings_put(&self, t: &StoredTimings, pinned: bool) -> Result<()>; // file + ayah rows, one tx; keeps pinned=1 if set
    pub fn timings_set_pinned(&self, reciter: u32, surah: u32, pinned: bool) -> Result<()>;
    pub fn timings_delete(&self, reciter: u32, surah: u32) -> Result<()>;
    pub fn wbw_range(&self, pack_id: &str, from: u32, to: u32) -> Result<Vec<WbwEntry>>;
    pub fn wbw_put_chapter(&self, pack_id: &str, surah: u32, rows: &[WbwEntry], stamp: &ChapterStamp) -> Result<()>;
    pub fn tafsir_get(&self, pack_id: &str, ayah_id: u32) -> Result<Option<TafsirRow>>;
    pub fn tafsir_put_chapter(&self, pack_id: &str, surah: u32, rows: &[TafsirRow], stamp: &ChapterStamp) -> Result<()>;
    pub fn chapters(&self, pack_id: &str) -> Result<Vec<ChapterStamp>>;    // wbw/tafsir presence + fetched_at + pinned
    pub fn chapters_set_pinned(&self, pack_id: &str, pinned: bool) -> Result<()>; // pack installed (All) ⇒ pinned
    pub fn stale(&self, older_than_ms: i64) -> Result<Vec<StaleItem>>;     // revalidator input
    pub fn delete_pack(&self, pack_id: &str) -> Result<()>;
    /// "Clear cache": deletes every row with pinned = 0 (timings, chapters and their rows) and all kv rows, in one tx;
    /// returns what was removed so PackManager can re-sync installed_pack (§2.5.5).
    pub fn clear_unpinned(&self) -> Result<ClearReport>;
    pub fn kv_get(&self, key: &str) -> Result<Option<(String, i64)>>;      // (json, fetched_at_ms)
    pub fn kv_put(&self, key: &str, json: &str, fetched_at_ms: i64) -> Result<()>;
}
pub struct ChapterStamp { pub surah: u32, pub fetched_at_ms: i64, pub sha256: String, pub pinned: bool }
pub struct ClearReport { pub timings: Vec<(u32, u32)>, pub chapters: Vec<(String, u32)>, pub bytes: u64 }
pub struct TafsirRow { pub from_ayah_id: u32, pub to_ayah_id: u32, pub html: String }
pub struct StaleItem { pub kind: StaleKind /* Timings | Tafsir | Wbw */, pub pack_id: String, pub surah: u32, pub reciter_id: Option<u32> }

#[derive(Clone)] pub struct PackDb { pool: r2d2::Pool<SqliteConnectionManager>, meta: Arc<PackMeta>, path: PathBuf }
pub struct PackMeta { pub pack_id: String, pub kind: PackKind, pub lang: String, pub dir: TextDir, pub name: String,
                      pub author: String, pub source: String, pub source_version: String, pub licence: String,
                      pub attribution: String, pub tokenizer: PackTokenizer, pub normalizer_version: u32, pub format: u32 }
impl PackDb {
    pub fn open(path: &Path) -> Result<Self>;    // READ_ONLY|URI (NOT immutable), pool 2; requires meta.format = 1
    pub fn meta(&self) -> &PackMeta;
    pub fn entries(&self, from: u32, to: u32) -> Result<Vec<PackEntry>>;  // translations: one per ayah
    pub fn entry_for(&self, ayah_id: u32) -> Result<Option<PackEntry>>;  // tafsir range lookup
    pub fn footnotes_for(&self, ayah_ids: &[u32]) -> Result<Vec<Footnote>>;
    pub fn fts_search(&self, fts: &str, limit: u32) -> Result<Vec<(u32, String)>>; // (ayah_id, raw snippet)
    pub fn like_search(&self, needle: &str, limit: u32) -> Result<Vec<(u32, String)>>;
}
pub struct PackDbWriter { conn: rusqlite::Connection }
impl PackDbWriter {
    pub fn create(path: &Path, meta: &PackMeta) -> Result<Self>;   // applies schema/pack.sql
    pub fn entry(&mut self, e: &PackEntryInput) -> Result<()>;
    pub fn footnote(&mut self, f: &FootnoteInput) -> Result<()>;
    /// FTS 'rebuild' + 'optimize', ANALYZE, journal_mode=DELETE, VACUUM, integrity_check; returns counts.
    pub fn finish(self) -> Result<PackStats>;
}

// timings.rs
pub struct TimingFile { pub reciter_id: u32, pub surah: u32, pub audio_url: String, pub content_length: Option<u64>,
                        pub duration_ms: Option<u32>, pub source: String, pub fetched_at_ms: i64,
                        pub etag: Option<String>, pub payload_sha256: String }
pub struct WordSeg { pub pos: u16, pub start_ms: u32, pub end_ms: u32 }
pub struct TimedAyah { pub ayah: u32, pub from_ms: u32, pub to_ms: u32, pub words: Vec<WordSeg> } // ≠ DTO quran_types::AyahTiming
pub struct StoredTimings { pub file: TimingFile, pub ayahs: Vec<TimedAyah>, pub word_level: bool }
impl StoredTimings { pub fn to_dto(&self) -> quran_types::SurahTimings; }
pub struct SanitizeReport { pub dropped_segments: u32, pub coerced_values: u32, pub clamped: u32, pub reordered: u32 }
/// `file` = ONE element of QDC `audio_files[]` as serde_json::Value (tolerant: numbers may be strings/floats).
pub fn sanitize_qdc(file: &serde_json::Value, ayah_count: u32) -> Result<(Vec<TimedAyah>, SanitizeReport)>;
pub fn pack_words(w: &[WordSeg]) -> Vec<u8>;            // LE: u16 pos, u32 start, u32 end (10 B per word)
pub fn unpack_words(b: &[u8]) -> Result<Vec<WordSeg>>;
```
**`sanitize_qdc` rules** (FACT §5.2):
1. Take `verse_timings[]` and parse each `verse_key` (`s:a`). Drop rows whose surah ≠ the file's `chapter_id`, and drop the
   file if `chapter_id` or `audio_url` is null.
2. Coerce every number (string or float) with `round().max(0)`.
3. Drop segments that are not exactly 3 numbers.
4. Ignore the verse `duration` field. If `to < from`, set `to = next.from` (or `from + 1` for the last ayah).
5. Clamp each word to `[from, to]`. Drop the word if `end ≤ start` after clamping.
6. Sort words by `start` (stable sort). Keep repeated or backward positions: the active word is chosen **by time**.
7. Require ayahs `1..=ayah_count`, each exactly once, with non-decreasing `from`.
   - If the ayah rows are valid but the words are not, keep ayah-level timings only (`word_level = false`).
   - Otherwise fail with `Corrupt`.

### 2.3 `quran-audio`
Depends on quran-types, cpal, symphonia, rtrb, rubato, crossbeam-channel, stream-download, reqwest, tokio, thiserror and log.
On Linux: `[target.'cfg(target_os = "linux")'.dependencies] cpal = { workspace = true, features = ["pulseaudio"] }`.

#### 2.3.1 Module tree
```
crates/quran-audio/src/
├─ lib.rs          # pub use engine::*, plan::*, source::*, traits::*; crate-root deny attributes (§0.2)   (WP0B, frozen)
├─ error.rs        # AudioError                                                                          (WP0B, frozen)
├─ traits.rs       # TimingsSource, SourceProvider, EventSink, StreamRegistry, FileKey, SurahTimingSet, AyahSpan, ReciterFlags (WP0B, frozen)
├─ shared.rs       # Marker, MarkerKind, MediaRate, Shared atomics, OutCmd, DecodeCmd, CtlMsg                (WP0B, frozen)
├─ dsp/wsola.rs    # own pure-Rust WSOLA time-stretcher                                                  (WP4a)
├─ dsp/resample.rs # rubato Fft wrapper (FixedSync::Input, 1024-frame chunks)                            (WP4a)
├─ dsp/mix.rs      # channel map, 4 ms fades, gain ramp                                                  (WP4a)
├─ plan.rs         # Planner: PlayRequest + timings → Vec<Segment>                                       (WP4b)
├─ decode.rs       # qd-audio-decode: symphonia, segment/repeat/A-B/gap state machine, markers           (WP4b)
├─ fake_out.rs     # test-only output that drains the ring and records markers (cfg(any(test, feature="testing"))) (WP4b)
├─ output.rs       # qd-audio-out: host selection, cpal stream lifecycle, device events, rebuild         (WP4c)
├─ sink.rs         # debug-only Null / Wav(path) outputs + marker/tick log for QD_AUDIO_SINK (D24)       (WP4c)
├─ ticker.rs       # qd-audio-tick                                                                       (WP4c)
├─ control.rs      # qd-audio-ctl: command loop, planner, source open/prefetch, snapshot state           (WP4c)
├─ engine.rs       # AudioEngine handle: spawns threads, public command API, snapshot()                  (WP4c)
└─ source.rs       # CachingHttpSource (stream-download + CacheFileProvider), LocalFileSource            (WP4d)
```

#### 2.3.2 Public API
```rust
pub struct EngineConfig { pub tick_hz: u32 /* 30 */, pub ring_ms: u32 /* 750 */, pub prefetch_next_file_ms: u32 /* 20_000 */ }

/// Blocking calls made ONLY on qd-audio-ctl (a plain OS thread, never a tokio worker). Implemented in
/// src-tauri/audio_glue.rs over ContentDb + PackManager. The impls may use `Handle::block_on` on the async PackManager API and
/// MUST start with `debug_assert!(tokio::runtime::Handle::try_current().is_err())` (§0.2). Never call them from async code.
pub trait TimingsSource: Send + Sync + 'static {
    fn surah_timings(&self, reciter_id: u32, surah: u16) -> Result<Arc<SurahTimingSet>, AudioError>;
    fn reciter_flags(&self, reciter_id: u32) -> ReciterFlags;
    fn surah_ayah_count(&self, surah: u16) -> u16;
    fn ayah_id(&self, surah: u16, ayah: u16) -> u32;
}
#[derive(Clone, Copy)] pub struct ReciterFlags { pub basmala_in_file: bool } // false for all 14 QDC reciters (FACT C8)
pub struct SurahTimingSet { pub reciter_id: u32, pub surah: u16, pub file: FileKey, pub duration_ms: u32,
                            pub ayahs: Vec<AyahSpan>, pub word_level: bool }
pub struct AyahSpan { pub ayah: u16, pub from_ms: u32, pub to_ms: u32, pub words: Vec<(u16, u32, u32)> }
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct FileKey { pub reciter_id: u32, pub surah: u16, pub url: String, pub expected_len: Option<u64> }

pub trait SourceProvider: Send + Sync + 'static {
    /// Blocking, control thread only (same rule and debug_assert as TimingsSource). Returns a local file when complete and
    /// correctly sized, a reader over a live stream for the same key, or a new progressive stream that fills the cache.
    fn open(&self, key: &FileKey) -> Result<OpenedSource, AudioError>;
}
pub struct OpenedSource { pub source: Box<dyn symphonia::core::io::MediaSource>, pub buffered_permille: Arc<AtomicU32> }

pub trait EventSink: Send + Sync + 'static {
    fn tick(&self, t: &AudioTick);              // ≤ tick_hz while playing; once per change otherwise
    fn state(&self, s: &AudioSnapshot);         // any snapshot change except position
    fn ayah_changed(&self, c: &AyahChange);     // marker edge into a new segment (basmala: ayah = 0)
    fn error(&self, e: &AudioError);
}

pub struct AudioEngine { /* ctl: Sender<CtlCmd>, snapshot: Arc<RwLock<AudioSnapshot>>, threads */ }
impl AudioEngine {
    pub fn start(cfg: EngineConfig, timings: Arc<dyn TimingsSource>, sources: Arc<dyn SourceProvider>,
                 sink: Arc<dyn EventSink>) -> Result<Self, AudioError>;  // no device ⇒ Ok; status error; retry every 2 s
    pub fn play(&self, req: PlayRequest);          // quran_types::PlayRequest with `to` resolved (§5.8)
    pub fn pause(&self);
    pub fn resume(&self);
    pub fn toggle(&self);
    pub fn stop(&self);
    pub fn skip(&self, dir: SkipDirection);        // prev within 1.5 s of segment start ⇒ previous ayah, else restart
    pub fn seek(&self, target: SeekTarget);
    pub fn set_speed(&self, pct: u32);             // 50..=200, step 5; 100 ⇒ WSOLA bypass
    pub fn set_volume(&self, pct: u32);            // 0..=100
    pub fn set_repeat(&self, ayah_repeat: u32, range_repeat: u32); // 1..=99, 0 = infinite
    pub fn set_gap(&self, gap: GapSetting);
    pub fn set_ab_loop(&self, ab: Option<AbLoop>);
    pub fn snapshot(&self) -> AudioSnapshot;
    /// Idempotent and callable through `&AppState`: join handles live in `Mutex<Option<Vec<JoinHandle<()>>>>`; the first
    /// call stops the threads and joins them within 500 ms, later calls return immediately.
    pub fn shutdown(&self);
}
// Every engine thread is started with std::thread::Builder::new().name("qd-audio-…").spawn(..) and the error mapped to
// AudioError::Device; AudioEngine::start never panics (§0.2).
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no audio output device")]  NoOutputDevice,
    #[error("audio device: {0}")]       Device(String),
    #[error("decode: {0}")]             Decode(String),
    #[error("source: {0}")]             Source(String),    // network / file
    #[error("offline: {0}")]            Offline(String),   // not cached and network unavailable or not allowed
    #[error("timings: {0}")]            Timings(String),
    #[error("invalid: {0}")]            Invalid(String),
    #[error("engine stopped")]          EngineGone,
}
impl From<AudioError> for quran_types::AppError { /* §5.2 */ }
```

#### 2.3.3 Planner (`plan.rs`)
```rust
#[derive(Clone, Copy, PartialEq, Eq)] pub enum SegmentKind { Ayah, Basmala }
#[derive(Clone)] pub struct Segment { pub kind: SegmentKind, pub surah: u16, pub ayah: u16 /* 0 for Basmala */,
    pub ayah_id: u32 /* 0 for Basmala */, pub file: FileKey, pub start_ms: u32, pub end_ms: u32,
    pub words: Arc<[(u16, u32, u32)]> }
pub fn plan(req: &PlayRequest, src: &dyn TimingsSource) -> Result<Vec<Segment>, AudioError>;
```
Rules:
1. The range is `req.from ..= req.to`. The glue resolves `to` from `stop_at` when it is `None` (§5.8). The range may cross surahs.
2. For each surah `s` in the range, let `a0` be its first planned ayah. If `a0 == 1 && s ∉ {1, 9}`, insert a **Basmala**
   segment first:
   - `basmala_in_file == false` (every QDC reciter): use the same reciter's **surah 1** file, range 1:1 `[from_ms, to_ms)`
     (BRIEF §4, FACT C8).
   - `basmala_in_file == true`: use the same file, range `[0, ayah1.from_ms)`.
   - If the basmala source is unavailable **because it is offline** (surah-1 timings or file not cached, `AudioError::Offline`),
     the segment is **skipped**, not the play: log at info, set `AudioSnapshot.basmala_skipped = true` for this play, and
     continue with ayah 1. Any other basmala error fails the play as before. Pinning a surah pins the reciter's surah 1 too
     (§2.5.6), so this only happens for stream-only playback.
3. Ayah segments cover `[from_ms, end)`.
   - **Continuous** mode (`ayah_repeat == 1`, gap `none`, no A-B): `end = next.from_ms` when the next segment is ayah a+1 in the
     same file. Inter-ayah breaths play and boundaries are seamless markers.
   - Otherwise `end = to_ms`.
4. Segments are always in mushaf order. Range repeat restarts at index 0, so a basmala segment at the start of the range plays
   again on every repeat. `ayah_repeat` applies only to Ayah segments.
5. An empty range, `from > to`, or an ayah outside its surah returns `AudioError::Invalid`.

#### 2.3.4 Decode, markers, flush generations
```rust
#[repr(u8)] #[derive(Clone, Copy)] pub enum MarkerKind { Segment = 0, Gap = 1, End = 2, Sync = 3 }
/// Exact rational rate: file-timeline µs advanced per output frame = num / den.
/// num = speed_pct · 1_000_000, den = 100 · out_rate (no truncation; u64 products stay < 2^63 between Sync markers).
#[derive(Clone, Copy)] pub struct MediaRate { pub num: u64, pub den: u64 }   // num = 0 during Gap (position frozen)
#[derive(Clone, Copy)] pub struct Marker {
    pub generation: u32, pub ring_frame: u64, pub kind: MarkerKind, pub seg_index: u32,
    pub file_pos_us: u64,           // EXACT file-timeline position at ring_frame (from consumed source frames, see Sync)
    pub rate: MediaRate,
}
pub struct Shared {                 // atomics only; written by callback/decode, read by ticker
    pub generation: AtomicU32, pub playing: AtomicBool, pub seg_index: AtomicU32, pub marker_kind: AtomicU8,
    pub file_pos_us: AtomicU64, pub out_latency_us: AtomicU64, pub underruns: AtomicU32,
    pub gain_bits: AtomicU32,       // f32 bits of the target volume
    pub ayah_repeat_left: AtomicU32, pub range_repeat_left: AtomicU32, pub status: AtomicU8,
}
```
- **Ring.** `rtrb::RingBuffer<f32>` holds `ring_ms` of interleaved output frames at the device rate. A second
  `RingBuffer<Marker>` (4,096 slots) carries markers. With a Sync marker every ~100 ms plus segment/gap markers, a 750 ms ring
  holds well under 100 markers.
- **Sync markers (position from consumed source frames).** Extrapolating from a nominal speed drifts: WSOLA's long-run speed
  is not exactly α, and 44.1 kHz QDC files make any per-frame truncation accumulate. So, besides the Segment/Gap/End markers,
  decode pushes a `MarkerKind::Sync` marker every ~100 ms of **output** (at a WSOLA hop boundary) whose `file_pos_us` is the
  exact source position of that ring frame: `segment_file_start_us + src_frames_consumed × 1_000_000 / src_rate`, where
  `src_frames_consumed` is WSOLA's nominal analysis position `p_k` (§2.3.5, never `k·Hs·α` integrated in floating point),
  mapped through the resampler's exact frame ratio and reported delay. The callback's extrapolation therefore spans at most
  ~100 ms and cannot accumulate error.
- **Callback** (the verified sketch's algorithm, kept). In order:
  1. If `cur.generation != shared.generation`, discard ring frames up to the first marker of the new generation.
  2. Copy frames, splitting at marker boundaries so `cur` changes on the exact frame (a Sync marker only refreshes `cur`).
  3. Apply the gain ramp (linear from the last gain to the target across the buffer). Pause ramps to 0 over 8 ms, then
     outputs silence **without consuming** the ring.
  4. Publish `file_pos_us = cur.file_pos_us + (read − cur.ring_frame) × cur.rate.num / cur.rate.den` (integer arithmetic),
     `seg_index` and `marker_kind` (Sync never changes `marker_kind`).
  5. Count an underrun when the ring is empty while playing.
- **Flush** (user seek, jump, play, speed change, new output):
  - `generation += 1`; clear the pending decode buffers; reset WSOLA and the resampler; seek the decoder.
  - Push a `Segment` marker of the new generation at `written_frames`.
  - Fade in the first 4 ms.
- **Seek.** `SeekMode::Accurate`, then drop `required_ts − actual_ts` frames. `FormatOptions.seek_index_fill_period_ms = 250`.
- **Segment end** (decode position ≥ `end_ms`). No flush, so it is gapless and needs no new generation:
  - If the next segment is contiguous (same file, `next.start == end`), push only a `Segment` marker at
    `written_frames + dsp_latency_frames`, where the latency is WSOLA's plus the resampler's reported output delay.
  - Otherwise **drain** WSOLA and the resampler (zero-padded), fade out the last 4 ms, seek or open the next position,
    fade in 4 ms, and push the marker at `written_frames`.
- **Repeat, range, A-B, gap** (all handled in-band by the decode-thread state machine):
  - `ayah_repeat` (1..=99, 0 = ∞) plays each Ayah segment that many times. It never applies to Basmala segments.
  - `range_repeat` (1..=99, 0 = ∞) replays the whole queue.
  - **Gap:** after **every** Ayah-segment play (when the gap is not `none`), push a `Gap` marker followed by `gap_frames` of
    silence. `fixed{ms}` gives `ms`. `multiplier{pct}` gives `(end_ms − start_ms) × pct / 100`. The highlight stays on the
    finished ayah during the gap.
  - **A-B loop** (file timeline): reaching `b_ms` seeks to `a_ms` in-band, like a non-contiguous segment end. While A-B is
    active, segment ends inside `[a, b]` emit markers only and repeats are suspended.
  - The end of the queue pushes an `End` marker. The ticker then sets status `idle`.
- **Next-file prefetch.** When the current segment is the last one in its file and less than `prefetch_next_file_ms` remains,
  decode sends `CtlMsg::NeedSource(next_file)`. Control opens it and replies `DecodeCmd::SourceReady(key, OpenedSource)`.
  If the file isn't ready when needed, decode writes nothing, the ring drains, the status becomes `buffering`, and position
  freezes.
- **Speed (D15).** `set_speed` triggers a flush plus a seek to the audible position. At `speed_pct == 100` WSOLA is bypassed.
- **Resampling.** When `src_rate != out_rate`, use rubato `Fft` with `FixedSync::Input` and 1024-frame chunks (see rubato 5.0.1
  `examples/process_raw.rs`).
- **Channel map.** Mono is duplicated. Stereo goes to the first `out_ch` channels. Any extra device channels get silence.

#### 2.3.5 WSOLA (`dsp/wsola.rs`, own implementation, BRIEF §2)
```rust
pub struct Wsola { /* sr, ch, n, hs, delta, alpha, input: Vec<f32>, overlap: Vec<f32>, p_prev, k, … */ }
impl Wsola {
    pub fn new(sample_rate: u32, channels: usize) -> Self;
    pub fn set_speed(&mut self, speed_pct: u32);          // called only right after reset() (flush)
    pub fn push(&mut self, interleaved: &[f32]);           // input frames at the source rate
    pub fn pull(&mut self, out: &mut Vec<f32>) -> usize;   // appends produced frames; returns frame count
    pub fn drain(&mut self, out: &mut Vec<f32>) -> usize;  // zero-pads input, flushes the tail
    pub fn reset(&mut self);
    pub fn latency_frames(&self) -> usize;                 // n/2
}
```
Parameters for sample rate `sr` and speed `α = pct / 100`:
- frame `N = 2·round(0.0125·sr)` (≈ 25 ms)
- synthesis hop `Hs = N/2`; nominal analysis positions `p_k = round(k·Hs·α)` (no per-hop rounded `Ha`, see step 1)
- tolerance `Δ = round(0.010·sr)`
- periodic Hann window (50 % overlap sums to 1)

For each output hop `k`:
1. Nominal input position **`p_k = round(k·Hs·α)`** relative to the last reset, computed in integers as
   `(k·Hs·speed_pct + 50) / 100`. (`p = k·Ha` with `Ha = round(Hs·α)` accumulated the rounding: at 44.1 kHz, Hs = 551 and
   α 0.5/0.75/1.5 gave real speeds 0.50091/0.74955/1.50091, i.e. 100–330 ms of drift in a 3-minute ayah.)
2. Natural continuation `c = x[p_prev + Hs .. p_prev + Hs + N]`.
3. Choose the `δ ∈ [−Δ, Δ]` that maximises the normalised cross-correlation of `c` with `x[p+δ .. p+δ+N]`. Compute it on a mono
   mix decimated ×4 (coarse step 4), then refine at full rate ±3.
4. With `q = p_k + δ` and `y = w·x[q .. q+N]`, emit `overlap + y[0..Hs]` and keep `y[Hs..N]` as the next overlap.
5. Set `p_prev = q`. Expose `p_k` (`nominal_input_pos()`) for the Sync markers (§2.3.4).

Keep input until `q + N + Δ` has been consumed. All slicing uses checked `get(..)` ranges (the crate denies
`clippy::indexing_slicing`, §0.2).

Acceptance criteria (unit tests in `quran-audio`, WP4a):
- Output length is within **±1 hop** of `len/α` over **10 minutes** of input, at every 5 % step from 0.50 to 2.00, at 44.1 and
  48 kHz.
- Position accuracy: after 5 minutes of 44.1 kHz input at every 5 % step, the position derived from Sync markers is within
  **±5 ms** of the true source position.
- There is no sample-to-sample jump > 0.25 on a 440 Hz sine at α ∈ {0.5, 0.75, 1.25, 1.5, 2.0}.
- A 440 Hz sine at 1.5× keeps its frequency within ±1 % (zero-crossing count).
- It uses under 3 % of one core at 48 kHz stereo, α = 1.5 (release build).

#### 2.3.6 Output, device changes, ticks
- **Output thread.** `qd-audio-out` owns the `cpal::Stream`, because PulseAudio/PipeWire host streams are not asserted `Send`.
  - Host: iterate `cpal::available_hosts()` in platform preference order (Linux: PulseAudio, then ALSA; Windows: WASAPI; macOS:
    CoreAudio) and take the first `cpal::host_from_id(id)` that returns `Ok`. Never `cpal::default_host()` (it `.expect`s on
    Linux and macOS, §0.2). No host ⇒ status `error(NoOutputDevice)` and a retry every 2 s.
  - It opens `default_output_device()` with `default_output_config()` (keeping the device rate), records the device's `id()`
    (cpal 0.18.2 `Device` has `description()` and `id()`, no `name()`) and `description()` (the `AudioSnapshot.device`
    label), builds the stream for the sample format (F32/I16/I32/U16), and calls `play()` because cpal 0.18 doesn't
    auto-start.
- **Device change** (D19; cpal 0.18.2 semantics verified in its `error.rs` and `host/wasapi/stream.rs`):
  - `StreamInvalidated` or `DeviceNotAvailable` from the error callback → `OutCmd::Rebuild { generation }`. On Windows this is
    how a default-device change arrives (WASAPI never rebinds the `IAudioClient`).
  - `DeviceChanged` (CoreAudio and PipeWire default-device streams) means the stream was **already rerouted**: refresh the
    `device` label (`description()`) and the output latency, emit a state change, and do **not** flush or rebuild.
  - Default-device polling only on hosts that report neither event (ALSA, PulseAudio): every 2 s compare
    `default_output_device()?.id()` with the id the current stream was built from; on a difference send `OutCmd::Rebuild`.
  - **Debounce:** at most one rebuild per output generation; further `Rebuild` requests for an already-replaced generation are
    dropped (prevents the poll and a `StreamInvalidated` from rebuilding twice).
  - Rebuild: drop the stream, open the new default device, create a new ring pair, and send
    `DecodeCmd::NewOutput { prod, mprod, rate, channels, resume_at_us }` with the last audible position. Decode then flushes
    and reseeks.
  - If the rebuild fails, retry every 2 s with status `error(NoOutputDevice)`.
- **Debug sinks (D24).** With `QD_AUDIO_SINK=null` the output thread drives the ring from a timer at 48 kHz instead of cpal;
  with `QD_AUDIO_SINK=wav:<path>` it also writes the frames to a WAV file and appends every applied marker and tick to
  `<path>.log` (JSON lines). Compiled only with `debug_assertions`. Tests and WP4c/WP4d acceptance use these instead of hardware.
- **Ticker.**
  - While `playing`, every `1000/tick_hz` ms: read `Shared`, map `seg_index` to `(surah, ayah, ayah_id)` through the
    `Arc<[Segment]>` that control publishes, and find the active word by binary search (the last word with
    `start_ms ≤ file_ms`, held through inter-word gaps). Then send `AudioTick`.
  - On a `seg_index` or `marker_kind` edge, call `sink.ayah_changed` and `sink.state`.
  - When paused or idle, park until the next command wake-up (no busy loop).
- **Status machine.**
  - `idle → loading` (play: timings plus source open) `→ playing ⇄ paused`.
  - `playing → buffering` while the underrun counter rises and the source is not complete.
  - Any state `→ error` on an unrecoverable failure (the snapshot carries the `AppError`).
  - `stop → idle`.

#### 2.3.7 Streaming sources (`source.rs`)
`CachingHttpSource::new(root: PathBuf, rt: tokio::runtime::Handle, client: reqwest::Client,
registry: Arc<dyn StreamRegistry>, online: Arc<dyn Fn() -> bool + Send + Sync>)` implements `SourceProvider`. The
`StreamRegistry` trait lives in `traits.rs` (frozen by WP0B) and is implemented by the glue over PackManager's single-writer
registry (§2.5.5):
```rust
pub trait StreamRegistry: Send + Sync + 'static {
    fn begin(&self, key: &FileKey);                              // a stream started writing {sss}.stream.part
    fn end(&self, key: &FileKey, promoted_bytes: Option<u64>);  // Some = promoted to {sss}.mp3; None = abandoned
}
```
**Each writer has its own temp file**, so no writer can truncate another's: streaming writes `{sss}.stream.part`; explicit
download jobs write `{sss}.dl.part` plus `{sss}.dl.part.json` (§2.5.5). Stale `*.stream.part` files are deleted at startup.
1. The path is `root/{reciter_id}/{surah:03}.mp3`. If it exists and its size matches `expected_len` (or `expected_len` is None),
   return the local `File`.
2. Else, if a stream for the same `FileKey` is still alive in this source's registry
   (`Mutex<HashMap<FileKey, Weak<LiveStream>>>`), return a new cursor over the same `Arc<Mutex<StreamDownload<…>>>` (each
   cursor keeps its own position and seeks before each read). A second play of the same surah never opens a second writer.
3. Else, if offline → `AudioError::Offline`.
4. Else, on `qd-audio-ctl` only (§0.2), `rt.block_on(StreamDownload::new_http(url, CacheFileProvider(stream_part),
   Settings::default().prefetch_bytes(65536)))` (the verified sketch), pre-sizing `{sss}.stream.part` with `set_len`, and call
   `registry.begin(key)`. `CacheFileProvider` tracks the set of downloaded byte ranges.
5. **Promotion.** When the downloaded ranges cover `[0, Content-Length)` exactly (a stream that seeked past a gap never
   promotes, so zero-filled holes can't be pinned as complete): if `{sss}.mp3` already exists with that length (a job finished
   first), delete the temp; otherwise rename `.stream.part → .mp3`. Then `registry.end(key, Some(bytes))`; the glue registers
   the file in `pack_item` with `pinned = 0` unless it is already pinned. When the last cursor is dropped without promotion,
   delete the temp and call `registry.end(key, None)`.
6. Host fallback: on a connect error or a 5xx from `download.quranicaudio.com`, retry once on `download.quranicaudio.org`.
7. If `Content-Length` differs from `expected_len`, return `AudioError::Source("timings/file mismatch")`. The glue then drops the
   stored timings and refetches them once (§2.5.7).

### 2.4 `media-session`
No tauri dependency. Platform crates: `windows` (Windows), `objc2`, `objc2-foundation`, `objc2-media-player` and `block2` (macOS),
and `mpris-server`, `async-channel`, `async-executor` and `futures-lite` (Linux).
```
crates/media-session/src/{lib.rs, error.rs, model.rs, windows.rs, noop.rs}   (stubs WP0B → WP6c)
crates/media-session/src/{macos.rs, linux.rs}                               (stubs WP0B → WP6d)
```
```rust
pub struct SessionConfig {
    pub app_id: String,          // "com.quran.labs.desktop" (Windows AUMID only)
    pub desktop_entry: String,   // MPRIS DesktopEntry = basename (no ".desktop") of the .desktop file the deb/AppImage
                                 // bundler actually installs: "{productName}.desktop" → "Quran" (WP6d, LEAD 16), pinned in
                                 // src-tauri/src/media.rs and tested against tauri.conf.json; GNOME/KDE use it for
                                 // the player's name and icon
    pub display_name: String,    // "Quran" (productName)
    pub dbus_name: String,       // "quran_desktop" → org.mpris.MediaPlayer2.quran_desktop
    pub hwnd: Option<isize>,     // Windows: raw HWND of the main window (hidden, never destroyed, on close-to-tray)
}
pub type MainThreadDispatch = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>; // macOS: AppHandle::run_on_main_thread
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MediaCommand { Play, Pause, Toggle, Stop, Next, Previous, SeekTo(std::time::Duration), SeekBy(i64), SetRate(f64), Raise }
#[derive(Debug, Clone, Default)]
pub struct Metadata { pub title: String, pub artist: String, pub album: String,
                      pub duration: Option<std::time::Duration>, pub artwork_path: Option<std::path::PathBuf> }
#[derive(Debug, Clone, Copy, PartialEq, Eq)] pub enum Status { Playing, Paused, Stopped }
#[derive(Debug, Clone, Copy)]
pub struct PlaybackState { pub status: Status, pub position: std::time::Duration, pub rate: f64,
                           pub can_next: bool, pub can_previous: bool, pub can_seek: bool }
pub struct MediaSession { /* tx to the backend thread */ }
impl MediaSession {
    pub fn new(cfg: SessionConfig, dispatch: Option<MainThreadDispatch>,
               on_command: Arc<dyn Fn(MediaCommand) + Send + Sync>) -> Result<Self, MediaSessionError>;
    pub fn set_metadata(&self, m: Metadata);       // non-blocking (channel)
    pub fn set_state(&self, s: PlaybackState);     // non-blocking
    pub fn shutdown(self);
}
/// Must run before any UI exists: it is the FIRST statement of `quran_desktop_lib::run()`, before `tauri::Builder::default()`,
/// because Tauri creates the config windows before the setup closure runs (tauri-2.12.2 app.rs `setup()`).
#[cfg(windows)] pub fn set_process_app_user_model_id(app_id: &str) -> Result<(), MediaSessionError>;
#[derive(Debug, thiserror::Error)]
pub enum MediaSessionError { #[error("platform: {0}")] Platform(String), #[error("unsupported platform")] Unsupported }
```
Backends:
- **Windows.** A dedicated thread calls `CoInitializeEx(COINIT_MULTITHREADED)` and owns `SystemMediaTransportControls` obtained via
  `ISystemMediaTransportControlsInterop::GetForWindow(hwnd)`, following the **compile-checked sketch** `smtc_native.rs` (it was
  `cargo check`ed only, never run, and it obtains SMTC on the caller's thread).
  - **The first WP6c task is a Windows runtime check** of `GetForWindow` called on the MTA backend thread for an HWND owned by
    the main (STA) thread. If it fails, obtain the controls on the main thread via `run_on_main_thread` (the `dispatch`
    closure) and move the agile `SystemMediaTransportControls` object to the backend thread; event handlers stay on the
    backend thread. WP6c records the outcome in `docs/deviations/WP6c.md`.
  - Handles: ButtonPressed, PlaybackPositionChangeRequested, PlaybackRateChangeRequested.
  - Sets: SetPlaybackRate, the timeline properties, MusicProperties. Artwork falls back to the app icon (§9.9).
- **macOS.** Every call is marshalled through `dispatch` to the main thread.
  - `MPNowPlayingInfoCenter.defaultCenter`: title, artist, album, duration, elapsed, and `MPNowPlayingInfoPropertyPlaybackRate`
    (the real speed while playing, 0 when paused).
  - **On every `set_state`, also set `MPNowPlayingInfoCenter.playbackState`** (`setPlaybackState`, already in the chosen
    objc2-media-player features) to Playing, Paused or Stopped. A non-AVFoundation app that sets only `nowPlayingInfo` shows
    the wrong play/pause state and media keys don't toggle reliably. On idle and on `shutdown`, set it to Stopped and clear
    `nowPlayingInfo`.
  - `MPRemoteCommandCenter`: play, pause, toggle, next, previous, changePlaybackPosition, and changePlaybackRate with
    supported rates 0.5…2.0.
- **Linux.** A dedicated thread runs `futures_lite::future::block_on` over an `async_executor::LocalExecutor` that owns the
  mpris-server `Player` (it is not `Send`). Commands arrive over `async-channel`. Rate min 0.5, max 2.0.
  `trackid = /com/quran/labs/desktop/track/{surah}_{ayah}` (the identifier as a path; Changed by LEAD 16).
- **Fallback.** `noop.rs` is used when init fails: the failure is logged and the app runs without OS media controls.

Mapping (in `src-tauri/src/media.rs`):
- Metadata: title `"{surah name} {s}:{a}"` where the name is `name_simple` in the English UI and `name_ar` (with Arabic-Indic
  digits) in the Arabic UI, artist = reciter name in the UI language, album from the Rust string table `src-tauri/src/i18n.rs`
  (§11.4). A `ui_language` change re-sends the current metadata.
- Position and duration: the surah-file timeline.
- Commands: Next/Previous map to next/previous ayah. SetRate maps to `set_speed`, rounded to 5 %.
- Updates are sent on ayah change, play-state change, seek and rate change, never per tick.

### 2.5 `quran-packs`
Depends on quran-types, quran-core, reqwest, tokio, futures-util, sha2, zip, ammonia, serde, serde_json, thiserror, log, uuid
and tempfile.

#### 2.5.1 Module tree
```
crates/quran-packs/src/
├─ lib.rs, error.rs  # crate-root deny attributes (§0.2)                                          (WP0B, frozen)
├─ adapters/mod.rs   # enum Adapter + shared AdapterCtx/ItemOutcome types                          (WP0B, frozen)
├─ catalog.rs        # Catalog model (serde) + validation; reciters()                             (WP5a)
├─ http.rs           # reqwest client, host semaphores, mirrors, retries, Range resume, online tracking (WP5b)
├─ jobs.rs           # JobQueue, Job, JobSnapshot, throttled progress, pause/cancel tokens          (WP5b)
├─ install.rs        # staging dirs, atomic flip, removal (handles closed before delete)          (WP5b)
├─ writers.rs        # single-writer registry for audio FileKeys (streams vs jobs, §2.5.5)          (WP5b)
├─ fonts.rs          # interactive lane for page fonts (in-flight dedupe), decor                   (WP5c)
├─ adapters/{qcf_font_pages.rs, static_files.rs, quranenc_sqlite.rs}                              (WP5c)
├─ transform/{html.rs, translation.rs}   # ammonia policy, footnote normalisation, QuranEnc → PackDbWriter (WP5c)
├─ adapters/{qurancom_tafsir.rs, qurancom_wbw.rs, qdc_audio.rs}                                   (WP5d)
├─ revalidate.rs     # 7-day revalidator for QF-sourced items; QuranEnc update checks              (WP5d)
└─ manager.rs        # PackManager (public API), registry view over UserDb tables, cache clear     (WP5e)
```
Adapters use **enum dispatch** (`enum Adapter { QcfFontPages(..), StaticFiles(..), … }` with `async fn`), not `dyn` traits.
`adapters/mod.rs` (frozen in wave 0) declares the enum, each variant's config type and the per-adapter function signatures
that the variant files implement, so WP5c and WP5d never edit the same file.

#### 2.5.2 Public API
```rust
pub struct PackManagerConfig {
    pub packs_root: PathBuf,          // <app_local_data_dir>/packs
    pub catalog_path: PathBuf,        // resource data/catalog.json
    pub core: CoreDb, pub user: UserDb, pub content: ContentDb,
    pub runtime: tokio::runtime::Handle,
    pub user_agent: String,           // "QuranForDesktop/<version>" (setup::USER_AGENT; Changed by LEAD 16)
    pub network_allowed: bool,        // from settings at startup
    pub stream_cache_cap_bytes: u64,  // from settings.stream_cache_cap_mib at startup
}
/// Implemented by src-tauri/src/packs_glue.rs (WP5e): forwards DownloadEvent to the Channel registered by
/// packs_subscribe, and emits PacksChanged / NetworkChanged.
pub trait PackEvents: Send + Sync + 'static {
    fn download(&self, e: DownloadEvent);          // throttled ≤ 10/s per job
    fn packs_changed(&self, pack_ids: Vec<String>);
    fn network(&self, online: bool);
}
#[derive(Clone)] pub struct PackManager { inner: Arc<Inner> }
impl PackManager {
    pub fn new(cfg: PackManagerConfig, events: Arc<dyn PackEvents>) -> Result<Self, PackError>;
    pub fn catalog(&self) -> &Catalog;
    pub fn list(&self) -> Result<Vec<PackInfo>, PackError>;
    pub fn summaries(&self) -> Result<Vec<PackSummary>, PackError>;
    pub fn reciters(&self) -> Vec<ReciterInfo>;   // word_level from the catalog until real timings override it
    pub fn reciter_meta(&self, reciter_id: u32) -> Option<(L10nText /* name */, bool /* basmala_in_file */)>;
    pub async fn install(&self, pack_id: &str, scope: InstallScope) -> Result<u32, PackError>; // returns job id
    pub fn pause(&self, pack_id: &str) -> Result<(), PackError>;
    pub async fn resume(&self, pack_id: &str) -> Result<u32, PackError>;
    pub fn cancel(&self, pack_id: &str) -> Result<(), PackError>;
    pub async fn remove(&self, pack_id: &str) -> Result<(), PackError>;
    pub fn items(&self, pack_id: &str) -> Result<Vec<PackItemState>, PackError>;          // per page/surah/chapter state
    pub async fn remove_items(&self, pack_id: &str, items: &[u32]) -> Result<u64, PackError>; // bytes freed
    pub fn jobs(&self) -> Vec<JobSnapshot>;
    pub async fn ensure_page_fonts(&self, style: MushafStyle, pages: &[u32], prio: FetchPriority)
        -> Result<Vec<PageFontStatus>, PackError>;
    pub async fn ensure_decor(&self) -> Result<DecorStatus, PackError>;
    pub fn decor_status(&self) -> DecorStatus;
    pub fn translation_db(&self, pack_id: &str) -> Result<PackDb, PackError>;   // cached open handle
    pub async fn tafsir_entry(&self, pack_id: &str, ayah_id: u32) -> Result<TafsirEntry, PackError>;
    pub async fn wbw_range(&self, pack_id: &str, from: u32, to: u32) -> Result<Vec<WbwEntry>, PackError>;
    pub async fn surah_timings(&self, reciter_id: u32, surah: u32) -> Result<StoredTimings, PackError>;
    pub fn audio_root(&self) -> PathBuf;                                         // packs/audio
    pub fn audio_stream_begin(&self, reciter_id: u32, surah: u32);              // StreamRegistry::begin (writers.rs)
    pub fn audio_stream_end(&self, reciter_id: u32, surah: u32, promoted_bytes: Option<u64>); // pinned = 0 unless pinned
    pub async fn enforce_stream_cache_cap(&self, cap_bytes: u64) -> Result<u64, PackError>;  // bytes freed
    pub async fn clear_stream_cache(&self) -> Result<u64, PackError>;           // unpinned audio files only
    /// "Clear cache": unpinned audio files + ContentDb::clear_unpinned (unpinned timings/chapters + kv), then re-sync
    /// installed_pack (packs whose rows vanished become Partial). Pinned files and the timings they need survive.
    pub async fn clear_cache(&self) -> Result<u64, PackError>;
    pub fn disk_usage(&self) -> Result<DiskUsage, PackError>;
    pub async fn check_updates(&self) -> Result<Vec<PackUpdate>, PackError>;
    /// Called from settings_set (§5.13): set_network_allowed on change; when stream_cache_cap_mib changes, store the new cap
    /// and spawn enforce_stream_cache_cap.
    pub fn apply_settings(&self, prev: &Settings, next: &Settings);
    pub fn set_network_allowed(&self, allowed: bool);
    pub fn online(&self) -> bool;
    pub fn start_background(&self);   // revalidator, cache-cap enforcement, resume of interrupted jobs, stale temp cleanup
}
#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error("http {status} for {url}")] Http { status: u16, url: String },
    #[error("network: {0}")]            Network(#[from] reqwest::Error),
    #[error("offline")]                 Offline,
    #[error("io: {0}")]                 Io(#[from] std::io::Error),
    #[error("integrity: {0}")]          Integrity(String),
    #[error("zip: {0}")]                Zip(#[from] zip::result::ZipError),
    #[error("core: {0}")]               Core(#[from] quran_core::CoreError),
    #[error("catalog: {0}")]            Catalog(String),
    #[error("not found: {0}")]          NotFound(String),
    #[error("cancelled")]               Cancelled,
    #[error("conflict: {0}")]           Conflict(String),       // e.g. a job is already running for this pack
    #[error("unsupported: {0}")]        Unsupported(String),
}
impl From<PackError> for quran_types::AppError { /* §5.2 */ }
```

#### 2.5.3 Pack kinds and ids
| kind | id pattern | items | storage | install mode |
|---|---|---|---|---|
| `mushaf_fonts` | `mushaf.v2`, `mushaf.v1`, `mushaf.v4` | pages 1..604 | `packs/mushaf/{v1\|v2\|v4}/p{N}.woff2` | `on_demand`, plus "download all" |
| `decor` | `decor` (required by every `mushaf.*`, and **offered on its own**: starter set and, v1.2, the onboarding's "Ornate surah headers" for every style, §9.7) | 3 files | `packs/decor/{qcf-surah-header.woff2, quran-common.ttf, sura-names.woff2}` | `whole` |
| `translation` | `tr.{lang}.{name}`, e.g. `tr.en.saheeh` | 1 zip | `packs/translation/{id}/{version}/pack.db` | `whole` |
| `tafsir` | `tafsir.{lang}.{name}`, e.g. `tafsir.ar.muyassar`, `tafsir.en.ibn_kathir` | 1 zip (QuranEnc) or 114 chapters (Quran.com) | pack DB, or `content.db` (D20) | `whole` / `on_demand` |
| `recitation` | `audio.qdc.{reciterId}`, e.g. `audio.qdc.7` | surahs 1..114 | `packs/audio/{reciterId}/{sss}.mp3`; timings in content.db | `on_demand` (stream), plus download all/selected |
| `wbw` | `wbw.{lang}`, e.g. `wbw.en` | 114 chapters | `content.db` table `wbw` | `on_demand`, plus "download all" |

Decorative fonts stay **optional at runtime**. Without them the renderer uses its own SVG cartouche and Unicode text
(FACT §4.2). Because the default style is `hafs`, which never pulls decor in as a requirement, decor is offered explicitly
(BRIEF forbids silent network use). **(v1.2, owner 2026-10-11)** The `ornateHeaders` setting (default on, §5.11) gates both
the fetching and the drawing of decor, in every style: off, no style fetches it by itself and the page draws the plain look
even with decor installed (the surah-name calligraphy of lists, from the same pack, stays whenever it is installed); turning
it on fetches decor while online, in any style. The onboarding's Mushaf preview fetches it while its option is ticked.

**Item ids.** `InstallScope::Items { items: Vec<u32> }`, `PackItemState.item` and `packs_remove_items` use numbers that map to
`pack_item.item` strings as: mushaf fonts `N` ↔ `p{N}` (page), recitation `N` ↔ `{N:03}` (surah), wbw/Quran.com tafsir
`N` ↔ `ch{N}` (chapter). Decor, QuranEnc translations and tafsir have no per-item scope (`All` only).

#### 2.5.4 `catalog.json` (resource `data/catalog.json`, owner WP5a)
Exact schema, in TypeScript notation. The Rust serde model in `quran-packs/src/catalog.rs` mirrors it with camelCase keys and
`deny_unknown_fields`. WP5a also commits an equivalent JSON Schema (draft 2020-12) at `src-tauri/resources/catalog.schema.json`
for editor validation. `cargo xtask catalog-check` validates by strict deserialisation plus the id rules and the
`requires`/`kind` consistency rules.
```ts
type Catalog = { catalogVersion: 1; generatedAt: string /* ISO date */; packs: CatalogPack[] };
type L10n = { en: string; ar: string };
type CatalogPack = {
  id: string;                                  // /^decor$|^[a-z0-9]+(\.[a-z0-9_]+)+$/
  kind: "mushaf_fonts" | "decor" | "translation" | "tafsir" | "recitation" | "wbw";
  title: L10n; description: L10n;
  language?: string;                           // BCP-47 of the content ("en", "ar", "ur")
  direction?: "ltr" | "rtl";
  version: string;                             // upstream version, or "YYYY.MM"
  installMode: "whole" | "on_demand";
  requires?: string[];                         // e.g. ["decor"]
  sizeBytes: number;                           // full-install estimate, shown before download
  itemCount: number;
  recommended?: boolean;                       // starter-set candidate for onboarding
  revalidateDays?: number;                     // 7 for QF-sourced content
  attribution: { text: L10n; url: string; licence: string };
  source: Source;
};
type Source =
  | { adapter: "qcf_font_pages"; variant: "v1" | "v2" | "v4"; urlTemplates: string[] }        // "{page}" placeholder
  | { adapter: "static_files"; files: { path: string; urls: string[]; bytes: number; sha256?: string }[] }
  | { adapter: "quranenc_sqlite"; key: string; version: string; sha256?: string;
      versionSource: "list" | "http_validators";   // "list": /api/v1/translations/list; else conditional HEAD on the zip
      tokenizer: "porter_unicode61" | "unicode61_remove_diacritics" | "arabic_normalized" | "like_fallback";
      contentKind: "translation" | "tafsir" }
  | { adapter: "qurancom_v4_tafsir_by_chapter"; resourceId: number }
  | { adapter: "qurancom_v4_wbw"; language: string }                                          // ISO code, e.g. "en"
  | { adapter: "qdc_audio"; reciterId: number; name: L10n; style?: L10n; basmalaInFile: boolean; hosts: string[];
      wordLevel: boolean };   // from a one-time `catalog-check --online` probe; ReciterInfo reports it until timings arrive
```
**Starter set** (onboarding, §9.7) is defined exactly, never derived from `recommended` alone:
1. `decor` (≈ 0.3 MB, for every style including hafs);
2. the chosen translation (≈ 0.5 MB, e.g. `tr.en.saheeh`);
3. the chosen Mushaf style **on demand** (pages download as they are viewed; nothing up front). A checkbox "Download all pages
   in the background (93.2 MB)" is off by default;
4. WBW for the UI language, on demand (0 MB now);
5. the chosen reciter's **timings only** (fetched on first play); audio streams and is cached ("Recitation streams as you
   listen and is cached"). Onboarding never bulk-downloads audio.

The onboarding summary shows the exact total of what "Download now" fetches (items 1–2 plus the optional checkbox).
v1 seed content:
- **Mushaf fonts.** `mushaf.v2` (93.2 MB, recommended), `mushaf.v1` (45.7 MB), `mushaf.v4` (48.5 MB).
  - urlTemplates: `https://verses.quran.foundation/fonts/quran/hafs/{v}/woff2/p{page}.woff2`, then
    `https://static-cdn.tarteel.ai/qul/fonts/quran_fonts/{v'}/woff2/p{page}.woff2`.
  - `{v}` is `v1`, `v2` or `v4/colrv1`. `{v'}` is `v1`, `v2` or `v4-tajweed`.
- **Decor.** `decor` with the three FACT §4.2 files: QCF_SurahHeader 118,552 B, quran-common 125,444 B, sura_names 88,560 B.
  `decor.nastaliq` (optional, offered with Urdu packs): Noto Nastaliq Urdu (OFL) as `packs/decor/noto-nastaliq-urdu.woff2`
  (§9.3); WP5a pins its URL, size and sha256 from the Noto release when writing the catalog.
- **Translations (QuranEnc).**
  - `tr.en.saheeh`: `english_saheeh` 1.1.2, 518,866 B zip, recommended when the UI is English.
  - Also: `tr.en.rwwad`, `tr.en.hilali_khan`, `tr.ur.junagarhi`, `tr.id.affairs`, `tr.tr.rwwad`, `tr.fr.rashid`, `tr.es.garcia`,
    `tr.de.bubenheim`, `tr.bn.zakaria`, `tr.ru.rwwad`, `tr.fa.ih`, `tr.hi.omari`.
  - `versionSource`: `"list"` for every key present in `/api/v1/translations/list` (76 keys in the research snapshot).
    **`bengali_zakaria` (`tr.bn.zakaria`), `russian_rwwad` (`tr.ru.rwwad`) and `arabic_moyassar` (`tafsir.ar.muyassar`) are
    not in the list API** although their zips respond (HEAD 200 `application/zip`, 4,178,560 / 576,373 / 812,274 B on
    2026-10-10), so they use `"http_validators"`. QuranEnc's republishing terms require staying on the latest version, so
    update detection must work for them too (§2.5.7).
- **Tafsir.**
  - `tafsir.ar.muyassar`: QuranEnc `arabic_moyassar` (`versionSource: "http_validators"`), recommended when the UI is Arabic.
  - From Quran.com: `tafsir.en.ibn_kathir` (169), `tafsir.en.maarif` (168), `tafsir.ar.saadi` (91).
- **Recitations.** `audio.qdc.{97,2,3,4,5,6,10,161,1,7,9,12,168,173}` with hosts `download.quranicaudio.com` and
  `download.quranicaudio.org`. `audio.qdc.7` (Afasy) is recommended.
- **Word by word.** `wbw.en` (recommended), `wbw.ur`, `wbw.id`, `wbw.bn`, `wbw.tr`, `wbw.fa`, `wbw.hi`, `wbw.ta`.

**The Clear Quran is never listed** (BRIEF §4).

#### 2.5.5 Download manager
- **Lanes.**
  - Background: a FIFO job queue, one job per pack, at most 3 jobs running at once.
  - **Interactive:** used by `ensure_page_fonts`, `tafsir_entry`, `wbw_range` and timings. It skips the queue but shares the
    host limits. In-flight requests are deduplicated by item key (a shared-future map).
- **Limits.** Global semaphore 6, per host 4. Timeouts: connect 10 s, idle read 30 s.
- **Retries.** Up to 3 attempts with backoff 0.5 s, 2 s, 8 s (honour `Retry-After` on 429/503).
  - A 404 or connect error moves on to the next mirror/URL template.
  - When all mirrors fail, the item fails. 3 failed items fail the job. Completed items are kept.
- **Resume.** Single large files (zip, mp3) are written by jobs to `{name}.dl.part` with a `{name}.dl.part.json` sidecar
  `{url, etag, lastModified, total, received}`. `received` is updated only **after** each chunk has been written and fsynced.
  - Resume first truncates the `.dl.part` to `received`, then sends `Range: bytes={received}-` with
    `If-Range: <etag | lastModified>`. The offset never comes from the file length (a streaming writer pre-sizes its own
    temp sparsely; job temps are never pre-sized).
  - `206` → append. `200` → truncate and restart.
  - Multi-item packs resume by skipping items already recorded in `pack_item`.
- **Single writer per audio file** (`writers.rs`): `Mutex<HashMap<(reciter, surah), WriterState>>` with
  `WriterState::{Stream(Arc<Notify>), Job}`, fed by `audio_stream_begin/end` (the glue's `StreamRegistry`) and by jobs.
  - A job item whose surah is currently streaming **waits** for that stream to end (≤ 10 min). If the stream promoted a file
    of the expected length, the job item only pins it (`pack_item.pinned = 1`, timings pinned); otherwise it downloads normally.
  - A stream that starts while a job writes the same surah writes its own `.stream.part`; whichever completes first renames
    into place, the other deletes its temp (§2.3.7). Two writers never share a file.
  - At startup `start_background` deletes every stale `*.stream.part`.
- **Integrity.** sha256 is computed while streaming.
  - If the catalog gives a `sha256`, it must match. Otherwise the computed value is recorded (trust on first use).
  - **Before any file is pinned or renamed into place: its length must equal `Content-Length`** (and `total` in the sidecar).
  - Fonts: the file must also start with `wOF2`.
  - Zips: exactly **one** `*.sqlite` entry (the entry name is not assumed to be `{key}.sqlite`; the research only read
    `/downloads/sqlite/{key}.sqlite` directly and never listed a zip), whose `translations(id, sura, aya, translation,
    footnotes)` table exists with that column set and has exactly 6,236 rows.
- **Content DB re-sync.** After `clear_cache`, a recovered (quarantined) `content.db`, or startup, every installed QF-backed
  pack is checked against `content.db` chapters/timings; a pack whose rows are missing becomes `partial` (never silently
  "installed" without data).
- **Atomic install** (whole packs):
  1. Build `pack.db` in `packs/.staging/{uuid}/` with `PackDbWriter`, then `finish()`.
  2. Rename it into a **new** directory `packs/{kind}/{id}/{version}/pack.db`, so nothing is overwritten.
  3. In one user.db transaction, upsert `installed_pack` with the new version and path and `status='installed'`.
  4. Drop the cached `PackDb` handle for the old version, then delete the old directory. If Windows still holds a file, retry on
     the next start.
  - Per-item files use `.part` + rename into place.
- **Cancel / pause.** Each job has `Arc<AtomicBool>` cancel and pause flags plus a `tokio::sync::Notify`, checked between 64 KiB
  chunks. Cancel deletes the staging and `.dl.part` files. Pause keeps them and sets `status='paused'`.
- **Progress.** Bytes are aggregated per job and `DownloadEvent::Progress` is emitted at most every 100 ms. `rate_kib_s` is an EWMA
  over 3 s.
- **Network.**
  - When `settings.network_allowed == false`, every network operation returns `PackError::Offline`. `quran://` is unaffected.
  - `online()` tracks request outcomes: any success → online; 3 consecutive connect failures → offline. While offline, it
    re-probes every 60 s with `HEAD https://verses.quran.foundation/`. Each change calls `PackEvents::network`.

#### 2.5.6 Source adapters (exact endpoints)
| adapter | requests | parse / transform |
|---|---|---|
| `qcf_font_pages` | `GET <urlTemplate with {page}>` for each missing page | Integrity checks above. Write `packs/mushaf/{variant}/p{page}.woff2`. Record `pack_item` with item `p{page}`. |
| `static_files` | `GET url` | Write `packs/decor/{path}`. Verify bytes and sha256. |
| `quranenc_sqlite` | `GET https://quranenc.com/downloads/sqlite/{key}.zip` (store its `ETag`, `Last-Modified` and `Content-Length` in `installed_pack.source_version` as JSON). Updates: `versionSource: "list"` → `GET https://quranenc.com/api/v1/translations/list`, compare `version`; `versionSource: "http_validators"` → conditional `HEAD` of the zip (`If-None-Match`/`If-Modified-Since`), an update when it is not 304 and any stored validator or the length differs | Unzip the single `*.sqlite` entry (§2.5.5 integrity) and read `translations(id, sura, aya, translation, footnotes)`. Strip the leading `(n) ` from `translation`. Turn footnote markers `\[(\p{Nd}+)\]` in the text into `<sup class="fn" data-fn="{s}:{a}:{n}">{n}</sup>`. Split footnote lines on `^\[(\p{Nd}+)\]-?\s*` into `footnote(id "{s}:{a}:{n}", ayah_id, marker n, html)`. Sanitise (policy below). `plain` = text with tags removed. `fold` follows the tokenizer. Tafsir packs get one entry per ayah (`to = from`). |
| `qurancom_v4_tafsir_by_chapter` | `GET https://api.quran.com/api/v4/tafsirs/{resourceId}/by_chapter/{ch}?per_page=300&page={n}` until `pagination.next_page == null` | A row with empty `text` extends the previous row's range (`to_ayah_id`). Sanitise. Store in `content.db tafsir_entry`, and stamp `content_chapter(fetched_at, sha256, pinned)` (pinned = the pack is installed with scope `All`). |
| `qurancom_v4_wbw` | `GET https://api.quran.com/api/v4/verses/by_chapter/{ch}?words=true&language={iso}&word_fields=location&per_page=300&page={n}` | For `char_type_name == "word"`, map `location` to a word id via core.db and keep `translation.text` and `transliteration.text` (transliteration is English-only upstream). Store in `content.db wbw`. |
| `qdc_audio` | Timings: `GET https://api.qurancdn.com/api/qdc/audio/reciters/{id}/audio_files?chapter={n}&segments=true`. Audio: `audio_files[0].audio_url`, with host fallback | Timings go through `quran_core::timings::sanitize_qdc` into `content.db`. Explicit downloads write `packs/audio/{id}/{n:03}.dl.part` → `{n:03}.mp3` with `pinned = 1`, and pin that surah's timings. **Pinning any surah of a reciter also pins (and if needed downloads) that reciter's surah 1 file and timings**, because every surah 2–114 except 9 plays its basmala from the surah-1 file (§2.3.3); the UI counts it as part of the download. `content_length` is the HTTP `Content-Length`, never `file_size` (FACT §5.2). |

**Ammonia policy** (the same for translations and tafsir):
- Allowed tags: `p, br, b, strong, i, em, span, sup, sub, h2, h3, h4, ul, ol, li, a, blockquote`.
- Allowed classes: `span.h`, `span.s`, `span.green`, `span.arabic`, `span.qpc-hafs`, `span.brown`, `sup.fn`, `i.s`.
- Allowed attributes:
  - `sup[data-fn]`.
  - `a[data-ref]` **with no `href`**: an upstream `a[href]` whose href matches `^/?\d{1,3}:\d{1,3}(-\d{1,3})?$` is rewritten in
    Rust to `<a data-ref="{s}:{a}[-{b}]">` (href removed) before ammonia runs. Any other link is unwrapped. (A
    `quran-ref:` URL scheme would be stripped by DOMPurify's default `ALLOWED_URI_REGEXP` and by ammonia's `url_schemes`, so
    no custom scheme is used.)
- `style` is always dropped. `h1` becomes `h2`.
- The webview's DOMPurify config (`src/lib/text/html.ts`, §7.6) uses the same tag and class allowlist, `ALLOWED_ATTR` including
  `data-fn` and `data-ref`, and forbids `href` on `a`.

#### 2.5.7 Revalidation policy (QF content, BRIEF §4)
Scope: every item from a pack with `revalidateDays` (tafsir and WBW chapters from Quran.com, and QDC timings).
- **When.** On startup (+60 s) and every 6 h, if online and allowed.
- **What.** Items whose `fetched_at < now − 7 d` are refetched, 2 at a time. Interactive work takes priority.
- **Result.** If the payload sha256 is unchanged, only `fetched_at` is updated. Otherwise the item is replaced.
- **Timings.** If the new `audio_url` or the HEAD `Content-Length` differs from the stored one (timings are tied to the exact
  file):
  - **unpinned (stream-cached) file:** delete the cached mp3, store the new timings, emit `PacksChanged`;
  - **pinned file:** never delete it first. Enqueue a re-download of the new file to `{sss}.dl.part` and keep the **old file
    and old timings** in use until the new pair (file of the new `Content-Length` + new timings) is complete; then swap both
    in one step (rename + `timings_put`), and emit `PacksChanged`. A pinned download is never silently removed.
- **Offline.** If offline for longer than 7 days, keep using the stored copy. Content is never deleted just for being stale.
- **QuranEnc packs** are not revalidated as content. `check_updates` offers an update when the list version
  (`versionSource: "list"`) or the zip's HTTP validators (`"http_validators"`) differ from the installed ones (§2.5.6);
  `catalog-check --online` HEADs every QuranEnc zip.

### 2.6 `quran-types` (contract crate, D1)
`crates/quran-types/src/{lib.rs, ids.rs, error.rs, meta.rs, mushaf.rs, text.rs, search.rs, content.rs, audio.rs, packs.rs, user.rs,
settings.rs, system.rs}`. It holds **only** the §5 DTO definitions, `Settings::default()`, `Settings::validated()`, and small pure
helpers (`MushafStyle::layout()`, `MushafLayout::db_id()`, `MushafLayout::from_db_id()`). It depends only on serde, specta and
thiserror. Its tests include a committed JSON snapshot of `Settings::default()` (`tests/data/settings_default.json`), so the
camelCase IPC names and every default are pinned (§0.2).

### 2.7 `xtask`
Specified in §4. A binary crate that depends on quran-core, quran-types, quran-packs (for `catalog-check` and
`fetch-dev-packs`), rusqlite, reqwest (driven by a local current-thread tokio runtime), quick-xml, zip, sha2, toml, clap,
anyhow and serde_json. `xtask/src/{main.rs, cli.rs}` (WP0B, frozen) declare every subcommand of §4.1 and dispatch to one
module per subcommand, so the WP3 sub-packages and WP1a/1b/1c/5a (fixture exporters) never edit the same file.

### 2.8 `src-tauri` (crate `quran-desktop`, lib `quran_desktop_lib`)
#### 2.8.1 Module tree
```
src-tauri/
├─ Cargo.toml, build.rs, tauri.conf.json   # base config: identifier, build, bundle.resources, security/CSP   (WP0A, frozen)
├─ tauri.{windows,macos,linux}.conf.json   # per-OS window chrome + bundle targets                          (WP6b)
├─ capabilities/default.json               # created by WP0A, then owned by                                  (WP6b)
├─ icons/**  (incl. icons/tray/)           # generated from assets/brand (§9.9)                             (WP-Brand)
├─ resources/core.db                       # generated by `pnpm core:qdc|core:qul`, gitignored; build.rs placeholder (§5.15)
├─ resources/{catalog.json, catalog.schema.json}                                                            (WP5a)
└─ src/
   ├─ main.rs                   # fn main() { quran_desktop_lib::run() }                                     (WP0A, frozen)
   ├─ lib.rs                    # run(): AUMID, builder, plugins, protocol, invoke handler, setup, run events (WP0A, frozen)
   ├─ ipc/{mod.rs, events.rs}   # specta_builder(); #[test] export_bindings; event types                    (WP0A, frozen)
   ├─ util.rs                   # blocking(), internal(), now_secs(), to_js_path()                           (WP0A, frozen)
   ├─ commands/mod.rs           # `pub mod` declarations only                                                (WP0A, frozen)
   ├─ state.rs                  # AppState, AppPaths, StartupNotice, Send + Sync assertion        (stub WP0A → WP0B → WP6a)
   ├─ setup.rs                  # init(app): never returns Err (§2.8.2)                           (stub WP0A → WP0B → WP6a)
   ├─ protocol.rs               # quran:// handler (§6) + raw `font_bytes` command (§5.13)        (stub WP0A → WP6a)
   ├─ window.rs                 # show-after-ready, close-to-tray, UI zoom, run events, focus     (stub WP0A → WP6b)
   ├─ tray.rs                   # tray menu + label updates                                       (stub WP0A → WP6b)
   ├─ i18n.rs                   # Rust string table en/ar: tray, media album, startup dialogs     (stub WP0A → WP6b)
   ├─ media.rs                  # MediaSession glue                                               (stub WP0A → WP6c)
   ├─ audio_glue.rs             # AudioService + TimingsSource/SourceProvider/StreamRegistry/EventSink impls (stub → WP4d)
   ├─ packs_glue.rs             # PackEventsImpl (implements quran_packs::PackEvents), build()    (stub WP0A → WP5e)
   └─ commands/ app.rs, system.rs (WP6a) · mushaf.rs, quran.rs (WP1a) · search.rs (WP1b) · content.rs, packs.rs (WP5e)
                · audio.rs (WP4d) · user_library.rs (WP2a) · user_study.rs, settings.rs (WP2b)        (stubs WP0A)
```
- Wave-0 command stubs (WP0A) may omit the `State`/`AppHandle` parameters, which never appear in `bindings.ts`; the owning
  package adds them when it implements the body. Everything else in the signature is final.
- `lib.rs` (frozen) wires everything through the §2.8.4 hooks:
  ```rust
  pub fn run() {
      #[cfg(windows)]   // FIRST statement: before any window exists (§2.4); failure is logged, never fatal
      if let Err(e) = media_session::set_process_app_user_model_id(APP_ID) { eprintln!("aumid: {e}"); } // "com.quran.labs.desktop"
      let specta = ipc::specta_builder();
      let typed = specta.invoke_handler();
      let raw = tauri::generate_handler![protocol::font_bytes];          // excluded from specta (raw bytes, §5.13)
      let built = tauri::Builder::default()
          .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| window::on_second_instance(app, argv)))
          .plugin(/* log, §13.5 */).plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_dialog::init())
          .plugin(tauri_plugin_os::init()).plugin(/* window-state, §13.5 */)
          .register_asynchronous_uri_scheme_protocol("quran", protocol::handle)
          .invoke_handler(move |invoke| if invoke.message.command() == "font_bytes" { raw(invoke) } else { typed(invoke) })
          .on_window_event(window::on_window_event)
          .setup(move |app| { specta.mount_events(app); setup::init(app); Ok(()) })   // init never fails (§2.8.2)
          .build(tauri::generate_context!());
      match built {
          Ok(app) => app.run(|handle, ev| window::on_run_event(handle, &ev)),
          Err(e) => { log::error!("tauri build: {e}"); eprintln!("tauri build: {e}"); std::process::exit(1) }
      }
  }
  ```
  WP0A verifies the handler-dispatch closure compiles against tauri 2.12.2 (`Invoke::message.command()`); if it does not,
  `font_bytes` becomes a raw `Channel<InvokeResponseBody>` stream registered through specta (never `Vec<u8>`, which
  serialises as a JSON array; FACT §7).

#### 2.8.2 `AppState` and setup
```rust
pub struct AppPaths { pub data: PathBuf /* app_local_data_dir or QD_DATA_DIR */, pub packs: PathBuf, pub logs: PathBuf,
                      pub core_db: PathBuf, pub catalog: PathBuf }
pub struct AppState {
    pub paths: AppPaths,
    pub core: quran_core::CoreDb,                     // CoreDb::unavailable(..) only in debug builds (degrade path)
    pub search: quran_core::SearchEngine,
    pub user: quran_core::UserDb,
    pub content: quran_core::ContentDb,
    pub packs: quran_packs::PackManager,
    pub pack_events: Arc<crate::packs_glue::PackEventsImpl>,   // packs_subscribe sets its channel
    pub audio: crate::audio_glue::AudioService,      // AudioEngine + PlayRequest resolution + timings cache
    pub media: std::sync::OnceLock<media_session::MediaSession>,  // filled after manage(); empty if init failed
    pub app_info: quran_types::AppInfo,
    pub startup_notices: Vec<quran_types::StartupNotice>,         // e.g. user.db recovered (§9.8); returned by app_bootstrap
    pub ready: std::sync::atomic::AtomicBool,        // set by window_ready
}
#[allow(dead_code)] fn _assert_send_sync() { fn check<T: Send + Sync>() {} check::<AppState>(); } // compile-time check
```
`setup.rs` is split into a testable core and a thin UI wrapper: `fn build_state(app: &AppHandle, policy: CorePolicy) ->
Result<AppState, Fatal>` (policy `Fatal` in release, `Degrade` in debug builds) and `pub fn init(app: &mut tauri::App)`.
**`init` never returns `Err` and never panics**: Tauri calls `panic!("Failed to setup app: {e}")` on an `Err` from the setup
closure (tauri-2.12.2 `app.rs`), which aborts under `panic = "abort"`. Steps, in order:
1. Resolve paths (each through `dunce::simplified`):
   - core.db: release `resolve("data/core.db", BaseDirectory::Resource)`; **debug** `QD_CORE_DB`, else
     `env!("CARGO_MANIFEST_DIR")/resources/core.db`, so a rebuilt DB is picked up without recompiling.
   - catalog.json: release `resolve("data/catalog.json", Resource)`; debug `CARGO_MANIFEST_DIR/resources/catalog.json`.
   - data root: `app_local_data_dir()` (debug: `QD_DATA_DIR` if set); create `packs/`.
2. Open `CoreDb`. Release: any error is **fatal**. Debug: log at error and continue with `CoreDb::unavailable(reason)`;
   `app_bootstrap` then returns `AppError::NotFound("core.db missing — run pnpm core:qdc")` and the frontend shows its
   fatal screen "Core data missing (dev build)" (§9.8) instead of the app crashing.
3. `UserDb::open_or_recover` and `ContentDb::open_or_recover` (never fatal for corruption: a quarantined `user.db` adds
   `StartupNotice::UserDbRecovered { quarantined_file }`). Only failing to open the **fresh** DB (disk full, permissions) is
   fatal.
4. Load settings. `packs_glue::build(..)` (validates the catalog), `SearchEngine`, and
   `AudioService::start(app, core, content, user, packs, settings)` (having no output device is not fatal).
   - **Fatal path (steps 1–4):** log at error; call
     `app.dialog().message(i18n::startup_error(lang, &e)).kind(MessageDialogKind::Error).show(move |_| handle.exit(1))`,
     which is **non-blocking** (`blocking_show` must not run on the main thread, and setup runs inside the event loop's
     Ready callback, so it would hang on macOS/GTK); **skip `app.manage(AppState)`**; return. The window stays hidden (only
     `window_ready` shows it, and that command fails without state).
5. `app.manage(AppState)`. Then, each **logged and skipped on failure**: apply the UI zoom (`window::set_ui_zoom`, D27), build
   the tray if `settings.show_tray_icon`, `media::init(..)` into `state.media`, start the PackManager background tasks.
   The window chrome effect is **not** applied here: the frontend owns it through `window_set_chrome` (§9.6).
6. Keep the window hidden until the frontend calls `window_ready` after first paint. A 3 s safety timer shows it anyway.

Tests (`src-tauri`, WP6a): `build_state` with a corrupt or 0-byte core.db returns `Err(Fatal)` under `CorePolicy::Fatal` and
an `AppState` with an unavailable core under `CorePolicy::Degrade`; neither panics. A corrupt user.db yields
`StartupNotice::UserDbRecovered` and a fresh DB.

Wave 0 (§14.2): every constructor above returns an **inert handle** that does no IO, so the skeleton app boots, manages
`AppState` and shows the window; only query and mutation methods return `NotImplemented`/`Unsupported`.

#### 2.8.3 Data directories (D3)
```
<app_local_data_dir>/   Win: %LOCALAPPDATA%\com.quran.labs.desktop
                        macOS: ~/Library/Application Support/com.quran.labs.desktop
                        Linux: ~/.local/share/com.quran.labs.desktop
├─ user.db (+ -wal, -shm)        # (+ user.db.corrupt-{unix_ms} after a recovery, kept for the user)
├─ content.db (+ -wal, -shm)     # QF-derived content (D20); pinned rows survive "Clear cache" (PackManager::clear_cache)
├─ backups/                      # default output of user_backup_create
└─ packs/                        # quran:// root (§6)
   ├─ mushaf/{v1,v2,v4}/p{N}.woff2
   ├─ decor/{qcf-surah-header.woff2, quran-common.ttf, sura-names.woff2}
   ├─ translation/{packId}/{version}/pack.db
   ├─ tafsir/{packId}/{version}/pack.db
   ├─ audio/{reciterId}/{sss}.mp3   (+ {sss}.stream.part while streaming; {sss}.dl.part + {sss}.dl.part.json during a job)
   └─ .staging/
```
The directory is named after the bundle identifier (Changed by LEAD 16: it was `com.qurandesktop.app`; no release
shipped, so nothing is migrated). Logs go to `app_log_dir()` (the tauri-plugin-log default). WebView data stays in the platform default location (`EBWebView`
under local app data on Windows).

#### 2.8.4 Internal cross-package hooks (WP0A stubs them with these exact signatures)
```rust
// src-tauri/src/window.rs (WP6b)
/// Tray visibility, close-to-tray, tray labels and media metadata language, UI zoom. NOT the chrome effect: the frontend is
/// the single owner of chrome through window_set_chrome, because only it knows the resolved theme for `system` (§9.6).
pub fn apply_settings(app: &tauri::AppHandle, prev: &Settings, next: &Settings);
pub fn set_ui_zoom(app: &tauri::AppHandle, ui_scale_pct: u32);                    // WebviewWindow::set_zoom(pct / 100)
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent);        // CloseRequested → hide when close_to_tray
pub fn on_run_event(app: &tauri::AppHandle, ev: &tauri::RunEvent);                // macOS Reopen → show_main; Exit → shutdown
pub fn on_second_instance(app: &tauri::AppHandle, argv: Vec<String>);              // unminimize/show/focus; argv → NavigateRequested
pub fn show_main(app: &tauri::AppHandle);
// src-tauri/src/tray.rs (WP6b)
pub fn build(app: &tauri::AppHandle, lang: UiLanguage) -> tauri::Result<()>;
pub fn relabel(app: &tauri::AppHandle, lang: UiLanguage);                          // after a ui_language change
pub fn set_now_playing(app: &tauri::AppHandle, label: Option<String>, playing: bool);  // cheap; no-op without a tray
// src-tauri/src/i18n.rs (WP6b)
pub enum RustText { TrayShow, TrayPlayPause, TrayNext, TrayPrevious, TrayQuit, TrayNowPlaying, MediaAlbum,
                    StartupErrorTitle, StartupErrorBody, CloseToTrayTitle, CloseToTrayKeep, CloseToTrayQuit }
pub fn text(lang: UiLanguage, key: RustText) -> &'static str;
pub fn startup_error(lang: UiLanguage, detail: &dyn std::fmt::Display) -> String;
// src-tauri/src/media.rs (WP6c)
pub fn init(app: &tauri::AppHandle, on_command: Arc<dyn Fn(media_session::MediaCommand) + Send + Sync>) -> Option<media_session::MediaSession>;
pub fn on_audio_state(app: &tauri::AppHandle, snapshot: &AudioSnapshot, title: &str, reciter: &str);   // maps to set_metadata/set_state
// src-tauri/src/packs_glue.rs (WP5e)
pub struct PackEventsImpl { app: tauri::AppHandle, channel: std::sync::Mutex<Option<tauri::ipc::Channel<DownloadEvent>>> }
impl quran_packs::PackEvents for PackEventsImpl { /* download → channel; packs_changed → PacksChanged; network → NetworkChanged */ }
impl PackEventsImpl { pub fn set_channel(&self, ch: tauri::ipc::Channel<DownloadEvent>); }   // replaces the previous one
pub fn build(app: &tauri::AppHandle, cfg: quran_packs::PackManagerConfig)
    -> Result<(quran_packs::PackManager, Arc<PackEventsImpl>), AppError>;
// src-tauri/src/audio_glue.rs (WP4d)
pub struct AudioService { /* AudioEngine, tick channel slot, reciter metadata, AppHandle, UserDb */ }
impl AudioService {
    pub fn start(app: &tauri::AppHandle, core: CoreDb, content: ContentDb, user: UserDb, packs: PackManager,
                 settings: &Settings) -> Result<Self, AppError>;
    pub fn play(&self, req: PlayRequest) -> Result<AudioSnapshot, AppError>;    // cheap: validates, resolves `to` (§5.8) from the
                                                                                // cached index, sends to qd-audio-ctl; never blocks
    pub fn engine(&self) -> &quran_audio::AudioEngine;
    pub fn set_tick_channel(&self, ch: tauri::ipc::Channel<AudioTick>);        // replaces the previous one
    pub fn snapshot(&self) -> AudioSnapshot;
    /// ASYNC: awaits PackManager::surah_timings directly. audio_get_timings calls it without blocking() (§0.2: no block_on in
    /// async code). Only the TimingsSource impl, which runs on qd-audio-ctl, uses Handle::block_on.
    pub async fn timings(&self, reciter_id: u32, surah: u32) -> Result<SurahTimings, AppError>;
    pub fn reciters(&self) -> Vec<ReciterInfo>;
    pub fn apply_settings(&self, prev: &Settings, next: &Settings);            // volume live; others are defaults for the next play
    pub fn handle_media_command(&self, cmd: media_session::MediaCommand);
    pub fn shutdown(&self);                                                    // idempotent (AudioEngine::shutdown(&self))
}
```
The `EventSink` implementation in `audio_glue.rs` does three things:
1. Emits `AudioStateChanged` and `AudioAyahChanged` (tauri-specta `.emit(&app)`) and sends ticks to the stored channel.
2. Calls `tray::set_now_playing` and `media::on_audio_state` (through `state.media.get()`) on ayah or state edges only.
3. Records a `listen` history entry through the `UserDb` it was started with when an ayah has played for ≥ 3 s, at most one
   per page.

---

## 3. Databases

All tables are `STRICT`. Timestamps stored in SQLite are **Unix milliseconds** (`INTEGER`). DTOs convert them to seconds (§0.2).
DDL files are owned by WP0B and copied verbatim from this section.

### 3.1 `core.db` (bundled, read-only, `CORE_SCHEMA_VERSION = 1`)
#### 3.1.1 DDL (`crates/quran-core/schema/core.sql`)
```sql
PRAGMA page_size = 4096;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
-- keys: schema_version, normalizer_version, source ('qul'|'qdc'), source_manifest_sha256, tanzil_sha256,
--       built_at (RFC 3339 UTC), builder (xtask version), ayah_count, word_count, licence_note

CREATE TABLE mushaf (
  id             INTEGER PRIMARY KEY,            -- 1 = v2 (1421H), 2 = v1 (1405H), 19 = v4 (1441H tajweed)
  code           TEXT NOT NULL UNIQUE CHECK (code IN ('v2','v1','v4')),
  name           TEXT NOT NULL,
  pages          INTEGER NOT NULL,               -- 604
  lines_per_page INTEGER NOT NULL,               -- 15
  glyph_column   TEXT NOT NULL CHECK (glyph_column IN ('code_v1','code_v2'))  -- v4 uses code_v2 (FACT C4)
) STRICT;

CREATE TABLE surah (
  id               INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 114),
  name_ar          TEXT NOT NULL,                -- الفاتحة
  name_simple      TEXT NOT NULL,                -- Al-Fatihah   (ASCII transliteration)
  name_complex     TEXT NOT NULL,                -- Al-Fātiĥah   (transliteration with diacritics)
  name_en          TEXT NOT NULL,                -- The Opener   (meaning; Tanzil `ename`)
  revelation_place TEXT NOT NULL CHECK (revelation_place IN ('makkah','madinah')),
  revelation_order INTEGER NOT NULL,
  ayah_count       INTEGER NOT NULL,
  first_ayah_id    INTEGER NOT NULL,
  rukus            INTEGER NOT NULL,
  bismillah_pre    INTEGER NOT NULL CHECK (bismillah_pre IN (0,1)),   -- 0 for surahs 1 and 9
  header_cp        INTEGER                       -- QCF_SurahHeader code point (surah 1 = 0xFC45); NULL if map absent
) STRICT;

CREATE TABLE juz    (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 30),  first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE hizb   (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 60),  first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE rub    (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 240), first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE manzil (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 7),   first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
-- Sources per field (D6): juz/hizb/manzil = Tanzil (hard cross-check); rub = mushaf source (allowlisted Tanzil diff);
-- ruku and sajda = Tanzil only.
CREATE TABLE ruku   (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 556), surah INTEGER NOT NULL,
                     first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE sajda  (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 15), ayah_id INTEGER NOT NULL UNIQUE,
                     kind TEXT NOT NULL CHECK (kind IN ('recommended','obligatory'))) STRICT;

CREATE TABLE ayah (
  id            INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 6236),
  surah         INTEGER NOT NULL REFERENCES surah(id),
  ayah          INTEGER NOT NULL,
  juz           INTEGER NOT NULL,
  hizb          INTEGER NOT NULL,
  rub           INTEGER NOT NULL,
  manzil        INTEGER NOT NULL,
  ruku          INTEGER NOT NULL,
  sajda         INTEGER NOT NULL DEFAULT 0 CHECK (sajda IN (0,1,2)),  -- 0 none, 1 recommended, 2 obligatory
  flags         INTEGER NOT NULL DEFAULT 0,      -- bit0 rub start, bit1 hizb start (both from the mushaf-source rub, D6),
                                                 -- bit2 juz start, bit3 surah start
  first_word_id INTEGER NOT NULL,
  last_word_id  INTEGER NOT NULL,                -- the 'end' marker word
  text_hafs     TEXT NOT NULL,                   -- word.text_hafs joined by U+0020 (marker: U+06DD + Arabic-Indic digits);
                                                 -- display/copy only: NEVER split it to recover words (a word may contain
                                                 -- a space before ۩); per-word text always comes from `word` rows
  text_imlaei   TEXT NOT NULL,                   -- word.text_imlaei (non-end) joined by U+0020
  norm_loose    TEXT NOT NULL,                   -- normalize_ar(text_imlaei, Loose)
  norm_strict   TEXT NOT NULL,                   -- normalize_ar(text_imlaei, Strict)
  UNIQUE (surah, ayah)
) STRICT;

CREATE TABLE word (
  id          INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 83665),   -- canonical (surah, ayah, position) order
  ayah_id     INTEGER NOT NULL,
  surah       INTEGER NOT NULL,
  ayah        INTEGER NOT NULL,
  position    INTEGER NOT NULL,                  -- 1-based; the end marker is the last position
  is_end      INTEGER NOT NULL CHECK (is_end IN (0,1)),
  text_hafs   TEXT NOT NULL,                     -- QPC Hafs; end marker = U+06DD + Arabic-Indic digits (KFGQPC V30).
                                                 -- MAY contain U+0020 + U+06E9 (۩) inside ONE word: 38:24:32 'وَأَنَابَ ۩',
                                                 -- 22:77:11 'تُفۡلِحُونَ ۩' (9 of the 15 sajda words; G5b). Never split
                                                 -- text_hafs to recover words.
  text_imlaei TEXT,                              -- Imla'i simple; NULL for markers; may contain a space ("يا ايها", "واناب ۩")
  norm_loose  TEXT,                              -- normalize_ar(text_imlaei, Loose); NULL for markers
  code_v1     TEXT NOT NULL,                     -- 1–4 chars (FACT C5)
  code_v2     TEXT NOT NULL                      -- 1–4 chars (FACT C5); also used by v4
) STRICT;

CREATE TABLE page (
  mushaf_id     INTEGER NOT NULL REFERENCES mushaf(id),
  page          INTEGER NOT NULL CHECK (page BETWEEN 1 AND 604),
  first_word_id INTEGER NOT NULL,
  last_word_id  INTEGER NOT NULL,
  first_ayah_id INTEGER NOT NULL,
  last_ayah_id  INTEGER NOT NULL,
  PRIMARY KEY (mushaf_id, page)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX page_first_word ON page (mushaf_id, first_word_id);

CREATE TABLE line (
  mushaf_id     INTEGER NOT NULL,
  page          INTEGER NOT NULL,
  line          INTEGER NOT NULL CHECK (line BETWEEN 1 AND 15),
  kind          INTEGER NOT NULL CHECK (kind IN (0,1,2)),        -- 0 ayah, 1 surah_name, 2 basmallah
  centered      INTEGER NOT NULL CHECK (centered IN (0,1)),
  surah_id      INTEGER,                                         -- kinds 1,2: the surah being introduced
  first_word_id INTEGER,                                         -- kind 0 only
  last_word_id  INTEGER,
  PRIMARY KEY (mushaf_id, page, line),
  CHECK ((kind = 0 AND first_word_id IS NOT NULL AND last_word_id IS NOT NULL AND surah_id IS NULL)
      OR (kind IN (1,2) AND first_word_id IS NULL AND last_word_id IS NULL AND surah_id IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE vocab_loose (term TEXT PRIMARY KEY, doc_count INTEGER NOT NULL) STRICT, WITHOUT ROWID;

CREATE VIRTUAL TABLE ayah_fts USING fts5(loose, strict, content='', tokenize='unicode61');
```
Build finalisation (xtask, in this order):
```sql
INSERT INTO ayah_fts(rowid, loose, strict) SELECT id, norm_loose, norm_strict FROM ayah;
INSERT INTO ayah_fts(ayah_fts) VALUES('optimize');
CREATE VIRTUAL TABLE temp.v USING fts5vocab(main, ayah_fts, 'col');
INSERT INTO vocab_loose(term, doc_count) SELECT term, doc FROM temp.v WHERE col = 'loose';
ANALYZE;
PRAGMA journal_mode = DELETE;
VACUUM;
PRAGMA integrity_check;   -- must return 'ok'
```
Expected size: ≈ 9–10 MB raw (FACT §2.4). Shipped uncompressed and opened in place (FACT C12).
**(v1.2)** `word.text_imlaei` holds the diacritised Imla'i text (QDC `text_imlaei`, QUL script 54), not "Imla'i simple" as
the DDL comment (frozen in `schema/core.sql`) still says; it may also contain a waqf mark after a space (§4.2). A qdc
build is 12.5 MB (≈ 2.2 MB under NSIS's LZMA).

#### 3.1.2 Derived values
- `ayah.flags`:
  - bit0 when `rub` differs from the previous ayah's `rub` (ayah 1 sets it). `rub` is the **mushaf-source** value (D6), so the
    ۞ for rub 106 sits at 15:49 as in the printed page (Tanzil says 15:50; allowlisted in `division_exceptions.toml`).
  - bit1 when that new rub is a hizb start (`(rub − 1) % 4 == 0`).
  - bit2 when the juz changes.
  - bit3 when `ayah == 1`.
- Margin label (renderer, §8.9):
  - bit2 → `الجزء {juz}`
  - else bit1 → `الحزب {hizb}`
  - else rub position within the hizb, **(v1.2)** in words: `(rub − 1) % 4` = 1 → `ربع الحزب {hizb}`,
    2 → `نصف الحزب {hizb}`, 3 → `ثلاثة أرباع الحزب {hizb}` (the vulgar fractions ¼ ½ ¾ exist only in Western Arabic
    numbers).
- `surah.header_cp` comes from `xtask/data/qcf_surah_header_cmap.json`, copied from research evidence
  (`mushaf-fonts/qul_ligatures_surah_header_QCF_SurahHeader_COLOR.json`): `surah-N` → its first code point, e.g. surah-1 =
  U+FC45 and surah-114 = U+FBEB (non-contiguous).

#### 3.1.3 Indexing rationale
- `word`: no secondary index. Every access is a rowid range (`BETWEEN first_word_id AND last_word_id`).
- `ayah`: PK plus `UNIQUE(surah, ayah)`.
- `page_first_word`: serves both "page of ayah/word" (largest `first_word_id ≤ x`) and the bootstrap arrays.
- `line`: PK prefix `(mushaf_id, page)`.

#### 3.1.4 Key queries
**Page render: ONE query per page (target < 5 ms p99; typically < 1 ms).**
```sql
-- ?1 = mushaf_id (1|2|19), ?2 = page, ?3 = glyph selector (0 = hafs text_hafs, 1 = code_v1, 2 = code_v2)
SELECT l.line, l.kind, l.centered, l.surah_id,
       w.id, w.ayah_id, w.surah, w.ayah, w.position, w.is_end,
       CASE ?3 WHEN 1 THEN w.code_v1 WHEN 2 THEN w.code_v2 ELSE w.text_hafs END AS glyph,
       w.text_hafs,
       a.juz, a.hizb, a.rub, a.sajda, a.flags
FROM line AS l
LEFT JOIN word AS w ON l.kind = 0 AND w.id BETWEEN l.first_word_id AND l.last_word_id
LEFT JOIN ayah AS a ON a.id = w.ayah_id
WHERE l.mushaf_id = ?1 AND l.page = ?2
ORDER BY l.line, w.id;
```
The required plan (asserted by a test via `EXPLAIN QUERY PLAN`):
- `SEARCH l USING PRIMARY KEY (mushaf_id=? AND page=?)`
- `SEARCH w USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)`
- `SEARCH a USING INTEGER PRIMARY KEY (rowid=?)`

Glyph selector by style: hafs → 0, qcf_v1 → 1, qcf_v2 → 2, qcf_v4 → 2.

**Bootstrap layout arrays:**
```sql
SELECT page, first_ayah_id, first_word_id FROM page WHERE mushaf_id = ?1 ORDER BY page;   -- 604 rows
SELECT first_word_id FROM ayah ORDER BY id;                                               -- 6,236 rows
```
**Page of an ayah** (layout-specific; C1): the page whose start is at or before the ayah's first word.
```sql
SELECT page FROM page WHERE mushaf_id = ?1 AND first_word_id <= ?2 ORDER BY first_word_id DESC LIMIT 1;
```
**Ayah rows (translation mode):**
```sql
SELECT a.id, a.surah, a.ayah, a.juz, a.hizb, a.rub, a.sajda, a.flags, a.text_hafs,
       (SELECT p.page FROM page p WHERE p.mushaf_id = ?1 AND p.first_word_id <= a.first_word_id
        ORDER BY p.first_word_id DESC LIMIT 1) AS page
FROM ayah a WHERE a.id BETWEEN ?2 AND ?3 ORDER BY a.id;
```
**Search:** see §2.2.5. FTS: `SELECT rowid FROM ayah_fts WHERE ayah_fts MATCH ?1 AND rowid BETWEEN ?3 AND ?4 ORDER BY rowid LIMIT ?2`.

### 3.2 `user.db` (read-write; migrations via rusqlite_migration)
`crates/quran-core/migrations/user/0001_init.sql`. Migrations are append-only (`0002_…sql`). `PRAGMA user_version` is
owned by rusqlite_migration and nothing else may write it. PRAGMAs are set outside migrations.
```sql
CREATE TABLE setting (
  key        TEXT PRIMARY KEY,                    -- Rust field name (snake_case) from SETTING_FIELDS, NOT the camelCase IPC name
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE collection (
  id TEXT PRIMARY KEY,                            -- UUIDv7
  name TEXT NOT NULL, color TEXT, sort_key INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;

CREATE TABLE bookmark (
  id         TEXT PRIMARY KEY,                    -- UUIDv7
  kind       TEXT NOT NULL CHECK (kind IN ('ayah','page')),
  ayah_id    INTEGER NOT NULL CHECK (ayah_id BETWEEN 1 AND 6236),  -- page kind: first ayah on that page
  mushaf_id  INTEGER CHECK (mushaf_id IN (1,2,19)),                -- page kind only
  page       INTEGER CHECK (page BETWEEN 1 AND 604),               -- page kind only
  label      TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  CHECK ((kind = 'page') = (page IS NOT NULL AND mushaf_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX bookmark_ayah_u ON bookmark(ayah_id) WHERE kind = 'ayah' AND deleted_at IS NULL;
CREATE UNIQUE INDEX bookmark_page_u ON bookmark(mushaf_id, page) WHERE kind = 'page' AND deleted_at IS NULL;
CREATE INDEX bookmark_created ON bookmark(created_at) WHERE deleted_at IS NULL;

CREATE TABLE collection_item (
  collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  bookmark_id   TEXT NOT NULL REFERENCES bookmark(id) ON DELETE CASCADE,
  sort_key      INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, bookmark_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX collection_item_bookmark ON collection_item(bookmark_id);

CREATE TABLE reading_bookmark (                   -- the single movable "reading bookmark"
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ayah_id INTEGER NOT NULL, mushaf_id INTEGER NOT NULL, page INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE highlight (
  id           TEXT PRIMARY KEY,
  from_ayah_id INTEGER NOT NULL CHECK (from_ayah_id BETWEEN 1 AND 6236),
  to_ayah_id   INTEGER NOT NULL CHECK (to_ayah_id BETWEEN from_ayah_id AND 6236),
  color        TEXT NOT NULL CHECK (color IN ('yellow','green','blue','red','purple')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE INDEX highlight_range ON highlight(from_ayah_id, to_ayah_id) WHERE deleted_at IS NULL;

CREATE TABLE note (
  rid          INTEGER PRIMARY KEY,               -- explicit rowid for external-content FTS (VACUUM-safe)
  id           TEXT NOT NULL UNIQUE,              -- UUIDv7
  from_ayah_id INTEGER NOT NULL CHECK (from_ayah_id BETWEEN 1 AND 6236),
  to_ayah_id   INTEGER NOT NULL CHECK (to_ayah_id BETWEEN from_ayah_id AND 6236),
  title        TEXT,
  body         TEXT NOT NULL,                     -- Markdown subset (§7.5)
  body_search  TEXT NOT NULL,                     -- fold_latin(normalize_ar(coalesce(title,'')||' '||body, Loose))
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE INDEX note_range ON note(from_ayah_id, to_ayah_id) WHERE deleted_at IS NULL;
CREATE VIRTUAL TABLE note_fts USING fts5(body_search, content='note', content_rowid='rid',
                                         tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER note_ai AFTER INSERT ON note BEGIN
  INSERT INTO note_fts(rowid, body_search) VALUES (new.rid, new.body_search); END;
CREATE TRIGGER note_ad AFTER DELETE ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, body_search) VALUES ('delete', old.rid, old.body_search); END;
CREATE TRIGGER note_au AFTER UPDATE OF body_search ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, body_search) VALUES ('delete', old.rid, old.body_search);
  INSERT INTO note_fts(rowid, body_search) VALUES (new.rid, new.body_search); END;

CREATE TABLE tag (
  id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE UNIQUE INDEX tag_name_u ON tag(name) WHERE deleted_at IS NULL;
CREATE TABLE item_tag (
  tag_id    TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('bookmark','note','highlight')),
  item_id   TEXT NOT NULL,
  PRIMARY KEY (tag_id, item_kind, item_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX item_tag_item ON item_tag(item_kind, item_id);

CREATE TABLE reading_position (
  context    TEXT PRIMARY KEY CHECK (context IN ('mushaf','translation','audio')),
  mushaf_id  INTEGER, page INTEGER, ayah_id INTEGER NOT NULL, scroll_px INTEGER,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE history_entry (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  mode      TEXT NOT NULL CHECK (mode IN ('read','listen','memorize')),
  mushaf_id INTEGER, page INTEGER, ayah_id INTEGER NOT NULL,
  dwell_s   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX history_at ON history_entry(at);

CREATE TABLE search_history (
  query TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (json_valid(scope)),  -- serde JSON of SearchScope, e.g. {"type":"quran"}
  last_used_at INTEGER NOT NULL, use_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (query, scope)
) STRICT, WITHOUT ROWID;

CREATE TABLE memo_ayah (
  ayah_id          INTEGER PRIMARY KEY CHECK (ayah_id BETWEEN 1 AND 6236),
  status           TEXT NOT NULL CHECK (status IN ('new','learning','memorized','review')),
  strength         INTEGER NOT NULL DEFAULT 0 CHECK (strength BETWEEN 0 AND 5),
  reviews          INTEGER NOT NULL DEFAULT 0,
  lapses           INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at INTEGER, due_at INTEGER,
  updated_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX memo_due ON memo_ayah(due_at) WHERE status IN ('learning','review');

CREATE TABLE memo_test (
  id INTEGER PRIMARY KEY,
  from_ayah_id INTEGER NOT NULL, to_ayah_id INTEGER NOT NULL, start_ayah_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  reveals INTEGER, mistakes INTEGER, rating INTEGER CHECK (rating BETWEEN 1 AND 4)
) STRICT;

CREATE TABLE loop_preset (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, reciter_id INTEGER,
  from_ayah_id INTEGER NOT NULL, to_ayah_id INTEGER NOT NULL,
  ayah_repeat INTEGER NOT NULL DEFAULT 1, range_repeat INTEGER NOT NULL DEFAULT 1,
  gap_json TEXT NOT NULL DEFAULT '{"type":"none"}' CHECK (json_valid(gap_json)),
  speed_pct INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE installed_pack (
  pack_id         TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  version         TEXT NOT NULL,
  path            TEXT,                           -- relative to packs/; NULL for cache-backed packs
  status          TEXT NOT NULL CHECK (status IN ('installed','partial','paused','failed','removing')),
  bytes           INTEGER NOT NULL DEFAULT 0,
  items_total     INTEGER NOT NULL DEFAULT 0,
  items_present   INTEGER NOT NULL DEFAULT 0,
  sha256          TEXT, source_version TEXT,
  installed_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_checked_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE pack_item (
  pack_id      TEXT NOT NULL,
  item         TEXT NOT NULL,                     -- 'p262' | '002' | 'ch18' | 'file:qcf-surah-header.woff2'
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0,1)),   -- 0 = evictable stream cache
  fetched_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, item)
) STRICT, WITHOUT ROWID;
CREATE INDEX pack_item_lru ON pack_item(pinned, last_used_at);
```
Rules:
- Ids for user entities are UUIDv7 strings (sync-ready). Every user entity has `created_at`/`updated_at` and a `deleted_at`
  tombstone. Delete commands tombstone and return the row (for undo). `purge_tombstones(30)` runs at open.
- **Settings:** one row per top-level `Settings` field, `value` = serde_json of that field. Keys come from an explicit table in
  `user_db/settings.rs`, `const SETTING_FIELDS: &[SettingField]`, one entry per top-level field with its snake_case Rust name
  and a per-field (de)serialiser pair (`fn(&Settings) -> serde_json::Value`, `fn(&mut Settings, serde_json::Value) ->
  Result<()>`). Keys are therefore independent of the camelCase serde rename used over IPC (§0.2); a unit test asserts the
  table covers every field exactly once. Unknown keys are ignored. A key that is missing or fails to deserialise falls back to
  `Settings::default()` for that field (logged at warn).
- **Highlight overlap:** `highlight_set(from, to, color)` splits or trims existing ranges that overlap `[from, to]` in one
  transaction, so ranges never overlap.
- **Marks query** (one call per visible page set):
  ```sql
  SELECT ayah_id, id FROM bookmark WHERE kind = 'ayah' AND deleted_at IS NULL AND ayah_id BETWEEN ?1 AND ?2;
  SELECT page, id FROM bookmark WHERE kind = 'page' AND deleted_at IS NULL AND mushaf_id = ?3 AND page IN (…);
  SELECT id, from_ayah_id, to_ayah_id, color FROM highlight WHERE deleted_at IS NULL AND from_ayah_id <= ?2 AND to_ayah_id >= ?1;
  SELECT id, from_ayah_id, to_ayah_id FROM note WHERE deleted_at IS NULL AND from_ayah_id <= ?2 AND to_ayah_id >= ?1;
  SELECT ayah_id FROM reading_bookmark WHERE id = 1;
  ```

### 3.3 `content.db` (read-write; `schema/content.sql` applied as migration 1; D20)
Not disposable as a whole: rows with `pinned = 1` back installed packs and pinned audio and survive "Clear cache"
(`ContentDb::clear_unpinned`). A corrupt file is quarantined and recreated (`open_or_recover`), after which installed packs
re-sync to `partial` (§2.5.5).
```sql
CREATE TABLE timing_file (
  reciter_id INTEGER NOT NULL, surah INTEGER NOT NULL,
  audio_url TEXT NOT NULL, content_length INTEGER, duration_ms INTEGER,
  word_level INTEGER NOT NULL CHECK (word_level IN (0,1)),
  source TEXT NOT NULL,                           -- 'qdc'
  fetched_at INTEGER NOT NULL, etag TEXT, payload_sha256 TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),   -- 1 while the matching audio file is pinned (and surah 1)
  PRIMARY KEY (reciter_id, surah)
) STRICT, WITHOUT ROWID;
CREATE TABLE timing_ayah (
  reciter_id INTEGER NOT NULL, surah INTEGER NOT NULL, ayah INTEGER NOT NULL,
  from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL,
  words BLOB NOT NULL,                            -- pack_words(): LE u16 pos, u32 start_ms, u32 end_ms; sorted by start
  PRIMARY KEY (reciter_id, surah, ayah)
) STRICT, WITHOUT ROWID;
CREATE TABLE wbw (
  pack_id TEXT NOT NULL, word_id INTEGER NOT NULL, translation TEXT, transliteration TEXT,
  PRIMARY KEY (pack_id, word_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE tafsir_entry (
  pack_id TEXT NOT NULL, from_ayah_id INTEGER NOT NULL, to_ayah_id INTEGER NOT NULL, html TEXT NOT NULL,
  PRIMARY KEY (pack_id, from_ayah_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE content_chapter (                    -- presence + revalidation stamps for wbw/tafsir chapters
  pack_id TEXT NOT NULL, surah INTEGER NOT NULL, fetched_at INTEGER NOT NULL, sha256 TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),   -- 1 when the pack is installed (scope All)
  PRIMARY KEY (pack_id, surah)
) STRICT, WITHOUT ROWID;
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL) STRICT, WITHOUT ROWID; -- disposable
```
`clear_unpinned` deletes `timing_file`/`timing_ayah` rows of unpinned timings, `content_chapter` rows with `pinned = 0`
together with their `wbw`/`tafsir_entry` rows for that `(pack_id, surah)`, and every `kv` row, in one transaction.
Queries:
- Tafsir for an ayah:
  `SELECT from_ayah_id, to_ayah_id, html FROM tafsir_entry WHERE pack_id = ?1 AND from_ayah_id <= ?2 ORDER BY from_ayah_id DESC LIMIT 1`,
  then require `to_ayah_id >= ?2`.
- WBW range: `SELECT word_id, translation, transliteration FROM wbw WHERE pack_id = ?1 AND word_id BETWEEN ?2 AND ?3`.

### 3.4 Pack DB format (`schema/pack.sql`, one file per translation or tafsir pack)
```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
-- keys: format ('1'), pack_id, kind ('translation'|'tafsir'), lang, dir ('ltr'|'rtl'), name, author, source,
--       source_version, licence, attribution, tokenizer, normalizer_version, created_at, source_sha256
CREATE TABLE entry (
  ayah_id    INTEGER PRIMARY KEY CHECK (ayah_id BETWEEN 1 AND 6236),  -- first ayah of the range; explicit rowid
  to_ayah_id INTEGER NOT NULL CHECK (to_ayah_id >= ayah_id),          -- = ayah_id for translations
  html  TEXT NOT NULL,                            -- sanitised (ammonia policy §2.5.6)
  plain TEXT NOT NULL,                            -- tags stripped, footnote markers removed
  fold  TEXT NOT NULL                             -- tokenizer input (see below)
) STRICT;
CREATE TABLE footnote (
  id TEXT PRIMARY KEY,                            -- "{s}:{a}:{n}" (QuranEnc) or upstream id
  ayah_id INTEGER NOT NULL, marker TEXT NOT NULL, html TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX footnote_ayah ON footnote(ayah_id);
-- created unless tokenizer = like_fallback; <T> substituted by PackDbWriter:
CREATE VIRTUAL TABLE entry_fts USING fts5(fold, content='entry', content_rowid='ayah_id', tokenize='<T>');
```
| `meta.tokenizer` | `<T>` | `fold` content | languages |
|---|---|---|---|
| `porter_unicode61` | `porter unicode61 remove_diacritics 2` | `plain` | en |
| `unicode61_remove_diacritics` | `unicode61 remove_diacritics 2` | `plain` | fr, es, de, id, tr, ru, bn, hi, … |
| `arabic_normalized` | `unicode61` | `normalize_ar(plain, Loose)` | ar, ur, fa, ps, ku |
| `like_fallback` | (no FTS table) | `fold_latin(plain)` | zh, ja, ko, th, km |

Where `fold ≠ plain` (`arabic_normalized`, `like_fallback`), FTS `snippet()` would show folded text, so search snippets are
built in Rust from `plain` (§2.2.5 step 7).

Queries: `SELECT ayah_id, to_ayah_id, html FROM entry WHERE ayah_id BETWEEN ?1 AND ?2` (translations), and tafsir `… WHERE
ayah_id <= ?1 ORDER BY ayah_id DESC LIMIT 1` with `to_ayah_id >= ?1`.

### 3.5 Performance budgets (release build, measured by `cargo bench`-style tests in WP1a/WP1b/WP2a/WP2b)
| Operation | Budget (p99) |
|---|---|
| `CoreDb::pages` (1 page) | < 5 ms (target < 1 ms) |
| `CoreDb::index` (first call) | < 30 ms; cached after |
| `search_quran` smart, 1–3 tokens, ≤ 500 hits incl. word mapping | < 25 ms |
| typo fallback | < 60 ms |
| pack `entries` 50 ayahs × 3 packs | < 10 ms |
| `user_marks` | < 3 ms |
| `app_bootstrap` total | < 40 ms |

---

## 4. `xtask` data pipeline

### 4.1 Commands
```
cargo xtask build-core   --source qdc|qul [--out src-tauri/resources/core.db] [--cache data/cache] [--offline] [--jobs 4]
cargo xtask verify-core  [--db src-tauri/resources/core.db] [--report target/verify-core.json]
cargo xtask export-fixtures [--only mushaf,search,content,packs] [--db …] [--content-db <dev content.db>] [--packs <dir>] [--out src/lib/ipc/mock/fixtures]
cargo xtask fetch-assets [--force]          # KFGQPC Hafs V30 → public/fonts/
cargo xtask fetch-dev-packs [--out data/dev-packs] [--force]   # QCF v1/v2/v4 woff2 for the §4.6 page list + decor (§4.8)
cargo xtask licenses                        # cargo metadata + pnpm licenses → src/lib/about/thirdparty.json
cargo xtask catalog-check [--online]        # catalog.json schema + id rules (+ HEAD every URL incl. every QuranEnc zip)
cargo xtask bindings                        # = cargo test -p quran-desktop --lib export_bindings
```
`build-core` always ends by running `verify-core` and fails if any gate fails. It writes to `<out>.tmp` and renames on
success. The build is deterministic: the same inputs produce a byte-identical DB, because `built_at` comes from
`SOURCE_DATE_EPOCH` when set.

Module tree (owner in brackets): `xtask/src/{main.rs, cli.rs}` [WP0B, frozen], `build/{mod.rs, model.rs, qdc.rs, tanzil.rs,
derive.rs, write.rs}` [WP3a], `build/qul.rs` [WP3d], `verify.rs` [WP3b], `assets.rs, licenses.rs, catalog.rs, dev_packs.rs`
[WP3c], `fixtures/mod.rs` [WP0B, frozen dispatcher], `fixtures/{mushaf.rs}` [WP1a], `fixtures/search.rs` [WP1b],
`fixtures/content.rs` [WP1c], `fixtures/packs.rs` [WP5a]; data files `xtask/data/{qcf_surah_header_cmap.json,
division_exceptions.toml}` [WP3a]. `build/model.rs` is the adapter-neutral intermediate
`SourceQuran { surahs, ayahs (with divisions), words (location → fields), layouts: [Layout{mushaf_id, pages: [Page{lines:
[RawLine{line, kind?: LineKind, centered?: bool, words: Vec<location>}]}]}] }`. Both adapters fill it, and `derive.rs` +
`write.rs` are shared.

### 4.2 `qdc` adapter (development only; FACT §2.1, BRIEF §4)
Raw responses are cached under `data/cache/qdc/` (gitignored). A cached file older than 7 days is refetched (QF terms).
Concurrency is 4 and the User-Agent is `QuranForDesktop-xtask/<version>`. Requests (all verified live 2026-10-10):
1. `GET https://api.qurancdn.com/api/qdc/chapters?language=en` → `chapters[]{id, revelation_place ('makkah'|'madinah'),
   revelation_order, bismillah_pre, name_simple, name_complex, name_arabic, verses_count, translated_name.name}`.
2. For `m ∈ {1, 2, 19}` and `p ∈ 1..=604`:
   `GET https://api.qurancdn.com/api/qdc/verses/by_page/{p}?mushaf={m}&per_page=all&words=true&word_fields=code_v1,code_v2,text_qpc_hafs,text_imlaei,location`
   (1,812 requests). **(v1.2)** The search seed is the diacritised word-level `text_imlaei` (= QUL script 54), not
   `text_imlaei_simple`, which writes the dagger alef as a full alef and pre-folds hamza seats, so `الرحمن` found
   nothing (IMPLEMENTATION_NOTES §4.1; WP3a deviation 1; LEAD 17).
   - Verse fields: `verse_key, juz_number, hizb_number, rub_el_hizb_number, manzil_number, ruku_number, sajdah_number`
     (`ruku_number` and `sajdah_number` are read for the report only, never stored; D6).
   - Word fields: `location ("s:a:w"), char_type_name ('word'|'end'), page_number, line_number, code_v1, code_v2,
     text_qpc_hafs, text_imlaei` (v1.2).
   - `pagination.next_page` MUST be null (`per_page=all`). Otherwise fail.
3. Tanzil metadata `GET https://tanzil.net/res/text/metadata/quran-data.xml` (CC BY 3.0, direct). Cached under
   `data/cache/tanzil/` and hashed into `meta.tanzil_sha256`.

Mapping rules:
- Word-level fields (`code_v1`, `code_v2`, `text_qpc_hafs`, `text_imlaei`) come from the `m=1` responses. The other two
  mushafs MUST return identical values for the same location; a mismatch fails the build.
- Per mushaf, words are grouped by `(page_number, line_number)`, with **D4: on pages 1 and 2, `line_number −= 7`**. The
  result must be p1 lines 2..8 and p2 lines 3..8. The build fails if any page-1/2 line falls outside 1..8 after the fix.
- `text_hafs` = `text_qpc_hafs`, except for end words, which become `"\u{06DD}" + digits`. The digits are the Arabic-Indic
  ayah number exactly as the source gives it.
- `text_imlaei` = the source's `text_imlaei` for `char_type_name == "word"` (v1.2; it may hold waqf marks after a space and
  is never displayed raw), and NULL for `end`.
- **(v1.2) Source facts kept verbatim** (LEAD 17; WP3a deviation 3): QDC labels 2:181's end marker a word, and derive
  relabels it by a narrow rule. The first word of 199 of the 240 quarter starts (every one except ayah 1 of a surah)
  begins with the printed `۞ ` in `text_qpc_hafs` and `text_imlaei`; 195 of its `code_v1`/`code_v2` values are
  `<۞ glyph> U+0020 <word glyph>` and 4 have no separator. The inline ۞ is kept as printed (the margin then draws the
  quarter's label, never a second ۞, §8.9 and IMPLEMENTATION_NOTES §10.4).
- Divisions (D6): per-ayah `rub` = `rub_el_hizb_number` (mushaf source); `juz`, `hizb` and `manzil` from Tanzil and hard-checked
  against `juz_number`/`hizb_number`/`manzil_number`; `ruku` and sajda from Tanzil only.
- Centring:
  - v2: pages 1–2 are fully centred, plus the FACT §2.3 list.
  - v1 and v4 (dev approximation, see §4.4): pages 1–2 only, plus ayah lines whose words are identical to a centred v2 line.

### 4.3 `qul` adapter (release-grade; inputs placed by a human, BRIEF §4)
`data/sources/qul/manifest.toml` (committed together with `data/sources/README.md`; the data files themselves are
gitignored unless permission is granted):
```toml
# Valid TOML: inline tables, one entry per line (a table header cannot share a line with key/value pairs).
layout.v2        = { file = "layout-10.sqlite",  resource = 10,  sha256 = "…" }
layout.v1        = { file = "layout-15.sqlite",  resource = 15,  sha256 = "…" }
layout.v4        = { file = "layout-19.sqlite",  resource = 19,  sha256 = "…" }
script.code_v2   = { file = "script-61.sqlite",  resource = 61,  sha256 = "…" }
script.code_v1   = { file = "script-57.sqlite",  resource = 57,  sha256 = "…" }
script.text_hafs = { file = "script-312.sqlite", resource = 312, sha256 = "…" }
script.imlaei    = { file = "script-60.sqlite",  resource = 60,  sha256 = "…" }
meta.surah       = { file = "surah-names.json",  resource = 70,  sha256 = "…" }
meta.rub         = { file = "rub-el-hizb.json",  resource = 67,  sha256 = "…" }   # rub boundaries (D6)
tanzil           = { file = "quran-data.xml",                     sha256 = "…" }
```
WP3d's unit test parses this exact snippet with the `toml` crate.
**(v1.2) The committed [`data/sources/qul/manifest.toml`](../data/sources/qul/manifest.toml) is authoritative** and corrects
two resource ids of the example above (WP3d deviations 1–5): `script.imlaei` is QUL **54** (`script-54.sqlite`; 60 is
"Imlaei simple", which breaks search, §4.2), and `meta.rub` is QUL **63** (67 is QUL's *Hizb* file). It adds the optional
D6 cross-check inputs `meta.juz` (68), `meta.hizb` (67) and `meta.manzil` (66). `sha256 = ""` means "not recorded yet":
the build stops and prints the file's actual hash. `meta.source_manifest_sha256` hashes one canonical line per input,
not the file. The build rejects a wrong resource id and names the right one.
Reading rules:
- **Layouts.** Read `pages(page_number, line_number, line_type, is_centered, first_word_id, last_word_id, surah_number)`.
  Convert `''` to NULL. `line_type` maps to kind 0/1/2. `basmallah` lines take the surah of the next ayah line.
- **Scripts.** Read `words(id|word_index, location|word_key, surah, ayah, word?, text)`. Accept both column-name variants
  (mushaf-text-layout §2).
- **Canonical word ids.** The four scripts MUST have identical location sets. Build the canonical sequence by sorting
  locations by (s, a, w). It MUST contain exactly 83,665 locations. If QUL has 83,668 rows (the 3 extra slots, FACT C7), the
  build fails and prints the extra locations for a human decision.
- **QUL id mapping.** QUL `first_word_id`/`last_word_id` are QUL `word_index` values. Map them via the layout DB's own words,
  or script 61, to locations and then to canonical ids. Never compare raw ids.
- **38:24:32–33 (D5).** If `code_v1(38:24:32) == "\u{FBE9}"` and `code_v1(38:24:33) == "\u{FBEA}\u{FBEB}"` (the combined
  exporter's grouping), regroup to `"\u{FBE9}\u{FBEA}"` / `"\u{FBEB}"`.
- **Surah names:** from QUL 70 (`id, name, name_simple, name_arabic, revelation_order, revelation_place, verses_count,
  bismillah_pre`). `name_complex = name` (transliteration with diacritics). `name_en` comes from Tanzil `ename`.
- **Rub:** per-ayah rub-el-hizb from QUL metadata **63** (v1.2; 67 is the Hizb file. The shape is verified by WP3d when the
  file arrives; the parsers are unit-tested on synthetic JSON and on a full-scale round trip of the qdc build until then). Cross-checked against Tanzil with the same allowlist as the qdc adapter (D6).

### 4.4 Shared derivation rules (`derive.rs`)
1. **Line kinds (FACT C15).** For an adapter that has no line types (qdc), every empty line slot on a page is a header slot.
   For each surah s, let L be the line of its first ayah's first word on page P.
   - s ∈ {1, 9}: line L−1 is `surah_name`.
   - otherwise: line L−1 is `basmallah` and line L−2 is `surah_name`.
   - Both lines are on page P, with `centered = 1` and `surah_id = s`.
   - Any empty slot that isn't explained this way fails the build.
   - **(v1.2, LEAD 17) Cross-page headers.** The lines are taken in reading order, and the `surah_name` of a two-line
     header MAY be line 15 of page P−1 when L is line 2 of P (the basmallah then opens page P). This is the authentic
     print geometry: V2 has it for 18 surahs (4, 10, 22, 23, 24, 26, 27, 32, 33, 37, 38, 45, 47, 53, 60, 64, 65, 80), V1
     for 21 (those plus 82, 86, 91), V4 for none. The slot directly above L (the basmallah, or the lone `surah_name` of
     surahs 1 and 9) is always on page P. FACT C15's "no header is ever orphaned" was measured on the legacy API and is
     wrong (FACT_SHEET C15, corrected). Page assembly, `PageInfo.surah_ids` and the renderer handle a page that ends
     with the next surah's `surah_name`.
   
   For qul, the provided types MUST equal the derived ones (gate G8).
2. **Pages 1–2:** exactly lines 1..8. Line 1 is `surah_name`. Page 2 line 2 is `basmallah`. Every line is centred.
3. **Divisions (D6, one source per field).**
   - `juz`, `hizb` (of 60) and `manzil`: Tanzil boundaries, hard cross-checked per ayah against the mushaf source (qdc verse
     fields / QUL metadata). Any difference fails the build (0 differences verified on 2026-10-10).
   - `rub` (and therefore `ayah.flags` bits 0/1 and the ۞ margin marker): the **mushaf source** (qdc `rub_el_hizb_number`,
     qul metadata 63, v1.2). Cross-checked against Tanzil quarter boundaries with the committed allowlist
     `xtask/data/division_exceptions.toml`, which contains exactly one entry:
     ```toml
     [[rub]]
     id = 106
     source = "15:49"
     tanzil = "15:50"
     ```
     Any other difference, or an allowlisted entry that no longer differs, fails the build.
   - `ruku`: Tanzil only (556 rows; the Madani print has no ruku marks), no per-ayah cross-check. (QDC numbers 558 rukus and
     differs on 2,904 ayahs: starts only in QDC 26:52, 26:69, 28:83, 31:31; only in Tanzil 26:53, 26:70.)
   - `sajda`: Tanzil's 15 ayahs with `sajda.kind` from Tanzil `type`. QDC `sajdah_number` is never used (it misses 22:77).
4. `ayah.flags`, `text_hafs`, `text_imlaei`, `norm_*`: as §3.1.1 and §3.1.2.
5. `page.first/last_word_id` and `first/last_ayah_id` are derived from the line table.
6. `surah.header_cp` comes from `xtask/data/qcf_surah_header_cmap.json`.

### 4.5 `verify-core` gates (every one MUST pass; `--report` writes JSON)
| Gate | Invariant |
|---|---|
| G1 counts | surah = 114, ayah = 6,236, word = 83,665 (77,429 `is_end=0` + 6,236 `is_end=1`); per-surah ayah counts == Tanzil |
| G2 word order | ids contiguous 1..83,665 and strictly increasing in (surah, ayah, position); each ayah has positions 1..n contiguous, exactly one `is_end` and it is the last |
| G3 ayah ranges | `ayah.first_word_id/last_word_id` match the word table; ayah ids contiguous in (surah, ayah) order; `surah.first_ayah_id` consistent |
| G4 glyph codes | `code_v1`, `code_v2` have 1–4 chars, no whitespace (hard; **v1.2:** one inner U+0020 is allowed in exactly two cases, the printed `۞ ` prefix of a quarter's first word (195 codes per column) and the three listed words 8:6:4, 36:52:6, 37:130:3); multi-char word counts reported, with a warning if they differ from FACT C5 (V1 4,580, V2 4,517) (report); `code_v1(38:24:32) = U+FBE9 U+FBEA` and `code_v1(38:24:33) = U+FBEB` (D5, hard) |
| G5 Hafs text | end words = U+06DD followed by the Arabic-Indic digits of `ayah`; U+06DD appears nowhere else; no empty `text_hafs` |
| G5b word spaces | every U+0020 inside a non-end `word.text_hafs` is immediately followed by U+06E9 (۩), so words containing a space ⊆ words containing ۩ (hard); the list is reported. Verified for QDC QPC text on 2026-10-10: 9 of the 15 sajda words carry "space + ۩" (17:109:5, 19:58:29, 22:18:37, 22:77:11, 25:60:13, 32:15:15, 38:24:32, 41:38:12, 84:21:6); the other 6 attach ۩ directly. **v1.2:** every such space must be one of three kinds: before ۩ (that list; another list is a warning), the `۞ ` prefix of a quarter's first word (199 words), or the single space of a listed compound (2:181:3, 8:6:4, 13:37:8, 37:130:3); any other space fails |
| G6 page shape | for each mushaf (1, 2, 19): 604 pages; pages 1–2 have exactly lines 1..8; pages 3..604 have exactly lines 1..15 |
| G7 coverage | per mushaf, every word id is covered by exactly one kind-0 line; ranges are contiguous across lines and pages (`next.first = prev.last + 1`); `page` rows agree with lines |
| G8 header lines | per mushaf, 114 `surah_name` and 112 `basmallah` lines (none for 1 or 9 basmallah); C15 geometry holds for all 114 surahs; header lines are on the same page as the surah's first ayah line (**v1.2:** except a two-line header's `surah_name`, which may be the previous page's line 15, §4.4 rule 1; the cross-page surahs are reported); `surah.bismillah_pre = (id ∉ {1, 9})` |
| G9 centring | pages 1–2: every line centred; every kind 1/2 line centred; v2 ayah lines centred exactly on {255:[2], 528:[9], 534:[6], 545:[6], 586:[1], 593:[2], 594:[5], 600:[10], 602:[5,15], 603:[10,15], 604:[4,9,14,15]}; v1/v4 with source qul: as provided (report count) |
| G10 page starts | every page's first word has `position = 1` in all layouts; v1 first ayah per page == Tanzil 604/604; the set of pages where v1 and v2 first words differ == {121,122,123,145,532,533,534,565,568,570,576,584,586,588,589,590,592..600} (25); v4 page starts == v2 page starts (604/604) |
| G11 divisions | juz 30, hizb 60, rub 240, manzil 7, ruku 556, sajda 15 with obligatory = {32:15, 41:38, 53:62, 96:19}; boundaries == Tanzil **except the entries allowlisted in `xtask/data/division_exceptions.toml`** (exactly `rub 106: 15:49 vs 15:50`; a stale allowlist entry also fails) |
| G11b sajda glyphs | the set of ayahs that have a word whose `text_hafs` contains U+06E9 == the `sajda` table (15 ayahs, exactly one such word each) |
| G12 search | `ayah_fts` has 6,236 rows; loose `"الرحمن"` hits ⊇ {1:1, 1:3}; `"العالمين"` ⊇ {1:2}; `"الصلاه"` hits 2:3; prefix `"الرح"*` ≥ 1; strict `"الصلاة"` hits 2:3; `vocab_loose` row count within 14,000–15,500 |
| G13 normaliser | `meta.normalizer_version` == `quran_core::NORMALIZER_VERSION`; `ayah.norm_*` == `normalize_ar(text_imlaei)` for all rows; no char of `norm_loose` in the step-1 deletion set |
| G14 SQLite | `integrity_check = ok`; `foreign_key_check` empty; `journal_mode = delete`; file < 16 MB (v1.2: MiB; also the schema equals `CORE_SQL`, the 10 `meta` keys, `page_size = 4096`) |
| G15 performance | the §3.1.4 page query plan matches (v1.2: of `core_db::PAGE_SQL`, ignoring SQLite 3.53's ` LEFT-JOIN` suffix); all 3 × 604 page queries run in < 5 ms each (p99) on the CI runner (v1.2: 4 × 604, one pass per style, after a warm-up pass) |
| G16 header map | `header_cp` non-null for 114 surahs when the map file is present; surah 1 = 0xFC45, 114 = 0xFBEB |

### 4.6 `export-fixtures` (input to the browser mock, D10)
Output: `src/lib/ipc/mock/fixtures/` (gitignored, local development only, never committed or uploaded; QF terms). Every file is
the **serde_json serialisation of the same quran-types DTO** that the real command returns, so the shapes can't drift. The
exporter is split by domain (`xtask/src/fixtures/*.rs`, §4.1) and each part serialises through the owning package's own
Rust API, so WP1a can deliver pages and the index on day 1 of its package without waiting for search or packs.
```
fixtures/
├─ manifest.json                 # { builtAt, source, pages: [...], ayahWindows: [...], packs: [...], timings: [...], queries: [...] }
├─ index.json                    # QuranIndex (WP1a). The mock assembles Bootstrap at runtime from index.json + its state slices
├─ pages/{style}/p{NNN}.json     # PageData, style ∈ hafs|qcf_v2|qcf_v1|qcf_v4                             (WP1a)
├─ ayahs/{from}-{to}.json        # Vec<AyahText> (layout v2)                                               (WP1a)
├─ search/vocab.json             # top 2,000 vocab_loose terms (mock suggest)                              (WP1b)
├─ search/ayahs.json             # 6,236 × [id, normLoose] so the mock can do ad-hoc substring search       (WP1b)
├─ search/results/{slug}.json    # SearchResults from the real SearchEngine for the fixed query list below  (WP1b)
├─ translations/{packId}/{from}-{to}.json   # Vec<TranslationRow>; real packs only if --packs given, else synthetic (WP1c)
├─ tafsir/{packId}/{ayahId}.json # TafsirEntry; synthetic (one Arabic RTL pack, one English pack)          (WP1c)
├─ timings/{reciterId}/{surah}.json         # SurahTimings; from --content-db if given, else synthetic       (WP1c)
├─ wbw/{packId}/{surah}.json     # Vec<WbwEntry>; real with --content-db, else synthetic for every word on the fixture pages (WP1c)
└─ packs/list.json               # Vec<PackInfo> from catalog.json, every pack NotInstalled                  (WP5a)
```
- **Pages exported** (all 4 styles): 1, 2, 3, 4, 5, 42, 43, 50, 51, 76, 77, 106, 107, 121, 122, 123, 145, 176, 177, 187,
  206, 207, 255, 256, 261, 262, 263, 293, 342, 343, 377, 415, 454, 455, 528, 529, 534, 545, 586, 587, 593, 594, 600, 601,
  602, 603, 604. This covers the opening pages, consecutive spreads, the surah 9 header, sajda pages, centred-line pages,
  the V1/V2 divergent pages, multi-glyph waqf words and the last pages.
- **Pages outside the list:** the mock serves a synthetic page carrying the real page number (and the real ayah range from
  `index.json` when present) with a visible "synthetic" badge, so navigation never breaks.
- **Ayah windows:** 1–7, 8–40 (2:1–33), 255–262 (2:248–255), 2101–2140 (al-Kahf start), 3706–3790 (Yā-Sīn),
  5242–5271 (al-Mulk), 6222–6236 (112–114).
- **Search query list** (`search/results/{slug}.json`, smart mode unless noted): `الرحمن`, `العالمين`, `الصلاه`, `الرح*`
  (prefix), `يا ايها`, and translation-scope queries `mercy` and `light` (against a real or synthetic `tr.en.*` pack).
- **Synthetic timings** (no QF content needed): for surahs 1, 2, 18, 36, 67, 112, 113 and 114, ayah durations are
  `1200 ms + 380 ms × (non-end word count)`, with words evenly split. `audio_url` is `mock://{reciter}/{surah}`.
- `pnpm dev:web` also works **without** fixtures: the mock then falls back to the WP0C synthetic generator (15 lines × 8
  placeholder words `كلمة`, hafs style), so UI work never blocks on WP3a.

### 4.7 `fetch-assets`
1. `GET https://fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip`. The size MUST be 844,410 B (FACT §4.3).
2. Extract `KFGQPC Hafs V30.ttf`. Its size MUST be 301,356 B. Write it **unmodified** (EULA: no modification, no woff2
   conversion) to `public/fonts/KFGQPC-Hafs-V30.ttf`, and the EULA (name table ID 13, extracted as text) to
   `public/fonts/KFGQPC-Hafs-V30.LICENSE.txt`.
3. Record sha256 in `xtask/assets.lock` on first run (trust on first use). Later runs MUST match unless `--force` is given.
4. `public/fonts/KFGQPC-Hafs-V30.ttf` is **gitignored**. CI and developers fetch it with this command; CI caches the
   result keyed by the hash of `xtask/assets.lock` so fonts.qurancomplex.gov.sa is not hit on every run. The EULA allows
   redistribution of the unmodified file, so the installer bundles it. The licence text file is committed.
5. **Fallback (LEAD 24).** When the download in step 1 fails (no connection, a timeout, an HTTP error, a body over the
   size cap), the font comes from `xtask/assets/KFGQPC-Hafs-V30.ttf`, the unmodified pinned file committed to the
   repository, once its size and sha256 match the pin; the outputs are those of step 2. Only with a pin and without
   `--force`: the committed copy never pins or re-pins. A downloaded archive or font of the wrong size or hash never
   falls back (an upstream change to review). A run that pins or re-pins rewrites the committed copy too.

### 4.8 `fetch-dev-packs` (WP3c; local development only)
- Downloads, via the catalog URL templates (`quran_packs::catalog`), the QCF v1, v2 and v4 woff2 files for the §4.6 page list
  (3 × 47 files, ≈ 4 MB) and the 3 decor files into `data/dev-packs/` in the same layout as the app's `packs/` directory
  (`mushaf/{v1,v2,v4}/p{N}.woff2`, `decor/*`).
- `data/dev-packs/` is **gitignored, never committed and never uploaded** (QF terms: fonts may be cached by the app for the
  user, not redistributed as an asset package).
- The Vite dev-packs plugin (`vite/dev-packs.ts`, WP8b) serves it at `/__packs/*` in `--mode mock`, and `QD_PACKS_DIR`
  defaults to it, so QCF rendering, the D13 cross-fade, palettes, the COLR probe, glyph-scale measurement and decor headers
  can be built and screenshotted in a normal browser before the WP5 and WP6 packages exist.

---

## 5. IPC contract (THE integration surface)

Everything below lives in `crates/quran-types` (DTOs) and `src-tauri/src/{commands,ipc}` (signatures). WP0A writes it
verbatim. `src/lib/ipc/bindings.ts` is generated from it. Every DTO derives
`#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]` (`Eq`/`Hash`/`Copy` where noted).
Integer-only rules: §0.2. Serde casing: §0.2.

### 5.1 Conventions for commands
- Every command is `#[tauri::command] #[specta::specta] pub async fn …(…) -> Result<T, AppError>`. All of them are `async`
  (D: no main-thread work), and borrowed `State` requires `Result`.
- DB work goes through `crate::util::blocking(move || …).await`, defined as:
  ```rust
  pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, AppError> + Send + 'static) -> Result<T, AppError> {
      tauri::async_runtime::spawn_blocking(f).await.map_err(internal)?
  }
  /// The only way to turn foreign errors (tauri::Error, JoinError, …) into AppError: `impl From<tauri::Error> for AppError`
  /// cannot be written anywhere (orphan rule in src-tauri; quran-types has no tauri dependency).
  pub fn internal(e: impl std::fmt::Display) -> AppError { AppError::Internal(e.to_string()) }
  ```
  Use `.map_err(util::internal)` for every tauri and join error.
- Async managers (`PackManager`, `AudioService::timings`) are awaited directly in the command; `blocking()` is only for
  synchronous SQLite/disk work. Never `block_on` inside a command (§0.2).
- Argument names are snake_case in Rust. Tauri maps them to camelCase in JS (verified in the probe: `pack_id` → `packId`).
- Commands validate input and return `InvalidArgument` (ayah 1..=6236, page 1..=604, ranges ≤ the documented maximum).
- Commands never panic (§0.2). Long work goes through the managers, which do not block command threads.

### 5.2 Error model
```rust
// quran-types/src/error.rs
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum AppError {
    #[error("not found: {0}")]        NotFound(String),
    #[error("invalid argument: {0}")] InvalidArgument(String),
    #[error("database: {0}")]         Database(String),
    #[error("io: {0}")]               Io(String),
    #[error("network: {0}")]          Network(String),
    #[error("offline: {0}")]          Offline(String),
    #[error("integrity: {0}")]        Integrity(String),
    #[error("cancelled: {0}")]        Cancelled(String),
    #[error("conflict: {0}")]         Conflict(String),
    #[error("audio: {0}")]            Audio(String),
    #[error("unsupported: {0}")]      Unsupported(String),
    #[error("internal: {0}")]         Internal(String),
}
```
TS: `type AppError = { kind: "not_found"; message: string } | { kind: "invalid_argument"; message: string } | …`.
Every command result in TS is `{status:"ok", data:T} | {status:"error", error:AppError}` (tauri-specta `typedError`).
**That type is unsound at the edges:** Tauri rejects argument-deserialisation failures and unmanaged `State` with a plain
JSON **string** (`InvokeError::from_anyhow`), which the generated wrapper passes through as `error`. `call()` (§5.16)
normalises a string error to `{ kind: 'internal', message }` before anything reads `kind`.

| Source error | → AppError |
|---|---|
| `CoreError::NotFound` | `NotFound` |
| `CoreError::InvalidArgument` | `InvalidArgument` |
| `CoreError::{Sqlite, Pool, Migration, SchemaMismatch, Corrupt}` | `Database` |
| `CoreError::Io` | `Io` |
| `CoreError::Json` | `Internal` |
| `CoreError::NotImplemented` | `Unsupported` |
| `PackError::Http{status: 404}` | `NotFound` |
| `PackError::Http{..}`, `Network` | `Network` |
| `PackError::Offline`, `AudioError::Offline` | `Offline` |
| `PackError::{Integrity, Zip}` | `Integrity` |
| `PackError::Cancelled` | `Cancelled` |
| `PackError::Conflict` | `Conflict` |
| `PackError::{Catalog}` | `Internal` |
| `tauri::Error`, `JoinError` (no `From` impl possible; use `util::internal`) | `Internal` |
| `PackError::Unsupported`, `PackError::NotFound` | `Unsupported` / `NotFound` |
| `AudioError::Source` | `Network` |
| `AudioError::{NoOutputDevice, Device, Decode, Timings, EngineGone}` | `Audio` |
| `AudioError::Invalid` | `InvalidArgument` |

Messages are English, developer-oriented, and **never shown raw**. The UI maps `kind` to a localised message (§11) and shows
`message` only in a "Details" disclosure.

### 5.3 DTOs: ids, meta, bootstrap
```rust
// quran-types/src/ids.rs
pub type AyahId = u32;   // 1..=6236
pub type WordId = u32;   // 1..=83665
pub type UnixSecs = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AyahRef { pub surah: u32, pub ayah: u32 }          // ayah = 0 ⇒ the basmala before `surah` (audio only)

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MushafLayout { V2, V1, V4 }                           // DB mushaf_id 1, 2, 19 ("v2" | "v1" | "v4")

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MushafStyle { Hafs, QcfV2, QcfV1, QcfV4 }            // "hafs" | "qcf_v2" | "qcf_v1" | "qcf_v4"
impl MushafStyle { pub fn layout(self) -> MushafLayout; /* hafs,qcf_v2→V2; qcf_v1→V1; qcf_v4→V4 */
                   pub fn glyph_selector(self) -> u8;   /* hafs 0, qcf_v1 1, qcf_v2/qcf_v4 2 */ }
impl MushafLayout { pub fn db_id(self) -> u32; pub fn from_db_id(id: u32) -> Option<Self>; }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct L10nText { pub en: String, pub ar: String }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TextDir { Ltr, Rtl }
```
```rust
// quran-types/src/meta.rs
#[serde(rename_all = "snake_case")] pub enum Platform { Windows, Macos, Linux }
#[serde(rename_all = "snake_case")] pub enum RevelationPlace { Makkah, Madinah }
#[serde(rename_all = "snake_case")] pub enum SajdaKind { Recommended, Obligatory }
#[serde(rename_all = "snake_case")] pub enum FontTransport { Url, Bytes }      // D30, §8.5

#[serde(rename_all = "camelCase")]
pub struct CoreDbInfo { pub schema_version: u32, pub normalizer_version: u32, pub source: String, pub built_at: String }

#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,               // "Quran" (productName; the UI shows common.appName / appFullName)
    pub version: String,            // CARGO_PKG_VERSION
    pub identifier: String,         // "com.quran.labs.desktop"
    pub platform: Platform,
    pub arch: String,               // std::env::consts::ARCH
    pub os_version: String,         // tauri_plugin_os::version().to_string() (D22)
    pub os_locale: Option<String>,  // tauri_plugin_os::locale(); used for the first-run ui_language guess
    pub webview_version: String,    // tauri::webview_version() or "unknown"
    pub data_dir: String,           // dunce-simplified
    pub log_dir: String,
    pub protocol_base: String,      // "http://quran.localhost/" (windows) | "quran://localhost/"
    pub font_transport: FontTransport, // per platform from the WP6a spike; default Url
    pub debug: bool,
    pub test_mode: bool,            // debug builds with QD_TEST=1 (D24); installs window.__QD_TEST__
    pub core: CoreDbInfo,
}

#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StartupNotice {
    UserDbRecovered { quarantined_file: String },   // §9.8 banner with "Restore from backup…"
    ContentDbRecovered,                              // silent re-sync; packs may show Partial
}

#[serde(rename_all = "camelCase")]
pub struct SurahInfo {
    pub id: u32, pub name_ar: String, pub name_simple: String, pub name_complex: String, pub name_en: String,
    pub revelation_place: RevelationPlace, pub revelation_order: u32, pub ayah_count: u32, pub first_ayah_id: u32,
    pub bismillah_pre: bool, pub header_cp: Option<u32>,
}
#[serde(rename_all = "camelCase")] pub struct Division { pub id: u32, pub first_ayah_id: u32, pub last_ayah_id: u32 }
#[serde(rename_all = "camelCase")] pub struct SajdaInfo { pub id: u32, pub ayah_id: u32, pub kind: SajdaKind }
#[serde(rename_all = "camelCase")]
pub struct LayoutInfo {
    pub layout: MushafLayout, pub pages: u32, pub lines_per_page: u32,
    pub page_first_ayah: Vec<u32>,  // len 604; index = page − 1
    pub page_first_word: Vec<u32>,  // len 604
}
#[serde(rename_all = "camelCase")]
pub struct QuranIndex {
    pub surahs: Vec<SurahInfo>,     // 114
    pub juz: Vec<Division>, pub hizb: Vec<Division>, pub rub: Vec<Division>, pub manzil: Vec<Division>,
    pub sajdas: Vec<SajdaInfo>,
    pub layouts: Vec<LayoutInfo>,   // v2, v1, v4
    pub ayah_first_word: Vec<u32>,  // len 6236; index = ayah_id − 1
}

#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub app: AppInfo,
    pub index: QuranIndex,
    pub settings: Settings,
    pub first_run: bool,
    pub positions: Vec<ReadingPosition>,
    pub reading_bookmark: Option<ReadingBookmark>,
    pub packs: Vec<PackSummary>,
    pub reciters: Vec<ReciterInfo>,
    pub decor: DecorStatus,
    pub audio: AudioSnapshot,
    pub online: bool,
    pub notices: Vec<StartupNotice>,
}
```
(Attributes elided above are the §0.2 defaults: every struct `camelCase`, every unit enum `snake_case`.)
`app_bootstrap` fails with `NotFound("core.db missing — run pnpm core:qdc")` when the core is unavailable (debug degrade path,
§2.8.2); the frontend then shows its fatal screen (§9.8) and still calls `window_ready`.

### 5.4 DTOs: Mushaf
```rust
// quran-types/src/mushaf.rs
#[serde(rename_all = "snake_case")] pub enum LineKind { Ayah, SurahName, Basmallah }
#[serde(rename_all = "snake_case")] pub enum FetchPriority { Interactive, Prefetch }
/// What mushaf_ensure_page_fonts resolves with. It resolves only when each page is final, so there is no
/// Missing/Downloading state: Ready (file on disk), Failed (download/integrity failed; retry possible),
/// Unavailable (network not allowed or offline, and not on disk).
#[serde(rename_all = "snake_case")] pub enum FontAvailability { Ready, Failed, Unavailable }

pub struct PageWord {
    pub id: u32, pub ayah_id: u32, pub surah: u32, pub ayah: u32, pub position: u32, pub is_end: bool,
    pub glyph: String,   // style glyphs: code_v1 | code_v2 (1–4 chars) | text_hafs for hafs
    pub text: String,    // QPC Hafs Unicode (end marker: U+06DD + Arabic-Indic digits) — fallback, copy, a11y
}
pub struct PageLine {
    pub line: u32,                   // 1..=15
    pub kind: LineKind,
    pub centered: bool,
    pub surah: Option<u32>,          // surah_name / basmallah lines
    pub words: Vec<PageWord>,        // empty for header lines
}
pub struct PageAyah {
    pub id: u32, pub surah: u32, pub ayah: u32, pub juz: u32, pub hizb: u32, pub rub: u32,
    pub sajda: Option<SajdaKind>,
    pub flags: u32,                  // §3.1.2 bits
    pub first_word_id: u32,          // first word of this ayah ON THIS PAGE
    pub last_word_id: u32,           // last word of this ayah ON THIS PAGE
    pub starts_on_page: bool, pub ends_on_page: bool,
    pub line: u32,                   // line of first_word_id
}
pub struct PageInfo {
    pub first_ayah_id: u32, pub last_ayah_id: u32,
    pub juz: u32, pub hizb: u32,     // of the first ayah on the page
    pub head_surah: u32,             // surah of the first ayah on the page (running head)
    pub surah_ids: Vec<u32>,         // surahs with content on the page, in order
}
pub struct PageData {
    pub layout: MushafLayout, pub style: MushafStyle, pub page: u32,
    pub lines: Vec<PageLine>,        // pages 1–2: 8 lines; others: 15
    pub ayahs: Vec<PageAyah>,
    pub info: PageInfo,
}
pub struct PageFontStatus {
    pub style: MushafStyle, pub page: u32, pub availability: FontAvailability,
    pub family: String,              // "qcf-v2-p262" (style qcf_v1 → qcf-v1-, qcf_v4 → qcf-v4-); "qd-hafs" for hafs
    pub url: Option<String>,         // "<protocolBase>mushaf/v2/p262.woff2?v=<sha8>" when Ready; None for hafs
    pub rel: Option<String>,         // "mushaf/v2/p262.woff2" when Ready: the font_bytes argument when fontTransport = bytes
    pub bytes: u32,
}
// Style `hafs` has no page fonts: every page returns Ready with family "qd-hafs", url None, rel None, bytes 0, without IO.
// Priority `prefetch` also resolves only when the download completes (or fails); it just runs in the background lane.
pub struct DecorStatus {
    pub installed: bool,
    pub surah_header_url: Option<String>,   // <base>decor/qcf-surah-header.woff2?v=…   (rel: decor/qcf-surah-header.woff2)
    pub quran_common_url: Option<String>,   // <base>decor/quran-common.ttf?v=…          (rel: decor/quran-common.ttf)
    pub sura_names_url: Option<String>,     // <base>decor/sura-names.woff2?v=…          (rel: decor/sura-names.woff2)
}
```

### 5.5 DTOs: Quran text, copy
```rust
// quran-types/src/text.rs
pub struct AyahText {
    pub id: u32, pub surah: u32, pub ayah: u32, pub juz: u32, pub hizb: u32, pub rub: u32,
    pub sajda: Option<SajdaKind>, pub flags: u32,
    pub page: u32,                   // in the requested layout
    pub text_hafs: String,
}
#[serde(rename_all = "snake_case")] pub enum ReferenceStyle { Short, Long, Arabic }
// Short: "(2:255)"  Long: "— Al-Baqarah 2:255"  Arabic: "[البقرة: ٢٥٥]"; ranges "2:255–257" / "[البقرة: ٢٥٥–٢٥٧]"
pub struct CopyOptions {
    pub include_reference: bool,
    pub reference_style: ReferenceStyle,
    pub ayah_numbers: bool,                   // render markers as ﴿N﴾ (Arabic-Indic) instead of dropping them
    pub translation_pack_id: Option<String>,  // append that translation (plain text) after the Arabic
}
```
Copy text format (shared by Rust `quran_copy_text` and TS `src/lib/mushaf/copy.ts`; golden tests on both sides):
- Arabic: the non-end words' `text_hafs` joined by U+0020.
- Each end marker → ` ﴿N﴾` when `ayah_numbers`, otherwise dropped.
- Then `\n{reference}` when `include_reference`.
- Then `\n\n{translation plain text joined by " "}` when a pack is given.
- `copy_vectors.json` (WP1a, read by both test suites) includes 1:1–7, 2:255, a cross-surah range, and the sajda words whose
  `text_hafs` contains "space + ۩" (**38:24** and **22:77**, §3.1.1): the word is copied whole, so the space before ۩ is
  preserved and never doubled. The a11y text tests (§8.15) use the same two ayahs.

### 5.6 DTOs: search
```rust
// quran-types/src/search.rs
#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SearchScope { Quran, Translation { pack_id: String }, Notes }
#[serde(rename_all = "snake_case")] pub enum SearchMode { Smart, Exact, Substring }
pub struct SearchRequest {
    pub query: String,
    pub scope: SearchScope,
    pub mode: SearchMode,
    pub surah: Option<u32>,
    pub juz: Option<u32>,
    pub limit: u32,                  // 1..=2000; UI default 500
    pub layout: MushafLayout,        // for page numbers in hits
}
pub struct SearchHit {
    pub ayah_id: u32, pub surah: u32, pub ayah: u32, pub page: u32,
    pub first_word_id: u32,          // quran scope: id of words[0]
    pub words: Vec<String>,          // quran scope: per-word text_hafs, end marker last (never derived by splitting, §3.1.1)
    pub matched_word_ids: Vec<u32>,  // quran scope; words[id − first_word_id] is matched; empty otherwise
    pub snippet: Option<String>,     // translation/notes: escaped HTML with <mark>…</mark> only
    pub note_id: Option<String>,
}
pub struct SearchGroup { pub surah: u32, pub count: u32, pub hits: Vec<SearchHit> }
pub struct SearchResults {
    pub query: String, pub normalized: String, pub total: u32, pub truncated: bool, pub took_ms: u32,
    pub groups: Vec<SearchGroup>,    // mushaf order
    pub suggestions: Vec<String>,    // typo-expansion terms used (smart mode), else empty
}
pub struct SearchSuggestion { pub term: String, pub count: u32 }
pub struct SearchHistoryEntry { pub query: String, pub scope: SearchScope, pub last_used_at: u32, pub use_count: u32 }
```

### 5.7 DTOs: translation, tafsir, WBW
```rust
// quran-types/src/content.rs
pub struct Footnote { pub id: String, pub marker: String, pub html: String }
pub struct TranslationText { pub pack_id: String, pub html: String, pub footnotes: Vec<Footnote> }
pub struct TranslationRow { pub ayah_id: u32, pub items: Vec<TranslationText> } // items in requested pack order
pub struct TafsirEntry {
    pub pack_id: String, pub from_ayah_id: u32, pub to_ayah_id: u32, pub html: String,
    pub lang: String, pub dir: TextDir,
    pub fetched_at: Option<u32>,     // QF-sourced content only
    pub stale: bool,                 // older than 7 days and revalidation not yet possible (UI footer, §9.8)
}
pub struct WbwEntry {
    pub word_id: u32,
    pub text: String,                // the word's text_hafs (from core.db), so the Words tab never splits ayah text
    pub translation: Option<String>, pub transliteration: Option<String>,
}
```
HTML in `html` fields is already sanitised (ammonia). The webview sanitises **again** with DOMPurify 3.4.x through `SafeHtml`
(§7.6), using the same allowlist plus `a[data-ref]` reference handling.

### 5.8 DTOs: audio
```rust
// quran-types/src/audio.rs
#[serde(rename_all = "snake_case")] pub enum PlaybackStatus { Idle, Loading, Buffering, Playing, Paused, Error }
#[serde(rename_all = "snake_case")] pub enum SkipDirection { Next, Previous }
#[serde(rename_all = "snake_case")] pub enum StopAt { EndOfSurah, EndOfPage, EndOfJuz, EndOfQuran }

#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum GapSetting { None, Fixed { ms: u32 }, Multiplier { pct: u32 } }   // ms 0..=30000; pct 0..=300

#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SeekTarget { Ayah { ayah_id: u32 }, FileMs { ms: u32 }, RelativeMs { delta_ms: i32 } }

pub struct AyahRange { pub from: AyahRef, pub to: AyahRef }
pub struct AbLoop { pub a_ms: u32, pub b_ms: u32 }          // file timeline; b − a ≥ 300

pub struct PlayRequest {
    pub reciter_id: u32,
    pub from: AyahRef,               // ayah ≥ 1
    pub to: Option<AyahRef>,         // None ⇒ resolved from stop_at (or settings.stop_at)
    pub stop_at: Option<StopAt>,
    pub layout: MushafLayout,        // for EndOfPage resolution
    pub ayah_repeat: u32,            // 1..=99, 0 = ∞
    pub range_repeat: u32,           // 1..=99, 0 = ∞
    pub gap: GapSetting,
    pub start_paused: bool,
    #[serde(default = "PlayRequest::recorded")] #[specta(optional)]
    pub record: bool,                // absent ⇒ true; false: a preview (no listen history, never replayed by
                                     // "play with nothing loaded"). Added by the integration gate (INTEGRATION.md)
}
pub struct AudioSnapshot {
    pub status: PlaybackStatus,
    pub reciter_id: Option<u32>,
    pub current: Option<AyahRef>,    // ayah 0 = basmala
    pub current_ayah_id: Option<u32>,
    pub range: Option<AyahRange>,
    pub ayah_repeat: u32, pub ayah_repeat_left: u32,
    pub range_repeat: u32, pub range_repeat_left: u32,
    pub gap: GapSetting,
    pub ab_loop: Option<AbLoop>,
    pub speed_pct: u32, pub volume_pct: u32,
    pub file_ms: u32, pub file_duration_ms: u32,
    pub ayah_from_ms: u32, pub ayah_to_ms: u32,
    pub buffered_pct: u32,
    pub device: Option<String>,      // cpal Device::description() of the current output
    pub basmala_skipped: bool,       // this play skipped the basmala because it was offline and not cached (§2.3.3)
    pub error: Option<AppError>,
}
pub struct AudioTick {              // Channel payload, ≤ 30 Hz
    pub seq: u32, pub generation: u32, pub status: PlaybackStatus,
    pub surah: u32, pub ayah: u32, pub ayah_id: u32,   // ayah 0 / ayah_id 0 during basmala
    pub file_ms: u32,                // audible, latency-compensated
    pub word_pos: u32,               // 0 = none
    pub speed_pct: u32, pub in_gap: bool, pub buffered_pct: u32,
}
pub struct AyahChange { pub reciter_id: u32, pub surah: u32, pub ayah: u32, pub ayah_id: u32 }
pub struct WordTiming { pub pos: u32, pub start_ms: u32, pub end_ms: u32 }
pub struct AyahTiming { pub ayah: u32, pub from_ms: u32, pub to_ms: u32, pub words: Vec<WordTiming> }
pub struct SurahTimings { pub reciter_id: u32, pub surah: u32, pub duration_ms: u32, pub word_level: bool, pub ayahs: Vec<AyahTiming> }
pub struct ReciterInfo {
    pub id: u32, pub pack_id: String, pub name: L10nText, pub style: Option<L10nText>,
    pub word_level: bool,            // catalog `wordLevel` until real timings for this reciter override it
    pub size_kib: u32, pub downloaded_surahs: u32, pub cached_surahs: u32,
}
```
`to` resolution (glue, WP4d):
- `EndOfSurah` → last ayah of `from.surah`.
- `EndOfPage` → last ayah whose first word is on `from`'s page (layout).
- `EndOfJuz` → the juz's last ayah.
- `EndOfQuran` → 114:6.
- Validation: `from ≤ to`, ayahs exist, at most 6,236 segments.

### 5.9 DTOs: packs and downloads
```rust
// quran-types/src/packs.rs
#[serde(rename_all = "snake_case")] pub enum PackKind { MushafFonts, Decor, Translation, Tafsir, Recitation, Wbw }
#[serde(rename_all = "snake_case")] pub enum InstallMode { Whole, OnDemand }
#[serde(rename_all = "snake_case")] pub enum JobPhase { Queued, Downloading, Verifying, Installing, Paused, Completed, Failed, Cancelled }

#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PackState {
    NotInstalled,
    Partial { items_present: u32, items_total: u32 },
    Installed { version: String },
    UpdateAvailable { installed: String, latest: String },
    Paused { items_present: u32, items_total: u32 },
    Failed { error: AppError },
}
#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum InstallScope { All, Items { items: Vec<u32> } }   // pages (mushaf) | surahs (recitation) | chapters (wbw, tafsir); §2.5.3

/// One per present or queued item of an on-demand pack (packs_items). SurahGrid (WP12a) and ReciterPicker (WP9a) use it.
pub struct PackItemState {
    pub item: u32,                   // page / surah / chapter number (§2.5.3 item ids)
    pub pinned: bool,                // explicitly downloaded (false = stream-cached / fetched on demand)
    pub queued: bool,                // part of a running or paused job, not yet present
    pub kib: u32,                    // 0 while queued
}

pub struct Attribution { pub text: L10nText, pub url: String, pub licence: String }
pub struct JobSnapshot {
    pub job_id: u32, pub pack_id: String, pub phase: JobPhase,
    pub received_kib: u32, pub total_kib: u32, pub items_done: u32, pub items_total: u32,
    pub rate_kib_s: u32, pub eta_s: Option<u32>, pub error: Option<AppError>,
}
pub struct PackInfo {
    pub id: String, pub kind: PackKind, pub title: L10nText, pub description: L10nText,
    pub language: Option<String>, pub direction: Option<TextDir>, pub version: String,
    pub install_mode: InstallMode, pub requires: Vec<String>,
    pub size_kib: u32, pub item_count: u32, pub recommended: bool, pub revalidate_days: Option<u32>,
    pub attribution: Attribution,
    pub state: PackState, pub installed_kib: u32, pub job: Option<JobSnapshot>,
}
pub struct PackSummary { pub id: String, pub kind: PackKind, pub title: L10nText, pub language: Option<String>, pub state: PackState }
pub struct PackUpdate { pub pack_id: String, pub installed: String, pub latest: String, pub size_kib: u32 }
pub struct DiskUsage {
    pub total_kib: u32, pub mushaf_kib: u32, pub decor_kib: u32, pub translation_kib: u32, pub tafsir_kib: u32,
    pub audio_pinned_kib: u32, pub audio_stream_kib: u32, pub content_db_kib: u32, pub user_db_kib: u32,
    pub data_dir: String,
}
#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DownloadEvent {                                                   // Channel payload
    Queued     { job_id: u32, pack_id: String },
    Started    { job_id: u32, pack_id: String, total_kib: u32, items_total: u32 },
    Progress   { job_id: u32, pack_id: String, received_kib: u32, total_kib: u32, items_done: u32,
                 items_total: u32, rate_kib_s: u32, eta_s: Option<u32> },
    Verifying  { job_id: u32, pack_id: String },
    Installing { job_id: u32, pack_id: String },
    Paused     { job_id: u32, pack_id: String },
    Completed  { job_id: u32, pack_id: String },
    Failed     { job_id: u32, pack_id: String, error: AppError },
    Cancelled  { job_id: u32, pack_id: String },
}
```
UI actions map onto commands as: **Update** = `packs_install(id, All)` on a pack whose state is `UpdateAvailable`;
**Retry** = `packs_resume(id)` on a pack whose job or state is `Failed`; **Remove one surah/page** = `packs_remove_items`;
**Clear cache** (Settings › Storage) = `cache_clear`; **Clear streaming cache** (Downloads header) = `packs_clear_stream_cache`.

### 5.10 DTOs: user data
```rust
// quran-types/src/user.rs
#[serde(rename_all = "snake_case")] pub enum BookmarkKind { Ayah, Page }
#[serde(rename_all = "snake_case")] pub enum HighlightColor { Yellow, Green, Blue, Red, Purple }
#[serde(rename_all = "snake_case")] pub enum TaggableKind { Bookmark, Note, Highlight }
#[serde(rename_all = "snake_case")] pub enum PositionContext { Mushaf, Translation, Audio }
#[serde(rename_all = "snake_case")] pub enum HistoryMode { Read, Listen, Memorize }
#[serde(rename_all = "snake_case")] pub enum MemoStatus { New, Learning, Memorized, Review }
#[serde(rename_all = "snake_case")]
pub enum UserDataKind { Bookmarks, ReadingBookmark, Highlights, Notes, Collections, Tags, Positions, History, Memo, Presets }

pub struct Bookmark {
    pub id: String, pub kind: BookmarkKind, pub ayah_id: u32, pub surah: u32, pub ayah: u32,
    pub layout: Option<MushafLayout>, pub page: Option<u32>, pub label: Option<String>,
    pub collection_ids: Vec<String>, pub tag_ids: Vec<String>,
    pub created_at: u32, pub updated_at: u32,
}
pub struct BookmarkInput {
    pub id: Option<String>,          // None ⇒ create
    pub kind: BookmarkKind, pub ayah_id: u32, pub layout: Option<MushafLayout>, pub page: Option<u32>,
    pub label: Option<String>, pub collection_ids: Vec<String>, pub tag_ids: Vec<String>,
}
pub struct BookmarkFilter {
    pub kind: Option<BookmarkKind>, pub collection_id: Option<String>, pub tag_id: Option<String>,
    pub surah: Option<u32>, pub limit: u32,
}
pub struct BookmarkToggle { pub bookmark: Bookmark, pub active: bool }   // active=false ⇒ just tombstoned (undo = restore)
pub struct ReadingBookmark { pub ayah_id: u32, pub layout: MushafLayout, pub page: u32, pub updated_at: u32 }
pub struct ReadingBookmarkInput { pub ayah_id: u32, pub layout: MushafLayout, pub page: u32 }
pub struct ReadingBookmarkMove { pub previous: Option<ReadingBookmark>, pub current: ReadingBookmark }

pub struct Highlight { pub id: String, pub from_ayah_id: u32, pub to_ayah_id: u32, pub color: HighlightColor,
                       pub tag_ids: Vec<String>, pub created_at: u32, pub updated_at: u32 }
pub struct HighlightInput { pub from_ayah_id: u32, pub to_ayah_id: u32, pub color: HighlightColor }

pub struct Note {
    pub id: String, pub from_ayah_id: u32, pub to_ayah_id: u32, pub title: Option<String>, pub body: String,
    pub tag_ids: Vec<String>, pub created_at: u32, pub updated_at: u32,
}
pub struct NoteInput { pub id: Option<String>, pub from_ayah_id: u32, pub to_ayah_id: u32,
                       pub title: Option<String>, pub body: String, pub tag_ids: Vec<String> }
pub struct NoteFilter { pub from_ayah_id: Option<u32>, pub to_ayah_id: Option<u32>, pub tag_id: Option<String>, pub limit: u32 }

pub struct Collection { pub id: String, pub name: String, pub color: Option<String>, pub item_count: u32,
                        pub sort_key: i32, pub created_at: u32, pub updated_at: u32 }
pub struct CollectionInput { pub id: Option<String>, pub name: String, pub color: Option<String>, pub sort_key: i32 }
pub struct Tag { pub id: String, pub name: String, pub color: Option<String>, pub usage_count: u32 }
pub struct TagInput { pub id: Option<String>, pub name: String, pub color: Option<String> }

pub struct AyahMark { pub ayah_id: u32, pub bookmark_id: String }
pub struct PageMark { pub page: u32, pub bookmark_id: String }
pub struct HighlightMark { pub id: String, pub from_ayah_id: u32, pub to_ayah_id: u32, pub color: HighlightColor }
pub struct NoteMark { pub id: String, pub from_ayah_id: u32, pub to_ayah_id: u32 }
pub struct UserMarks {
    pub bookmarks: Vec<AyahMark>, pub page_bookmarks: Vec<PageMark>, pub highlights: Vec<HighlightMark>,
    pub notes: Vec<NoteMark>, pub reading_ayah_id: Option<u32>,
}

pub struct ReadingPosition {
    pub context: PositionContext, pub layout: Option<MushafLayout>, pub page: Option<u32>,
    pub ayah_id: u32, pub scroll_px: Option<u32>, pub updated_at: u32,   // updated_at ignored on input
}
pub struct HistoryInput { pub mode: HistoryMode, pub layout: Option<MushafLayout>, pub page: Option<u32>, pub ayah_id: u32, pub dwell_s: u32 }
pub struct HistoryEntry { pub id: u32, pub at: u32, pub mode: HistoryMode, pub layout: Option<MushafLayout>,
                          pub page: Option<u32>, pub ayah_id: u32, pub dwell_s: u32 }

pub struct MemoProgress { pub ayah_id: u32, pub status: MemoStatus, pub strength: u32, pub reviews: u32,
                          pub lapses: u32, pub last_reviewed_at: Option<u32>, pub due_at: Option<u32> }
pub struct MemoReviewInput { pub from_ayah_id: u32, pub to_ayah_id: u32, pub rating: u32 /* 1..=4 */, pub mistakes: u32 }
pub struct MemoTest { pub id: u32, pub from_ayah_id: u32, pub to_ayah_id: u32, pub start_ayah_id: u32,
                      pub started_at: u32, pub finished_at: Option<u32>, pub reveals: Option<u32>,
                      pub mistakes: Option<u32>, pub rating: Option<u32> }
pub struct MemoTestResult { pub id: u32, pub reveals: u32, pub mistakes: u32, pub rating: u32 }
pub struct LoopPreset { pub id: u32, pub name: String, pub reciter_id: Option<u32>, pub from_ayah_id: u32,
                        pub to_ayah_id: u32, pub ayah_repeat: u32, pub range_repeat: u32, pub gap: GapSetting,
                        pub speed_pct: u32, pub created_at: u32, pub updated_at: u32 }
pub struct LoopPresetInput { pub id: Option<u32>, pub name: String, pub reciter_id: Option<u32>, pub from_ayah_id: u32,
                             pub to_ayah_id: u32, pub ayah_repeat: u32, pub range_repeat: u32, pub gap: GapSetting,
                             pub speed_pct: u32 }
```
**Memorisation scheduling** (Leitner-style, deterministic, `UserDb::memo_review`), applied to every ayah in the range.
Strength `s` ranges 0..=5.

| rating | new strength | lapses | due |
|---|---|---|---|
| 1 (again) | `max(s−2, 0)` | +1 | now + 10 min |
| 2 (hard) | `max(s, 1)` | | now + 1 day |
| 3 (good) | `min(s+1, 5)` | | now + 2^s days |
| 4 (easy) | `min(s+2, 5)` | | now + 2^(s+1) days |

Status: `memorized` if strength ≥ 4, else `learning`. When read, a `memorized` ayah whose `due_at < now` is returned as
`review`.

### 5.11 DTOs: settings (typed JSON, persisted per top-level key)
Over IPC every field is **camelCase** (`pageTurnAnimation`, `uiLanguage`, `sidePane.autoCollapseSidebar`); TypeScript always uses
the generated names. user.db keys are the snake_case Rust names from `SETTING_FIELDS` (§0.2, §3.2). The comments below give
the Rust names, defaults and ranges.
```rust
// quran-types/src/settings.rs
#[serde(rename_all = "snake_case")] pub enum ThemeMode { System, Paper, Sepia, Night, Black, HighContrast }
#[serde(rename_all = "snake_case")] pub enum DarkVariant { Night, Black }
#[serde(rename_all = "snake_case")] pub enum LightVariant { Paper, Sepia }
#[serde(rename_all = "snake_case")] pub enum Accent { Teal, Emerald, Blue, Indigo, Rose, Amber }
#[serde(rename_all = "snake_case")] pub enum UiLanguage { En, Ar }
#[serde(rename_all = "snake_case")] pub enum DigitStyle { Auto, Latin, ArabicIndic }
#[serde(rename_all = "snake_case")] pub enum MotionPref { System, Reduce, Full }
#[serde(rename_all = "snake_case")] pub enum ChromeEffect { Auto, Off }
#[serde(rename_all = "snake_case")] pub enum PageMode { Auto, Single, Spread }
#[serde(rename_all = "snake_case")] pub enum ReadingMode { Mushaf, Translation }
#[serde(rename_all = "snake_case")] pub enum SidePaneTab { Translation, Tafsir, Notes, Words }
#[serde(rename_all = "snake_case")] pub enum SidePaneFollow { Selection, SelectionOrAudio, Pinned }
#[serde(rename_all = "snake_case")] pub enum SidebarTab { Index, Search, Bookmarks, Highlights, Notes, History, Memorize }
#[serde(rename_all = "snake_case")] pub enum MemoHideStyle { Blur, Blank }

pub struct SidePaneSettings { pub open: bool, pub width_px: u32, pub tab: SidePaneTab, pub follow: SidePaneFollow,
                              pub auto_collapse_sidebar: bool }   // collapse the sidebar while the pane is open if that lets it dock (§9.6)
pub struct SidebarSettings  { pub open: bool, pub width_px: u32, pub tab: SidebarTab }
pub struct CopySettings     { pub include_reference: bool, pub reference_style: ReferenceStyle, pub ayah_numbers: bool,
                              pub translation_pack_id: Option<String> }

pub struct Settings {
    // appearance
    pub theme: ThemeMode,                   // default system
    pub light_variant: LightVariant,        // paper (what `system` resolves to when the OS is light)
    pub dark_variant: DarkVariant,          // night (what `system` resolves to when the OS is dark)
    pub accent: Accent,                     // teal
    pub ui_language: UiLanguage,            // first run: "ar" if AppInfo.os_locale starts with "ar", else "en" (D22)
    pub digits: DigitStyle,                 // auto (= arabic_indic when ui_language = ar)
    pub ui_scale_pct: u32,                  // 100 (80..=200, step 10) — webview zoom from Rust (D27)
    pub motion: MotionPref,                 // system
    pub ink_brightness_pct: u32,            // 88 (65..=100; night/black only; §8.6 opaque precomposite)
    pub chrome_effect: ChromeEffect,        // auto
    // mushaf
    pub mushaf_style: MushafStyle,          // hafs (a first-run onboarding preselects qcf_v2, v1.2)
    pub page_mode: PageMode,                // auto
    pub zoom_pct: u32,                      // 100 (50..=300, step 10; 100 = fit to height)
    pub tajweed_colors: bool,               // true (qcf_v4: palettes 0–2 vs 3–5)
    pub ornate_headers: OnByDefault,        // true (v1.2): decor ornaments fetched and drawn, every style; absent ⇒ true
    pub show_page_frame: bool,              // true
    pub show_running_heads: bool,           // true
    pub show_margin_markers: bool,          // true
    pub highlight_bookmarks: bool,          // true (shows bookmark, note and reading-bookmark marks in the margin, §8.9)
    pub hover_highlight: bool,              // true
    pub ayah_action_bar: bool,              // true (D26; false = click only selects)
    pub page_turn_animation: bool,          // true
    pub wbw_pack_id: Option<String>,        // None
    pub wbw_tooltip: bool,                  // true
    pub wbw_show_transliteration: bool,     // true
    // reading mode, translations, side pane, sidebar
    pub reading_mode: ReadingMode,          // mushaf
    pub translations: Vec<String>,          // [] (ordered pack ids; max 5)
    pub tafsir_pack_id: Option<String>,     // None
    pub translation_font_pct: u32,          // 100 (80..=200)
    pub translation_arabic: bool,           // true
    pub footnotes_inline: bool,             // false
    pub side_pane: SidePaneSettings,        // { open: false, width_px: 400 (320..=640), tab: translation, follow: selection_or_audio,
                                            //   auto_collapse_sidebar: true }
    pub sidebar: SidebarSettings,           // { open: true, width_px: 300 (240..=420), tab: index }
    // audio
    pub reciter_id: u32,                    // 7 (Mishary Alafasy)
    pub speed_pct: u32,                     // 100 (50..=200, step 5)
    pub volume_pct: u32,                    // 100 (0..=100)
    pub follow_along: bool,                 // true
    pub word_highlight: bool,               // true
    pub ayah_repeat: u32,                   // 1 (0..=99)
    pub range_repeat: u32,                  // 1 (0..=99)
    pub gap: GapSetting,                    // none
    pub stop_at: StopAt,                    // end_of_surah
    pub stream_cache_cap_mib: u32,          // 2048 (256..=20480)
    // memorisation
    pub memo_hide_style: MemoHideStyle,     // blur
    pub memo_reveal_on_hover: bool,         // true
    // copy
    pub copy: CopySettings,                 // { include_reference: true, reference_style: long, ayah_numbers: true, translation_pack_id: None }
    // system
    pub announce_recitation: bool,          // false (screen-reader live announcements on ayah change)
    pub close_to_tray: bool,                // false
    pub close_to_tray_asked: bool,          // false; set by the first-close-during-playback dialog (§9.6), never asked again
    pub show_tray_icon: bool,               // true
    pub network_allowed: bool,              // true (onboarding offers "work offline")
    pub onboarding_done: bool,              // false
    pub hints_seen: Vec<String>,            // [] one-time hint chips already shown: "page_turn", "action_bar", …
}
impl Default for Settings { /* values in comments above */ }
impl Settings { pub fn validated(self) -> Self; /* clamp ranges, round steps, dedupe + truncate translations to 5 */ }
```

### 5.12 DTOs: system
```rust
// quran-types/src/system.rs
#[serde(rename_all = "snake_case")] pub enum AppView { Reader, Downloads, Settings, About }
#[serde(tag = "type", content = "data", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum NavTarget { Ayah { ayah_id: u32 }, Page { page: u32 }, Surah { surah: u32 }, View { view: AppView }, Search { query: String } }
pub struct ChromeAppearance { pub dark: bool, pub effect: ChromeEffect }
```

### 5.13 Command catalogue (exact signatures)
All commands take `state: tauri::State<'_, AppState>` unless shown otherwise. That parameter is omitted from the TS
signature (and may be omitted from WP0A's wave-0 stubs, §2.8.1). TS names are camelCase (`mushaf_get_pages` →
`commands.mushafGetPages(style, pages)`). Owners in brackets are the §14 packages that implement the bodies.

**App and window: `commands/app.rs`, `commands/system.rs` [WP6a]**
```rust
pub async fn app_bootstrap(state: State<'_, AppState>) -> Result<Bootstrap, AppError>;
pub async fn window_ready(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError>; // show + focus main window once
pub async fn window_set_chrome(app: AppHandle, appearance: ChromeAppearance) -> Result<(), AppError>; // single chrome owner = frontend
pub async fn app_quit(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError>;     // stop audio, close DBs, exit(0)
pub async fn system_open_external(app: AppHandle, url: String) -> Result<(), AppError>;      // https:// or mailto: only
pub async fn system_reveal_data_dir(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError>;
```
**Raw font bytes: `protocol.rs` [WP6a]. Not a specta command** (excluded from `bindings.ts`; registered through the dispatch in
`lib.rs`, §2.8.1). Used only when `AppInfo.fontTransport = bytes` (D30); hand-wrapped in `src/lib/ipc/index.ts` (§5.16).
```rust
#[tauri::command]
pub async fn font_bytes(state: State<'_, AppState>, rel: String) -> Result<tauri::ipc::Response, String>;
// rel must match a §6.2 font route (mushaf/ or decor/); same path rules and allow-list as the protocol handler.
// Returns the raw file bytes (InvokeResponseBody::Raw), never a JSON array.
```
**Mushaf and text: `commands/mushaf.rs`, `commands/quran.rs` [WP1a]**
```rust
pub async fn mushaf_get_pages(state: State<'_, AppState>, style: MushafStyle, pages: Vec<u32>) -> Result<Vec<PageData>, AppError>; // 1..=8
pub async fn quran_get_ayahs(state: State<'_, AppState>, layout: MushafLayout, from_ayah_id: u32, to_ayah_id: u32) -> Result<Vec<AyahText>, AppError>; // ≤ 300
pub async fn quran_copy_text(state: State<'_, AppState>, from_ayah_id: u32, to_ayah_id: u32, options: CopyOptions) -> Result<String, AppError>; // ≤ 6236
```
**Search: `commands/search.rs` [WP1b]**
```rust
pub async fn search_query(state: State<'_, AppState>, request: SearchRequest) -> Result<SearchResults, AppError>;
pub async fn search_suggest(state: State<'_, AppState>, prefix: String, limit: u32) -> Result<Vec<SearchSuggestion>, AppError>;
```
**Content: `commands/content.rs` [WP5e]**
```rust
pub async fn translation_get(state: State<'_, AppState>, pack_ids: Vec<String>, from_ayah_id: u32, to_ayah_id: u32) -> Result<Vec<TranslationRow>, AppError>; // ≤ 300 ayahs, ≤ 5 packs
pub async fn tafsir_get(state: State<'_, AppState>, pack_id: String, ayah_id: u32) -> Result<TafsirEntry, AppError>;      // may fetch the chapter
pub async fn wbw_get_range(state: State<'_, AppState>, pack_id: String, from_word_id: u32, to_word_id: u32) -> Result<Vec<WbwEntry>, AppError>; // ≤ 2000 words
```
**Packs and fonts: `commands/packs.rs` [WP5e]**
```rust
pub async fn packs_list(state: State<'_, AppState>) -> Result<Vec<PackInfo>, AppError>;
pub async fn packs_subscribe(state: State<'_, AppState>, on_event: Channel<DownloadEvent>) -> Result<Vec<JobSnapshot>, AppError>; // state.pack_events.set_channel; replaces any previous channel
pub async fn packs_install(state: State<'_, AppState>, pack_id: String, scope: InstallScope) -> Result<u32, AppError>;
pub async fn packs_pause(state: State<'_, AppState>, pack_id: String) -> Result<(), AppError>;
pub async fn packs_resume(state: State<'_, AppState>, pack_id: String) -> Result<u32, AppError>;   // also "Retry" on Failed
pub async fn packs_cancel(state: State<'_, AppState>, pack_id: String) -> Result<(), AppError>;
pub async fn packs_remove(state: State<'_, AppState>, pack_id: String) -> Result<(), AppError>;
pub async fn packs_items(state: State<'_, AppState>, pack_id: String) -> Result<Vec<PackItemState>, AppError>;   // on-demand packs
pub async fn packs_remove_items(state: State<'_, AppState>, pack_id: String, items: Vec<u32>) -> Result<u32, AppError>; // KiB freed
pub async fn packs_disk_usage(state: State<'_, AppState>) -> Result<DiskUsage, AppError>;
pub async fn packs_check_updates(state: State<'_, AppState>) -> Result<Vec<PackUpdate>, AppError>;
pub async fn packs_clear_stream_cache(state: State<'_, AppState>) -> Result<u32, AppError>;   // unpinned audio only; KiB freed
pub async fn cache_clear(state: State<'_, AppState>) -> Result<u32, AppError>;                // PackManager::clear_cache; KiB freed
pub async fn mushaf_ensure_page_fonts(state: State<'_, AppState>, style: MushafStyle, pages: Vec<u32>, priority: FetchPriority) -> Result<Vec<PageFontStatus>, AppError>;
    // ≤ 12 pages; resolves when each is Ready/Failed/Unavailable (prefetch too); hafs → Ready "qd-hafs" without IO (§5.4)
pub async fn decor_ensure(state: State<'_, AppState>) -> Result<DecorStatus, AppError>;
```
**Audio: `commands/audio.rs` [WP4d]**
```rust
pub async fn audio_subscribe(state: State<'_, AppState>, on_tick: Channel<AudioTick>) -> Result<AudioSnapshot, AppError>; // replaces previous channel
pub async fn audio_play(state: State<'_, AppState>, request: PlayRequest) -> Result<AudioSnapshot, AppError>;
pub async fn audio_pause(state: State<'_, AppState>) -> Result<(), AppError>;
pub async fn audio_resume(state: State<'_, AppState>) -> Result<(), AppError>;
pub async fn audio_toggle(state: State<'_, AppState>) -> Result<(), AppError>;
pub async fn audio_stop(state: State<'_, AppState>) -> Result<(), AppError>;
pub async fn audio_skip(state: State<'_, AppState>, direction: SkipDirection) -> Result<(), AppError>;
pub async fn audio_seek(state: State<'_, AppState>, target: SeekTarget) -> Result<(), AppError>;
pub async fn audio_set_speed(state: State<'_, AppState>, speed_pct: u32) -> Result<(), AppError>;
pub async fn audio_set_volume(state: State<'_, AppState>, volume_pct: u32) -> Result<(), AppError>;
pub async fn audio_set_repeat(state: State<'_, AppState>, ayah_repeat: u32, range_repeat: u32) -> Result<(), AppError>;
pub async fn audio_set_gap(state: State<'_, AppState>, gap: GapSetting) -> Result<(), AppError>;
pub async fn audio_set_ab_loop(state: State<'_, AppState>, ab_loop: Option<AbLoop>) -> Result<(), AppError>;
pub async fn audio_get_snapshot(state: State<'_, AppState>) -> Result<AudioSnapshot, AppError>;
pub async fn audio_get_timings(state: State<'_, AppState>, reciter_id: u32, surah: u32) -> Result<SurahTimings, AppError>; // state.audio.timings(..).await — no blocking(), no block_on
pub async fn audio_list_reciters(state: State<'_, AppState>) -> Result<Vec<ReciterInfo>, AppError>;
```
**User library: `commands/user_library.rs` [WP2a].** Every mutating command emits `UserDataChanged`.
```rust
pub async fn bookmark_list(state: State<'_, AppState>, filter: BookmarkFilter) -> Result<Vec<Bookmark>, AppError>;
pub async fn bookmark_upsert(state: State<'_, AppState>, input: BookmarkInput) -> Result<Bookmark, AppError>;
pub async fn bookmark_toggle_ayah(state: State<'_, AppState>, ayah_id: u32) -> Result<BookmarkToggle, AppError>;
pub async fn bookmark_delete(state: State<'_, AppState>, id: String) -> Result<Bookmark, AppError>;
pub async fn bookmark_restore(state: State<'_, AppState>, id: String) -> Result<Bookmark, AppError>;
pub async fn reading_bookmark_set(state: State<'_, AppState>, input: ReadingBookmarkInput) -> Result<ReadingBookmarkMove, AppError>;
pub async fn reading_bookmark_clear(state: State<'_, AppState>) -> Result<Option<ReadingBookmark>, AppError>; // undo of a first set
pub async fn highlight_list(state: State<'_, AppState>, color: Option<HighlightColor>) -> Result<Vec<Highlight>, AppError>;
pub async fn highlight_set(state: State<'_, AppState>, input: HighlightInput) -> Result<Highlight, AppError>;
pub async fn highlight_delete(state: State<'_, AppState>, id: String) -> Result<Highlight, AppError>;
pub async fn highlight_restore(state: State<'_, AppState>, id: String) -> Result<Highlight, AppError>;
pub async fn highlight_clear_range(state: State<'_, AppState>, from_ayah_id: u32, to_ayah_id: u32) -> Result<Vec<Highlight>, AppError>; // removed rows (undo)
pub async fn note_list(state: State<'_, AppState>, filter: NoteFilter) -> Result<Vec<Note>, AppError>;
pub async fn note_get(state: State<'_, AppState>, id: String) -> Result<Note, AppError>;
pub async fn note_upsert(state: State<'_, AppState>, input: NoteInput) -> Result<Note, AppError>;
pub async fn note_delete(state: State<'_, AppState>, id: String) -> Result<Note, AppError>;
pub async fn note_restore(state: State<'_, AppState>, id: String) -> Result<Note, AppError>;
pub async fn collection_list(state: State<'_, AppState>) -> Result<Vec<Collection>, AppError>;
pub async fn collection_upsert(state: State<'_, AppState>, input: CollectionInput) -> Result<Collection, AppError>;
pub async fn collection_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError>;
pub async fn collection_set_membership(state: State<'_, AppState>, bookmark_id: String, collection_ids: Vec<String>) -> Result<Bookmark, AppError>;
pub async fn tag_list(state: State<'_, AppState>) -> Result<Vec<Tag>, AppError>;
pub async fn tag_upsert(state: State<'_, AppState>, input: TagInput) -> Result<Tag, AppError>;
pub async fn tag_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError>;
pub async fn item_tags_set(state: State<'_, AppState>, kind: TaggableKind, item_id: String, tag_ids: Vec<String>) -> Result<(), AppError>;
pub async fn user_marks(state: State<'_, AppState>, layout: MushafLayout, from_ayah_id: u32, to_ayah_id: u32, pages: Vec<u32>) -> Result<UserMarks, AppError>;
```
**User study data: `commands/user_study.rs` [WP2b].** Every mutating command except `position_set` emits `UserDataChanged`.
```rust
pub async fn position_set(state: State<'_, AppState>, position: ReadingPosition) -> Result<(), AppError>;   // no event
pub async fn history_record(state: State<'_, AppState>, entry: HistoryInput) -> Result<(), AppError>;
pub async fn history_list(state: State<'_, AppState>, limit: u32, before_id: Option<u32>) -> Result<Vec<HistoryEntry>, AppError>;
pub async fn history_clear(state: State<'_, AppState>) -> Result<(), AppError>;
pub async fn search_history_add(state: State<'_, AppState>, query: String, scope: SearchScope) -> Result<(), AppError>;
pub async fn search_history_list(state: State<'_, AppState>, limit: u32) -> Result<Vec<SearchHistoryEntry>, AppError>;
pub async fn search_history_clear(state: State<'_, AppState>) -> Result<(), AppError>;
pub async fn memo_progress(state: State<'_, AppState>, from_ayah_id: u32, to_ayah_id: u32) -> Result<Vec<MemoProgress>, AppError>;
pub async fn memo_set_status(state: State<'_, AppState>, from_ayah_id: u32, to_ayah_id: u32, status: MemoStatus) -> Result<Vec<MemoProgress>, AppError>;
pub async fn memo_review(state: State<'_, AppState>, input: MemoReviewInput) -> Result<Vec<MemoProgress>, AppError>;
pub async fn memo_test_start(state: State<'_, AppState>, from_ayah_id: u32, to_ayah_id: u32) -> Result<MemoTest, AppError>; // random start (fastrand)
pub async fn memo_test_finish(state: State<'_, AppState>, result: MemoTestResult) -> Result<MemoTest, AppError>;
pub async fn loop_preset_list(state: State<'_, AppState>) -> Result<Vec<LoopPreset>, AppError>;
pub async fn loop_preset_upsert(state: State<'_, AppState>, input: LoopPresetInput) -> Result<LoopPreset, AppError>;
pub async fn loop_preset_delete(state: State<'_, AppState>, id: u32) -> Result<(), AppError>;
pub async fn user_backup_create(state: State<'_, AppState>, dest_path: Option<String>) -> Result<String, AppError>; // returns path
```
**Settings: `commands/settings.rs` [WP2b]**
```rust
pub async fn settings_get(state: State<'_, AppState>) -> Result<Settings, AppError>;
/// Validates, persists changed keys, applies side effects through stable hooks owned by WP6b/WP5e/WP4d:
///   crate::window::apply_settings(&app, &prev, &next)   (tray, close-to-tray, labels, UI zoom; not chrome)
///   state.packs.apply_settings(&prev, &next)            (network allowed; stream-cache cap → enforce_stream_cache_cap)
///   state.audio.apply_settings(&prev, &next)            (volume applies live; speed/repeat/gap are defaults for the next play)
/// Then emits SettingsChanged(next).
pub async fn settings_set(app: AppHandle, state: State<'_, AppState>, next: Settings) -> Result<Settings, AppError>;
pub async fn settings_reset(app: AppHandle, state: State<'_, AppState>) -> Result<Settings, AppError>;
```

### 5.14 Events (tauri-specta, low frequency) and Channels (streams)
```rust
// src-tauri/src/ipc/events.rs  — every type: #[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct AudioStateChanged(pub AudioSnapshot);   // "audio-state-changed": status/ayah/repeat/speed/volume/AB/error changes
pub struct AudioAyahChanged(pub AyahChange);       // "audio-ayah-changed": exact marker edge
pub struct PacksChanged { pub pack_ids: Vec<String> }        // "packs-changed" (#[serde(rename_all="camelCase")])
pub struct SettingsChanged(pub Settings);          // "settings-changed"
pub struct UserDataChanged { pub kinds: Vec<UserDataKind> }  // "user-data-changed"
pub struct NavigateRequested(pub NavTarget);       // "navigate-requested": tray, single-instance argv, deep link (stretch)
pub struct NetworkChanged { pub online: bool }     // "network-changed"
```
Event names follow tauri-specta's default: the kebab-case type name (verified in the probe: `PlaybackTick` → `"playback-tick"`).
TS usage: `events.audioStateChanged.listen(e => …)`.

| Channel | Created by | Payload | Rate | Lifetime |
|---|---|---|---|---|
| `audio_subscribe(on_tick)` | `PlayerStore.init()` once | `AudioTick` | 30 Hz while playing; one per change otherwise | until the webview reloads (send error ⇒ dropped) |
| `packs_subscribe(on_event)` | `PacksStore.init()` once | `DownloadEvent` | ≤ 10 Hz per job | same; stored in `AppState.pack_events` (`PackEventsImpl::set_channel`) |

### 5.15 Generating `bindings.ts` (D8), and building on a fresh checkout
```rust
// src-tauri/src/ipc/mod.rs (WP0A)
pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(tauri_specta::collect_commands![
            crate::commands::app::app_bootstrap, crate::commands::app::window_ready, /* … every command in §5.13 except font_bytes … */
        ])
        .events(tauri_specta::collect_events![
            events::AudioStateChanged, events::AudioAyahChanged, events::PacksChanged, events::SettingsChanged,
            events::UserDataChanged, events::NavigateRequested, events::NetworkChanged
        ])
}
#[cfg(test)]
mod tests {
    #[test]
    #[allow(clippy::expect_used)]
    fn export_bindings() {
        super::specta_builder()
            .export(specta_typescript::Typescript::default(), "../src/lib/ipc/bindings.ts")  // cwd = src-tauri
            .expect("export TS bindings");
    }
}
```
- `pnpm bindings` = `cargo test -p quran-desktop --lib export_bindings`.
- `pnpm bindings:check` = `pnpm bindings && git add -N src/lib/ipc/bindings.ts && git diff --exit-code --
  src/lib/ipc/bindings.ts`. The `git add -N` (intent-to-add) makes the check fail when the file is untracked; a plain
  `git diff` passes trivially on an untracked file (this repository had no commits when wave 0 started).
- `.gitattributes` (WP0D) sets `* text=auto eol=lf`, so a Windows checkout with `core.autocrlf` doesn't report the LF-generated
  file as drifted, and prettier's `endOfLine: lf` agrees.
- `bindings.ts` is committed, listed in `.prettierignore` and ESLint `ignores`, and never edited by hand.

**Fresh checkout must compile** (no core.db, no `dist/`):
- **core.db placeholder.** `tauri-build` copies `bundle.resources` at build time and fails with `ResourcePathNotFound` when a
  listed file is missing (tauri-build-2.7.1 `copy_resources`, tauri-utils-2.10.1 `resources.rs`). `resources/core.db` is
  gitignored and generated, so `src-tauri/build.rs` (WP0A), **before** `tauri_build::build()`:
  ```rust
  let core = Path::new("resources/core.db");
  if !core.exists() {
      if std::env::var("QD_REQUIRE_CORE").as_deref() == Ok("1") {
          panic!("resources/core.db missing and QD_REQUIRE_CORE=1: run `pnpm core:qdc` or `pnpm core:qul`"); // build script only
      }
      std::fs::write(core, b"").ok();   // 0-byte placeholder
      println!("cargo:warning=core.db placeholder created; run `pnpm core:qdc` (cargo xtask build-core --source qdc)");
  }
  if !Path::new("resources/catalog.json").exists() {     // WP5a replaces it with the curated catalog
      std::fs::write("resources/catalog.json", br#"{"catalogVersion":1,"generatedAt":"1970-01-01","packs":[]}"#).ok();
  }
  println!("cargo:rerun-if-env-changed=QD_REQUIRE_CORE");
  tauri_build::build();
  ```
  `CoreDb::open` maps the 0-byte file to `SchemaMismatch { found: 0 }`; debug builds then degrade (§2.8.2) and release builds
  show the fatal dialog. The CI `build` job and `release.yml` set `QD_REQUIRE_CORE=1` and additionally assert that core.db is
  larger than 1 MB and passes `verify-core` before `tauri build`, so a placeholder can never ship.
- **`dist/`.** `generate_context!` needs `../dist`. Every CI job that compiles `src-tauri` runs the shared setup (§13.3:
  `pnpm i --frozen-lockfile && pnpm build`) first. Locally, `pnpm build` once, or create an empty `dist/index.html`
  (gitignored).
- **Linux system packages.** Every ubuntu job that compiles `src-tauri` installs the §13.3 apt line (webkit2gtk, appindicator,
  ALSA, …) through the same shared setup.

### 5.16 Frontend IPC wrapper (`src/lib/ipc/index.ts`, owner WP0C, frozen)
```ts
import { invoke } from '@tauri-apps/api/core';
import { commands, events, type AppError } from './bindings';
export type Api = typeof commands;
export let api: Api = commands;               // live binding; replaced by the mock in browser mode
export { events };
/** Compile-time (D29): `__MOCK_IPC__` is defined by vite.config.ts as `mode === 'mock'`. In production builds the branch
 *  below is dead code, so Rollup drops ./mock, the synthetic generator and every fixture chunk from dist/. */
declare const __MOCK_IPC__: boolean;
export async function initIpc(): Promise<void> {
  if (__MOCK_IPC__) { const m = await import('./mock'); await m.installMockRuntime(); api = m.mockCommands; }
  else if (!('__TAURI_INTERNALS__' in window)) { throw new IpcError('unsupported', 'Run Quran in Tauri (pnpm app:dev)'); }
}
export class IpcError extends Error {
  constructor(public readonly kind: AppError['kind'], public readonly detail: string) { super(`${kind}: ${detail}`); }
}
type Res<T> = { status: 'ok'; data: T } | { status: 'error'; error: AppError | string };
/** Unwraps tauri-specta results; throws IpcError. Every store uses this. Tauri rejects argument and unmanaged-state errors
 *  with a plain string (§5.2), so both shapes are normalised before `kind` is read. */
export async function call<T>(p: Promise<Res<T>>): Promise<T> {
  const r = await p;
  if (r.status === 'ok') return r.data;
  const e: AppError = typeof r.error === 'string' ? { kind: 'internal', message: r.error } : r.error;
  throw new IpcError(e.kind, e.message);
}
/** The one hand-written command wrapper: raw bytes, not in bindings.ts (§5.13). */
export async function fontBytes(rel: string): Promise<ArrayBuffer> {
  if (__MOCK_IPC__) { return (await fetch(`/__packs/${rel}`)).arrayBuffer(); }
  return await invoke<ArrayBuffer>('font_bytes', { rel });
}
export function packUrl(base: string, rel: string): string { return base + rel; } // base = bootstrap.app.protocolBase
```
- A browser production preview (`vite preview` of a production build) shows the fatal "Run Quran in Tauri" screen.
- vitest (`src/lib/ipc/index.test.ts`) covers `call()` with an `AppError` object error and with a plain string error.
- Rules: stores import `api`, `events`, `call` and `fontBytes` from `$lib/ipc` only. An ESLint `no-restricted-imports` rule
  forbids importing `./bindings` (types excepted) or `@tauri-apps/api/core#invoke` anywhere else.
- CI (`scripts/check-dist.mjs`, after `pnpm build`): fails if any file under `dist/` matches `/fixtures|synthetic|mock/` or if
  `dist/` exceeds 6 MB (so QF-derived fixtures can never reach an installer).

### 5.17 Browser mock contract (`src/lib/ipc/mock/*`, D9)
```
src/lib/ipc/mock/
├─ index.ts           # installMockRuntime(); export const mockCommands = {...} satisfies typeof commands  (WP0C, frozen)
├─ runtime.ts         # mockWindows('main'); mockConvertFileSrc('windows'); mockIPC(fallback, { shouldMockEvents: true }) (WP0C, frozen)
├─ result.ts          # ok<T>(data), err(kind, message) → tauri-specta result shapes (WP0C, frozen)
├─ state.ts           # typed state slices with load()/save() (WP0C, frozen)
├─ fixtures.ts        # import.meta.glob('./fixtures/**/*.json') loader + synthetic generator fallback (WP0C, frozen)
├─ synthetic.ts       # synthetic pages/index/timings when fixtures are absent (WP0C, frozen)
├─ handlers/app.ts, settings.ts (WP7c)   handlers/mushaf.ts (WP8a)   handlers/fonts.ts (WP8b)   handlers/search.ts (WP10b)
├─ handlers/content.ts (WP11a)           handlers/user.ts (WP11c)    handlers/audio.ts (WP9a)   handlers/memo.ts (WP9b)
├─ handlers/packs.ts (WP12a)
└─ fixtures/          # GENERATED by `cargo xtask export-fixtures`, gitignored, never committed
```
- `mockCommands` spreads the handler modules. `satisfies typeof commands` makes the TS compiler fail when a command is
  missing or its signature drifts after `bindings.ts` is regenerated. After a contract PR, each handler owner fixes its own
  handler when `pnpm check` fails (§14.2).
- Command → handler file:

  | Handler file | Commands |
  |---|---|
  | `app.ts` | `app_*`, `window_*`, `system_*` |
  | `settings.ts` | `settings_*` |
  | `mushaf.ts` | `mushaf_get_pages`, `quran_copy_text` |
  | `fonts.ts` | `mushaf_ensure_page_fonts`, `decor_ensure` |
  | `content.ts` | `quran_get_ayahs`, `translation_get`, `tafsir_get`, `wbw_get_range` |
  | `search.ts` | `search_query`, `search_suggest`, `search_history_*` |
  | `audio.ts` | `audio_*` |
  | `memo.ts` | `memo_*`, `loop_preset_*` |
  | `packs.ts` | `packs_*`, `cache_clear` |
  | `user.ts` | `bookmark_*`, `reading_bookmark_set`, `reading_bookmark_clear`, `highlight_*`, `note_*`, `collection_*`, `tag_*`, `item_tags_set`, `user_marks`, `position_set`, `history_*`, `user_backup_create` |
- Every handler returns `Promise<Result>` built with `ok()` or `err()`. Handlers MUST resolve asynchronously
  (`await Promise.resolve()`) to mirror IPC timing. Pages add a 2–8 ms artificial delay to surface race conditions.
- **Channels:** handlers keep the `Channel` they receive and push with `channel.onmessage(payload)`. The audio mock drives
  `AudioTick` at 30 Hz from fixture or synthetic timings, with a simulated clock that honours `speedPct`. The packs mock
  simulates downloads at 2 MB/s.
- **Events:** handlers emit through the generated `events.x.emit(payload)`, which mockIPC delivers when `shouldMockEvents` is set.
- **State (`state.ts`).** Typed slices, each mutated **only by its owner's handler**:
  `settings` (settings.ts), `user` (user.ts: bookmarks, reading bookmark, highlights, notes, collections, tags, positions,
  history), `memo` (memo.ts), `packs` (packs.ts: PackInfo list from `fixtures/packs/list.json` or synthetic, jobs),
  `audio` (audio.ts: snapshot, reciters), `fonts` (fonts.ts: decor status). Each slice has `load()`/`save()` mirrored to
  `localStorage` key `qd-mock-v1:<slice>` (try/catch, per-viewer convenience only). `app_bootstrap` (app.ts) **reads** the
  slices (plus `fixtures/index.json` or the synthetic index) to assemble `Bootstrap`; it never writes them.
- **mockIPC fallback** (`runtime.ts`), for plugin calls the UI makes outside the typed commands: `plugin:window|*` → `null`
  (minimize, toggleMaximize, startDragging, setFullscreen, …); `plugin:log|log` → `console[level]`; `plugin:dialog|save` →
  `'C:/mock/backup.qdb'`; `plugin:dialog|open` → `null`; anything else throws an Error naming the command.
- **Fonts in browser mode:** with `data/dev-packs/` populated by `cargo xtask fetch-dev-packs` (§4.8; `QD_PACKS_DIR`
  overrides the path), the dev plugin `vite/dev-packs.ts` (WP8b, `--mode mock` only) serves `/__packs/*` and the mock returns
  `Ready` with `url = /__packs/mushaf/{v}/p{N}.woff2` and `rel = mushaf/{v}/p{N}.woff2`. Without it, `Unavailable` (hafs
  fallback). Decor works the same way.

---

## 6. Custom protocol `quran://` and CSP

### 6.1 Registration and URL forms
- `tauri::Builder::register_asynchronous_uri_scheme_protocol("quran", protocol::handle)` (verified in the probe).
- **Windows:** `http://quran.localhost/<rel>`. **macOS/Linux:** `quran://localhost/<rel>`. The app origin on Windows is
  `http://tauri.localhost`. The frontend never builds these by hand: `AppInfo.protocol_base` carries the base, and Rust returns
  full URLs in `PageFontStatus.url`/`DecorStatus`.
- Root: `<app_local_data_dir>/packs/` (D3). The asset protocol stays **disabled** (no `protocol-asset` feature).
- **Cross-origin font loads are unverified outside WebView2.** `FontFace` URL loads run in CORS mode from the app origin to
  `quran://localhost` (or `http://quran.localhost`). The protocol and its CORS headers were probed only on Windows/WebView2
  (FACT §7). On Linux, wry 0.57.0 registers custom schemes only as **secure** (`register_uri_scheme_as_secure`), never as
  CORS-enabled, so WebKitGTK may reject the load and every QCF page would stay on the hafs fallback. **WP6a's day-1 spike**
  loads a `quran://` woff2 through `FontFace` in WebKitGTK ≥ 2.50 (ubuntu CI runner under Xvfb, or a Linux VM) and in
  WKWebView, and records the result per platform as `AppInfo.fontTransport`: `url` where it works, `bytes` where it doesn't
  (the `font_bytes` raw command, §5.13, and `new FontFace(family, arrayBuffer)`, which needs no CORS; §8.5). The default is
  `url` on Windows.

### 6.2 Routes (allow-list; anything else is 404)
| Route (regex on the decoded path) | File | Content-Type |
|---|---|---|
| `^/mushaf/(v1\|v2\|v4)/p([1-9][0-9]{0,2})\.woff2$` (page ≤ 604) | `packs/mushaf/{v}/p{N}.woff2` | `font/woff2` |
| `^/decor/qcf-surah-header\.woff2$` | `packs/decor/qcf-surah-header.woff2` | `font/woff2` |
| `^/decor/quran-common\.ttf$` | `packs/decor/quran-common.ttf` | `font/ttf` |
| `^/decor/sura-names\.woff2$` | `packs/decor/sura-names.woff2` | `font/woff2` |
| `^/decor/noto-nastaliq-urdu\.woff2$` | `packs/decor/noto-nastaliq-urdu.woff2` (optional `decor.nastaliq`, §9.3) | `font/woff2` |
| `^/audio/([0-9]{1,4})/([0-9]{3})\.mp3$` | `packs/audio/{r}/{sss}.mp3` (diagnostics; the engine reads files natively) | `audio/mpeg` |

`.stream.part`/`.dl.part` temps and sidecars never match a route. `font_bytes` (§5.13) accepts exactly the font routes above
(without the leading `/`) and applies the same path rules.

### 6.3 Handler rules (`src-tauri/src/protocol.rs`, WP6a; based on the verified probe handler)
- **Methods.** `GET` and `HEAD` → served. `OPTIONS` → `204` with CORS headers. Anything else → `405`.
- **Path.** Percent-decode the path, ignore the query string (`?v=` is a cache-buster), then:
  - empty path, or any path `Component` other than `Normal` → `403`
  - no matching route → `404`
- **IO.** All file IO runs in `tauri::async_runtime::spawn_blocking`. Errors map to `404` (missing) or `500` and are logged at
  debug. The handler **never** panics.
- **Range.** A single range `bytes=a-b | a- | -n` → `206` with `Content-Range: bytes a-b/len`, at most **1 MiB** per response. Only
  the first range of a multi-range request is honoured. Unsatisfiable → `416` with `Content-Range: bytes */len`. No Range → `200`
  with the full body.
- **Headers on every response, errors included:**
  ```
  Access-Control-Allow-Origin: *
  Access-Control-Expose-Headers: content-range, content-length, accept-ranges
  Cross-Origin-Resource-Policy: cross-origin
  X-Content-Type-Options: nosniff
  ```
- **Additional headers on success:**
  ```
  Content-Type: <exact, table above>
  Accept-Ranges: bytes
  Content-Length: <body length>
  Cache-Control: public, max-age=31536000, immutable   (URLs are content-versioned by ?v=<sha256[0..8]>)
  ```

### 6.4 CSP (`tauri.conf.json → app.security`)
```json
"csp": {
  "default-src": "'self' ipc: http://ipc.localhost",
  "script-src": "'self'",
  "style-src": "'self' 'unsafe-inline'",
  "img-src": "'self' data: blob: quran: http://quran.localhost",
  "font-src": "'self' data: quran: http://quran.localhost",
  "media-src": "'self' quran: http://quran.localhost",
  "connect-src": "'self' ipc: http://ipc.localhost quran: http://quran.localhost",
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'none'",
  "frame-ancestors": "'none'"
},
"devCsp": {
  "default-src": "'self' ipc: http://ipc.localhost",
  "script-src": "'self'",
  "style-src": "'self' 'unsafe-inline'",
  "img-src": "'self' data: blob: quran: http://quran.localhost",
  "font-src": "'self' data: quran: http://quran.localhost",
  "media-src": "'self' quran: http://quran.localhost",
  "connect-src": "'self' ipc: http://ipc.localhost quran: http://quran.localhost ws://localhost:1420 ws://localhost:1421 http://localhost:1420",
  "object-src": "'none'"
},
"dangerousDisableAssetCspModification": ["style-src"]
```
- `style-src 'unsafe-inline'` is required for the generated `@font-palette-values` `<style id="qd-v4-palettes">` (D14),
  Svelte inline style attributes and the bits-ui positioning styles.
- **Why `dangerousDisableAssetCspModification: ["style-src"]`.** At build time Tauri injects a nonce into every `<style>`
  element of the bundled HTML and appends `'nonce-…'` and style hashes to `style-src` (tauri-utils-2.10.1 `html.rs`
  `inject_nonce(document, "style", …)`; tauri-2.12.2 `manager/mod.rs` `replace_csp_nonce`). Once a nonce or hash is present,
  CSP3 browsers **ignore `'unsafe-inline'`**, which would block every inline style attribute and the runtime palette
  `<style>`. Disabling the modification for `style-src` only keeps `script-src` nonce protection intact.
- Belt and braces: `index.html` MUST NOT contain a `<style>` element (no-flash backgrounds go in `src/styles/base.css` or a
  `<link>`); `scripts/check-dist.mjs` (§5.16) fails CI if `dist/index.html` contains `<style`.
- WP13b's real-app check asserts that `#qd-v4-palettes` is applied (a V4 page renders palette colours) and that no
  `securitypolicyviolation` event fires during the scripted navigation.
- `devCsp` is a verified key in schema 2.12.2. Both `font-src` and `media-src` may additionally list `blob:` (the scaffold
  does); bytes-transport fonts (`FontFace(family, ArrayBuffer)`) need no `font-src` entry.
- There is no remote origin anywhere: all network IO is in Rust.

---

## 7. Frontend architecture

### 7.1 Directory tree (`src/`)
Owners are §14 packages. "A → B" means A creates the file in wave 0 and B owns it afterwards.
```
src/
├─ main.ts            # await initIpc(); await document.fonts.load(qd-hafs); const b = await bootstrap();
│                     # await initStores(b); mount(App)                                                  (WP0C, frozen)
├─ env.d.ts           # Vite client types + `declare const __MOCK_IPC__: boolean`                          (WP0D)
├─ App.svelte         # shell layout, landmarks, view switch, OverlayHost                                  (WP0C → WP7c)
├─ app.css            # @layer reset, tokens, base, components, mushaf, utilities; imports styles/*       (WP7a)
├─ assets/            # app-icon.svg, star8.svg (EmptyState art)                                           (WP-Brand)
├─ styles/{tokens.css, base.css, fonts.css}                                                                (WP7a)
├─ styles/mushaf/index.css       # imports the files below, nothing else                                  (WP0C, frozen)
├─ styles/mushaf/{page.css, lines.css} (WP8a) · frame.css (WP8c) · highlights.css (WP8d) · spread.css (WP8e) · memo.css (WP9b)
├─ lib/
│  ├─ ipc/        bindings.ts (generated by WP0A), index.ts (WP0C, frozen), mock/** (§5.17)
│  ├─ contracts/  overlays.ts, components.ts — the §7.9 cross-package types                                (WP0C, frozen)
│  ├─ stores/     index.ts (WP0C, frozen: initStores order)
│  │              app, settings, ui, shortcuts, i18n (WP0E → WP7c); quran (WP0E → WP10a); search (WP10b);
│  │              pages (WP8a); fonts (WP8b); reader (WP8e); player (WP9a); memo (WP9b); translations (WP11a);
│  │              library, history (WP11c); packs (WP12a)
│  ├─ shortcuts/  index.ts, app.ts (WP0E → WP7c); navigation.ts, view.ts (WP8e); audio.ts (WP9a); memorize.ts (WP9b);
│  │              study.ts (WP11c)
│  ├─ mushaf/     geometry.ts, metrics.ts (WP8a); fontRegistry.ts, palettes.ts, colrProbe.ts (WP8b); ornaments.ts (WP8c);
│  │              layout.ts, a11y.ts, interactions.ts (WP8d); copy.ts, transitions.ts, wheel.ts (WP8e)
│  ├─ text/       html.ts (WP0C, frozen: DOMPurify config, §7.6); normalize.ts, refparse.ts (WP10a); markdown.ts (WP11d)
│  ├─ i18n/       index.ts (WP0E → WP7c); {en,ar}/{index,common,shortcuts,errors}.ts (WP0C, frozen); {en,ar}/<domain>.ts (§11.1)
│  ├─ testing/    qdtest.ts — window.__QD_TEST__, installed only when bootstrap.app.testMode                (WP13a)
│  ├─ about/      thirdparty.json (created `[]` by WP0D; content generated by `xtask licenses`, WP3c); attributions.ts (WP12c)
│  └─ util/       lru.ts, debounce.ts, raf.ts, platform.ts, format.ts, binsearch.ts                         (WP7c)
├─ components/
│  ├─ ui/         design-system primitives §9.5 (WP7b); SafeHtml.svelte (WP0C, frozen; §7.6)
│  ├─ shell/      TitleBar, WindowControls, NavRail, Sidebar, PaneLayout, OverlayHost, LiveRegion, OfflineBadge,
│  │              FatalScreen, StartupBanner (WP7c)
│  ├─ dialogs/    ShortcutSheet, ShortcutTable, ConfirmDialog (WP7c); GoToDialog (WP10a); NoteEditorDialog (WP11d);
│  │              SelfTestDialog (WP9b)
│  ├─ mushaf/     MushafPage, GlyphLayer (WP8a) · RenditionStack (WP8b) · PageFrame, SurahCartouche, HeaderLine, BasmalaLine,
│  │              RunningHead, PageFooter, MarginMarkers, MarginMarks, OpeningMedallion, SurahInfoPopover (WP8c) ·
│  │              HighlightLayer, A11yLayer, WordTooltip, AyahActionBar (WP8d) · MushafView, SpreadStage, FollowChip,
│  │              ZoomControl (WP8e) · PageTurnZones, FlipHUD, PageRail, HintChip, DivisionChip (WP8f) ·
│  │              AyahContextMenu (WP11c)
│  ├─ translation/ TranslationView, VerseRow, SurahCard, FootnotePopover (WP11a)
│  ├─ sidepane/   SidePane, AyahHeader, TranslationTab, TafsirTab, NotesTab, WordsTab (WP11b)
│  ├─ library/    BookmarksPanel, HighlightsPanel, NotesPanel, HistoryPanel (WP11c); CollectionsPicker, TagPicker (WP11d)
│  ├─ index/      IndexPanel, SurahList, JuzList, HizbList, PageGrid, ContinueCard (WP10a)
│  ├─ search/     SearchPanel, SearchResults, ResultGroup, ResultItem, ScopePicker (WP10b)
│  ├─ palette/    CommandPalette, palette-providers.ts (WP10c)
│  ├─ player/     PlayerDock, SideDockCard, Transport, AyahScrubber, TimeReadout, RepeatPopover, SpeedPopover, ReciterPicker,
│  │              PlayerMore (WP9a)
│  ├─ memo/       MemoPanel, MemoToolbar, SelfTestBar, ProgressHeatmap (WP9b)
│  ├─ downloads/  DownloadsView, PackSection, PackRow, ReciterRow, SurahGrid, DiskUsageBar (WP12a)
│  ├─ settings/   SettingsView, sections/*.svelte, meta.ts (`settingsMeta`: labels and ranges per field) (WP12b)
│  ├─ onboarding/ OnboardingDialog, steps/*.svelte (WP12c)
│  └─ about/      AboutView, AttributionList (WP12c)
└─ (tests colocated as *.test.ts; browser tests *.browser.test.ts)
vite/dev-packs.ts     # repo root; serves data/dev-packs at /__packs/* in --mode mock (WP8b)
```
Aliases in `vite.config.ts`, `vitest.config.ts` and `tsconfig`: `$lib → src/lib`, `$components → src/components`,
`$styles → src/styles` (the scaffold has only `$lib`; WP0D adds the other two).

### 7.2 State management rules
- Stores are **classes in `*.svelte.ts`** using `$state` / `$state.raw` / `$derived`. One singleton per class, exported from its
  file. `src/lib/stores/index.ts` exports `initStores(b: Bootstrap)`, which calls every store's `init(b)` in order: `app →
  settings → i18n → quran → ui → shortcuts → library → history → packs → fonts → pages → translations → search → player →
  reader → memo`. **Every store implements `init(b: Bootstrap): void | Promise<void>` and `reset(): void`** (§7.9), so the
  frozen `index.ts` never changes when a store grows.
- **Layering (no import cycles).**
  - L0: `app, settings, i18n, quran, ui, shortcuts`.
  - L1: `pages, fonts, library, history, packs, translations, search`.
  - L2: `player` (must not import reader or memo), `reader` (may import player), `memo` (may import reader and player).
- Large immutable data (`QuranIndex`, `PageData`, timings) is held in `$state.raw` or in plain non-reactive `Map`s plus a
  `$state` version counter. Deep proxies are never created over 6,236-entry arrays.
- All IPC goes through `call(api.x(...))`. Failures surface as an `IpcError` → the store sets an error state and/or
  `ui.toastError(err)`.
- Settings fields are always read and written by their **generated camelCase names** (`settings.value.followAlong`,
  `settings.update({ inkBrightnessPct: 80 })`, §0.2).
- Effects that live outside components run inside `$effect.root` created in the store's `init()`. They are disposed by
  `dispose()` (tests).

### 7.3 Store specifications
| Store (file, owner) | State | Derived | Methods | IPC / events |
|---|---|---|---|---|
| `app` (WP7c) | `ready, info: AppInfo, online, firstRun, fatal: string\|null, notices: StartupNotice[]` | `platform, isWindows, isMac, isLinux, protocolBase, testMode` | `init(b)`, `failBootstrap(e)` (sets `fatal`, still calls `markReady`), `markReady()` (double rAF after first paint → `windowReady`) | `appBootstrap`, `windowReady`, `appQuit`; `networkChanged` |
| `settings` (WP7c) | `value: Settings` | `resolvedTheme ('paper'\|'sepia'\|'night'\|'black'\|'high_contrast')` (system → `lightVariant`/`darkVariant`), `isDark`, `dir`, `reducedMotion`, `arabicDigits`, `highContrastDark` | `init(b)`, `update(patch)` (optimistic → `settingsSet(full)` → reconcile; revert + toast on error), `reset()`, `applyEffects()` (html `data-theme`, `data-accent`, `lang`, `dir`, `data-motion`, `--ink-alpha`; `windowSetChrome` whenever the **resolved** theme or `chromeEffect` changes — the frontend is the single chrome owner, §9.6). UI scale is applied by Rust (D27), not here. | `settingsGet/Set/Reset`, `windowSetChrome`; `settingsChanged` |
| `i18n` (WP7c) | `locale` | `dir` | `t(key, params?)`, `tp(key, count, params?)`, `num`, `mushafNum`, `ref(surah, ayah)` (returns text wrapped for bidi, §11.3), `bytes(kib)`, `duration(ms)`, `relTime(secs)` | — |
| `ui` (WP7c) | `view: AppView`, `overlays: OverlayEntry[]` (typed by `OverlayProps`, §7.9), `floating: number` (open context menus, popovers, selects, menus), `contextMenu: {x,y,ayahId,wordId?}\|null`, `zen`, `fullscreen`, `toasts` | `topOverlay`, `layerOpen` (overlay or floating), `sidebarOpen/sidePaneOpen` (settings + auto-collapse), `paneDocked` (§9.6 geometry rule) | `open<K>(k, p: OverlayProps[K])`, `close(k?)`, `pushFloating()/popFloating()` (called by the bits-ui wrappers), `setView(v)`, `toggleSidebar(tab?)`, `toggleSidePane(tab?)`, `resizeSidebar(px)`, `resizeSidePane(px)`, `toast(…)` (actions ≥ 10 s, pause on hover/focus), `toastError(e)`, `focusToasts()` (F6 / Mod+Shift+U), `confirm(opts): Promise<boolean>`, `announce(text)` (LiveRegion) | `navigateRequested` → routes to reader/view |
| `shortcuts` (WP7c) | `defs: ShortcutDef[]`, `layoutMap: Map<code, key>\|null` | `byGroup` | `register(defs) → unregister`, `handleCapture(e)`, `handleBubble(e)`, `format(def)` (§7.7) | — |
| `quran` (WP10a) | `index` (raw) | — | `surah(n)`, `ayahRef(id)`, `ayahId(s,a)`, `firstWordOf(id)`, `pageOfAyah(layout,id)`, `pageOfWord(layout,w)`, `juzOf(id)`, `hizbOf(id)`, `surahRange(n)`, `juzRange(n)` (ayah-id ranges), `pageRange(layout,p)`, `surahMatches(q)` (normalised names + aliases), `refLabel(id, style)` | — |
| `pages` (WP8a) | non-reactive LRU(48) of `PageData` + `version` | — | `get(style,p)`, `ensure(style, pages)` (batch ≤ 8, in-flight dedupe), `prefetch(style, pages, dir?)` (idle; ±8 in the flip direction while flipping) | `mushafGetPages` |
| `fonts` (WP8b) | `status: SvelteMap<family, 'loading'\|'ready'\|'failed'\|'unavailable'>`, `decor: DecorStatus`, `v4Supported: boolean\|null` (cached per webview version in localStorage) | `transport` (from `AppInfo.fontTransport`) | `family(style,p)`, `ensure(style,pages,prio)`, `isReady(style,p)`, `retry(style,p)`, `prefetchAround(style,p,spread)`, `ensureDecor()`, `regeneratePalettes()` | `mushafEnsurePageFonts`, `decorEnsure`, `fontBytes` (bytes transport); `packsChanged` |
| `reader` (WP8e) | `page`, `cursorAyahId` (the single reading cursor, §8.15), `selection {fromAyahId,toAyahId,anchorAyahId}\|null`, `paneFollow: 'selection'\|'audio'`, `hover {ayahId,wordId}\|null`, `searchHit {ayahId,wordIds}\|null`, `flash {ayahId,until}\|null`, `viewport {w,h}`, `navBack/navFwd: Loc[]`, `turning`, `flipping` | `style, layout, spread, dock ('side'\|'bar'\|'compact')`, `visiblePages (RTL order), qfs, pageBox, currentAyahId, headSurah, juz, zoomPct, actionTarget` (visible selection, else visible cursor, else first visible ayah) | `goToPage(p,{push,transition})`, `goToAyah(id,{select,highlightWords,flash,focus})`, `goToSurah(n)`, `goToJuz(n)`, `goToHizb(n)` (the last three call `goToAyah(first, {flash: true})`), `next()`, `prev()`, `flip(dir)` (key repeat, §8.11), `back()`, `forward()`, `moveCursor(±1, {extend})`, `select(id, extend)`, `clearSelection()`, `followRecitation()`, `setHover(a,w)`, `zoomIn/Out/Reset`, `zoomAt(delta,x,y)`, `setViewport(w,h)`, `cyclePageMode()` | `positionSet` (debounced 1 s), `historyRecord` (3 s dwell); follows `player` (§8.12); startup restore (§7.8) |
| `library` (WP11c) | `bookmarks, highlights, notes, collections, tags, readingBookmark`, `marks: Map<key, UserMarks>`, `undoStack` / `redoStack` (20 deep each) | `bookmarkedAyahs: Set<number>`, `notedAyahs`, `canUndo`, `canRedo` | `loadAll()`, `marksFor(layout,pages,from,to)`, `toggleBookmark(id)`, `bookmarkPage(layout,p)`, `moveReadingBookmark(id,layout,p)`, `setHighlight(from,to,color)`, `clearHighlight(from,to)`, `saveNote(input)`, `deleteNote(id)`, `setCollections(bid, ids)`, `setTags(kind,id,tags)`, `undo()`, `redo()` — every mutation pushes an undo entry and shows a toast naming the change (§9.5) | user commands; `userDataChanged` |
| `history` (WP11c) | `entries`, `positions` | `last(context)` | `init(b)` (positions from bootstrap), `load()`, `record(input)`, `clear()`, `setPosition(p)` | `historyList/Record/Clear`, `positionSet` |
| `translations` (WP11a) | caches: `rows: Map<ayahId,{ayah,tr}>`, `tafsir: Map`, `wbw: Map<wordId,WbwEntry>` + `version` | — | `ensureWindow(from,to)`, `tafsirFor(packId, ayahId)`, `wbwForRange(packId, fromWord, toWord)` | `quranGetAyahs`, `translationGet`, `tafsirGet`, `wbwGetRange` |
| `search` (WP10b) | `query, scope, mode, surahFilter, juzFilter, status, results, activeIndex, history, suggestions` | `flatHits`, `count` | `setQuery(q)` (debounce 120 ms), `run()`, `openHit(h)`, `submit()`, `clearHistory()`, `move(±1)` (also F3 / Shift+F3 from the reader: opens the next/previous hit and keeps the list in sync) | `searchQuery`, `searchSuggest`, `searchHistory*` |
| `player` (WP9a) | `snapshot`, `tick`, `tickAt`, `positionMs` (rAF-interpolated), `timings: Map` + `version`, `reciters`, `abPending: number\|null`, `muted` | `isPlaying, isActive, currentAyahId, currentRef, activeWord {ayahId, wordId, pos}\|null, ayahProgress, timingsForCurrent, resumeCandidate` (§7.8) | `init(b)`, `playFrom(target, opts?)`, `playRange(from,to,{ayahRepeat,rangeRepeat,gap})`, `resume()` (idle: from the start of the resume candidate's ayah), `toggle/pause/stop/next/prev()`, `seekAyah(id)`, `seekMs(ms)`, `nudge(ms)`, `setSpeed(pct)`, `speedStep(±1)`, `setVolume(pct)`, `toggleMute()`, `setRepeat(a,r)`, `cycleRepeat()`, `setGap(g)`, `abMark()`, `setReciter(id)`, `ensureTimings(r,s)` | audio commands; `audioStateChanged`, `audioAyahChanged`; Channel `AudioTick` |
| `memo` (WP9b) | `active {from,to,mode:'hide'\|'test'}\|null`, `revealedThrough: number` (word id), `peeking`, `test: MemoTest\|null`, `progress: Map` | `isHidden(wordId)` | `startHide(from,to)`, `stop()`, `revealNextWord()`, `revealNextAyah()`, `peek(on)`, `startTest(from,to)`, `finishTest(rating)`, `rate(from,to,r)`, `setStatus(from,to,s)`, `loadProgress(from,to)`, `applyPreset(p)` | `memo*`, `loopPreset*` |
| `packs` (WP12a) | `list: PackInfo[]`, `jobs: Map<packId, JobSnapshot>`, `items: Map<packId, PackItemState[]>`, `usage`, `updates`, `filter` | `byKind`, `installedTranslations`, `installedTafsir`, `starterSet` (§2.5.4, exact), `activeJobs` | `init(b)`, `refresh()`, `install(id, scope?)`, `pause/resume/cancel/remove(id)`, `retry(id)` (= resume), `update(id)` (= install All), `loadItems(id)`, `removeItems(id, items)`, `loadUsage()`, `checkUpdates()`, `clearStreamCache()`, `clearCache()` | `packs*`, `cacheClear`; Channel `DownloadEvent`; `packsChanged` |

`PlayerStore.positionMs` interpolation runs while `isPlaying && document.visibilityState === 'visible'`:
`positionMs = clamp(tick.fileMs + (now − tickAt) × tick.speedPct / 100, tick.fileMs, snapshot.ayahToMs + 250)`.
When a tick arrives with a new `generation`, interpolation resets to that tick. `activeWord` = the last word in the current
ayah's timings with `startMs ≤ positionMs` (binary search). It is held through inter-word gaps and is `null` in a gap marker
or at basmala.

**Undo (WP11c).** The library store keeps a 20-deep undo stack (and a redo stack cleared by any new mutation) covering
bookmark toggle and move, reading-bookmark move (undoing a first set calls `readingBookmarkClear`), highlight set and clear,
note delete, collection membership and tag changes. Before `setHighlight`, the store snapshots the highlights overlapping
`[from, to]` client-side; undo calls `highlightClearRange(from, to)` and re-sets the snapshot rows, so no contract change is
needed. `Mod+Z` / `Mod+Shift+Z` (§10.1) and every toast's Undo action call `undo()`/`redo()`.

### 7.4 View and overlay model (no router)
- `ui.view ∈ {reader, downloads, settings, about}` replaces the canvas content. Esc or the back button returns to `reader`.
  The player dock stays visible in every view.
- `settings.readingMode ∈ {mushaf, translation}` picks the reader body. `T` toggles it, and the reading position is kept by ayah.
- **Overlays** form a stack in `ui.overlays`: `palette`, `goto`, `shortcuts`, `onboarding`, `confirm`, `note-editor`,
  `self-test`. Each is a bits-ui `Dialog` with focus trap. `OverlayHost` renders only the top-most interactive overlay. Opening
  `palette` while it is already open closes it (toggle).
- **Floating layers** (context menu, popovers such as Repeat/Speed/ReciterPicker, open Select/Combobox listboxes, dropdown
  menus, the AyahActionBar's swatch popover) register through `ui.pushFloating()/popFloating()` in the `src/components/ui`
  wrappers. For shortcut purposes they count as overlays (§7.7 rule 1).
- **Context menu:** one `AyahContextMenu` instance (WP11c), opened by `ui.contextMenu = {…}` (right-click or `Shift+F10`/
  `ContextMenu` on the focused ayah). (v1.2) Its openers call `openAyahMenu`, which selects the ayah first unless the
  selection holds it (§10.3).
- **Focus after navigation.** Overlays restore focus on close, **except** after a jump (palette, Go to, search hit, bookmark,
  history entry): then focus moves to the target ayah's roving `li` once it renders (`focus({ preventScroll: true })`) and the
  live region announces "Al-Baqarah 2:255, page 42" (§8.15).
- Deep navigation requests (tray, `NavigateRequested`, palette, search) all go through `reader.goToAyah/goToPage`, or
  `ui.setView`.

### 7.5 Component trees per screen
```
App (WP7c)
├─ TitleBar ─ [mac: 78px traffic-light inset] AppIcon · Breadcrumb(surah · juz · page or "ص ٢٦١–٢٦٢" in a spread) · SearchButton(Ctrl+K) · OfflineBadge · WindowControls[win]
├─ StartupBanner (user.db recovered, §9.8)
├─ .app-body (grid)
│  ├─ <nav aria-label="Sections"> NavRail ─ IndexBtn · SearchBtn · BookmarksBtn · HighlightsBtn · NotesBtn · HistoryBtn · MemorizeBtn ─ spacer ─ DownloadsBtn · SettingsBtn
│  ├─ <aside> Sidebar (PaneLayout) ─ IndexPanel | SearchPanel | BookmarksPanel | HighlightsPanel | NotesPanel | HistoryPanel | MemoPanel
│  ├─ <main class="canvas">
│  │  ├─ reader:  MushafView (WP8e)  |  TranslationView (WP11a)
│  │  ├─ downloads: DownloadsView (WP12a) · settings: SettingsView (WP12b) · about: AboutView (WP12c)
│  │  ├─ FatalScreen (app.fatal)
│  │  └─ <div role="region" aria-label="Recitation player"> PlayerDock | SideDockCard (WP9a; placement from reader.dock)
│  └─ <aside> SidePane (WP11b) ─ AyahHeader · Tabs[TranslationTab | TafsirTab | NotesTab | WordsTab]
├─ OverlayHost ─ CommandPalette (WP10c) | GoToDialog (WP10a) | ShortcutSheet (WP7c) | OnboardingDialog (WP12c)
│               | ConfirmDialog (WP7c) | NoteEditorDialog (WP11d) | SelfTestDialog (WP9b)
├─ AyahContextMenu (WP11c) · Toaster (svelte-sonner) · LiveRegion
```
- `MushafView` (WP8e):
  `SpreadStage → MushafPage×{1,2} → {PageFrame, RunningHead, mp-block{HighlightLayer, RenditionStack{GlyphLayer×{1,2}},
  A11yLayer}, MarginMarkers, MarginMarks, PageFooter}`, plus `PageTurnZones`, `FlipHUD`, `PageRail`, `ZoomControl`
  (top inline-end corner, §8.13), `WordTooltip`, `AyahActionBar`, `SurahInfoPopover`, and an **overlay slot**
  (bottom-centre of the canvas) that renders, in order, `FollowChip` ("Return to recitation", WP8e), `MemoToolbar` +
  `SelfTestBar` (WP9b), `DivisionChip` and `HintChip` (WP8f).
- `TranslationView` (WP11a): `VList → (SurahCard | VerseRow{KeyBadge, ActionBar, ArabicText, TranslationBlock×n{FootnotePopover}})`.
- `DownloadsView` (WP12a): `DiskUsageBar · Filters · PackSection(mushaf) · PackSection(recitations → ReciterRow{SurahGrid}) ·
  PackSection(translations by language) · PackSection(tafsir) · PackSection(wbw)`.
- `SettingsView` (WP12b): `SectionNav · {Appearance, Mushaf, Translations, Audio, Memorization, Language, Keyboard, Storage, System, About}`.

### 7.6 HTML rendering rule
Only `TranslationText.html`, `Footnote.html`, `TafsirEntry.html` and `SearchHit.snippet` may be rendered as HTML, and only
through **`src/components/ui/SafeHtml.svelte`** (WP0C, frozen; props `{ html: string; onref?: (ref: string) => void;
onfootnote?: (id: string) => void }`). It is the only file allowed
`<!-- eslint-disable-next-line svelte/no-at-html-tags -->` (the scaffold's ESLint config sets `svelte/no-at-html-tags: error`).
`SafeHtml` passes the string through `sanitize(html)` (`src/lib/text/html.ts`, WP0C, frozen): DOMPurify 3.4.x with the
§2.5.6 tag/class allowlist and `ALLOWED_ATTR` including `data-fn` and `data-ref` (`href` is not allowed; references arrive as
`<a data-ref="s:a[-b]">`, never as a URL scheme that DOMPurify's default `ALLOWED_URI_REGEXP` would strip). Afterwards:
- `a[data-ref]` anchors are rendered as `<button data-ref="s:a[-b]">`. A delegated click handler on the container calls
  `onref` (→ `reader.goToAyah`).
- `sup.fn[data-fn]` gets `role=button tabindex=0` and calls `onfootnote` (→ `FootnotePopover`).

Nothing else is ever rendered as HTML. User note bodies are rendered by the WP11d Markdown renderer, which escapes all input.

### 7.7 Shortcut registry
```ts
export type ShortcutGroup = 'navigation' | 'view' | 'audio' | 'study' | 'memorize' | 'app';
export interface ShortcutDef {
  id: string;                         // 'nav.nextPage'
  keys: string[];                     // chords, §10.1: 'Mod+k', 'ArrowLeft', '?', '>', 'Shift+b', 'Digit1', 'Alt+ArrowRight'
  group: ShortcutGroup;
  labelKey: I18nKey;                  // shortcuts.* keys only (frozen dictionary, §11.1)
  scope: 'global' | 'reader' | 'mushaf' | 'translation';
  capture?: boolean;                  // runs in the capture-phase listener (only the defs listed below)
  allowInInput?: boolean;             // default false (Escape, Mod+K, Mod+F are true)
  repeat?: boolean;                   // allow key auto-repeat (page turns: true, throttled by reader.flip; zoom: true)
  when?: () => boolean;
  run: (e: KeyboardEvent) => void;
}
```
- **Key matching (D11, hybrid).** A chord is `[Mod+][Alt+][Shift+]<key>`; `Mod` is Ctrl on Windows/Linux and Meta on macOS.
  - Letters and punctuation are defined by their **US character** (`'k'`, `'?'`, `'['`, `'.'`, `'>'`). They match `e.key`
    (letters lower-cased, `Shift+` written explicitly for letters only) when `e.key` is a single printable ASCII character;
    for punctuation the Shift state is implied by the character and not compared (`'>'` is "the key that types >"). When
    `e.key` is not ASCII (Arabic, Persian, Cyrillic, … layouts) they fall back to `e.code` plus Shift through a US table
    (`'k'` ↔ `KeyK`, `'['` ↔ `BracketLeft`, `'?'` ↔ `Shift+Slash`, `'>'` ↔ `Shift+Period`).
  - Digits are defined as `Digit0`–`Digit9` and always match `e.code` (AZERTY digits need Shift).
  - Named keys (`ArrowLeft`, `PageDown`, `Home`, `End`, `Space`, `Enter`, `Escape`, `F3`, `F6`, `F11`, `ContextMenu`) match
    `e.key`/`e.code` names.
  - Labels: `format(def)` uses `navigator.keyboard.getLayoutMap()` when available (WebView2) to print the key the user
    actually sees, else the US label; per OS (`⌘K` on macOS, `Ctrl+K` elsewhere) inside `<Kbd>` (§11.3: wrapped in
    `<bdi dir="ltr">`).
- **Listeners (two):**
  1. **Capture phase** on `window`: only defs with `capture: true` — `Mod+K`, `Mod+F`, `Mod+G`, `Mod+Comma`, `Mod+Shift+D`,
     `Escape`, `F11` (and `Mod+Ctrl+F` on macOS). They run even when a widget has focus (Escape still lets an open overlay or
     floating layer close itself first: `Escape` only acts when `ui.layerOpen` is false or the layer did not handle it).
  2. **Bubble phase** on `window`: everything else, skipped when `e.defaultPrevented || e.isComposing`, so bits-ui widgets
     that handle a key (Space on a Button, arrows in a Slider/Tabs/Menu, typeahead in a Select) win.
- **Rules, in order (bubble listener):**
  1. If an overlay **or a floating layer** is open (`ui.layerOpen`), only `allowInInput` defs run.
  2. If the target is editable (`input`, `textarea`, `select`, `[contenteditable]`), only `allowInInput` defs run.
  3. **Widget guard.** A def without `Mod` or `Alt` (plain or Shift-only keys: Space, Enter, arrows, Home/End, PageUp/
     PageDown, digits, letters, punctuation) does nothing when `e.target.closest('button, a[href], input, textarea, select,
     summary, [contenteditable], [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio],
     [role=option], [role=tab], [role=slider], [role=spinbutton], [role=switch], [role=checkbox], [role=radio],
     [role=combobox], [role=listbox], [role=menu], [role=grid], [role=gridcell], [role=tree], [role=treeitem],
     [role=toolbar], [data-qd-keys=own]')` matches. Exceptions (shortcuts DO run): the Mushaf roving items
     (`.mp-a11y li`), `body`, and `main.canvas` itself.
  4. Scope filter (`reader` requires `ui.view === 'reader'`, `mushaf` also requires Mushaf mode).
  5. `when()`.
  6. `e.repeat && !def.repeat` → ignore.
  7. `run(e)` and `preventDefault()`.
- bits-ui `Command` uses `vimBindings={false}` (FACT §1 note).
- Definitions live in `src/lib/shortcuts/*.ts`. The full table is in §10.1.
- **Tests (WP7c unit, WP7b browser):** chord normalisation incl. an Arabic layout (`ن` with code `KeyK` → previous ayah) and
  AZERTY (`?` typed as Shift+, with `key '?'` opens the sheet; the key labelled Q on AZERTY, `key 'q'`, peeks); Space on a
  focused `Button` clicks it and does not call `audioToggle`; ArrowRight in the Speed slider changes speed and leaves the page
  unchanged; typing `b` in the open context menu moves to "Bookmark" and does not toggle a bookmark.

### 7.8 Startup (WP8e reader, WP9a player, WP10a index; data from `Bootstrap`)
1. `readingMode` comes from settings.
2. Open `positions[context = readingMode]`. If its layout differs from the current style's layout, map `ayahId → page` in
   the current layout. With no position (first run), open the spread `[1, 2]`.
3. Set `reader.cursorAyahId` to the restored ayah with **no visible selection**.
4. If an `audio` position exists that was updated in the last 7 days, the idle dock reads "Resume Al-Kahf · 18:45 ·
   Mishary Alafasy" (`player.resumeCandidate`). Space (or the pill) resumes from the start of that ayah. It never auto-plays.
5. When the reading bookmark is more than 2 pages from the restored page, the Index panel top (`ContinueCard`) and the
   palette's Recent group show "Continue from reading bookmark · p 297 · 3 days ago".
6. Zoom, page mode, sidebar and side pane come from settings **before first paint** (the window is shown only after
   `windowReady`, §2.8.2), so nothing jumps.

Scenario S35 (§12.6) covers a relaunch restoring page 297 and the resume pill.

### 7.9 Cross-package component contract (WP0C, `src/lib/contracts/*`, frozen)
```ts
// overlays.ts
export type OverlayProps = {
  palette: { query?: string };
  goto: { initial?: string };
  shortcuts: Record<string, never>;
  onboarding: Record<string, never>;
  confirm: ConfirmOptions;                      // { title, body, confirmLabel, danger?: boolean }
  'note-editor': { noteId?: string; fromAyahId: number; toAyahId: number };
  'self-test': { fromAyahId: number; toAyahId: number };
};
// ui.open<K extends keyof OverlayProps>(k: K, p: OverlayProps[K]): void
```
- Every view, panel, dock and pane component (`MushafView`, `TranslationView`, `SidePane`, `PlayerDock`, `SideDockCard`, all
  sidebar panels, `DownloadsView`, `SettingsView`, `AboutView`) takes **no props** and reads stores.
- `MushafPage` props (WP8a): `{ data: PageData; qfs: number; side: 'right' | 'left'; interactive?: boolean;
  furniture?: boolean; ornaments?: boolean }` (`ornaments`, v1.2: draw the decor ornaments; default the `ornateHeaders`
  setting). Onboarding thumbnails and the Settings › Appearance preview (WP12b/12c) render it with
  `interactive={false}`.
- WP7c exports `ShortcutTable.svelte` (props `{ groups?: ShortcutGroup[] }`), embedded by Settings › Keyboard.
- `MushafView` renders `<MemoToolbar/>` and `<SelfTestBar/>` (WP9b, no props) and the chips in its overlay slot (§7.5).
- Every store implements `init(b: Bootstrap): void | Promise<void>` and `reset(): void`; `stores/index.ts` passes the
  bootstrap.
- WP0C creates every component file of §7.1 as a placeholder with these exact props, so later packages never edit another
  package's file to change a prop.

---

## 8. Mushaf renderer specification (WP8a–WP8f)

### 8.1 Invariants
1. **CLS = 0.** Page, frame, line boxes and margins have fixed geometry derived from one variable (`--qfs`). Font swaps never move a
   box: the fallback→QCF swap is a cross-fade between stacked layers (D13). Style switches keep the same frame (D17). The dock
   placement depends on geometry only (D28), so starting playback never moves the page.
2. **< 16 ms render** of a page once its `PageData` is cached and its font is ready (`performance.measure('qd:page')`).
3. **60 fps** highlight glide: transform-only animation of one element in a `contain: strict` layer.
4. **Crisp at any zoom:** all geometry is vector (fonts and SVG) and sized in px from `--qfs` (no CSS `zoom` on the page; the
   only `scale()` is the bounded line-fit of §8.4).
5. **Glyph colours never change for highlights.** Highlights are drawn behind the glyphs (D12). The only glyph-colour changes are
   theme ink, V4 palettes and memorisation hiding.
6. The Mushaf is always `dir="rtl" lang="ar"`. Physical left/right in this section is intentional: book geometry doesn't
   mirror with the UI language.
7. **Legibility floor:** the fitted `qfs` is never below `QFS_MIN = 18` (the canvas scrolls instead); furniture text has px
   minimums (§8.9). Only an explicit user zoom-out goes below 18.

### 8.2 Geometry (all lengths in qfs units; constants in `src/lib/mushaf/geometry.ts`, WP8a)
| Constant | Value | Meaning |
|---|---|---|
| `TB_W` | 16.5 | text block width (line width) |
| `LH` | 1.75 | line pitch (line box height) |
| `TB_H` | 26.25 | 15 × LH |
| `FR` | 0.85 | frame band (gap 0.40 + inner rule + band 0.32 + outer rule), each side |
| `HEAD` / `FOOT` | 1.40 / 1.40 | running-head band / page-number band |
| `M_OUT` / `M_IN` | 1.90 / 0.90 | outer margin (margin markers) / spine margin |
| `M_TB` | 0.60 | paper margin top and bottom |
| `PW` | **21.00** | page width = M_IN + FR + TB_W + FR + M_OUT = 0.90 + 0.85 + 16.5 + 0.85 + 1.90 |
| `PH` | **31.95** | page height = M_TB + HEAD + FR + TB_H + FR + FOOT + M_TB = 0.60 + 1.40 + 0.85 + 26.25 + 0.85 + 1.40 + 0.60 |
| `SHIFT` | 0.50 | single-page paper offset = (M_OUT − M_IN) / 2 (§8.10) |
| `SINGLE_W` | 22.00 | single-page footprint = PW + 2·SHIFT |

A unit test asserts `PW` and `PH` equal the sums of their components (the v1.0 table had 20.90/31.85, which clipped the frame
band and footer by 0.1·qfs).

Fit math (`fitLayout()`, pure function, unit-tested; replaces v1.0's always-reserved 84 px dock):
```ts
const PAD_X = 24, PAD_Y = 16, SIDE_DOCK_W = 288, QFS_MIN = 18, QFS_MAX = 160;   // px
type Dock = 'side' | 'bar' | 'compact';      // side: 272×120 card beside the pages; bar: 64 px pill; compact: 56 px pill
function fitLayout(canvasW: number, canvasH: number, pageMode: PageMode, zoomPct: number) {
  const barReserve = canvasH < 860 ? 64 : 84;               // compact bar under 860 px canvas height
  const hSide = (canvasH - 2 * PAD_Y) / PH;                   // height-fit qfs with no dock reserve
  const hBar = (canvasH - 2 * PAD_Y - barReserve) / PH;
  const wSide = canvasW - 2 * PAD_X - SIDE_DOCK_W, wBar = canvasW - 2 * PAD_X;
  const sideSpread = 2 * PW * hSide <= wSide, sideSingle = SINGLE_W * hSide <= wSide;
  const barSpreadQ = Math.min(hBar, wBar / (2 * PW)), barSingleQ = Math.min(hBar, wBar / SINGLE_W);
  // candidates, by page mode
  let spread: boolean, dock: Dock, fit: number;
  if (pageMode !== 'single' && sideSpread) { spread = true; dock = 'side'; fit = hSide; }
  else {
    const single = sideSingle ? { q: hSide, dock: 'side' as Dock } : { q: barSingleQ, dock: (canvasH < 860 ? 'compact' : 'bar') as Dock };
    const takeSpread = pageMode === 'spread' || (pageMode === 'auto' && barSpreadQ >= 0.85 * single.q);
    if (takeSpread) { spread = true; dock = canvasH < 860 ? 'compact' : 'bar'; fit = barSpreadQ; }
    else { spread = false; dock = single.dock; fit = single.q; }
  }
  const base = Math.max(fit, QFS_MIN);                       // legibility floor; the canvas scrolls vertically below it
  const qfs = clamp(Math.floor(base * zoomPct / 100 * 4) / 4, 8, QFS_MAX);   // quarter-px steps avoid sub-pixel jitter
  return { spread, dock, qfs, scroll: fit < QFS_MIN || zoomPct > 100 };
}
```
- In pageMode `auto`, a bar-dock spread beats a side-dock single page when its qfs is ≥ 0.85 × the single page's qfs.
- The side dock card sits at the bottom inline-end of the canvas beside the pages, which are centred in `canvasW − 288`.
- The dock is chosen from geometry only (D28), so it never changes when playback starts or stops.
- At zoom > 100 the page can exceed the canvas. The canvas then scrolls on both axes (overlay scrollbars), and page turns
  still work from the keyboard. `fitLayout` measures CSS px, so the UI scale (webview zoom, D27) doesn't change the page's
  physical fit.

**Acceptance values** (window size, sidebar open at 300 px, side pane closed, title bar 40, rail 52, auto, zoom 100; asserted
by `geometry.test.ts`):

| Window | Canvas | Result |
|---|---|---|
| 1366×768 | 1014×728 | spread, compact bar, qfs **19.75** (side-dock single would be 21.75; the spread wins at ≥ 0.85) |
| 1536×864 (1920×1080 @125 %) | 1184×824 | spread, compact bar, qfs **22.75** |
| 1920×1080 | 1568×1040 | spread, bar, qfs **28.75** |
| 1920×1080, sidebar closed | 1868×1040 | spread, side dock, qfs **31.5** |
| 1536×864, sidebar open, side pane open (S32) | 784×824 (pane docked, §9.6) | single, compact bar, qfs **22.75** |
| 1024×700 (S29) | 672×660 | single, compact bar, fit 17.65 → qfs **18** (QFS_MIN), vertical scroll |

Per-style tunables (`src/lib/mushaf/metrics.ts`, WP8b; data-driven, §12.6):

| Style | font-family | `--glyph-scale` | `--center-gap` (em) | notes |
|---|---|---|---|---|
| `qcf_v2` | `qcf-v2-p{N}` | measured | 0.12 | natural line ≈ 15.5–16.0 em (FACT §4.1) |
| `qcf_v4` | `qcf-v4-p{N}` | measured | 0.12 | natural line ≈ 16.2–16.5 em |
| `qcf_v1` | `qcf-v1-p{N}` | measured | 0.14 | natural 12–17 em |
| `hafs` (also the fallback rendition) | `qd-hafs` | measured | 0.30 | shaped Unicode |

**`--glyph-scale` is set from data, not by eye:** `glyphScale = floor2(16.5 / p99(natural line width in em over all 604
pages))`, measured per style by the one-off script `scripts/measure-glyph-scale.mjs` (WP8b; Playwright against `pnpm dev:web`
with all page fonts fetched locally by `cargo xtask fetch-dev-packs --all-pages`, gitignored, never committed). The result and
the measurement date are recorded in `metrics.ts`. Target: ≥ 99 % of lines fit at `--fit ≥ 0.98`.

### 8.3 DOM per page
```html
<section class="mp" data-page="262" data-side="right|left" data-style="qcf_v2" data-layout="v2"
         data-opening="(pages 1–2 only)" aria-roledescription="page" aria-label="Page 262 · Al-Ḥijr · Juz 14">
  <div class="mp-paper"></div>                               <!-- cream paper, radius-page, page shadow, spine shading, edge stack -->
  <svg class="mp-frame" aria-hidden="true">…</svg>            <!-- §8.9 -->
  <header class="mp-head" aria-hidden="true"><span class="mp-head-surah">سورة الحجر</span><span class="mp-head-juz">…</span></header>
  <div class="mp-block" dir="rtl" lang="ar">                 <!-- TB_W × TB_H; position: relative -->
    <div class="mp-hl" aria-hidden="true">…rects…</div>      <!-- §8.7, z 1 -->
    <div class="mp-glyphs quran-text" data-rendition="qcf|fallback" data-r="17" aria-hidden="true"
         style="--glyph-family: 'qcf-v2-p262'; --glyph-scale: 1; --center-gap: 0.12">   <!-- z 2; 1 or 2 layers -->
      <div class="ln" data-l="1" data-k="surah_name" style="--l:1"> …SurahHeader… </div>
      <div class="ln" data-l="2" data-k="basmallah" style="--l:2"> …Basmala… </div>
      <div class="ln" data-l="3" data-k="ayah" data-c style="--l:3; --fx:1; --fy:1">
        <div class="lw">
          <span class="w" data-w="23101" data-a="1802">ﱁ</span> … <span class="w e" data-w="23109" data-a="1802">ﱅ</span>
        </div>
      </div> …
    </div>
    <ol class="mp-a11y sr-only">…</ol>                       <!-- §8.15 -->
  </div>
  <div class="mp-margin" aria-hidden="true">…markers + marks…</div>   <!-- §8.9 -->
  <footer class="mp-foot" aria-hidden="true">٢٦٢</footer>
</section>
```
- Words are plain elements in one component (`GlyphLayer.svelte`, WP8a), keyed by word id. There is **no per-word Svelte
  component and no per-word `$derived`**.
- `.e` marks end-marker words. Glyph text is the whole `glyph` string (1–4 chars, FACT C5) in one span.
- Interaction uses delegation on `.mp-glyphs` (`pointerover`, `pointermove`, `mousedown`, `click`, `dblclick`,
  `contextmenu`), installed by the `interactions.ts` action (WP8d), and reads `data-w` and `data-a`.
- `.quran-text` (§9.3) protects all Quran text from inherited weight, letter-spacing and synthesis.

### 8.4 Line CSS (justification, centred lines, line-fit)
```css
.mp { --lh: calc(var(--qfs) * 1.75); position: relative; contain: layout paint style;
      width: calc(var(--qfs) * 21); height: calc(var(--qfs) * 31.95); }
.mp-block { position: absolute; width: calc(var(--qfs) * 16.5); height: calc(var(--lh) * 15);
            top: calc(var(--qfs) * (0.60 + 1.40 + 0.85)); }
.mp[data-side="right"] .mp-block { right: calc(var(--qfs) * (1.90 + 0.85)); }  /* physical-ok: outer margin on the right */
.mp[data-side="left"]  .mp-block { left:  calc(var(--qfs) * (1.90 + 0.85)); }  /* physical-ok */
.mp-glyphs { position: absolute; inset: 0; z-index: 2; color: var(--ink); transition: opacity var(--dur-glyph-swap) linear; }
.ln { position: absolute; inset-inline: 0; top: calc(var(--lh) * (var(--l) - 1)); height: var(--lh);
      display: flex; justify-content: center; align-items: center;          /* centres .lw even when it overflows */
      font-family: var(--glyph-family); font-size: calc(var(--qfs) * var(--glyph-scale));
      line-height: 1; white-space: nowrap; direction: rtl; }
.lw { flex: none; display: flex; justify-content: space-between; align-items: center;
      width: max-content; min-width: 100%; transform: scale(var(--fx, 1), var(--fy, 1)); transform-origin: 50% 50%; }
.ln[data-c] .lw { justify-content: center; column-gap: calc(1em * var(--center-gap)); min-width: 0; }
.w { display: inline-block; white-space: nowrap; }
.mp[data-opening] .ln { top: calc(var(--lh) * (var(--l) - 1 + 3.5)); inset-inline: calc(var(--qfs) * 2.2); } /* 8 lines, centred block */
.mp[data-style="qcf_v4"] .lw { font-palette: --qd-v4; }
```
- **Justification:** `space-between` with no space characters between words (V2/V4 have no space glyph; FACT §4.1).
- **Centred lines:** `centered = 1` from the layout.
- **Line-fit (bounded):** run `fitLines(rendition)` once per rendition, after its font is ready, in one rAF. Read every
  `.lw.offsetWidth` and `.ln.clientWidth` first, then write for all lines (no interleaved reads and writes), with
  `fit = min(1, ln/lw)`:
  - `fit ≥ 0.96`: `--fx = fit`, `--fy = 1` (horizontal-only squeeze, invisible at ≤ 4 %);
  - `fit < 0.96`: `--fx = --fy = fit` (uniform scale centred in the fixed line box; letterforms keep their proportions and the
    line box doesn't change, so CLS stays 0). Horizontally squashed calligraphy (thin verticals, crowded harakat) is never
    produced; printed Mushafs never do it.
  Transforms don't affect layout, so this can't shift anything. Lines with `fit < 0.98` are logged at debug (tuning signal).
  Gate (§12.6): no rendered line has `--fx < 0.96` with `--fy = 1`; run on S11 (V1 p600) and a hafs sweep of 50 pages.

### 8.5 Fonts: registry, transport, swap, LRU, prefetch (WP8b)
- **Bundled:** `@font-face { font-family: "qd-hafs"; src: url("/fonts/KFGQPC-Hafs-V30.ttf") format("truetype"); font-display: block; }`.
  `main.ts` awaits `document.fonts.load('32px "qd-hafs"', 'بسم')` before mounting, and the window is shown only after first paint
  (`windowReady`). The user never sees a system-font flash. **(v1.2, LEAD 25)** A second bundled face,
  `@font-face { font-family: "qd-print-labels"; src: url("/fonts/QuranPrintLabels.otf") format("opentype"); font-display: block; }`
  (the 1441H print's running heads and margin labels, §8.9), is awaited the same way, in parallel; `fonts.printLabelsReady`
  records whether it loaded.
- **Page fonts:** family `qcf-{v1|v2|v4}-p{N}`. By transport (D30, `AppInfo.fontTransport`):
  - `url`: `new FontFace(family, \`url("${status.url}") format("woff2")\`, { display: 'block' })`;
  - `bytes`: `new FontFace(family, await fontBytes(status.rel), { display: 'block' })` (raw IPC, no CORS, §5.16);
  then `document.fonts.add(face)` → `await face.load()`.
- **Decor:** `qd-surah-header`, `qd-quran-common`, `qd-sura-names`, loaded when `DecorStatus.installed` (same transport rule).
- **First render of page P in style S:**
  - (a) `fonts.isReady(S,P)` → render the QCF rendition directly.
  - (b) Else call `fonts.ensure(S,[P],'interactive')` and wait **up to 120 ms**. A file already on disk resolves in a few ms →
    render QCF directly.
  - (c) Else render the **fallback rendition** (glyph = `text`, family `qd-hafs`, hafs metrics) in the same line boxes. When the
    font becomes ready, mount a second `.mp-glyphs` (`opacity: 0`), run `fitLines` and `measure` on it, then cross-fade (new
    0→1, old 1→0, `--dur-glyph-swap: 180ms`; 0 ms under reduced motion) and unmount the old layer (`RenditionStack.svelte`).
- **LRU:** at most 24 faces per style. Evict the least-recently-displayed faces that are not within the visible pages ±2, via
  `document.fonts.delete(face)`.
- **Prefetch:** at the first idle after a page settles, call `pages.prefetch` and `fonts.ensure(S, around, 'prefetch')` for
  P−2..P+2 (single page) or P−4..P+5 (spread), clamped to 1..604, then `load()` every face that is `Ready` (a local file load is
  cheap). While flipping (§8.11), prefetch ±8 in the flip direction.
- **Style change:** keep the page. Ensure the new style's font. A style change counts as a "swap": the same cross-fade as (c),
  from the old style to the new one.
- **Unavailable** (network not allowed or offline): the hafs fallback stays, with no error toast. The page footer shows a
  subtle "offline glyphs" dot with a tooltip (§9.8).
- **Failed** (download or integrity failure): the same dot, and its tooltip offers **Retry** (`fonts.retry(S,P)` →
  `mushafEnsurePageFonts(S,[P],'interactive')`).

### 8.6 V4 palettes (D14), ink, high contrast and the COLR support probe (WP8b)
`src/lib/mushaf/palettes.ts`:
```ts
export function paletteRule(families: string[], theme: ResolvedTheme, tajweed: boolean, inkRgb: string, contrastMore: boolean): string;
// base-palette — tajweed: paper 0, sepia 2, night 1, black 1, high_contrast 0 (+ HC overrides);  plain: paper 3, sepia 5, night 4, black 4, high_contrast 3
// → `@font-palette-values --qd-v4 { font-family: "qcf-v4-p1", "qcf-v4-p262"; base-palette: 1; override-colors: 0 rgb(220 215 205); }`
```
- Entry 0 (base ink) is overridden with the theme's resolved **opaque** ink, so night ink brightness and high contrast apply to
  V4. `--ink` is opaque in every theme: night/black precomposite it as
  `--ink: color-mix(in srgb, #e9e4d8 calc(var(--ink-alpha) * 100%), var(--surface-page))` (a translucent ink composited twice
  where glyph parts or COLR layers overlap, showing seams). `inkRgb` is resolved through a hidden probe element
  (`color: var(--ink)` → `getComputedStyle(el).color`), because `var()` is invalid inside `@font-palette-values`.
- **High contrast** (`high_contrast` theme, or `prefers-contrast: more` in any theme) with tajweed on: base palette 0 (light)
  or 1 (HC dark) plus `override-colors` that keep each rule's hue at ≥ 4.5:1 on the page: entries 1, 2 → #595959;
  3, 9 → #b00000; 4 → #a34a00; 5 → #7a5c00; 6 → #1b6b00; 7 → #2a32b8; 8 → #00627a (light); for HC dark the palette-1 entries
  are kept and entry 0 → #ffffff. With tajweed off: palette 3 (light) / 4 (dark). (Palette 0 on white is only 2.3–2.9:1.)
- The rule is written into `<style id="qd-v4-palettes">` whenever the loaded V4 family set, the resolved theme,
  `tajweedColors`, `inkBrightnessPct` or the contrast preference changes (CSP: §6.4).
- **COLR probe** (FACT §8.4; also covers the Safari 17.0–17.1 COLRv0 regression): after the first V4 face loads, draw the
  page's **first ayah-end glyph** (`code_v2` of an `is_end` word), which uses CPAL entries 10–13 (the ayah-marker colours, high
  chroma in all six palettes, e.g. palette 0 `#2ca4ab`, `#ff0080`), at 48 px on a 64×64 `OffscreenCanvas`
  (`ctx.font = '48px "qcf-v4-p{N}"'`; canvas renders palette 0). Set `fonts.v4Supported = true` **only if** some pixel has
  `alpha > 128` and `max(r,g,b) − min(r,g,b) > 48`; otherwise `false`, switch `mushafStyle` to `qcf_v2`, and show a one-time
  toast (i18n `mushaf.v4Unsupported`). (Probing an arbitrary glyph was wrong: many V4 glyphs use only entry 0, black.) The
  result is cached in `localStorage` keyed by `AppInfo.webviewVersion` (wrapped in try/catch); the probe re-runs when the
  webview version changes.
- `inkBrightnessPct` ranges 65–100 (§5.11): with highlight fills also multiplied by `--ink-alpha` (§8.7), the worst case at
  65 % is 4.6:1 (night) and 5.5:1 (black). Verified on S10 at ink 65 and 100.

### 8.7 Highlight layers (behind glyphs; WP8d)
`.mp-hl { position: absolute; inset: 0; z-index: 1; contain: strict; pointer-events: none; }`. Children are absolutely
positioned `div.hl` rects. States are separated **by shape**, and **at most one fill is drawn per word**. Bottom → top:

| # | Layer | Source | Shape | Token |
|---|---|---|---|---|
| 1 | user highlights | `UserMarks.highlights` | ayah pills (fill) | `--user-hl-{yellow,green,blue,red,purple}` |
| 2 | search hit | `reader.searchHit` | word pills: 18 % fill + a 0.10·qfs underline bar at the pill bottom | `--hl-search`, `--hl-search-solid` (+ 2 × 600 ms pulse on arrival) |
| 3 | selection | `reader.selection` | ayah pills: **ring** `box-shadow: inset 0 0 0 max(1px, calc(var(--qfs) * 0.05)) var(--accent)` + 6 % fill | `--hl-selection-ring`, `--hl-selection` |
| 4 | hover | `reader.hover` (if `hoverHighlight`) | ayah pills, 120 ms fade, **neutral** (not accent) | `--hl-hover` |
| 5 | audio ayah | `player.currentAyahId` | ayah pills, 150 ms cross-fade between ayahs | `--hl-audio` |
| 6 | audio word | `player.activeWord` (if `wordHighlight`) | single pill, Spring glide, **opaque** (replaces fills beneath it) | `--hl-word` |
| 7 | cursor / focus ring | `reader.cursorAyahId` when DOM focus is on the roving item | outline only, 2 px | `--focus-ring` |

- **One fill per word.** When a state fill (search, selection, audio ayah, audio word) covers a word, any user highlight on it
  is drawn instead as a 0.08·qfs bar at the bottom of that word's pill in `--user-hl-{color}-solid`; the user-highlight fill is
  clipped out for that word.
- **Bookmarks are not a fill** any more (an 18 % grey fill was invisible on cream and read as a stain): ayah and page
  bookmarks, notes and the reading bookmark are margin marks (§8.9).
- **Dark themes:** night/black use explicit user-highlight alphas (yellow .18, green .22, blue .24, red .24, purple .26),
  and **every** highlight alpha is multiplied by `--ink-alpha` (§9.2).
- Contrast test (WP8d unit, tokens from WP7a): for each theme × accent × ink 65/88/100, glyph ink is ≥ 4.5:1 on every allowed
  composite (page + at most one fill + bars), and the selection ring is ≥ 3:1 against the page.

Geometry (`src/lib/mushaf/layout.ts`):
```ts
export interface WordBox { id: number; ayahId: number; line: number; x: number; y: number; w: number; h: number; } // px rel. to .mp-block
export function measure(rendition: HTMLElement, block: HTMLElement): WordBox[];          // one batch of getBoundingClientRect
export function ayahPills(boxes: WordBox[], ayahFrom: number, ayahTo: number, lh: number, blockW: number): Rect[];
export function wordPill(box: WordBox, qfs: number, lh: number): Rect;
```
- **Measure:** once per rendition after `fitLines`, and again on `qfs` change. The values include the line-fit transforms. This is
  the only layout read in the renderer.
- **Ayah pill**, per line: x from the min x to the max x+w of the range's words on that line. Each side is extended by half the gap
  to the neighbouring word if that word belongs to another ayah, or to the line edge if there is none. y = line top + 0.12·LH,
  height = 0.76·LH, radius = 0.28·qfs.
- **Word pill:** the word box expanded by 0.10·qfs horizontally, the same vertical band, radius 0.24·qfs.
- **Glide** (`HighlightLayer.svelte`): `const glide = new Spring({x,y,w,h}, { stiffness: 0.22, damping: 0.78 })`.
  - Same line as before → `glide.target = rect`.
  - New line or page → `glide.set(rect, { instant: true })`.
  - Reduced motion → always instant.
  - Rendered as `transform: translate3d(x px, y px, 0); width; height` on one element. `will-change: transform` is set only
    while playing.
- **forced-colors:** fills become transparent with `outline: 2px solid Highlight`, and the audio word uses `outline-color: Mark`.

### 8.8 Surah header and basmala lines (WP8c)
- **`surah_name` line.**
  - Decor installed, `ornateHeaders` on (**v1.2**: the setting, or the page's `ornaments` prop, gates every decor
    ornament on the page: header, basmala, margin ornaments; the print's running heads and rub labels, LEAD 25, are
    not decor) and `header_cp` present:
    `<span class="sh" style="font-family:qd-surah-header">` with
    `String.fromCodePoint(header_cp)`. Font size `calc(var(--qfs) * var(--sh-scale))` (tunable, start at 1.55), colour
    `--surah-header-ink`, centred.
  - Fallback (the plain look: decor not installed, or `ornateHeaders` off; an offline first run reads hafs without
    decor): **one reviewed SVG**,
    `SurahCartouche.svelte` (original artwork, `src/lib/mushaf/ornaments.ts`), 16.5 × 1.55 qfs (`viewBox="0 0 1650 155"`):
    an ogee-ended body with three nested strokes (0.06 / 0.02 / 0.02·qfs) in `--frame-gold`, fill `--cartouche-fill`; end
    medallions of 1.1·qfs carrying the 8-point star (two squares at 45°) in `--frame-green` with a 20 % gold fill; centred
    `سُورَةُ {name_ar}` in `qd-hafs` at 0.85·qfs, `--ink`.
- **`basmallah` line.**
  - Decor installed and `ornateHeaders` on: `qd-quran-common` U+FDFD at `--basmala-scale` (tunable ≈ 1.25).
  - Fallback: the Unicode `بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ` in `qd-hafs` at 0.95 qfs, centred.
- Header lines are part of the line grid. **Clicking a surah header opens `SurahInfoPopover`**: revelation place and order,
  ayah count, page range, "Play surah" and "Download recitation". Hover on a header uses the neutral hover tint for ayah 1.
  The audio basmala segment highlights the basmala line with `--hl-audio`.
- WP8c acceptance includes **lead sign-off on S03** (the hafs, no-decor spread: the first-run look when it was signed off;
  v1.2: the plain look, since an online first run preselects the 1421 AH print with its ornaments).

### 8.9 Page frame, running heads, footer, margin markers and marks (WP8c)
- **`PageFrame.svelte`** draws an SVG sized in px (`pw = PW·qfs`, `ph = PH·qfs`), regenerated on `qfs` change (memoised):
  - outer rule: 0.09·qfs stroke, `--frame-gold`
  - inner rule: `max(1px, 0.04·qfs)`, `--frame-gold`
  - **band** between the rules: 0.32·qfs wide, filled with an original SVG `<pattern>` tile (0.32 × 0.32 qfs, a four-petal
    interlace in `--frame-gold`, stroke 0.018·qfs) on `--frame-band`
  - **corner blocks:** 0.85·qfs squares holding an 8-point khatam (two squares at 45°) in a `--frame-green` stroke with a 20 %
    gold fill
  - `showPageFrame = false` hides the SVG (geometry unchanged)
  - **Opening pages (1–2):** an arched (ogee-topped) medallion around the 8-line block with 12 small rosettes; the running heads
    are hidden on pages 1–2 (WP8c verifies both against a print scan and records the result in `docs/deviations/WP8c.md`).
- **Page-stack edges:** in a spread, each outer paper edge gets 1–5 hairlines (`--border`, 1 px, 1.5 px apart) proportional to
  the pages on that side: right = `page / 604`, left = `(604 − page) / 604`.
- **Running head** (`HEAD` band, `--font-naskh`, `--text-muted`), font-size `max(0.5·qfs, 12px)`:
  - right: `سورة {name_ar of info.headSurah}`
  - left: juz: `الجزء {mushafNum(juz)}`. (v1.2: no decor glyph here any more; see below.)
  - At `qfs < 20` the heads drop the `سورة` / `الجزء` prefixes. When margin labels are glyph-only (below), the quarter of a
    rub starting on the page is appended on the same line (e.g. `الجزء ١٤ · ثلاثة أرباع الحزب ٢٧`, v1.2).
  - **(v1.2, LEAD 25)** From `qfs` 20, with the bundled `qd-print-labels` face loaded, both heads are the print's own
    calligraphy at the print's proportion (1.7·qfs, baseline 0.5·qfs above the frame): U+F600 + `headSurah`
    («سُورَةُ name») and U+F700 + juz («الجُزۡءُ …», the ordinal in words); the quarter is the face's fraction word,
    «الحِزۡبُ» and digits as an RTL flex row. Bundled print furniture, not decor: drawn whatever `ornateHeaders` says.
    The text above is its fallback (and the compact form below `qfs` 20).
  - Hidden when `showRunningHeads = false`.
- **Footer:** the page number in Eastern Arabic numbers (`Intl.NumberFormat('ar-u-nu-arab')`), centred in a 1.1·qfs
  medallion (**v1.2:** a 12-lobed SVG rosette whose whole interior carries the 10 % `--frame-gold` tint: the fill of the
  outline path itself, no separate disc), `max(0.55·qfs, 12px)` `--font-naskh`.
- **Margin markers** (`MarginMarkers.svelte`, outer margin `M_OUT`), for each `PageAyah`, colour **`--marker-ink`** (§9.2;
  `--frame-green` is decorative only and fails text contrast in dark themes):
  - rub start (`flags & 1`, mushaf-source rub, D6): ۞ U+06DE in `qd-hafs` at `max(0.95·qfs, 14px)`, or `qd-quran-common`
    U+FC23 (hizb start) / U+FC22 (other quarters) when decor is installed.
  - **(v1.2, LEAD 17)** A quarter whose first word carries the printed inline ۞ (§4.2; 199 of 240, every one except ayah 1
    of a surah) draws its **label alone**, centred on the line, and nothing below qfs 28: never a second ۞ beside the
    inline one. Ornaments are drawn only with their labels, with the hizb number inside the frame (v1.2: a quarter's
    too); markers are sized by ink height (0.75·qfs) and sajda markers sit on the line where the ayah ends
    (IMPLEMENTATION_NOTES §10.4).
  - Label underneath, `font-size: max(0.36·qfs, 11px)`, **only when `0.36·qfs ≥ 10` (qfs ≥ 28)**: juz start → `الجزء N`;
    hizb start → `الحزب N`; else **(v1.2)** the quarter in words on two lines, `ربع`/`نصف`/`ثلاثة أرباع` over `الحزب N`
    (on one line it is wider than the margin; the tooltip keeps one line). Below that size the glyph is drawn alone; the
    label goes into its tooltip, the a11y text and the running head. **(v1.2, LEAD 25)** With the bundled
    `qd-print-labels` face loaded, a rub start's label is the print's own stacked glyph U+F800 + rub («رُبُع» / «الحِزۡبُ»
    / «٢٧»; «الجُزۡءُ ١٤» / «الحِزۡبُ ٢٧» at a juz start) at 1.7·qfs, in a box as tall as the ink of its kind of label;
    the Hafs words remain its fallback and its tooltip.
  - sajda: ۩ U+06E9 plus `سجدة`, plus ` واجبة` for obligatory ones (same size rules).
  - Vertical centre = block top + (line − 1)·LH + LH/2. Markers on the same line stack with 0.2·qfs spacing.
  - Hidden when `showMarginMarkers = false`. Pointer cursor; click selects the ayah; tooltip shows the full label.
- **Margin marks** (`MarginMarks.svelte`), stacked after the markers on the ayah's first line with a 0.2·qfs gap, or
  centred on a line without markers and pushed down to 0.2·qfs below a taller stack from the line above (a juz start
  with its ornament and print label, about 3·qfs) (shown when `highlightBookmarks` — now "show bookmarks and notes in
  the margin"):
  - **Ayah bookmark:** a filled bookmark glyph, 0.55·qfs, `--accent`.
  - **Note:** a note glyph, 0.5·qfs, `--text-muted`; tooltip with the first 80 characters; click opens the side pane on the
    Notes tab.
  - **Reading bookmark:** a silk ribbon hanging from the top paper edge on the **spine side** of its page, width 0.55·qfs,
    reaching down to the ayah's line + 0.6·qfs with a V-notch tail, fill `--ribbon` with a 1 px darker edge and `shadow-1`.
    Click shows a popover "Reading bookmark · 2:255 · moved 3 days ago · Move here (Shift+B)". A move animates over 250 ms
    (instant under reduced motion).
  - **Page bookmark:** a 1.2·qfs dog-ear at the outer top corner in `--accent-soft`.
  - Scenario S33 covers all four marks in paper and night.
- **Sajda overline (hafs rendition only):** sajda words get `text-decoration: overline 0.05em var(--ink)`, *if* WP8c confirms
  against a print scan and the QCF rendering that the printed Mushaf overlines them; otherwise it is dropped (record in
  `docs/deviations/WP8c.md`).

### 8.10 Two-page spread, single page and book gutter (WP8e)
```css
.spread { display: flex; flex-direction: row; direction: rtl; justify-content: center; align-items: flex-start;
          gap: 0; view-transition-name: qd-spread; }
.spread .mp[data-side="right"] .mp-paper { border-radius: 0 var(--radius-page) var(--radius-page) 0; } /* physical-ok */
.spread .mp[data-side="left"]  .mp-paper { border-radius: var(--radius-page) 0 0 var(--radius-page); } /* physical-ok */
.mp-paper::after { content: ""; position: absolute; top: 0; bottom: 0; width: calc(var(--qfs) * 1.2); pointer-events: none; }
.mp[data-side="right"] .mp-paper::after { left: 0;  background: linear-gradient(to right, rgb(0 0 0 / var(--spine-a)), transparent); } /* physical-ok */
.mp[data-side="left"]  .mp-paper::after { right: 0; background: linear-gradient(to left,  rgb(0 0 0 / var(--spine-a)), transparent); } /* physical-ok */
/* single page: move the PAPER, not the text, so the text block stays put across page turns */
.single .mp[data-side="right"] { translate: calc(var(--qfs) * 0.5) 0; }    /* physical-ok */
.single .mp[data-side="left"]  { translate: calc(var(--qfs) * -0.5) 0; }   /* physical-ok */
```
- In a spread the odd page is on the **right** and the even page on the **left** (BRIEF). The anchor is the odd page:
  `visiblePages = [odd, odd + 1]`, and page 604 pairs with 603. DOM order is [odd, even] inside `direction: rtl`.
- In a spread, the right page has rounded outer (right) corners and square spine corners. The left page mirrors that.
  Single-page mode rounds all four corners.
- `--spine-a`: 0.10 in light themes, 0.35 in dark themes. A 1 px `--border` line marks the fold.
- Single-page mode uses `data-side = odd ? "right" : "left"`, so the outer margin keeps its print position. Because
  `M_OUT ≠ M_IN`, the text block would otherwise jump sideways by `(M_OUT − M_IN)·qfs` (1.0·qfs: 22 px at qfs 22, 29 px at
  qfs 29) on every turn; the ±0.5·qfs paper translate (`SHIFT`, §8.2) keeps the block fixed, as a real book does, and `fitLayout`
  sizes single mode with `SINGLE_W = PW + 1.0`. Browser test (WP8e): `.mp-block` `getBoundingClientRect().x` is identical
  (±0.5 px) on pages 261 and 262 in single mode.

### 8.11 Page turns, flipping and page navigation affordances (WP8e, WP8f)
```ts
export async function turnTo(page: number, dir: 'next' | 'prev', opts?: { instant?: boolean }): Promise<void> {
  const animate = !opts?.instant && settings.value.pageTurnAnimation && !settings.reducedMotion && 'startViewTransition' in document;
  await Promise.race([readyForInstantRender(page), sleep(120)]);           // PageData + font (§8.5)
  if (!animate || !isInstantReady(page)) { reader.setPageNow(page); return; }
  document.documentElement.dataset.turn = dir;
  const vt = document.startViewTransition(async () => { reader.setPageNow(page); await tick(); });
  try { await vt.finished; } finally { delete document.documentElement.dataset.turn; }
}
```
```css
:root { view-transition-name: none; }        /* only the spread animates; title-bar breadcrumbs update instantly */
/* staggered, never a 50 % double exposure of two calligraphy pages */
html[data-turn]::view-transition-old(qd-spread) { animation: 110ms var(--ease-accelerate) both var(--qd-out); }
html[data-turn]::view-transition-new(qd-spread) { animation: 180ms var(--ease-decelerate) 80ms both var(--qd-in); }
html[data-turn="next"] { --qd-out: qd-out-right; --qd-in: qd-in-left; }   /* RTL book: next page enters from the left */
html[data-turn="prev"] { --qd-out: qd-out-left;  --qd-in: qd-in-right; }
@keyframes qd-out-right { to   { opacity: 0; transform: translateX(1.5%); } }
@keyframes qd-in-left   { from { opacity: 0; transform: translateX(-1.5%); } }
@keyframes qd-out-left  { to   { opacity: 0; transform: translateX(-1.5%); } }
@keyframes qd-in-right  { from { opacity: 0; transform: translateX(1.5%); } }
```
- `--dur-page` = 260 ms total (old 0–110 ms, new 80–260 ms). Under reduced motion there is no view transition.
- **Flipping (key repeat).** Page-turn shortcut defs are `repeat: true`. Repeat events call `reader.flip(dir)`, which skips the
  view transition and renders instantly (fallback rendition if the font isn't ready), throttled to **1 page per 70 ms**, with
  prefetch extended to ±8 pages in the flip direction. Turning never queues more than one pending page.
- **`FlipHUD`** (WP8f): a chip in the canvas centre, e.g. `الحجر · ص ٢٦٢ · ج ١٤` in Naskh 18 px on `--surface-overlay`,
  shown while flipping or dragging the rail, fading out 600 ms after the last flip (instant under reduced motion).
- **`PageRail`** (WP8f): a 28 px strip revealed by hovering the bottom 24 px of the canvas (outside the dock) or by `P`.
  604 steps laid out **right-to-left** (page 1 on the right, book semantics, never mirrored), 30 juz ticks with Arabic-Indic
  labels on hover, and a live label "surah · page · juz". Dragging only previews (FlipHUD); release navigates with a single
  turn. A focused rail is `role=slider` (`aria-valuetext` "Page 262, Al-Ḥijr, Juz 14") and takes ←/→ for ±1 page (← = next,
  book semantics) and Shift for ±10.
- **`PageTurnZones`** (WP8f): two zones, 56 px wide and full canvas height, in the canvas space outside the paper (narrowed to
  the free space when less, never covering the text block). The **left** zone means next page and the **right** zone previous,
  in physical book order, never mirrored. Each shows a 40 px circular chevron (`--surface-raised`, `shadow-1`) at opacity 0,
  60 % while the pointer is over the canvas and 100 % over the zone, or (v1.2) while a drag on the page would turn to it on
  release (§8.13). They carry `aria-label` "Next page"/"Previous page", come after the pages in tab order, and stay hidden
  in zen mode until the pointer moves.
- **First-run hint** (WP8f `HintChip`): once (`settings.hintsSeen` gets `"page_turn"`), "Scroll, swipe or press ← → to turn
  pages".

### 8.12 Follow-along (WP8e)
`reader.init()` installs an `$effect` that runs when `settings.followAlong && player.isActive`:
- **Target page.** Use the page of `player.activeWord.wordId` (layout-specific `pageOfWord`). Without word timings, use the page of
  `currentAyahId`'s first word. For a basmala segment, use the page of that surah's ayah 1.
- **Turn.** If the target page is not in `visiblePages`, call `turnTo(target, target > page ? 'next' : 'prev')`.
- **Manual override.** If the user navigated manually in the last 4 s, don't turn. Show `FollowChip` "Return to recitation" in
  the canvas overlay slot instead (click → turn, Esc → dismiss).
- **Division arrival** (WP8f `DivisionChip`): when reading or follow-along first enters a new juz (or hizb), show
  `بداية الجزء الخامس عشر · Juz 15` for 2.5 s and announce it politely.

### 8.13 Zoom, wheel and drag (WP8e, `src/lib/mushaf/wheel.ts`, `src/lib/mushaf/pan.ts`, `ZoomControl.svelte`)
- `Mod+wheel` and touchpad pinch (which arrives as Ctrl+wheel) call `reader.zoomAt(±10, clientX, clientY)` (step 10 %, 50–300 %).
- Anchor: after `qfs` changes, set `scroll = (scroll + pointer) × qfs'/qfs − pointer` on both axes, so the point under the cursor
  stays put.
- `Mod+=`, `Mod+-` and `Mod+0` work the same around the canvas centre. (UI scale has its own keys, §10.1.)
- **Zoom control (v1.2, `ZoomControl`).** Zoom without the wheel: a vertical glass capsule (40 × 92 px, `--glass-fill`,
  `shadow-2`) in the canvas's **top inline-end corner** (top right in the English UI, top left in the Arabic UI), 16 px
  from the top and 12 px from the edge (clear of the overlay scrollbars), outside the scroll viewport.
  - **Buttons**, top to bottom: **+** (`reader.zoomIn()`), **the level** ("120%", UI digits; a click is
    `reader.zoomReset()`, back to the fit), **−** (`reader.zoomOut()`), all around the canvas centre like the keys.
    Tooltips point into the canvas and show the keys (`view.zoomIn` / `view.zoomFit` / `view.zoomOut`, as bound). The
    button that would do nothing (+ at 300 %, the level at 100 %, − at 50 %) is `aria-disabled`, keeping focus; at the
    fit the level stays a full-opacity readout. Names: "Zoom in", "Zoom 120%, fit to window", "Zoom out".
  - **Clear of the page.** Every fit leaves at least `PAD_X + M_OUT·qfs` ≥ 24 + 1.9 × 18 = 58 px between the canvas edge
    and the running head or the text; the capsule ends 52 px in, so at the fit it covers neither, in any dock mode. With
    the side card it sits in the card's reserved column, above the card; the rail, dock, slot, follow chip and toasts
    are at the bottom, the zen hint and top toasts centred, the turn-zone chevrons at the book's middle (it may cover
    the top of a full-height zone's column, never its chevron).
  - **Look.** Always present while the Mushaf shows, quiet at rest: 40 % with the pointer off the canvas, 60 % over it
    (as the turn-zone chevrons, §8.11), 100 % hovered, keyboard-focused, or for 0.9 s after any zoom (wheel, pinch,
    keys, palette, Settings): it is the zoom readout, and the change is announced ("Zoom 120%"). **Yield:** when the
    text block, a running head, a dog-ear, the ribbon or a margin marker/mark lies within 4 px of it (a zoomed or
    scrolled book, a dog-ear in the tightest fit), it is hidden and click-through until the pointer comes within 24 px
    of it, it takes focus or a zoom wakes it; a held press (a drag) never brings it back. Measured in one frame after
    a resize, scroll, turn or late mark, never while flipping.
  - **Zen** (§9.6): hidden until the pointer moves, and again while it rests (`ui.pointerIdle`); it moves down by
    `ZEN_TOP_ZONE_PX`, so reaching for it never reveals the title bar.
  - **Keys and pointer.** `role="toolbar"` (`aria-orientation="vertical"`), one tab stop after the pages, the turn
    zones, the rail and the slot's chips; ↑/↓ and Home/End move, Enter/Space press, Escape returns focus to the reading
    cursor (consumed: the selection stays). A pointer press never takes focus (← → keep turning pages). A plain wheel
    over it scrolls a zoomed canvas (`forwardWheel`) and turns the page while it fits; `Mod`+wheel zooms at the
    pointer. It replaces WP8e's transient top-centre zoom indicator.
- **Plain wheel when the page fits:**
  - Normalise `deltaMode`: lines × 16 px, pages × canvas height.
  - A **gesture** ends after 160 ms with no wheel events; one gesture turns **at most one page** (touchpad and free-spin
    inertia streams last 600–1200 ms and used to double-turn).
  - `deltaY > 0` (scroll down) means next page; thresholds per gesture: 120 px vertical, 80 px horizontal; swiping right
    (`deltaX < 0`) means next page (RTL book). A 400 ms floor between turns remains.
- When zoomed past fit, or when the canvas scrolls because `qfs` hit `QFS_MIN`, the wheel scrolls.
- **Drag (v1.2, `pan.ts`).** A left-button press of the mouse or a pen on the book or its margins (inside the scroll
  viewport; the turn zones, the rail, the chips and the scrollbars are outside it) is a click until it travels past the
  slop, then a drag. Touch stays native; another button, a non-primary pointer, macOS Ctrl+click and a press while a
  layer is open never arm one. The mode is fixed at the press from the zoom:
  - **≤ 100 % (the fit or below): swipe.** A horizontal-dominant drag turns one page **on release** with ≥ 80 px of
    travel (the wheel's horizontal threshold) or a flick of ≥ 30 px within 250 ms; dragging right is the next page (RTL
    book, never mirrored by the UI language), through `reader.next()` / `reader.prev()` (animated like a turn-zone
    click). Dragging back before the release cancels; one drag turns at most one page. While the canvas still scrolls
    at the fit (`QFS_MIN`), a drag that sets off vertical-dominant pans vertically instead. Slop 8 px, so a shaky click
    on a word still selects its ayah. No rubber band: the cursor (`grabbing`) and the lit chevron of the zone the
    release turns to (§8.11) are the feedback.
  - **> 100 %: pan.** The canvas follows the pointer on both axes (`scrollBy`, physical, one per frame, no inertia).
    Slop 4 px. Cursor `grab` over the zoomed book, `grabbing` while dragging.
  - Pointer capture is taken only past the slop. The click (and dblclick) dispatched with a drag's release is swallowed
    at `window` for that task, so no word, header, marker, mark or blank-canvas clear takes it. Escape (consumed, so the
    reader keeps its selection), a context menu, a pointercancel, a lost capture, the window's blur or a layer opening
    cancel a drag without a turn.

### 8.14 Copy and native selection (WP8e copy, WP8d pointer handling)
- **Handler.** A `copy` listener on `MushafView`. If the selection intersects `.mp-glyphs`:
  1. Collect the intersecting `[data-w]` spans via `range.intersectsNode`.
  2. Map them to PageData words and build the text with `buildCopyText(words, settings.copy, quran)` (`src/lib/mushaf/copy.ts`,
     same format as §5.5).
  3. Call `e.clipboardData.setData('text/plain', text)` and `e.preventDefault()`.
- **Result.** PUA glyph codes never reach the clipboard (BRIEF). `Mod+C` with no DOM selection copies the selected ayahs via
  `quranCopyText`.
- **Selection (v1.2).** No native text selection starts on the page: the canvas's scroll viewport and `.mp-glyphs` are
  `user-select: none` (with `-webkit-user-select` for WKWebView), because a left drag pans or turns the page (§8.13).
  Copy goes through the ayah selection (click, Shift+click, then `C`, `Mod+C`, the action bar's Copy or the context
  menu's Copy ▸); partial-ayah copy by drag-selection is gone. The handler above still serves a DOM selection that
  reaches the glyphs another way (programmatic, assistive technology). A press on the page collapses a DOM selection
  made elsewhere (`user-select: none` would not), so it never shadows `Mod+C`.
- A `mousedown` with `detail ≥ 2` inside `.mp-glyphs` calls `preventDefault()` and clears the DOM selection, so a double-click
  never flashes a native word selection over the PUA glyphs.

### 8.15 Accessibility, the reading cursor and focus (WP8d a11y, WP8e cursor)
- Every glyph layer is `aria-hidden="true"` (PUA codes read as nothing). Each page has a visually hidden
  `<ol class="mp-a11y sr-only">` with one `<li lang="ar" dir="rtl" id="a11y-{page}-{ayahId}">` per ayah segment on the page.
  - Its content is `toSpeech(text)` of the ayah's words on that page, followed by ` (٢٥٥)`. `toSpeech` (`src/lib/mushaf/a11y.ts`)
    maps U+06E1 → U+0652 (sukun), U+0671 → U+0627, U+06E5 → و, U+06E6 → ي, and strips U+06D6–U+06DC, U+06DD, U+06DE,
    U+06DF–U+06E4, U+06E7–U+06ED and U+08F0–U+08F2 (small high/low letters, waqf signs and marks that Arabic TTS reads as symbol
    names). No contract change. WP8d verifies with NVDA + OneCore Arabic and VoiceOver "Majed" on 1:1–7, 2:255 and 38:24 and
    records the result in `docs/deviations/WP8d.md` (folded into §12.6 by the lead).
  - A hidden span in the UI language carries the reference: `Al-Baqarah, ayah 255`, plus margin labels that are glyph-only
    (§8.9).
- **One reading cursor:** `reader.cursorAyahId`.
  - `ArrowDown`/`ArrowUp` and `J`/`K` are aliases: they move the cursor to the next/previous ayah (crossing pages turns the
    page) **and set the selection to that single ayah**. `Shift+Arrow` / `Shift+J/K` extends the selection. DOM focus follows to
    the roving `li` with `focus({ preventScroll: true })`; when zoomed, the ayah's pill rect is then scrolled into view.
  - `Home`/`End`: first/last ayah on the page. `Enter`: open the side pane for the selection. `Space`: play/pause.
    `Shift+F10` or `ContextMenu`: open the ayah menu.
  - A manual page turn clears a selection that lies entirely off the visible pages.
  - `B`, `N`, `C`, `Digit0`–`Digit5` and `Enter` act on `reader.actionTarget`: the visible selection, else the visible cursor,
    else the first visible ayah. Every resulting toast names the target ("Bookmarked 2:255").
  - Layer 7 (§8.7) draws the cursor ring while DOM focus is on a roving item.
- **Side-pane precedence:** an explicit selection pins the side pane to it until Esc or clear. While a selection pins it during
  playback, `AyahHeader` shows a "Follow recitation" chip that clears the pin (`reader.followRecitation()`). With no selection,
  the pane follows audio (`followSelectionOrAudio`).
- **Focus after jumps:** palette, Go to, search, bookmark and history jumps move focus to the target ayah's `li` once it renders
  and announce "Al-Baqarah 2:255, page 42" (§7.4).
- **Labels and announcements.**
  - Each page `<section>` is labelled (`aria-label`, the localised "Page {n} · {surah} · Juz {j}").
  - A "Skip to Quran text" link is the first tab stop in the app.
  - Landmarks (§7.5): `<nav aria-label="Sections">` (rail), `<aside>` (sidebar and side pane), `<main>` (canvas),
    `role=region aria-label="Recitation player"` (dock).
  - The polite live region announces "Page {n}" on page change. It announces "Reciting {ref}" on ayah change only when
    `settings.announceRecitation` is on (default off).
- **Media queries.** `prefers-reduced-motion` (or `motion = reduce`) sets every duration to 0 and makes glides instant.
  `forced-colors: active` turns ink into `CanvasText`, the frame into `CanvasText`, and highlights into outlines (§8.7).

### 8.16 Memorisation rendering (hide/peek; WP9b with WP8a's class hook)
- While `memo.active` is set, each word span with `memo.isHidden(id)` gets the class `.w-hid`, applied by a class map from the
  memo store, not per-word derivations (`src/styles/mushaf/memo.css`, WP9b).
  - `blur`: `filter: blur(calc(var(--qfs) * 0.16)); opacity: 0.55;` (the blur is never transitioned).
  - `blank`: `opacity: 0;`, plus a 0.06·qfs underline placeholder via `box-shadow: inset 0 -0.06em var(--text-faint)`.
  - Both work on COLR V4, because `color: transparent` doesn't hide COLR layers.
- **Peek:**
  - hovering a `.w-hid` word reveals it when `memoRevealOnHover` (`filter: none; opacity: 1`, 120 ms)
  - holding `Q` reveals all hidden words (`memo.peek(true/false)` on keydown/keyup)
  - `W` reveals the next word, `Shift+W` the next ayah (moves `revealedThrough`)
- **Self-test:** `memoTestStart` returns a random start ayah. The reader jumps there and hides from that ayah to `to`.
  `SelfTestBar` (in the MushafView overlay slot) shows "Recite from {ref}" with Reveal (W), Mistake (M) and Finish (rating 1–4).
- **Budget** (§8.18): hide mode on a spread stays ≤ 16 ms per frame while revealing with W. If WebKitGTK misses it, the Linux
  default for `memoHideStyle` becomes `blank` (`Settings::default_for(Platform::Linux)`, recorded as a deviation).

### 8.17 Word interactions, action bar and WBW tooltip (WP8d)
| Gesture | Action |
|---|---|
| hover word | `reader.setHover(ayahId, wordId)` (neutral hover tint). WBW tooltip only after the pointer has **moved ≥ 4 px onto a word and then dwelt 450 ms** with WBW enabled (a parked cursor never pops tooltips); hidden on any keydown, page turn, scroll or zoom |
| click | select the ayah (cursor moves there) and, after 120 ms, show the **AyahActionBar** (D26) |
| click on empty paper or canvas | clear the selection and hide the bar |
| Shift+click | extend the selection to this ayah |
| double-click | select and open the side pane (Translation tab) |
| Mod+click (Ctrl on Windows/Linux, ⌘ on macOS) | play from this ayah (`player.playFrom({ayahId})`); Alt+click is an alias on Windows and macOS only (Linux window managers take Alt+drag) |
| right-click | `AyahContextMenu` (§10.3) for the selection if it contains the ayah; (v1.2) otherwise the ayah is selected first (cursor moves there, Shift never extends), so the menu acts on the tinted span. The selection stays after the menu closes; no action bar |
| click the end-of-ayah marker | select the ayah and open the side pane (Tafsir tab) |
| drag, zoom ≤ 100 % | past 8 px it is no click; on release, ≥ 80 px horizontal (or a 30 px flick) turns one page, right = next (§8.13) |
| drag, zoom > 100 % | past 4 px it is no click; the canvas follows the pointer (§8.13) |

- **Cursor:** default over glyphs at the fit; `grab` over the zoomed book and `grabbing` during a drag; `pointer` only over end
  markers, header lines and margin markers/marks.
- **`WordTooltip`:** translation in UI font 14 px, transliteration italic 12 px muted, the word's `WbwEntry.text` in `qd-hafs`
  22 px (`.quran-text`), placed above the word pill (flips below near the top).
- **`AyahActionBar.svelte`** (D26; `settings.ayahActionBar`):
  - Appears 120 ms after a **pointer** click-selection (never on hover or keyboard focus). It anchors above the selection's
    first line, flips below near the page top, and never covers the selected words.
  - 36 px tall, `radius-full`, `--surface-raised`, `shadow-2`.
  - Buttons (IconButton 32): Play from here · Repeat ▾ · Bookmark (pressed state) · Highlight (inline 5 swatches + remove) ·
    Note · Copy · Translation/Tafsir (opens the side pane) · More (opens the context menu).
  - Dismissed on Esc, outside click, scroll or page turn. No fade under reduced motion.
  - Scenario S34.

### 8.18 Performance budget (enforced in e2e, §12.6)
| Metric | Budget |
|---|---|
| page render after data + font ready (`qd:page` measure) | < 16 ms p95 |
| page turn (key → new page painted, prefetched) | < 50 ms p95 (+ 260 ms animation) |
| flip (key repeat) | sustained 1 page / 70 ms with no frame > 32 ms |
| `measure()` per rendition | < 3 ms |
| cumulative layout shift over a 20-page session incl. font swaps and playback start | 0 |
| audio word glide | ≥ 58 fps average, no frame > 32 ms |
| memo hide on a spread while revealing (W) | ≤ 16 ms per frame |
| line-fit | no line with horizontal-only squeeze below 0.96 (S11 + 50-page hafs sweep) |
| long tasks (> 50 ms) during navigation | none |
| memory: FontFaces | ≤ 24 per style; PageCache ≤ 48 pages |

---

## 9. Design system (WP7a tokens, WP7b primitives, WP7c shell)

### 9.1 Token architecture
- `src/styles/tokens.css` declares `@layer reset, tokens, base, components, mushaf, utilities;`.
- Themes are `html[data-theme="paper|sepia|night|black|high_contrast"]` (high contrast also gets `data-hc="light|dark"`),
  accents are `html[data-accent="…"]`, and motion is `html[data-motion="reduce|full"]`.
- The `settings` store resolves `theme: system` through `matchMedia('(prefers-color-scheme: dark)')` to `lightVariant`
  (paper or sepia) or `darkVariant` (night or black). `high_contrast` resolves to `data-hc="dark"` when the OS prefers dark.
- Components use **semantic tokens only**, never raw hex values. Accent-coloured **text** always uses `--accent-text`, never
  `--accent`.

### 9.2 Colour tokens (exact values)
| Token | paper | sepia | night | black | high_contrast (light) |
|---|---|---|---|---|---|
| `color-scheme` | light | light | dark | dark | light |
| `--surface-app` | #f3efe6 | #e9dcc3 | #111315 | #000000 | #ffffff |
| `--surface-chrome` (title bar, rail, sidebar) | rgb(243 239 230 / 0.72)¹ | #e4d5b8 | rgb(17 19 21 / 0.70)¹ | #000000 | #ffffff |
| `--surface-page` | #fdf8ec | #f6ead2 | #1a1c1f | #000000 | #ffffff |
| `--surface-raised` | #ffffff | #fbf3e4 | #222529 | **#161616** | #ffffff |
| `--surface-sunken` (input wells, tracks only) | #ebe5d8 | #e2d3b6 | #0c0d0f | **#0a0a0a** | #f0f0f0 |
| `--surface-hover` (every list/row hover) | rgb(60 45 20 / 0.06) | rgb(70 45 10 / 0.07) | rgb(255 255 255 / 0.06) | rgb(255 255 255 / 0.08) | rgb(0 0 0 / 0.08) |
| `--surface-overlay` | rgb(255 255 255 / 0.86) | rgb(251 243 228 / 0.90) | rgb(34 37 41 / 0.86) | rgb(22 22 22 / 0.94) | #ffffff |
| `--ink` (Quran glyphs; always opaque, §8.6) | #1c1a16 | #2e2418 | color-mix(in srgb, #e9e4d8 calc(var(--ink-alpha) * 100%), var(--surface-page)) | same as night | #000000 |
| `--text` | #24211c | #3a2f22 | #e3ded2 | #d6d1c5 | #000000 |
| `--text-muted` | #6b6457 | **#695a45** | #a39d90 | #8f8a80 | #1a1a1a |
| `--text-faint` (decoration and disabled only, ≥ 3:1) | **#8b8273** | **#86755a** | **#736e65** | **#6b6761** | #3a3a3a |
| `--border` (decorative separators) | #e2dac9 | #dccaa8 | #2c3035 | **#2a2a2a** | #000000 |
| `--border-strong` | #cbbfa6 | #c7b08a | #3a3f45 | **#3d3d3d** | #000000 |
| `--border-input` (component boundaries, ≥ 3:1) | #908876 | #8b7b61 | #6b6f74 | #606060 | #000000 |
| `--frame-gold` | **#ac8a55** | #9c7638 | #8f7444 | #6e5a36 | #000000 |
| `--frame-green` (decorative only) | #2f6b5e | #4b5d3a | #3f8a7b | #2f6b5e | #000000 |
| `--marker-ink` (margin glyphs and labels) | #2f6b5e | #4b5d3a | #499082 | #4a7e73 | #000000 |
| `--ribbon` (reading bookmark) | #8c2f39 | #7d2a2a | #a34c54 | #854a4f | #000000 |
| `--frame-band` | rgb(176 141 87 / 0.08) | rgb(156 118 56 / 0.10) | rgb(143 116 68 / 0.10) | rgb(110 90 54 / 0.10) | transparent |
| `--cartouche-fill` | rgb(176 141 87 / 0.10) | rgb(156 118 56 / 0.12) | rgb(143 116 68 / 0.12) | rgb(110 90 54 / 0.14) | #ffffff |
| `--surah-header-ink` | #2f6b5e | #5a4128 | #c9b98f | #a8996f | #000000 |
| `--spine-a` | 0.10 | 0.12 | 0.35 | 0.5 | 0 |
| `--danger` | #b3261e | #a3361f | #f2827a | #f2827a | #a00000 |
| `--success` | #2e7d32 | #4b6b2a | #6fcf7a | #6fcf7a | #005a00 |
| `--warning` | #a86400 | #9a5a00 | #f0b24a | #f0b24a | #7a4a00 |
| `--focus-ring` | var(--accent) | var(--accent) | var(--accent-strong) | var(--accent-strong) | #0040c0 |

¹ Translucent chrome is used only when `html[data-chrome="vibrant"]` (Windows Mica / macOS sidebar active, §9.6). Otherwise use
the opaque value of `--surface-app`. `--ink-alpha` = `inkBrightnessPct / 100` (night and black only; range 0.65–1.0).

**High contrast, dark** (`data-hc="dark"`, used when the OS prefers dark): `--surface-page`/`--surface-app`/`--surface-raised`/
`--surface-sunken` #000000, `--ink` and `--text` #ffffff, `--text-muted` #e6e6e6, `--border`/`--border-strong`/`--border-input`
#ffffff, `--accent`, `--accent-text` and `--focus-ring` #ffd600 (`--accent-ink` #000000), every shadow `0 0 0 2px #ffffff`.

**Accents** (`html[data-accent]`; light value used for paper/sepia, dark value for night/black; high_contrast forces #0040c0,
or #ffd600 in HC dark):

| accent | light `--accent` | `--accent-text` paper | `--accent-text` sepia | dark `--accent` (= dark `--accent-text`) | `--accent-strong` (dark) |
|---|---|---|---|---|---|
| teal (default) | #1f7a6d | #1d7366 | #1a675c | #4fb8a8 | #6fd3c3 |
| emerald | #1e7b4a | #1d7547 | #1a693f | #4cc38a | #74dba7 |
| blue | #2563a8 | #2563a8 | #235e9f | #6ea8e8 | #92c0f2 |
| indigo | #4b4fae | #4b4fae | #4b4fae | #9196f0 | #b0b4f6 |
| rose | #b0405d | #af405d | #9d3953 | #ec8aa4 | #f3a9bc |
| amber | #9a6410 | #8e5c0f | #7f530d | #e3a948 | #efc275 |

`--accent-text` (links, Undo actions, tab labels, footnote markers, the active Segmented label) is the accent darkened until it
reaches ≥ 4.5:1 on that light theme's darkest text surface (`--surface-sunken`); values above were computed that way on
2026-10-10. `--accent-ink` (text on an accent fill) is #ffffff in light themes and #0b1513 in dark themes. Derived tokens:
```css
--accent-soft:        color-mix(in srgb, var(--accent) 12%, transparent);
--hl-hover:           color-mix(in srgb, var(--ink) 6%, transparent);                  /* neutral, never accent */
--hl-selection:       color-mix(in srgb, var(--accent) 6%, transparent);               /* + ring */
--hl-selection-ring:  var(--accent);                                                   /* ≥ 3:1 vs page: paper 4.88, sepia 4.34, night 7.12 */
--hl-audio:           color-mix(in srgb, var(--accent) 14%, transparent);
--hl-word:            color-mix(in srgb, var(--accent) 28%, var(--surface-page));      /* opaque: replaces fills beneath */
--hl-search:          rgb(232 176 32 / 0.18);
--hl-search-solid:    #c98a00;                                                         /* night/black: #e8b020 */
--user-hl-yellow: rgb(249 168 37 / 0.30);  --user-hl-green: rgb(46 125 50 / 0.24);  --user-hl-blue: rgb(21 101 192 / 0.22);
--user-hl-red:    rgb(198 40 40 / 0.20);   --user-hl-purple: rgb(106 27 154 / 0.20);
/* night/black: yellow .18, green .22, blue .24, red .24, purple .26 — and EVERY highlight alpha × var(--ink-alpha) */
--user-hl-yellow-solid: #f9a825; --user-hl-green-solid: #2e7d32; --user-hl-blue-solid: #1565c0; --user-hl-red-solid: #c62828; --user-hl-purple-solid: #6a1b9a;
```
`@media (prefers-contrast: more)` on any theme: `--text-muted: var(--text)`, `--border: var(--border-strong)`, highlight
alphas × 1.6, and V4 tajweed uses the high-contrast overrides (§8.6). `@media (forced-colors: active)`:
`--ink: CanvasText; --surface-page: Canvas; --focus-ring: Highlight`, and highlight fills become `transparent` with outlines.

**Contrast test** (`src/styles/tokens.test.ts`, WP7a; parses tokens.css): for all 5 themes (+ HC dark) and 6 accents,
- every text token (`--text`, `--text-muted`, `--accent-text`) ≥ 4.5:1 on every surface it is used on: app, chrome
  (composited over app), page, raised, sunken, hover (composited over raised), overlay (composited over page);
- `--accent-text` and `--accent-ink` on `--accent` ≥ 4.5:1;
- `--text-faint` ≥ 3:1 on its worst surface;
- non-text pairs ≥ 3:1: `--border-input` on app/raised/sunken/overlay, `--hl-selection-ring` on page, the Segmented active pill
  border, scrubber track outline and ticks (§9.7), `--marker-ink` on page (4.5:1, it carries text), `--ribbon` on page;
- the §8.7 highlight composites (WP8d extends the same harness).

### 9.3 Typography
```css
--font-latin:  "Inter Variable", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
--font-arabic: "IBM Plex Sans Arabic", "Noto Naskh Arabic Variable", "Segoe UI", system-ui, sans-serif;
--font-ui:     var(--font-latin), "IBM Plex Sans Arabic";                 /* html[lang="ar"]: var(--font-arabic), "Inter Variable" */
--font-naskh:  "Noto Naskh Arabic Variable", "IBM Plex Sans Arabic", serif;   /* tafsir, Arabic prose, running heads */
--font-nastaliq: "qd-nastaliq", var(--font-naskh);                         /* lang=ur blocks when the optional font is installed */
--font-quran:  "qd-hafs";                                                  /* translation-mode Arabic, WBW, search hits */
--font-mono:   ui-monospace, "Cascadia Code", "SF Mono", Menlo, monospace;
```
Imports in `fonts.css`: `@fontsource-variable/inter/wght.css`, `@fontsource-variable/noto-naskh-arabic/wght.css`,
`@fontsource/ibm-plex-sans-arabic/{400,500,600}.css`. The root font-size stays 16px: **UI scale is webview zoom** (D27,
`window::set_ui_zoom`), so every px token scales uniformly and nothing in CSS reads a scale variable.

| Token | Latin UI | Arabic UI (`html[lang="ar"]`) | Use |
|---|---|---|---|
| `--text-2xs` | 11px | 13px | badges, captions |
| `--text-xs` | 12px | 14px | secondary labels, kbd |
| `--text-sm` | 13px | 15px | dense lists, sidebar items |
| `--text-md` | 14px | 16px | body UI |
| `--text-lg` | 16px | 18px | panel titles |
| `--text-xl` | 18px | 21px | dialog titles |
| `--text-2xl` | 22px | 26px | view titles |
| `--text-3xl` | 28px | 32px | onboarding headline |
| `--text-4xl` | 36px | 40px | about/brand |
| `--leading-ui` | 1.45 | 1.6 | |
| `--leading-reading` | 1.7 | 1.9 | translations (Urdu Nastaliq: 2.4) |
| `--leading-naskh` | 2.0 | 2.0 | tafsir |
| `--leading-quran` | 2.25 | 2.25 | translation-mode Arabic |

(Arabic needs roughly 12 % more size than Latin for equal legibility, hence the wider Arabic column.)

Weights: 400 body, 500 labels and buttons, 600 titles. Tabular numbers (`font-variant-numeric: tabular-nums`) for times and
counts. Translation reading size = `calc(18px * translationFontPct / 100)`. Translation-mode Arabic = `calc(28px *
translationFontPct / 100)`.

**`.quran-text` utility** (`base.css`, WP7a). qd-hafs and the QCF fonts have a single regular weight, so inherited weight or
style produces faux-bold/italic synthesis (smeared joins, colliding harakat). Every element that renders Quran text — `.mp-glyphs`,
translation-mode Arabic, search hits, WBW Arabic, `AyahHeader` Arabic, palette Arabic names, `WordTooltip` — carries:
```css
.quran-text { font-weight: 400; font-style: normal; font-synthesis: none; letter-spacing: 0; word-spacing: normal;
              text-transform: none; font-variant-ligatures: normal; font-feature-settings: normal; font-kerning: normal;
              text-shadow: none; }
```
`scripts/check-logical-css.mjs` (WP7a) also rejects `font-weight`, `letter-spacing` and `text-transform` declarations on any
selector containing `.quran-text`, `.mp-glyphs` or `[lang="ar"]` Quran classes. Quran text is truncated by **whole lines with
a 24 px fade mask**, never with an ellipsis inside a word.

**Scripts beyond Latin and Arabic.**
- **Urdu:** an optional on-demand "Urdu Nastaliq font" (Noto Nastaliq Urdu, OFL) is offered with Urdu packs (catalog pack
  `decor.nastaliq`, kind `decor`, adapter `static_files`, file `packs/decor/noto-nastaliq-urdu.woff2`, served by the §6.2 decor
  route); when installed, `lang=ur` blocks use `--font-nastaliq` (family `qd-nastaliq`) at line-height 2.4.
- **Linux fonts:** at startup, for each installed pack's script (Bengali, Devanagari, Tamil, …), render a short sample to an
  `OffscreenCanvas` in `sans-serif` and compare it with the same number of a code point no font covers (tofu); identical
  output means the script has no system font. (`document.fonts.check()` reports load state, not system-font coverage, so it
  can't detect this.) On failure the pack row and the translation block show "Install Noto fonts for Bengali" with the distro
  package name (e.g. `fonts-noto-core`).

### 9.4 Spacing, radius, elevation, motion, z-index, focus
```css
--space-0: 0; --space-0_5: 2px; --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px;
--space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px; --space-16: 64px;
--radius-xs: 4px; --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px; --radius-xl: 20px; --radius-full: 999px; --radius-page: 3px;
/* light themes */
--shadow-1: 0 1px 2px rgb(60 45 20 / 0.08), 0 0 0 1px rgb(60 45 20 / 0.04);
--shadow-2: 0 4px 12px rgb(60 45 20 / 0.10), 0 0 0 1px rgb(60 45 20 / 0.05);
--shadow-3: 0 16px 40px rgb(60 45 20 / 0.16), 0 0 0 1px rgb(60 45 20 / 0.06);
--shadow-page: 0 1px 1px rgb(60 45 20 / 0.06), 0 8px 28px rgb(60 45 20 / 0.10);
/* night */  --shadow-1: 0 0 0 1px rgb(255 255 255 / 0.05); --shadow-2: 0 0 0 1px rgb(255 255 255 / 0.06), 0 8px 24px rgb(0 0 0 / 0.45);
             --shadow-3: 0 0 0 1px rgb(255 255 255 / 0.07), 0 20px 50px rgb(0 0 0 / 0.6); --shadow-page: 0 0 0 1px rgb(255 255 255 / 0.04);
/* black */  --shadow-1: 0 0 0 1px #2a2a2a; --shadow-2: 0 0 0 1px #333333; --shadow-3: 0 0 0 1px #3d3d3d; --shadow-page: none;
/* high_contrast */ every shadow: 0 0 0 2px #000000 (HC dark: #ffffff); --shadow-page: 0 0 0 2px currentColor;
--dur-instant: 50ms; --dur-fast: 100ms; --dur-quick: 150ms; --dur-normal: 200ms; --dur-gentle: 250ms; --dur-slow: 300ms;
--dur-page: 260ms; --dur-glyph-swap: 180ms;
--ease-standard: cubic-bezier(0.33, 0, 0.67, 1); --ease-decelerate: cubic-bezier(0.1, 0.9, 0.2, 1);
--ease-accelerate: cubic-bezier(0.9, 0.1, 1, 0.2); --ease-emphasized: cubic-bezier(0.2, 0, 0, 1);
/* reduced motion (media query or data-motion="reduce"): every --dur-* = 0ms; Springs instant; view transitions off */
--z-canvas: 0; --z-chrome: 10; --z-sidebar: 20; --z-player: 30; --z-popover: 40; --z-menu: 50; --z-dialog: 60;
--z-palette: 70; --z-toast: 80; --z-tooltip: 90; --z-drag: 100;
--focus-ring-w: 2px; --focus-ring-offset: 2px;   /* high_contrast: 3px */
:focus-visible { outline: var(--focus-ring-w) solid var(--focus-ring); outline-offset: var(--focus-ring-offset); }
```
The Spring parameters (stiffness 0.22, damping 0.78) are constants in `src/lib/mushaf/metrics.ts`. Every Svelte transition is
wrapped as `duration: settings.reducedMotion ? 0 : d`.
**Translucency:** `backdrop-filter` (dock, palette) is used only on Windows and macOS and never under
`@media (prefers-reduced-transparency: reduce)`; Linux (WebKitGTK often renders it in software) and reduced transparency use
the opaque `--surface-raised` instead. Legibility never depends on it.

### 9.5 Component inventory (`src/components/ui/`, wrapping bits-ui 2.19.5; WP7b)
Every wrapper passes `dir={i18n.dir}` to bits-ui (Tabs, ToggleGroup, Slider, Menu, Select, …; without it arrow keys run
backwards in the Arabic UI) and registers open floating content with `ui.pushFloating()/popFloating()` (§7.4).

| Component | Base | Key props | Spec |
|---|---|---|---|
| `Button` | `<button>` | `variant: primary\|secondary\|ghost\|danger\|link`, `size: sm(28)\|md(32)\|lg(40)`, `loading`, `icon` snippet | radius-sm; primary uses accent/accent-ink; `link` uses `--accent-text`; hover +6 % mix; active scale .98 (no motion when reduced) |
| `IconButton` | `<button>` | `label` (required, aria-label + tooltip), `size`, `pressed?` | square; ghost by default; `aria-pressed` when a toggle |
| `Tooltip` | Tooltip | `content`, `delay=500`, `side` | surface-overlay, text-xs, radius-sm, shadow-2, max-width 280 |
| `Dialog` | Dialog | `size: sm(400)\|md(560)\|lg(720)`, `title`, `description`, header/body/footer snippets | radius-lg, shadow-3, backdrop rgb(0 0 0 / .32), enter 200 ms decelerate scale .98→1 |
| `Sheet` | Dialog | `side: end\|bottom`, `width` | full-height panel from inline-end; used for NoteEditor on narrow windows and for the side pane when it can't dock (§9.6) |
| `Popover` | Popover | `side`, `align`, `arrow?` | surface-raised, radius-md, shadow-2, padding 12 |
| `Menu` | DropdownMenu | `items` (or snippet), `kbd` hints | item height 30, radius-xs, icons 16, separator, submenu |
| `ContextMenu` | ContextMenu | as Menu | the Mushaf/translation trigger is the canvas root |
| `Slider` | Slider | `min,max,step,value`, `ticks?`, `format` | track 4 px with a 1 px `--border-input` outline, thumb 14, tick labels text-2xs; arrow keys step; Shift = 10×; value sliders mirror in RTL (§11.3) |
| `Segmented` | ToggleGroup (single) | `options`, `value` | 28/32 height; container 1 px `--border-input` on `--surface-sunken`; active pill `--surface-raised` with 1 px `--border-input`, weight 600, `--accent-text` (150 ms glide) |
| `Switch` | Switch | `checked`, `label` | 32×18; off track `--surface-sunken` with a 1 px `--border-input` outline; accent when on |
| `Tabs` | Tabs | `tabs`, `value` | underline indicator 2 px accent; label text-sm 500, active label `--accent-text` |
| `Toast` | svelte-sonner `Toaster` | position bottom-center above the dock (offset 96 px, or above the side card) | surface-raised, shadow-3; actions (Undo) as link buttons in `--accent-text`; **5 s without actions, ≥ 10 s with actions**, paused while hovered or focused, reachable with `F6` / `Mod+Shift+U`; undo toasts name the change ("Highlighted 2:255 yellow (replaced green) · Undo") |
| `Kbd` | `<kbd>` | `keys: string[]` | text-xs mono, 1 px border-strong, radius-xs, bottom inset shadow; content wrapped in `<bdi dir="ltr">` |
| `Badge` | `<span>` | `tone: neutral\|accent\|success\|warning\|danger`, `size` | pill, text-2xs 600 |
| `Progress` | Progress | `value`, `max`, `indeterminate`, `variant: bar\|ring` | bar 4 px radius-full on a `--border-input` 40 % track; ring 16/24 px |
| `Skeleton` | `<div>` | `w`, `h`, `radius` | sunken shimmer 1.2 s (static when reduced motion); never used on the Mushaf (§9.8) |
| `EmptyState` | `<div>` | `title`, `body`, `kbd?`, action snippet | centred; a 48 px 8-point-star SVG (`src/assets/star8.svg`) in `--frame-gold`, not a lucide icon |
| `ScrollArea` | ScrollArea | `orientation` | overlay scrollbars 8 px, thumb `--border-strong` |
| `Select`, `Combobox` | Select / Combobox | `items`, `value`, `searchable` | trigger with 1 px `--border-input`; used for translations, reciter, tafsir |
| `TextInput`, `SearchInput`, `Field` | `<input>` | `label`, `hint`, `error` | height 32, radius-sm, `--surface-sunken` fill **plus a 1 px `--border-input` border**, focus ring; `dir="auto"` (§11.3) |
| `Splitter` | paneforge `PaneGroup`/`PaneResizer` (wrapped in `PaneLayout`) | px ↔ % adapter, `min/max` px | 6 px hit area, 1 px visible line, double-click resets |
| `VirtualList` | virtua `VList` | `data`, `itemSize?`, `overscan` | used by search, translation mode, page grid, notes |
| `Card` | `<div>` | `interactive?` | surface-raised, radius-md, shadow-1 |

Row and list hover always use `--surface-hover` (never `--surface-sunken`, which is darker than app in night and equal to it in
black). Icons: `@lucide/svelte/icons/<name>`, 16 px in dense UI and 20 px in toolbars, stroke 1.75. Directional icons
(chevrons, arrows) get `.icon-dir` and mirror under `:dir(rtl)`. Media transport icons, the scrubber and the page rail never
mirror (§11.3).

### 9.6 Layout and window chrome
```
┌ TitleBar 40px ──────────────────────────────────────────────────────────────────────────────────────┐
├ NavRail 52px │ Sidebar 300px (240–420) │ Canvas (reader / views) + PlayerDock │ SidePane 400px (320–640) ┤
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- Arabic UI (`dir=rtl`) mirrors the grid: rail on the right, sidebar right, side pane left. The Mushaf inside the canvas is
  unchanged.
- **Side pane docking is a geometry rule** (`paneCanDock()` in `geometry.ts`, WP8a; applied by `PaneLayout`, WP7c). With the
  canvas width `canvasW` before the pane, the bar reserve `R = canvasH < 860 ? 64 : 84` and
  `qfsH = (canvasH − 2·PAD_Y − R) / PH`, the pane docks when `(canvasW − paneW) ≥ SINGLE_W·qfsH + 2·PAD_X + 16`, and
  `fitLayout` then re-decides spread or single for the remaining width. If it can't dock:
  1. if the sidebar is open and closing it would let the pane dock, collapse the sidebar while the pane is open and restore it
     when the pane closes (`settings.sidePane.autoCollapseSidebar`, default true);
  2. otherwise shrink the pane, down to 320 px;
  3. only then overlay the pane as a `Sheet`.
  At 1366×768, 1536×864 and 1920×1080 the pane docks even with the sidebar open (S32). Below 900 px window width the sidebar
  overlays too.
- **Zen mode** (`Z`): hides chrome except the page; the cursor auto-hides after 2.5 s idle; the dock hides and reappears when the
  pointer enters the bottom 80 px or an audio key is pressed; `PageTurnZones` and the zoom control stay hidden until the
  pointer moves (§8.13).
- **Chrome effect owner:** the frontend only. `settings.applyEffects()` calls `window_set_chrome` whenever the resolved theme or
  `chromeEffect` changes; Rust's `window::apply_settings` never touches chrome (it can't know what `system` resolved to).
- **Windows:** `decorations:false, transparent:true, windowEffects:["mica"]`.
  - The title bar has the drag region (`data-tauri-drag-region` on the bar and on breadcrumb whitespace).
  - `WindowControls`: 46×40 buttons for minimise, maximise/restore and close. Close hover is #c42b1c with white glyph. The
    glyphs are Segoe Fluent Icons code points (U+E921, U+E922/U+E923, U+E8BB) with an SVG fallback.
  - **Snap Layouts:** custom HTML caption buttons lose the Windows 11 snap flyout on maximise. WP6b investigates returning
    `HTMAXBUTTON` from `WM_NCHITTEST` over the maximise rect (the approach tauri-plugin-decorum uses, via a window subclass);
    if that is infeasible, the maximise tooltip reads "Maximize · Win+Z for snap layouts".
  - `html[data-chrome="vibrant"]` is applied when `chromeEffect = auto` and the resolved theme is paper or night.
    `window_set_chrome` then sets `micaLight`/`micaDark`. Otherwise the chrome is opaque.
  - The canvas, page and side pane are always opaque.
- **macOS:** `titleBarStyle:"Overlay"`, `hiddenTitle:true`, `trafficLightPosition:{x:16,y:20}` (tunable), `windowEffects:["sidebar"]`
  for vibrant chrome. The title bar reserves 78 px on the left and has no custom controls. Clicking the Dock icon while the
  window is hidden in the tray re-shows it (`RunEvent::Reopen` → `window::show_main`, §2.8.4).
- **Linux:** native decorations. The title bar becomes a 40 px toolbar (no drag region, no window controls). No
  `backdrop-filter` (§9.4).
- **Close during recitation** (`window::on_window_event`, WP6b, native dialog with Rust strings §11.4): the first close while
  audio plays, when `closeToTrayAsked` is false, asks "Keep reciting in the tray?" with [Keep playing in tray] [Quit]; the
  answer sets `closeToTray` and `closeToTrayAsked = true` and is never asked again. With `closeToTray` on, the first hide shows
  a one-time tray notification-style tooltip "Quran is still playing in the tray" (titled with the app's name in the UI
  language, `RustText::AppName`).

### 9.7 Visual specs of key surfaces
**Player dock (`PlayerDock` / `SideDockCard`, WP9a).** Placement comes from `reader.dock` (geometry only, D28, §8.2).
- **Bar (`bar`, 64 px; `compact`, 56 px when the canvas is under 860 px tall):** floating pill centred at the bottom of the
  canvas, 10 px above the edge; `width: clamp(min(560px, 100% - 24px), 70%, 880px)`, radius-xl. Fill `--surface-overlay` with
  `backdrop-filter: blur(24px) saturate(1.4)` where allowed (§9.4), 1 px `--border`, shadow-3.
- **Side card (`side`):** 272×120, anchored at the bottom inline-end of the canvas beside the pages: reciter row, transport,
  mini scrubber and readout. Same surfaces.
- Grid (bar): `[reciter 208px] [transport 132px] [scrubber 1fr] [readout 104px] [actions auto]`, gap 12, padding 0 14. Below a
  720 px dock width the reciter cell shrinks to the 48 px monogram only and the readout to one line; below 600 px the scrubber
  hides its labels. The scrubber never collapses to 0.
- Reciter cell: a 36 px circular monogram over an accent-soft disc (Latin initials in the English UI; the reciter's first Arabic
  letter in Naskh in the Arabic UI), the name (text-sm 500) and the current ref (text-xs muted, e.g. "Al-Baqarah · 2:255").
  Click → `ReciterPicker` popover (search, Arabic and Latin names, word-timing badge from `ReciterInfo.wordLevel`, downloaded
  count from `packs_items`).
- Transport: previous ayah, play/pause (40 px circle in accent, 20 px icon in accent-ink), next ayah. During buffering the play
  button shows a ring progress. The transport group, scrubber and readout are `direction: ltr` in both UI languages (§11.3).
- **Ayah-tick scrubber:**
  - Track 6 px, radius-full: `--border-input` at 40 % fill plus a 1 px `--border-input` outline (≥ 3:1 against the dock).
    One SVG `<path>` draws the ticks in `--text-muted` at 70 %: a 1×6 px tick at each ayah start **only when the mean spacing is
    ≥ 4 px**; otherwise a tick every 10 ayahs (or at page boundaries when that is sparser). When the track is ≥ 480 px, ticks
    every 10 ayahs are 1×10 px with a text-2xs label.
  - Played portion in `--accent`; the current ayah's span in `--accent-soft`.
  - The repeat range is shown with bracket caps above the track. A-B points are small "A"/"B" flags.
  - Thumb: 14 px accent with a 2 px `--surface-raised` ring, 18 px on hover or drag.
  - Hover tooltip: "2:255 · 01:23".
  - Click or drag seeks the file timeline. With Shift, it snaps to the nearest ayah start. Arrow keys move ±5 s, `PageUp`/`PageDown`
    move ±1 ayah (the scrubber is `[role=slider]`, so the §7.7 widget guard keeps page-turn keys away from it).
  - The scrubber always runs left-to-right (§11.3).
- Readout: "2:255" (text-sm 600, tabular) above "01:23 / 07:12" (text-xs muted), `direction: ltr`.
- Actions:
  - Repeat (icon + live badge: "2/3" during an ayah or range repeat from `ayahRepeatLeft`/`rangeRepeatLeft`, "∞", "A-B"),
    opening `RepeatPopover`: ayah ×N stepper, range ×N, gap (none / fixed seconds / ×length), a range picker defaulting to the
    selection, presets.
  - Speed (label "1.25×"), opening `SpeedPopover` (slider 0.5–2.0 in 0.05 steps, ticks at 0.75/1/1.25/1.5/2, and a pitch-preserved
    note).
  - More menu: stop-at, download this surah, A-B, volume, follow-along toggle.
  - Collapse chevron.
- **Idle:** a 380 px pill "▶ Play {surah} from {ref} · {reciter}", or, when `player.resumeCandidate` exists (§7.8),
  "Resume Al-Kahf · 18:45 · Mishary Alafasy". Space resumes; nothing auto-plays.
- **Errors** (§9.8): "Offline — Al-Baqarah isn't downloaded for Mishary Alafasy [Download when online]"; "No audio output —
  reconnecting…"; a dismissible note when `basmalaSkipped`.

**Command palette (WP10c).**
- Container: `Dialog` without chrome, 640 px wide, top 14 vh, radius-lg, `--surface-overlay` with blur 20 where allowed (§9.4),
  shadow-3.
- Input: 52 px, text-lg, search icon on the start side, scope chip on the end side, `dir="auto"`.
- List: max-height 420, group headings text-2xs 600 uppercase with letter-spacing 0.06em (none in the Arabic UI and never on
  Arabic text).
- Items: 40 px rows with a 24 px leading badge (surah number in a rosette or a command icon), primary label, a secondary Arabic name
  and a trailing `Kbd`/hint. The Arabic name uses `qd-sura-names` when decor is installed: the glyph for surah `n` is
  **`String.fromCodePoint(0xE000 + parseInt(String(n).padStart(3, '0'), 16))`** (`uniE001`…`uniE114`: the zero-padded decimal
  number read as hex, so surah 10 is U+E010 and 114 is U+E114; U+E000 is "سورة"); else Naskh text (`.quran-text` not needed,
  it is a name).
- Providers, in order: **Go to** (parsed refs §10.4), **Surahs** (fuzzy over names and aliases with Arabic normalisation),
  **Commands** (from the shortcut registry, with kbd hints), **Settings toggles** (labels from `settingsMeta`,
  `src/components/settings/meta.ts`, WP12b; until it exists, the field name), **Reciters**, **Recent** (history, plus the
  reading-bookmark "Continue" card, §7.8).
- Empty state: "No matches. Try 2:255, p 262, j 15, الكهف".

**Search results (WP10b).**
- Sidebar panel: `SearchInput` (`dir="auto"`), then a `Segmented` scope (Quran | Translation ▾ | Notes), then a mode menu
  (Smart / Exact letters / Contains), then a count line built with `tp()` plurals and locale digits ("438 results in 61 surahs ·
  12 ms").
- Results: grouped `VirtualList`.
  - Sticky group header 32 px: surah number badge, name and a count chip.
  - Hit rows (min 56 px): a key badge "2:255", then the ayah in `--font-quran` (`.quran-text`) **22 px, line-height 2.1**, built
    from `SearchHit.words`: a window of whole words around the **first matched word** (±12 words), with 24 px fade masks at the
    cut edges (never an ellipsis inside a word), matched words wrapped in `<mark class="hit">` (`--hl-search` +
    `--hl-search-solid` underline, radius 3), and a chip "+2 more in this ayah" when further matches lie outside the window.
  - Translation and notes scopes add a snippet in text-sm (`SafeHtml`).
- States: hover is `--surface-hover`. The active row has a 2 px accent bar on the inline-start edge. Enter opens it, `Mod+Enter`
  opens it in the side pane. F3 / Shift+F3 move through hits from the reader.
- Typo fallback banner: "Showing results for الرحمن (no exact match for الرحمان)". Empty, no-result and truncated states: §9.8.

**Translation mode (`TranslationView`, WP11a).**
- A centred column, `max-inline-size: 760px` (≈ 72ch at 18 px), `padding-inline: 32px`.
- `VerseRow`: `padding-block: 20px` with a 1 px `--border` separator. `KeyBadge`: a 28 px rosette at the inline start. `ActionBar`:
  ghost IconButtons shown only on row hover or focus, at the top inline end (same actions as the Mushaf action bar).
- Arabic first: `qd-hafs` (`.quran-text`) at `calc(28px × translationFontPct / 100)`, leading 2.25, right-aligned in `dir=rtl`.
- Each translation block carries an 11 px `--text-muted` translator label and takes its `lang`/`dir` from the pack (Urdu in
  Nastaliq when installed, §9.3).
- `SurahCard`: the `SurahCartouche` at 0.6 scale, the meaning, "Meccan · 7 ayahs · p 1", and a basmala line (`qd-hafs` 26 px)
  except for surahs 1 and 9.
- Playing ayah: `--hl-audio` row background plus a 3 px accent bar at the inline start. Auto-scroll keeps it at 30 % from the
  top, pauses for 4 s after a manual scroll, and offers the same "Return to recitation" chip.
- Scenario S36 (translation mode at 1920×1080).

**Side pane (`SidePane`, WP11b).**
- `AyahHeader` (56 px): rosette, "Al-Baqarah 2:255" and the Naskh name, a pin toggle, prev/next chevrons (`.icon-dir`), and the
  "Follow recitation" chip while a selection pins the pane during playback (§8.15).
- Translation tab: 16 px reading text.
- Tafsir tab: Naskh 18 px, leading 2.0, max 64ch, with a source and date footer ("Saved 9 days ago · refreshes when online" when
  `stale`); a range entry shows "Covers 2:255–257".
- Notes tab: inline editor (WP11d's editor in compact mode).
- Words tab: a grid of cards (`WbwEntry.text` in `qd-hafs` 24 px, gloss, transliteration); clicking a card highlights the word on
  the page (search-hit layer).
- Scenario S37 (side pane, tafsir).

**Index (`SurahList`, WP10a).** Rows 48 px: a 24 px rosette number; `name_simple` (text-sm 500) with the meaning beneath (text-xs
muted); the Arabic name at the inline end (sura-names glyph or Naskh 18 px); meta "Meccan · 286 · p 2" (text-2xs, locale digits);
the current surah marked by an accent bar; a small dot when the current reciter's surah is downloaded (from `packs_items`).

**Downloads manager (WP12a).**
- Header: `DiskUsageBar` (stacked segments per kind with a legend and totals) plus "Clear streaming cache"
  (`packs_clear_stream_cache`) and "Open folder".
- Filters: kind tabs, language select, search.
- Rows (56 px): kind icon, title and subtitle ("Saheeh International · English · 0.5 MB"), state `Badge`, and actions on the end
  side: Download / Pause / Resume / Cancel / Remove / Update (= `packs_install(id, All)` on `UpdateAvailable`) / Retry
  (= `packs_resume` on `Failed`).
- While downloading: a 4 px `Progress` under the subtitle and "12.4 of 93.2 MB · 2.1 MB/s · 0:42 left".
- Recitation rows expand to a 114-cell `SurahGrid` of 28 px cells driven by `packs_items`: filled accent when pinned, half-tone
  when stream-cached, an outline ring when queued. Clicking a cell downloads (`packs_install(id, Items[n])`) or removes
  (`packs_remove_items`) that surah; the first download of any surah also pins surah 1 (basmala, §2.5.6), shown in the grid.
  Bulk actions: "Download all (1.7 GB)" and "Remove all". Mushaf font packs show a page count instead of a grid.

**Onboarding (WP12c).** Dialog lg 720×540 over the **real page 1–2 spread** (backdrop rgb(0 0 0 / .18)), **(v1.2)** 5 steps
with progress dots. Never shown again after Finish (or Skip). **(v1.2, owner 2026-10-11)** A first run must be finished: no
Skip, Escape and a click outside do nothing, Back stays, and Finish on the last step is the only way out (`ui.dismissLayer`
never closes the onboarding). A tour reopened from Settings › System ("Show the welcome tour") keeps Skip, and Escape is Skip
there.
1. Welcome: headline, three feature bullets, language `Segmented` (English | العربية, live switch), and theme cards
   (**Match system** — selected by default — Paper, Sepia, Night, Black), each a mini Mushaf thumbnail rendering page 1 from
   core.db via `mushafGetPages` in the hafs style (`MushafPage interactive={false}`).
2. **(v1.2)** Mushaf, with a live preview:
   - Style cards, stacked: Hafs (offline, included), QCF V2 (authentic 1421H print, pages download as you read; **preselected
     on a first run**), Tajweed V4 (colour-coded, ≈ 48.5 MB on demand; locked with "Not supported on this system" where the
     §8.6 probe failed). With "Work offline" on, the QCF/Tajweed cards show "Needs download — available when you're
     online", the style stays hafs and download rows are disabled.
   - Under the cards, for every style: "Ornate surah headers · 325 kB" (`decor`, the `ornateHeaders` setting, ticked), and for
     a QCF style "Download all pages in the background (93.2 MB)" (off).
   - Beside them, the live preview: the Settings preview card (a faded slice of page 1 at qfs 14) in the chosen style, with or
     without the ornaments, before anything is saved. Online it fetches page 1's font of the chosen print and, while ticked,
     `decor` (once); offline it shows Hafs and fetches nothing.
3. Translation and recitation:
   - Translation select, preselected from the locale (en → Saheeh International).
   - Reciter select (default Mishary Alafasy) with a ▶ preview of 1:1 (online only); "Recitation streams as you listen and is
     cached".
4. Summary: the exact starter set (§2.5.4) with sizes and the **exact total** above the button, a "Work offline" switch
   (`networkAllowed`), and buttons "Download now" (installs the starter set) and "Start reading", both of which apply the style,
   `ornateHeaders` and the reciter. Onboarding never bulk-downloads audio. The lede says that apart from what the Mushaf
   preview showed (its first page and, while ticked, the ornate headers) nothing is fetched without asking.
5. Keys: teaches `Ctrl+K`/`⌘K`, `Space` and `?` with `Kbd`. Finish sets `onboardingDone = true`.

**Settings (WP12b).**
- Layout: 200 px section nav, content max-width 720, rows of 56 px (label text-md 500, description text-sm muted, control on the end
  side). Every `Settings` field is bound to a control; labels and ranges come from `settingsMeta` (`meta.ts`).
- Appearance has a live preview card (`MushafPage interactive={false}` in the current theme and style, plus a translation line),
  the theme with `lightVariant`/`darkVariant` pickers for "Match system", UI scale 80–200 % (step 10), and ink brightness 65–100 %.
- The Keyboard section embeds `ShortcutTable` (WP7c).
- The Storage section shows disk usage, "Clear cache" (`cache_clear`, ConfirmDialog explaining that downloads are kept) and links
  to Downloads.
- Destructive actions use `ConfirmDialog`.

**About and attribution (WP12c).**
- Header: the app icon (64 px, §9.9), the full name ("Quran for Desktop" / "قرآن لسطح المكتب"), version, build line
  ("core.db: qul · 2026-10-10 · schema 1"), and "Copy diagnostics" (app info JSON).
- `AttributionList` groups, each entry with licence and link:
  - This app (Changed by LEAD 16): "© Quran for Desktop contributors", GPL-3.0-or-later with the full text of `LICENSE`;
    "App icon: Quran.com / quran_android contributors, GPL-3.0", noting that the app is built to the Quran.com project's
    identity (github.com/quran).
  - Quran text and layout: QUL/Tarteel, KFGQPC, Tanzil (CC BY 3.0 + link).
  - Fonts: KFGQPC Hafs EULA text; QCF fonts © KFGQPC via Quran Foundation, with the credit "Quran fonts provided by Quran
    Foundation"; Noto Nastaliq Urdu (OFL) when installed.
  - Translations: each installed QuranEnc translation with version and link.
  - Tafsir.
  - Recitations: QuranicAudio (personal use), timings by Quran Foundation.
  - Open-source licences: collapsible, from `thirdparty.json`.

### 9.8 States (empty, loading, offline, error) — exact copy and actions
Owners implement the states of their own surfaces; strings live in the owner's i18n domain file. The Mushaf **never** shows
skeletons: paper, frame and furniture paint immediately and glyphs fall back to hafs.

| Surface | State | Copy and action |
|---|---|---|
| Translation tab / translation mode (WP11a/11b) | no translation installed (`translations = []`) | Card "Add a translation" listing 3 recommended packs for the UI language with sizes and Install; offline: "Translations download when you're online" |
| Tafsir tab (WP11b) | loading | 6 skeleton lines at `--leading-naskh` |
| | offline and the chapter isn't cached | "This tafsir needs a connection for Al-Kahf (≈180 KB)" [Retry] |
| | `stale` | footer "Saved 9 days ago · refreshes when online" |
| | no tafsir selected | card listing tafsir packs with Install |
| Words tab (WP11b) | no WBW pack | install card (WBW for the UI language) |
| Search (WP10b) | empty query | recent searches plus example chips `الرحمن`, `mercy`, `2:255` |
| | 0 hits | "No matches for X — try Smart mode / search translations" |
| | translation scope with no pack | install card |
| | truncated | "Showing 500 of 1,234 · filter by surah" (filter chips push the range into SQL, §2.2.5) |
| Library panels (WP11c) | empty | each teaches its key in `EmptyState` with `Kbd`: Bookmarks "Press B on any ayah", Highlights "1–5 to highlight", Notes "N to add a note", History "Pages you read appear here" |
| Player (WP9a) | offline and the surah isn't cached | dock error "Offline — Al-Baqarah isn't downloaded for Mishary Alafasy" [Download when online]; the Index marks surahs downloaded for the current reciter |
| | `NoOutputDevice` | "No audio output — reconnecting…" (retries every 2 s, §2.3.6) |
| | basmala skipped | "Played without the basmala (not downloaded)" note, once per play |
| Mushaf fonts (WP8b) | `Unavailable` | footer dot "Offline — showing the Hafs font" |
| | `Failed` | same dot; tooltip "Couldn't download this page's font" [Retry] |
| App (WP7c) | user.db recovered (`StartupNotice::UserDbRecovered`) | banner "Your library couldn't be opened. A copy was kept." [Restore from backup…] [Dismiss]; never exit for user.db or content.db |
| | `app_bootstrap` failed (debug: core.db missing) | `FatalScreen` "Core data missing (dev build) — run `pnpm core:qdc`" with the message in Details |
| | browser production preview | `FatalScreen` "Run Quran in Tauri" |

### 9.9 Brand and icons (WP-Brand; lead sign-off)
> Changed by LEAD 16 (2026-10-10): the app adopts the github.com/quran (Quran.com) identity. The first identity (a khatam
> star with an open book, gold on green) and its "geometry only" rule are superseded. `assets/brand/README.md` has the
> pipeline, the per-size treatments and every output with its consumer.
- **Names.** Product name **Quran** (`productName`: window title, taskbar, installer, tray, media flyout, FatalScreen);
  full name **Quran for Desktop** (About, onboarding, descriptions). Arabic UI: **قرآن** / **قرآن لسطح المكتب**
  (`common.appName` / `common.appFullName`; Rust `RustText::AppName` for the tray tooltip and notice and the
  close-to-tray dialog).
- **Mark.** The organisation's current mark, the word قرآن in gold calligraphy on a navy rounded tile: quran_android
  `app/src/main/res/drawable-nodpi/ic_upcoming_app_icon.webp` (1024 px, GPL-3.0, commit `19f5bde9`), kept unmodified in
  `assets/brand/source/`; it is also the github.com/quran avatar. About credits it: "App icon: Quran.com / quran_android
  contributors, GPL-3.0", with a note that the app is built to the Quran.com project's identity (§9.7).
- **Exports** (`node assets/brand/tools/build.mjs`, verified by `--check`, plus `pnpm tauri icon assets/brand/icon.png`):
  - 128 px and up, the ICO's 256 px entry and About use the master (Lanczos-3); 16–64 px are **tuned** (the glyph is cut
    from the master, emboldened and repainted in the avatar's flat gold #e2af56 on the navy tile);
  - Windows `icons/windows/icon.ico`: 16/20/24/32/40/48/64 tuned, 256 master, full-bleed;
  - macOS `icons/macos/icon.icns`: an 824 px body on the Apple grid with a 100 px margin;
  - Linux: the `tauri icon` PNG set, with the tuned `tray/tray-{32,16,24}.png` first in `tauri.linux.conf.json`
    `bundle.icon` (the first PNG is the window icon; one hicolor icon per size);
  - Tray `src-tauri/icons/tray/`: colour `tray-{16,20,24,32}.png` (Windows by DPI; `tray.png` = 32 on Linux) and the
    template `tray-template.png`/`tray-template@2x.png` (macOS, `iconAsTemplate`);
  - `src/assets/app-icon.svg` (About, Settings, onboarding, FatalScreen), `app-icon-small.svg` (title bar),
    `app-mark.svg` (single colour) and `star8.svg` (EmptyState, geometric).
- **Care.** The mark is Quranic text: it is the app's identity, never an ornament or a background, and `star8.svg` stays
  geometric.
- **Approval.** The owner approved this identity; a **public release** under it needs the approval of the quran
  organisation's maintainers (LEAD.md item 16).
- The icon is the SMTC / Now Playing / MPRIS fallback artwork. The taskbar, Dock and About header are on the WP13b smoke
  checklist. The Tauri default icons must never ship (CI checks `src-tauri/icons/icon.png` differs from the scaffold's hash).

---

## 10. Keyboard, mouse and context menus

### 10.1 Keyboard shortcuts (complete v1 table)
`Mod` is Ctrl on Windows/Linux and ⌘ on macOS. Keys use the §7.7 notation: letters and punctuation by their **US character**
(matched on `e.key`, falling back to `e.code` on non-Latin layouts; D11), digits as `Digit0`–`Digit9` (always `e.code`), named
keys by name. "reader" scope means the reader view is active; "mushaf" means Mushaf reading mode. **C** = capture-phase def
(§7.7). All plain/Shift-only keys are subject to the widget guard (§7.7 rule 3).

| Group | Keys | Action | Scope | Owner file |
|---|---|---|---|---|
| navigation | `ArrowLeft`, `PageDown` | Next page (RTL book); **repeat = flip** (§8.11) | mushaf | navigation.ts (WP8e) |
| navigation | `ArrowRight`, `PageUp` | Previous page; repeat = flip | mushaf | navigation.ts |
| navigation | `Shift+ArrowLeft` / `Shift+ArrowRight` | Next / previous surah start | reader | navigation.ts |
| navigation | `Mod+Home` / `Mod+End` | First / last page | reader | navigation.ts |
| navigation | `ArrowDown` / `ArrowUp`, `j` / `k` (aliases) | Next / previous ayah: moves the reading cursor and selects that ayah; turns the page (§8.15) | reader | navigation.ts |
| navigation | `Shift+ArrowDown` / `Shift+ArrowUp`, `Shift+j` / `Shift+k` | Extend the selection by one ayah | reader | navigation.ts |
| navigation | `Home` / `End` | First / last ayah on the page | mushaf | navigation.ts |
| navigation | `p` | Show and focus the page rail (§8.11) | mushaf | navigation.ts |
| navigation | `Alt+ArrowLeft` / `Alt+ArrowRight`, mouse back/forward buttons | Navigation history back / forward | reader | navigation.ts |
| navigation | `Mod+g` **C** | Go to… dialog | global | navigation.ts |
| navigation | `F3` / `Shift+F3` | Next / previous search hit (`search.move`, keeps the results list in sync) | reader | navigation.ts |
| app | `Mod+k` **C** | Command palette (toggle) | global, in inputs | app.ts (WP7c) |
| app | `Mod+f` **C** | Search (sidebar Search tab, focus input) | global, in inputs | app.ts |
| app | `?` | Shortcut sheet | global | app.ts |
| app | `Mod+,` **C** | Settings | global | app.ts |
| app | `Mod+Shift+d` **C** | Downloads | global | app.ts |
| app | `Escape` **C** | Close the top overlay/floating layer → else clear selection/search hit → else exit zen. In the note editor: closes; asks "Discard note?" only if the unsaved body is non-empty (drafts autosave to the ui store) | global, in inputs | app.ts |
| app | `F6`, `Mod+Shift+u` | Move focus to the toast region (actions such as Undo) | global | app.ts |
| app | `Mod+z` / `Mod+Shift+z` | Undo / redo the last library change (§7.3) | reader (not in inputs) | study.ts (WP11c) |
| view | `t` | Toggle Mushaf / Translation mode | reader | view.ts (WP8e) |
| view | `d` | Cycle page mode auto → single → spread | mushaf | view.ts |
| view | `Mod+=` / `Mod+-` / `Mod+Digit0` | Mushaf zoom in / out / fit (repeat allowed) | mushaf | view.ts |
| view | `Mod+Shift+=` / `Mod+Shift+-` / `Mod+Shift+Digit0` | UI scale up / down / reset (80–200 %, step 10; D27) | global | app.ts |
| view | `Mod+b` | Toggle sidebar | global | app.ts |
| view | `Mod+i` | Toggle side pane | reader | app.ts |
| view | `Mod+Digit1` … `Mod+Digit7` | Sidebar tab: Index, Search, Bookmarks, Highlights, Notes, History, Memorize | global | app.ts |
| view | `Mod+Shift+l` | Cycle theme paper → sepia → night → black | global | app.ts |
| view | `F11` **C** (Win/Linux), `Mod+Ctrl+f` **C** (macOS) | Fullscreen | global | app.ts |
| view | `z` | Zen mode (hide chrome except the page) | reader | view.ts |
| audio | `Space` | Play/pause. When idle: resume candidate (§7.8), else the selection, else the first ayah of the visible page | global | audio.ts (WP9a) |
| audio | `.` / `,` | Next / previous ayah (audio) | global | audio.ts |
| audio | `>` / `<` | Seek +5 s / −5 s | global | audio.ts |
| audio | `r` | Cycle repeat: off → ayah ×3 → ayah ∞ → off | global | audio.ts |
| audio | `l` | A-B loop: set A → set B → clear | global | audio.ts |
| audio | `]` / `[` | Speed +5 % / −5 % | global | audio.ts |
| audio | `}` / `{` | Speed +25 % / −25 % | global | audio.ts |
| audio | `\` | Speed 100 % | global | audio.ts |
| audio | `m` | Mute toggle | global | audio.ts |
| audio | `Mod+Shift+.` (`Mod+>`) | Stop (`Mod+.` is the macOS system "cancel" chord) | global | audio.ts |
| study | `b` | Toggle bookmark on `reader.actionTarget` (visible selection, else visible cursor, else first visible ayah); the toast names it | reader | study.ts (WP11c) |
| study | `Shift+b` | Move the reading bookmark here (undo toast) | reader | study.ts |
| study | `Digit1`…`Digit5` | Highlight the action target yellow / green / blue / red / purple | reader | study.ts |
| study | `Digit0` | Remove the highlight from the action target | reader | study.ts |
| study | `n` | Add or edit a note on the action target | reader | study.ts |
| study | `c` | Copy the action target (settings.copy format) | reader | study.ts |
| study | `Mod+c` | Copy (DOM selection, else the selected ayahs) | reader | study.ts |
| study | `Mod+Shift+c` | Copy with translation | reader | study.ts |
| study | `Enter` | Open the side pane for the action target | reader | study.ts |
| memorize | `e` | Toggle hide mode for the selection, else the visible page(s) | reader | memorize.ts (WP9b) |
| memorize | `Shift+e` | Start a self-test on the selection, else the current surah | reader | memorize.ts |
| memorize | hold `q` | Peek (reveal all while held; AZERTY users press the key that types q) | reader | memorize.ts |
| memorize | `w` / `Shift+w` | Reveal next word / next ayah | reader | memorize.ts |
| a11y | `Shift+F10`, `ContextMenu` | Ayah context menu for the cursor/selection | reader | study.ts |

Inside the palette or dialogs, bits-ui handles ↑/↓/Enter/Esc. The palette sets `vimBindings={false}`. WP0C writes the label of
every row above into the frozen `shortcuts.ts` dictionaries (en + ar, §11.1).

### 10.2 Mouse and gestures
| Input | Where | Action |
|---|---|---|
| wheel (page fits) | Mushaf canvas | per gesture (ends after 160 ms idle): ≥ 120 px vertical → one page, `deltaY > 0` = next (§8.13); `deltaMode` normalised |
| wheel (zoomed or below QFS_MIN) | Mushaf canvas | scroll |
| `Mod`+wheel / pinch | Mushaf canvas | zoom anchored at pointer (§8.13) |
| horizontal swipe (touchpad) | Mushaf canvas | ≥ 80 px per gesture: right → next page, left → previous |
| drag (zoom ≤ 100 %) | Mushaf page and margins | on release, ≥ 80 px horizontal or a 30 px flick: right → next page, left → previous (§8.13); vertical pans at `QFS_MIN` |
| drag (zoom > 100 %) | Mushaf page and margins | pan the canvas (§8.13) |
| click a page-turn zone chevron | Mushaf canvas edges | left zone = next page, right zone = previous (§8.11) |
| click + / the level / − | Mushaf canvas, top inline-end corner | zoom in / back to the fit / zoom out, around the canvas centre (§8.13) |
| hover the bottom 24 px of the canvas | Mushaf canvas | reveal the page rail; drag previews, release turns (§8.11) |
| hover / click / Shift+click / double-click / Mod+click / right-click | ayah words | §8.17 (click also shows the action bar) |
| click empty paper or canvas | Mushaf | clear the selection |
| click margin marker | Mushaf | select that ayah; tooltip shows the juz/hizb/sajda name |
| click a margin mark | Mushaf | bookmark: select; note: open Notes tab; ribbon: reading-bookmark popover (§8.9) |
| click a surah header | Mushaf | Surah info popover (§8.8) |
| double-click title bar | Windows/macOS | maximise/restore (native drag-region behaviour) |
| drag splitter / double-click splitter | sidebar, side pane | resize / reset to default |
| drag on scrubber | player | seek (Shift snaps to ayah starts) |
| mouse buttons 4/5 | anywhere | navigation history back/forward |
| middle-click a search hit or bookmark | lists | open in the side pane without navigating |

### 10.3 Context menus
**Ayah context menu** (`AyahContextMenu`, WP11c; Mushaf and translation mode; applies to the selection when the clicked ayah is
inside it; it is a floating layer, §7.4, so its typeahead never triggers reader shortcuts). (v1.2) Every opener (a right-click
on the words or a verse row, `Shift+F10` / `ContextMenu`, the action bar's or a verse's More) goes through `openAyahMenu`
(`interactions.ts`): an ayah outside the selection becomes the selection first, so what the menu acts on is always tinted.
The selection stays after the menu closes: Escape closes only the menu, the next Escape clears the selection.
```
Play from here                      Ctrl+Click (⌘+Click)
Play this ayah only
Repeat                            ▸ This ayah ×3 · ×5 · ×10 · ∞ │ Selection ×3 · ∞ │ Custom…
──────────
Bookmark / Remove bookmark          B
Move reading bookmark here          Shift+B
Highlight                         ▸ ● Yellow 1 · ● Green 2 · ● Blue 3 · ● Red 4 · ● Purple 5 │ Remove 0
Add note…                           N
Add to collection                 ▸ <collections…> │ New collection…
──────────
Copy                              ▸ Arabic with reference  C │ Arabic only │ With translation  Mod+Shift+C │ Reference (2:255)
Translation · Tafsir · Word by word   (opens side pane tab)
──────────
Memorize                          ▸ Hide from here │ Self-test this range │ Mark memorized │ Mark learning
```
**Other menus:**
- bookmark item: Open · Open in side pane · Edit label · Collections ▸ · Delete
- note item: Open · Edit · Delete
- search hit: Open · Open in side pane · Copy · Bookmark
- surah item: Open · Play surah · Surah info · Download recitation for this surah · Memorize ▸
- pack row: Download/Pause/Resume/Retry/Update/Remove · Open folder
- SurahGrid cell: Download · Remove · Play surah

### 10.4 Reference parser (`src/lib/text/refparse.ts`, palette and Go to; shared vectors in `src/lib/text/refparse.vectors.json`)
Digits are normalised first (Arabic-Indic and Persian → ASCII, see `normalize_ar` step 8).

| Input pattern | Result |
|---|---|
| `^\s*(\d{1,3})\s*[:.\s/]\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*$` | ayah (or range) `s:a[-b]` |
| `^\s*(p\|page\|ص\|صفحة)\s*(\d{1,3})\s*$` | page |
| `^\s*(j\|juz\|ج\|جزء)\s*(\d{1,2})\s*$` | juz |
| `^\s*(h\|hizb\|حزب)\s*(\d{1,2})\s*$` | hizb |
| `^\s*(s\|surah\|سورة)\s*(\d{1,3})\s*$` | surah |
| bare `n` | offer "Surah n" (if ≤ 114) and "Page n" (if ≤ 604) |
| anything else | surah name fuzzy match: normalised (`normalize_ar` Loose; Latin `fold_latin`, `-`/`'` removed) against name_ar, name_simple, name_complex, name_en and aliases (`al-`/`an-`/`as-` prefixes optional) |

Out-of-range values produce a disabled item with the reason, never an error.

---

## 11. Internationalisation

### 11.1 Typed dictionaries (no runtime library)
```
src/lib/i18n/
├─ index.ts                 # (WP0E → WP7c) I18n runtime: t, tp, formatters; locale from settings
├─ en/index.ts              # (WP0C, frozen) export const en = { common, shortcuts, errors, shell, mushaf, fonts, furniture,
│                           #        interactions, reader, pagenav, player, memo, navigation, search, palette, content, sidepane,
│                           #        library, notes, downloads, settings, onboarding, about } as const
├─ en/{common,shortcuts,errors}.ts   # (WP0C, frozen contract) complete in wave 0
├─ en/<domain>.ts           # one file per domain, owned by its package (table below)
├─ ar/index.ts              # (WP0C, frozen) export const ar = {...} satisfies Dict
└─ ar/<domain>.ts           # same owners as en
```
| Domain file (`en` and `ar`) | Owner | | Domain file | Owner |
|---|---|---|---|---|
| `common`, `shortcuts`, `errors` | WP0C (frozen) | | `palette` | WP10c |
| `shell` | WP7c | | `content` | WP11a |
| `mushaf` · `fonts` · `furniture` | WP8a · WP8b · WP8c | | `sidepane` | WP11b |
| `interactions` · `reader` · `pagenav` | WP8d · WP8e · WP8f | | | |
| `player` | WP9a | | `library` | WP11c |
| `memo` | WP9b | | `notes` | WP11d |
| `navigation` | WP10a | | `downloads` | WP12a |
| `search` | WP10b | | `settings` | WP12b |
| `onboarding`, `about` | WP12c | | | |

- **Frozen shared keys.** WP0C writes, in both languages: the complete `shortcuts.ts` from the §10.1 table (≈ 60 labels), a
  `common.ts` seed (OK, Cancel, Undo, Redo, Retry, Close, Delete, Save, Edit, Search, Download, Remove, Pause, Resume, Loading,
  Error, Details, Install, Update, Offline, Copy, Play) and `errors.ts` (one message per `AppError` kind). They change only
  through a contract PR.
- **Rule:** a package references only its own domain plus the frozen `common`, `shortcuts` and `errors` keys, so `pnpm check`
  never fails because another package's key doesn't exist yet. `ShortcutDef.labelKey` is always a `shortcuts.*` key. The
  palette's settings labels come from `settingsMeta` (WP12b), not from the `settings` dictionary.
- Every package has its own domain file(s), so no two packages ever edit the same dictionary file; the frozen `index.ts` files
  import them all (WP0C creates each as an empty `{}` placeholder).

```ts
type Plural = { zero?: string; one: string; two?: string; few?: string; many?: string; other: string };
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : Widen<T[K]> };
export type Dict = Widen<typeof en>;                            // ar must satisfy Dict ⇒ missing/extra keys = compile error
export type I18nKey = Paths<typeof en>;                        // dotted paths, e.g. 'player.repeat.ayahTimes'
export function t(key: I18nKey, params?: Record<string, string | number>): string;   // "{name}" interpolation
export function tp(key: I18nKey, count: number, params?: Record<string, string | number>): string; // Intl.PluralRules
```
- Arabic plural entries MUST define all six categories (`zero, one, two, few, many, other`). A vitest checks this for every
  `Plural` in `ar`.
- Error messages live at `errors.<AppError kind>`, e.g. `errors.offline`.
- Surah names come from core.db (`name_ar`, `name_simple`, `name_complex`, `name_en`), never from dictionaries.
- Switching language calls `settings.update({ uiLanguage: 'ar' })`, which updates `i18n.locale` and `html[lang][dir]`
  reactively. No reload, and audio is unaffected. Rust-side strings follow through `window::apply_settings` (§11.4).

### 11.2 Numbers, dates, references
- UI numbers: `Intl.NumberFormat(arabicDigits ? 'ar-u-nu-arab' : 'en-US')`. `arabicDigits = digits === 'arabic_indic' ||
  (digits === 'auto' && uiLanguage === 'ar')` (generated camelCase names, §0.2).
- **Mushaf furniture always uses Eastern Arabic numbers** (page numbers, markers, juz labels; the quarters of a hizb are
  words, v1.2). The setting names the systems "Western Arabic numbers" / "Eastern Arabic numbers" («الأرقام العربية
  الغربية» / «الأرقام العربية الشرقية», v1.2); `arabic_indic` stays the serialized value.
- References: en `2:255`; ar `٢:٢٥٥` with Arabic digits. Surah label: en `Al-Baqarah` (name_simple) with the meaning on hover; ar
  `البقرة`.
- Dates: `Intl.DateTimeFormat(locale, { dateStyle: 'medium' })`. Relative times: `Intl.RelativeTimeFormat`. Sizes: KiB/MiB/GiB
  with locale digits. Durations: `m:ss` / `h:mm:ss` with tabular numerals.

### 11.3 RTL UI rules
- `<html lang dir>` follows the UI language. The Mushaf is always `dir=rtl lang=ar`. Translation blocks take `lang`/`dir` from pack
  meta (Urdu and Persian are RTL).
- **Logical CSS only** in `src/components/**` and `src/styles/**` (`margin-inline-*`, `padding-inline-*`, `inset-inline-*`,
  `border-start-*-radius`, `text-align: start`).
  - `scripts/check-logical-css.mjs` (WP7a) fails CI on `margin-left|right`, `padding-left|right`, `left:`, `right:`,
    `text-align: left|right` and `border-*-left|right`, and on weight/spacing/transform declarations on Quran-text selectors
    (§9.3).
  - Exemption: lines marked `/* physical-ok */` (Mushaf geometry §8, transport, scrubber, readout, page rail).
- **Transport, scrubber, readout:** `.transport, .scrubber, .readout { direction: ltr; }` (physical-ok). The dock's outer grid
  still mirrors, but inside the transport group "previous" (⏮) stays on the left and "next" (⏭) on the right, so the arrows point
  the way they act, and "01:23 / 07:12" never reorders under RTL bidi.
- **Inputs:** every `TextInput`, `SearchInput`, the palette input and the note editor get `dir="auto"`; rendered user text gets
  `unicode-bidi: plaintext`. Arabic queries in the English UI and Latin queries in the Arabic UI then type in their natural
  direction.
- **bits-ui direction:** every `src/components/ui` wrapper passes `dir={i18n.dir}` (§9.5).
- **Kbd:** content wrapped in `<bdi dir="ltr">` so "Ctrl+K" never becomes "K+Ctrl".
- **References are explicitly isolated, never `auto`:** Western Arabic numbers `<bdi dir="ltr">2:255–257</bdi>`;
  Eastern Arabic numbers `<bdi dir="rtl">٢:٢٥٥–٢٥٧</bdi>` (`i18n.ref()` returns them wrapped). Vectors in the i18n tests
  cover both.
- **Sliders:** value sliders (speed, ink brightness, UI scale) mirror with the UI direction; the media scrubber and the page rail
  never mirror (the rail always has page 1 on the right, book order).
- Mirror directional icons (`.icon-dir`). **Never mirror** media transport icons. Download progress bars follow the inline
  direction.
- Keyboard: page-turn arrows keep book semantics in both UI languages (←: next page). Ayah-step keys are ↑/↓ and j/k.
- Text sizes in the Arabic UI follow the §9.3 column. Letter-spacing is never applied to Arabic text.
- Scenario S26 adds a dock close-up in the Arabic UI.

### 11.4 Rust-side strings (`src-tauri/src/i18n.rs`, WP6b)
Strings that originate in Rust — tray menu items and the "Now: {ref}" label, the media-session album and title (§2.4), the
startup error dialog (§2.8.2) and the close-to-tray question (§9.6) — come from a small en/ar table keyed by
`settings.ui_language`. A `ui_language` change makes `window::apply_settings` relabel the tray and re-send the media metadata.
Surah names in Rust strings use `name_ar` in the Arabic UI. The app's own name follows the UI language too
(`RustText::AppName` = `common.appName`: "Quran" / "قرآن"; Changed by LEAD 16) and heads the tray tooltip, the tray notice
and the close-to-tray dialog's caption; the OS-level name (window title, taskbar, installer, media flyout) is `productName`.

---

## 12. Testing and verification

### 12.1 Rust unit tests (per crate; run per crate with `cargo test -p <crate>`, all with `cargo test --workspace`)
| Crate | Must cover |
|---|---|
| quran-types | serde round trips for every DTO; JSON shape snapshots for tagged enums (`AppError`, `GapSetting`, `PackState`, `DownloadEvent`, `SearchScope`, `StartupNotice`); the committed `Settings::default()` JSON snapshot (camelCase names, §2.6); `Settings::validated` clamps (ui scale 80–200, ink 65–100) |
| quran-core | `normalize_vectors.json`; `build_match` escaping (quotes, phrases, prefix); Levenshtein; search id-range filters (surah, juz, both, empty intersection) applied in SQL with `total` from the same predicate; pack snippets built from `plain` for `arabic_normalized`; `sanitize_qdc` on synthetic JSON reproducing every quirk in FACT §5.2 (`[1]` segments, strings, floats, negative durations, null chapter row, backward positions); `pack_words` round trip; UserDb CRUD, undo, `reading_bookmark_clear`, highlight overlap split, `SETTING_FIELDS` covers every field exactly once, settings per-key fallback on corrupt JSON, migrations `validate()`, tombstone purge, memo scheduling table, `open_or_recover` quarantines a corrupt file; ContentDb pinned rows survive `clear_unpinned`; PackDbWriter → PackDb round trip + FTS per tokenizer; mini synthetic core DB (`tests/support/mini_core.rs`) for page assembly; `CoreDb::open` on a 0-byte file → `SchemaMismatch { found: 0 }` |
| quran-audio | planner (basmala for 2..114 except 9, none for 1, `basmala_in_file`, offline basmala skipped with the flag, cross-surah ranges, continuous `end = next.from`); decode state machine driven by `fake_out` (repeat ×N, range ×N, gap fixed/multiplier, A-B wrap, End): marker frames exact to ±0 frames; Sync markers every ~100 ms; WSOLA criteria (§2.3.5, incl. ±1 hop over 10 min and ±5 ms position after 5 min at 44.1 kHz); flush generations discard stale frames; seek accuracy on WAV fixtures (symphonia `wav`/`pcm` features in dev-dependencies only); output-event policy (`StreamInvalidated`/`DeviceNotAvailable` rebuild, `DeviceChanged` relabels only, one rebuild per generation); `QD_AUDIO_SINK=wav` run of 1:1–1:7 whose marker log matches the plan |
| quran-packs | catalog validation (ids, adapters, requires, `versionSource`, `wordLevel`); in-repo test HTTP server (`tests/support/http.rs`: Range, ETag, If-Range, 404, 429 Retry-After, mid-stream disconnect) → resume from the sidecar's `received` (never the file length), mirror fallback, retries; length ≠ Content-Length → never pinned; sha256 mismatch → Integrity; zip with one `*.sqlite` under any name accepted, two entries or a wrong schema rejected; single-writer registry (job waits for a live stream, then only pins); stale `.stream.part` cleanup; atomic install leaves the old version intact on failure; QuranEnc transform on a synthetic `translations` SQLite (footnote markers incl. Bengali digits); HTTP-validator update detection; tafsir grouped-row ranges; revalidation decisions (pinned audio keeps the old pair until the new one is complete); `clear_cache` re-sync marks packs partial |
| media-session | model mapping; noop backend; per-OS backends compile in CI |
| src-tauri | protocol `parse_range` table; path rejection (`..`, absolute, `%2e%2e`, drive prefixes); route allow-list incl. `font_bytes` path rules; `build_state` with a corrupt/0-byte core.db → `Fatal` (release policy) or degraded state (debug policy), never a panic; corrupt user.db → `UserDbRecovered`; `export_bindings` |

Live network tests are opt-in: `QD_NET_TESTS=1 cargo test -p quran-packs --test live -- --ignored` (WP5e).

### 12.2 Integration tests against a real core.db
Tests marked `#[ignore]` run with `QD_CORE_DB=<path> cargo test -p quran-core -- --ignored`. CI builds core.db inside the job
that runs them (§13.3):
- page assembly golden structure for pages 1, 2, 3, 187, 262, 600, 604 × 3 layouts
- `EXPLAIN QUERY PLAN` assertions
- p99 page query < 5 ms
- search goldens (G12 set plus "يا ايها" two-token words) and filtered searches
- `copy_vectors.json` (incl. 38:24 and 22:77)

### 12.3 Shared golden files (Rust ⇄ TS)
`crates/quran-core/tests/data/{normalize_vectors.json, copy_vectors.json}` and `src/lib/text/refparse.vectors.json`. Both
test suites read the same files, so a Rust or TS change can't silently diverge.

### 12.4 Data gates
`cargo xtask verify-core` (§4.5) runs in CI on every core build and before every release.

### 12.5 Frontend
- **Unit (vitest, jsdom, `pnpm test`):** normalize/refparse/copy vectors; `fitLayout` (the §8.2 acceptance table, `PW`/`PH`
  sums, `QFS_MIN`, dock choice), `paneCanDock`; `ayahPills`/`wordPill`; `paletteRule` (HC overrides, opaque ink); `toSpeech`
  vectors (1:1–7, 2:255, 38:24); player interpolation and `activeWord` (backward positions, gaps); shortcut matching (§7.7
  tests: Arabic layout fallback to `code`, AZERTY `?` and `q`, macOS `Mod`, `e.repeat`); i18n plural completeness, key parity
  and bidi-wrapped references; settings optimistic rollback; `call()` with object and string errors; `sanitize()` allowlist and
  `data-ref` handling; library undo/redo incl. the highlight snapshot; packs job map; token contrast (§9.2) and highlight
  composites (§8.7).
- **Component (vitest browser mode, chromium + webkit, `pnpm test:browser`):** `MushafPage` renders fixture pages with no layout
  shift during a simulated font swap (PerformanceObserver `layout-shift`); single-mode `.mp-block` x identical on pages 261/262;
  `HighlightLayer` rect snapshots; palette keyboard flow; Dialog focus trap; widget-guard tests (§7.7); `VirtualList`
  scroll-to-ayah.
- **Static:** `pnpm check` (svelte-check, TS ~6.0.3), `pnpm lint` (eslint), `pnpm format:check` (prettier), `pnpm lint:css`.

### 12.6 Visual verification
The harness exists from wave 1 day 1 (WP13a adopts the scaffold's `scripts/qa/*`), so every package can produce its own
evidence.
- **Scenario registry:** one file per scenario, `tests/e2e/scenarios/S{NN}.mjs`, exporting `default async function (ctx)` (the
  scaffold's scenario-module API: `ctx = { page, shot(name), wait(ms), log }`), plus `meta = { window: [w, h], ui: 'en'|'ar',
  theme, mode: 'web'|'app'|'both' }`. Each file is **owned by the package named in the table below**, so files stay disjoint.
- **Browser mock:** `pnpm shots:web -- --only S19,S20` (`node scripts/qa/web-shot.mjs --serve 1520 --registry
  tests/e2e/scenarios --only …`) starts `vite --mode mock`, runs the scenarios in the locally installed Edge/Chrome through
  `playwright-core` (no browser download), writes `artifacts/shots/web/S19.png`, and **fails on any page error or console
  error**. QCF fonts render when `data/dev-packs` is populated (§4.8).
- **Real app on Windows via CDP** (`pnpm shots:app`, `scripts/qa/app-driver.mjs`; WebView2 CDP is verified in Playwright's docs):
  1. `pnpm tauri build --debug --no-bundle`.
  2. The driver launches `target/debug/quran-desktop.exe` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`,
     `QD_TEST=1` and `QD_DATA_DIR=<temp or a prepared data dir>` (renamed from the scaffold's `QURAN_DESKTOP_QA`/
     `QURAN_DESKTOP_DATA_DIR`; both exist **only in debug builds**, D24).
  3. `chromium.connectOverCDP('http://127.0.0.1:9333')` and pick the page whose URL starts with `http://tauri.localhost` or
     `http://localhost:1420`.
  4. Drive the app through `window.__QD_TEST__` (`src/lib/testing/qdtest.ts`, WP13a; installed only when
     `bootstrap.app.testMode`): `goto(NavTarget)`, `setSettings(patch)`, `play(PlayRequest)`, `seek(ms)`, `pause()`,
     `openOverlay(kind)`, `waitIdle()` (no pending IPC, `document.fonts` ready, no running transitions), `metrics()` →
     `{ cls, longTasks, pageRenderMs[], glideFps, cspViolations }`.
  5. Write screenshots to `artifacts/shots/app/{id}.png` plus `metrics.json`. Compare to local, gitignored baselines with
     pixelmatch (threshold 0.1, ≤ 0.5 % differing pixels). Write an HTML report. Mushaf images are never committed to git.
- **Package acceptance vs review:** a package's acceptance is "the PNG exists for each owned scenario and there are no page or
  console errors". Lead visual review is a separate merge gate.
- **UI scale in the mock:** webview zoom (D27) exists only in the real app. Under `__MOCK_IPC__` the settings store applies CSS
  `zoom` on `<html>` as a preview approximation, so S24 and S29 run in the web mock for package acceptance and again in the real
  app (`meta.mode = 'both'`) at IC/WP13b time.
- Scenario list (window 1600×1000 unless noted):

| id | Scenario | Owner |
|---|---|---|
| S01 | Onboarding step 1 over the real page 1–2 spread, paper, English (v1.2: step 1 of 5, no Skip on a first run) | WP12c |
| S02 | Onboarding steps 2–3, Arabic UI (v1.2: the Mushaf step with the 1421 AH print, ornate headers and the live preview; then translation and recitation; offline lock) | WP12c |
| S03 | Pages 1–2 spread, hafs, paper, **no decor** (the plain look, signed off as the first-run look; lead sign-off) | WP8c |
| S04 | Pages 1–2 spread, qcf_v2, paper (opening medallion) | WP8c |
| S05 | Pages 3–4 spread, qcf_v2, sepia | WP8b |
| S06 | Pages 261–262 spread (15:1 header + basmala), qcf_v2, night | WP8c |
| S07 | Page 604 single, qcf_v2, black (3 headers, centred lines 4/9/14/15) | WP8a |
| S08 | Page 187, qcf_v2 (surah 9 header, no basmala) | WP8c |
| S09 | Page 50, qcf_v4, paper, tajweed on | WP8b |
| S10 | Page 50, qcf_v4, night, tajweed off (palette 4), ink 65 % and 100 % | WP8b |
| S11 | Page 600, qcf_v1, sepia (V1 layout differs from V2) + line-fit assertion | WP8b |
| S12 | Page 255, qcf_v2 (centred line 2) | WP8a |
| S13 | Page 176 (sajda and rub markers), margin labels, at 1600×1000 and at 1366×768 (glyph-only labels) | WP8c |
| S14 | 2:255 selected, side pane translation open | WP11b |
| S15 | Hover word + WBW tooltip (page 1) | WP8d |
| S16 | Audio paused at a fixed ms inside 1:2: ayah + word highlight | WP9a |
| S17 | Player dock with repeat popover open (×3, gap ×1.0), live "2/3" badge | WP9a |
| S18 | Five highlight colours + selection ring + bookmark margin marks (page 3) | WP8d |
| S19 | Search "الرحمن": sidebar results + hit highlight on page | WP10b |
| S20 | Command palette "2:255" | WP10c |
| S21 | Translation mode, surah 1, two translations, footnote popover open | WP11a |
| S22 | Tafsir tab, Arabic (muyassar), RTL | WP11b |
| S23 | Downloads manager with paused and failed jobs and an expanded SurahGrid | WP12a |
| S24 | Settings › Appearance, high_contrast, UI scale 150 % | WP12b |
| S25 | About / attribution | WP12c |
| S26 | Arabic UI (mirrored chrome), pages 261–262 spread, plus a dock close-up | WP7c |
| S27 | Memorisation hide (blur) on page 50 with 3 words revealed | WP9b |
| S28 | Zoom 200 %, page 262, scrolled | WP8e |
| S29 | 1024×700 window, UI scale 130 %: single page, qfs = 18, vertical scroll (assert qfs ≥ 18) | WP8e |
| S30 | Network disallowed: qcf_v2 selected, page 300 shows hafs fallback + offline dot | WP8b |
| S31 | `forced-colors: active` emulated (`page.emulateMedia({ forcedColors: 'active' })`), page 262 | WP8d |
| S32 | 1536×864, sidebar open, side pane open → single page at qfs 22.75, docked pane, no overlap | WP8e |
| S33 | All four margin marks (ayah bookmark, note, reading ribbon, page dog-ear), paper and night | WP8c |
| S34 | Ayah action bar after a click-selection on page 262 | WP8d |
| S35 | Relaunch (mock: reload) restores page 297 and shows the resume pill | WP8f |
| S36 | Translation mode at 1920×1080 (column, SurahCard, playing row) | WP11a |
| S37 | Side pane, Tafsir tab with a range entry and the stale footer | WP11b |

- **Integration checkpoints** (real app, Windows; each is the acceptance of the named package):
  - **IC1** (WP6a, needs 1a + 2b + 6a): `pnpm tauri build --debug --no-bundle && node scripts/qa/app-driver.mjs --scenario
    tests/e2e/scenarios/smoke.mjs` — the real app boots on a real core.db, renders page 1 in hafs through the real commands,
    and a settings change round-trips through user.db.
  - **IC2** (WP5e, needs 4d + 5e): with `QD_AUDIO_SINK=wav:artifacts/ic2.wav`, play 1:1–1:7 and assert the word-tick log;
    download the QCF v2 fonts for pages 1–3 and render page 1 in qcf_v2.
- **Metric assertions** (WP13b, real app, Windows):
  - CLS = 0 across a scripted 20-page navigation that includes 5 cold QCF font loads and a playback start
  - p95 `qd:page` < 16 ms; flip sustains 1 page / 70 ms
  - no long tasks > 50 ms during navigation
  - glide ≥ 58 fps (the engine on `QD_AUDIO_SINK=null`)
  - `#qd-v4-palettes` applied and **zero `securitypolicyviolation` events** (§6.4)
- **Screen-reader record:** WP8d's NVDA + OneCore Arabic and VoiceOver results for `toSpeech` (1:1–7, 2:255, 38:24) are kept here
  once the lead folds `docs/deviations/WP8d.md` in.
- **macOS and Linux:** CI builds plus a manual smoke checklist per release (WP13b):
  - launch, page render qcf_v2/v4, palette probe, `fontTransport` behaviour (§6.1)
  - audio play/seek/repeat/speed, device unplug and default-device switch
  - media keys / Now Playing (`playbackState` toggles) / MPRIS (player name and icon from the desktop entry)
  - tray, close-to-tray (first-close question), single instance, window-state restore, Dock reopen
  - the app icon in the taskbar/Dock and the About header
  
  `@wdio/tauri-service` automation is a post-v1 item.

---

## 13. Build, CI and release

### 13.1 `package.json` (owner WP0D; reconciled with the scaffold, which is the source of truth for names)
The lead's scaffold already exists; WP0D reconciles it to this list and the doc follows the scaffold where they differed
(`--mode mock` + compile-time `__MOCK_IPC__`, `scripts/qa/*`, `vitest.config.ts`, `capabilities/default.json`, `src/env.d.ts`,
pnpm 10.24.0, CDP port 9333).
```jsonc
{
  "name": "quran-desktop", "private": true, "version": "0.1.0", "type": "module",
  "engines": { "node": ">=22.12" }, "packageManager": "pnpm@10.24.0",
  "scripts": {
    "dev": "vite",                                   // used by tauri dev (beforeDevCommand)
    "dev:web": "vite --mode mock",                   // browser mock (__MOCK_IPC__ = true at compile time, D29)
    "build": "vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "app:dev": "tauri dev",
    "app:build": "tauri build",
    "check": "svelte-check --tsconfig ./tsconfig.app.json && tsc -p tsconfig.node.json",
    "lint": "eslint .",
    "lint:css": "node scripts/check-logical-css.mjs",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run --project unit",
    "test:browser": "vitest run --project browser",
    "test:watch": "vitest",
    "bindings": "cargo test -p quran-desktop --lib export_bindings",
    "bindings:check": "pnpm bindings && git add -N src/lib/ipc/bindings.ts && git diff --exit-code -- src/lib/ipc/bindings.ts",
    "core:qdc": "cargo xtask build-core --source qdc",          // scaffold's "data" renamed
    "core:qul": "cargo xtask build-core --source qul",
    "core:verify": "cargo xtask verify-core",                  // scaffold's "data:verify" renamed
    "fixtures": "cargo xtask export-fixtures",
    "dev-packs": "cargo xtask fetch-dev-packs",
    "assets": "cargo xtask fetch-assets",
    "shots:web": "node scripts/qa/web-shot.mjs --serve 1520 --registry tests/e2e/scenarios",
    "shots:app": "node scripts/qa/app-driver.mjs --registry tests/e2e/scenarios",
    "check:tooling": "node scripts/check-tooling.mjs",
    "check:dist": "node scripts/check-dist.mjs"
  }
}
```
Dependencies (exact versions; the scaffold already has most):
- **runtime:** `svelte 5.57.2`, `@tauri-apps/api 2.12.2`, `@tauri-apps/plugin-dialog 2.8.1`, `@tauri-apps/plugin-log 2.10.0`,
  `@tauri-apps/plugin-opener 2.7.0` and `@tauri-apps/plugin-os 2.4.0` (present in the scaffold and version-paired with the
  crates; the frontend calls neither, D22), `bits-ui 2.19.5`, `@internationalized/date 3.12.4`, `@lucide/svelte 1.54.0`,
  `virtua 0.53.3`, `paneforge 1.0.2`, `svelte-sonner 1.2.1`, `dompurify 3.4.16`, `@fontsource-variable/inter 5.3.0`,
  `@fontsource-variable/noto-naskh-arabic 5.3.0`, `@fontsource/ibm-plex-sans-arabic 5.3.0`.
- **dev:** `vite 8.3.4`, `@sveltejs/vite-plugin-svelte 7.3.1`, `typescript 6.0.3`, `svelte-check 4.7.6`, `@tsconfig/svelte 5.0.8`,
  `@tauri-apps/cli 2.12.1`, `vitest 5.0.3`, **`@vitest/browser-playwright 5.0.3`, `playwright 1.64.0`, `vitest-browser-svelte
  3.1.0`, `@testing-library/svelte 5.4.2`, `pixelmatch 8.0.0`, `pngjs 7.0.0`** (missing in the scaffold; WP0D adds them),
  `playwright-core 1.64.0` (scripts/qa), `jsdom 30.1.2`, `eslint 10.12.0`, `@eslint/js 10.0.1`, `typescript-eslint 8.71.1`,
  `eslint-plugin-svelte 3.23.1`, `prettier 3.9.9`, `prettier-plugin-svelte 4.1.1`, `globals 17.13.0`, `@types/node 24.19.2`.

Versions not already in FACT_SHEET or BRIEF (`@tauri-apps/plugin-dialog`, `plugin-log`, `dompurify`, `@internationalized/date`,
`pixelmatch`, `pngjs`, `playwright`) were read from npm on 2026-10-10.

`vite.config.ts` (WP0D; scaffold kept):
- `server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false, hmr: …1421…, watch: { ignored:
  ['**/src-tauri/**', '**/crates/**', '**/xtask/**', '**/target/**', '**/data/**'] } }`
- `envPrefix: ['VITE_', 'TAURI_ENV_*']`, `clearScreen: false`, `define: { __MOCK_IPC__: JSON.stringify(mode === 'mock') }`
- the default `build.target` (FACT C11), `build.sourcemap: !!process.env.TAURI_ENV_DEBUG`
- aliases `$lib`, `$components`, `$styles`
- the `devPacks()` plugin (`vite/dev-packs.ts`, WP8b) only when `mode === 'mock'`

`vitest.config.ts` (WP0D): `define: { __MOCK_IPC__: 'true' }`, the same aliases, and projects `unit` (jsdom,
`src/**/*.test.ts`) and `browser` (`@vitest/browser-playwright` provider, instances chromium and webkit,
`src/**/*.browser.test.ts`).

Other WP0D files: `.gitattributes` (`* text=auto eol=lf`), `.gitignore` additions (`src/lib/ipc/mock/fixtures/`, `data/dev-packs/`,
`public/fonts/*.ttf`, `artifacts/`, `tests/e2e/baselines/`, `src-tauri/resources/catalog.json` is **not** ignored),
`scripts/check-tooling.mjs` (asserts every command named in any §14.3 acceptance line resolves: `pnpm run` listing and
`cargo --list`), `scripts/check-dist.mjs` (§5.16, §6.4), `docs/DEVELOPING.md` (§14.2).

### 13.2 Cargo aliases (`.cargo/config.toml`, WP0A)
```toml
[alias]
xtask = "run --package xtask --"                          # scaffold form kept
lint = "clippy --workspace --all-targets -- -D warnings"  # integration checkpoints and CI only
bindings = "test -p quran-desktop --lib export_bindings"
```
Package acceptance lints only what the package owns: `cargo clippy -p <crate> --all-targets -- -D warnings` (§14.4), so one
package's work in progress never fails another package's definition of done.

### 13.3 GitHub Actions: `ci.yml` (on push and pull_request; owner WP-CI after WP0D's skeleton)
**Licensing rule for CI (BRIEF §4, FACT §2.1).** A qdc-built `core.db`, its fixtures, raw QF API responses and any installer or
bundle containing them are QF-derived and must not be distributed. Therefore, while the repository is **public**:
- core.db is built **inside each job that needs it** and is never uploaded (`upload-artifact`) or cached;
- the raw-response cache (`data/cache`) is used only when `github.event.repository.private` is true, and saved only on `push`
  to the default branch;
- jobs that build a qdc core.db do not run for pull requests from forks;
- `scripts/check-artifacts.mjs` runs before every `upload-artifact` step and fails if a path to upload is (or a zip/installer
  contains) a `.db`, a `fixtures/` tree, `data/cache`, `data/dev-packs` or a bundle, or any SQLite file whose
  `meta.source = 'qdc'`.

While the repository and its Actions are **private** (until §15.3 item 1 is resolved), the `core` step may additionally upload
`core.db` and `fixtures/` as 1-day artifacts for developers (`gh run download`), guarded by
`if: github.event.repository.private`.

**Shared setup** (composite action `.github/actions/setup/action.yml`, WP-CI), used by **every job that compiles `src-tauri`**:
node 22 + pnpm (version from `packageManager`), `pnpm i --frozen-lockfile`, `Swatinem/rust-cache`, on ubuntu the apt line below,
then `pnpm build` (so `dist/` exists for `generate_context!`, §5.15). The KFGQPC font from `cargo xtask fetch-assets` is cached
keyed by `hashFiles('xtask/assets.lock')`.

| Job | Runner(s) | Steps (after shared setup) |
|---|---|---|
| `lint` | ubuntu-22.04 | `cargo fmt --check`; `cargo lint`; `pnpm lint`; `pnpm format:check`; `pnpm lint:css`; `pnpm check`; `pnpm check:tooling`; `pnpm check:dist` |
| `test-rust` | ubuntu-22.04, windows-latest, macos-latest | `cargo test --workspace` (unit; no core.db needed thanks to the build.rs placeholder) |
| `test-web` | ubuntu-22.04 | `pnpm test`; `pnpm bindings:check` |
| `test-core` | ubuntu-22.04 (not for fork PRs) | `cargo xtask build-core --source qdc` (data cache only when private) → `verify-core` → `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core -- --ignored` → `cargo xtask export-fixtures` → `pnpm exec playwright install --with-deps chromium webkit` → `pnpm test:browser` → `pnpm shots:web` (screenshots uploaded only when private) |
| `build` | windows-latest, macos-latest, ubuntu-22.04 (not for fork PRs) | `cargo xtask fetch-assets`; build core.db in-job; assert size > 1 MB and `verify-core`; `QD_REQUIRE_CORE=1 pnpm tauri build --debug --no-bundle`. On Windows also the **size check**: move the in-job core.db aside (measure its LZMA-compressed size), let build.rs recreate the 0-byte placeholder, run `pnpm tauri build --bundles nsis` (`QD_REQUIRE_CORE` unset), and record installer size + compressed core.db size against the §13.6 budget; neither file is uploaded |

Linux packages (Tauri v2 prerequisites plus ALSA for cpal), installed by the shared setup on **every** ubuntu job:
```
sudo apt-get install -y build-essential pkg-config curl wget file patchelf libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libasound2-dev
```
Rust toolchain from `rust-toolchain.toml`. Caching: `Swatinem/rust-cache` and the pnpm store. Use node 22. The drift check
(`pnpm bindings:check`) must fail on a PR that changes a DTO without regenerating `bindings.ts`, and pass on a docs-only PR
(WP-CI acceptance).

### 13.4 `release.yml` (tags `v*`; owner WP13b)
- Matrix:
  - windows-latest: NSIS.
  - macos-latest: `--target universal-apple-darwin`, a single dmg. Add the `aarch64-apple-darwin` and `x86_64-apple-darwin` rustup
    targets. This avoids depending on retired Intel runner images.
  - ubuntu-22.04: deb and AppImage. The old glibc baseline is deliberate.
  
  Uses `tauri-apps/tauri-action`, pinned to a commit SHA when the workflow is created.
- `core.db` uses `--source qul`. QUL inputs come from a private store (`QUL_SOURCES_URL` + token secrets) because they are
  not public. **Release is blocked until the QUL/QF permission in FACT §8.1 is obtained.** With `QD_REQUIRE_CORE=1`, the job
  asserts core.db > 1 MB, `verify-core` passes and `meta.source = 'qul'` before `tauri build`.
- Artifacts are uploaded to a draft GitHub release. Signing and notarisation are open (§15.3).

### 13.5 Bundle configuration
`tauri.conf.json` (base, WP0A, frozen):
```json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "Quran",
  "mainBinaryName": "quran-desktop",
  "version": "0.1.0",
  "identifier": "com.quran.labs.desktop",
  "build": { "beforeDevCommand": "pnpm dev", "devUrl": "http://localhost:1420", "beforeBuildCommand": "pnpm build",
             "frontendDist": "../dist", "removeUnusedCommands": true },
  "app": {
    "withGlobalTauri": false,
    "windows": [{ "label": "main", "title": "Quran", "width": 1440, "height": 940, "minWidth": 760, "minHeight": 600,
                  "center": true, "visible": false, "decorations": true, "dragDropEnabled": false, "zoomHotkeysEnabled": false }],
    "security": { "csp": { "…": "§6.4" }, "devCsp": { "…": "§6.4" }, "dangerousDisableAssetCspModification": ["style-src"],
                  "capabilities": ["default"] }
  },
  "bundle": {
    "active": true,
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "resources": { "resources/core.db": "data/core.db", "resources/catalog.json": "data/catalog.json" },
    "category": "Education", "shortDescription": "Quran reader with recitation",
    "publisher": "Quran for Desktop contributors", "copyright": "© Quran for Desktop contributors",
    "license": "GPL-3.0-or-later"
  }
}
```
`minHeight` is 600 (was 560): below that the fitted page would fall far under `QFS_MIN`.
Identity (Changed by LEAD 16): `productName` "Quran" names the window, the installer (`Quran_<version>_x64-setup.exe`,
`%LOCALAPPDATA%\Quran`, Start-menu `Quran.lnk` stamped with the AUMID), the macOS bundle (`Quran.app`) and the Linux
desktop file (`Quran.desktop`); `publisher` is the exe's CompanyName and the Apps list's publisher (it would otherwise be
"quran", the identifier's second element). `lib.rs` tests that `APP_ID`, the name, the licence, the copyright and the
publisher match this file; `media.rs` tests that `DESKTOP_ENTRY` equals `productName`.

Platform overrides (WP6b). Arrays are **replaced whole** (JSON Merge Patch), so each file repeats the full window object.
- `tauri.windows.conf.json`: window `decorations:false, transparent:true, shadow:true, noRedirectionBitmap:true,
  windowEffects:{effects:["mica"]}, scrollBarStyle:"fluentOverlay"`. Bundle `targets:["nsis"]`,
  `windows.nsis:{installMode:"currentUser", compression:"lzma"}`, `windows.webviewInstallMode:{type:"downloadBootstrapper"}`.
- `tauri.macos.conf.json`: window `titleBarStyle:"Overlay", hiddenTitle:true, trafficLightPosition:{x:16,y:20}, transparent:true,
  windowEffects:{effects:["sidebar"], state:"followsWindowActiveState"}`. Bundle `targets:["app","dmg"]`,
  `macOS:{minimumSystemVersion:"13.3", hardenedRuntime:true}`.
- `tauri.linux.conf.json`: window `decorations:true, transparent:false`. Bundle `targets:["deb","appimage"]`,
  `linux.deb.depends:["libasound2 | libasound2t64"]`, and `icon` with the tuned `icons/tray/tray-32.png` first (tauri-codegen
  makes the first PNG the window icon), then `tray-16`, `tray-24`, `64x64`, `128x128`, `128x128@2x` and `icon.png` (512):
  one hicolor icon per size (LEAD 16/18). The AppImage has no `bundleMediaFramework` (native audio; FACT C10).
  WP6d inspects the built .deb for the installed `.desktop` file name and pins `SessionConfig.desktop_entry` to its basename
  (§2.4).

`capabilities/default.json` (created by WP0A, owned by WP6b):
```json
{ "$schema": "../gen/schemas/desktop-schema.json", "identifier": "default", "windows": ["main"],
  "platforms": ["linux", "macOS", "windows"],
  "permissions": ["core:default", "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-close",
                  "core:window:allow-start-dragging", "core:window:allow-set-fullscreen", "core:window:allow-is-fullscreen",
                  "core:window:allow-set-always-on-top", "dialog:allow-open", "dialog:allow-save", "log:default"] }
```
The probe validated `core:default`, the minimise/toggle-maximise/close/start-dragging window permissions and `log:default`.
The others are standard Tauri 2 identifiers, validated at build time. A typo fails the build, so the risk is low. No `os:`
permission (D22) and no webview-zoom permission: UI zoom is applied from Rust (`WebviewWindow::set_zoom`, D27; the JS route
would need `core:webview:allow-set-webview-zoom`, which exists in tauri 2.12.2 but is not granted).

Plugins registered in `lib.rs` (§2.8.1):
1. `single-instance` (first). On a second launch it focuses the window and forwards argv `quran-desktop://…` as
   `NavigateRequested` (stretch).
2. `log`: Info level (Debug in debug builds); targets LogDir + Stdout in debug.
3. `opener`.
4. `dialog`.
5. `os` (Rust-side use only, D22).
6. `window-state`, with flags `SIZE | POSITION | MAXIMIZED | FULLSCREEN` (never `VISIBLE`, so show-after-ready works; never
   `DECORATIONS`).

### 13.6 Size and runtime targets
| Target | Budget |
|---|---|
| Windows NSIS installer | ≤ 8 MB (CI: placeholder-core installer + measured compressed core.db, §13.3; release: real) |
| macOS dmg (universal) | ≤ 25 MB |
| deb / AppImage | ≤ 9 MB / ≤ 90 MB |
| installed footprint (without packs) | ≤ 35 MB |
| `dist/` (frontend bundle, no mock/fixtures) | ≤ 6 MB (`check:dist`) |
| cold start to first paint (Windows, SSD) | ≤ 800 ms |
| RSS with a spread + playback | ≤ 350 MB (webview included) |
| idle CPU (no playback, window visible) | ≈ 0 % (no timers when idle) |
| playback CPU at 1.0× / 1.5× | ≤ 3 % / ≤ 6 % of one core |

---

## 14. Work packages (parallel implementation plan)

### 14.1 Waves and critical path
Every package is sized for **one engineer (agent) session of 2–4 hours**. A package starts as soon as everything in its
"Depends on" line has merged; waves are only a coarse schedule. With up to 12 agents in parallel this is about five rounds plus
two integration checkpoints.
- **Wave 0, contract and skeleton (5 packages).** WP0A (Rust contract) → WP0B (crate skeletons) and WP0C (frontend skeleton)
  → WP0E (working L0 stores); WP0D (tooling) runs alongside WP0A. **Critical path: 0A → 0C → 0E (≈ 9 h in three sessions);**
  0B and 0D run off the critical path. Wave 0 ends with the lead's exit gate: every wave-0 acceptance command plus
  `pnpm check:tooling` green on a fresh clone.
- **Wave 1, foundations (14 packages):** WP1a, WP1c, WP2b, WP3a, WP4a, WP5a, WP6c, WP7a, WP7b, WP7c, WP8a, WP10a, WP13a,
  WP-Brand. WP1a delivers page/index fixtures and WP3a the qdc core.db (milestone **M1**) on their first day, and WP2b delivers
  `user_db/packs.rs` first (WP5b registry).
- **Wave 2, features (32 packages):** everything else except WP13b, started as dependencies land. Integration checkpoints:
  **IC1** (owned by WP6a: real app boots on a real core.db) and **IC2** (owned by WP5e: playback + font download in the real
  app), §12.6.
- **Wave 3, release (WP13b):** release pipeline, budgets, metric assertions, cross-OS smoke.

### 14.2 Shared-file protocol (no two packages write the same file)
- **Ownership is exclusive and listed per package (§14.3).** "A → B" in §2/§7 means A creates the file and B owns it after A
  merges. Owners never edit another package's file; they ask its owner (or the lead) instead.
- **Contract files** (frozen after wave 0): `crates/quran-types/**`, `src-tauri/src/{lib.rs, main.rs, util.rs, ipc/**,
  commands/mod.rs}`, `src-tauri/{Cargo.toml, build.rs, tauri.conf.json}`, `src/lib/ipc/{bindings.ts, index.ts, mock/{index,
  runtime, result, state, fixtures, synthetic}.ts}`, `src/lib/contracts/**`, `src/lib/stores/index.ts`,
  `src/lib/i18n/{en,ar}/{index, common, shortcuts, errors}.ts`, `src/lib/text/html.ts`, `src/components/ui/SafeHtml.svelte`,
  the schema/migration SQL, `crates/*/src/lib.rs` and the frozen crate-internal contracts (`quran-audio/{traits,shared,error}.rs`,
  `quran-packs/{error.rs, adapters/mod.rs}`, `quran-core/error.rs`), `xtask/src/{main.rs, cli.rs, fixtures/mod.rs}`.
  A **contract PR**:
  - touches only those files plus the regenerated `bindings.ts`, and appends an entry to `docs/contract-changes.md`;
  - is reviewed by the lead within 24 h; additive changes (a new command, an `Option` field) are preferred;
  - does **not** edit mock handlers or other packages' files: each handler owner fixes its own handler when `pnpm check` fails
    after the merge.
- **Dependencies and lockfiles.** WP0A writes the root `[workspace.dependencies]` (§2.1) and WP0B every crate's
  `[dependencies]`/`[dev-dependencies]` in full, so `Cargo.lock` is final after wave 0; WP0D does the same for `package.json`.
  Wave-1+ packages do not add dependencies; a request goes to the lead as one contract PR. `Cargo.lock` and `pnpm-lock.yaml`
  are generated files: on a conflict, take main's lockfile and re-run `cargo metadata` / `pnpm install --lockfile-only`; never
  hand-merge.
- **Deviations.** A package never edits `docs/ARCHITECTURE.md`. Any deviation from this document is recorded in the package's own
  `docs/deviations/WPxx.md` (one file per package); the lead folds them into this document between waves.
- **Placeholders (wave 0).** WP0A/0B/0C create every file listed in §2, §4.1 and §7.1 with compiling stubs, final export names
  and the §7.9 props. **Openers and constructors return `Ok` with inert handles that do no IO** (`CoreDb`, `UserDb`, `ContentDb`,
  `PackManager`, `AudioService`, `MediaSession`), so the skeleton app boots, manages `AppState` and shows its window; only query
  and mutation methods return `NotImplemented` (crates) or `AppError::Unsupported("not implemented: <cmd>")` (commands). Svelte
  placeholders render a labelled box with the final props.
- **Wave-0 working L0 stores** (WP0E): `app` (bootstrap data, fatal screen), `settings` (`value` + `update()` round trip),
  `i18n` (`t`/`tp` over the dictionaries, key fallback), `quran` (all §7.3 lookups except `surahMatches`), `ui` (overlay stack,
  floating counter, sidebar/side-pane toggles, a `toast` passthrough), `shortcuts` (both listeners, widget guard, hybrid
  matching, §7.7). The owners in §14.3 complete them, keeping the exported names.
- **`.gitignore`** (WP0D, merged with the scaffold's): `/target`, `/dist`, `/node_modules`, `src-tauri/resources/core.db*`,
  `src/lib/ipc/mock/fixtures/`, `data/cache/`, `data/dev-packs/`, `data/sources/qul/*` (except `manifest.toml`/`.gitkeep`),
  `public/fonts/*.ttf`, `artifacts/`, `tests/e2e/baselines/`.
- **Developer runbook** `docs/DEVELOPING.md` (WP0D): setup (node 22, pnpm 10.24, Rust 1.99), env vars (`QD_TEST`,
  `QD_DATA_DIR`, `QD_CORE_DB`, `QD_PACKS_DIR`, `QD_AUDIO_SINK`, `QD_REQUIRE_CORE`, `QD_NET_TESTS`), how to build core.db
  (`pnpm core:qdc`) and fixtures (`pnpm fixtures`) or download them (private repo only), `pnpm dev-packs`, the Windows note that
  `%USERPROFILE%\.cargo\bin` is not on the Git-Bash PATH (FACT C9), the short-path rule for MAX_PATH (FACT §9), and the common
  failures (missing `dist/`, placeholder core.db, WebView2 CDP port busy).

### 14.3 Packages
Acceptance lines are exact commands; "PNG" means `pnpm shots:web --only …` wrote the scenario images with no page or console
errors (lead visual review is a separate merge gate). Every package also meets §14.4.

#### Wave 0
**WP0A: Rust contract and app skeleton** (≈ 3.5 h)
- Owns (frozen): `Cargo.toml`, `rust-toolchain.toml`, `.cargo/config.toml`, `crates/quran-types/**`, `src-tauri/{Cargo.toml,
  build.rs, tauri.conf.json}`, `src-tauri/src/{main.rs, lib.rs, util.rs, ipc/**, commands/mod.rs}`, `src/lib/ipc/bindings.ts`.
  Creates and hands over: `src-tauri/src/commands/{app, system, mushaf, quran, search, content, packs, audio, user_library,
  user_study, settings}.rs`, `src-tauri/src/{state, setup, protocol, window, tray, i18n, media, audio_glue, packs_glue}.rs`,
  `src-tauri/capabilities/default.json`.
- Depends on: —
- Deliverables: all §5 DTOs with `Settings::default/validated` and the JSON snapshot test; every §5.13 command stub (state-less
  where convenient, §2.8.1) and every event; `font_bytes` raw stub and the lib.rs dispatch; `build.rs` placeholder logic
  (§5.15); a minimal `state.rs`/`setup.rs` that boots and shows the window; hook stubs with tauri/quran-types-only signatures
  (window, tray, i18n, protocol); empty `media.rs`/`audio_glue.rs`/`packs_glue.rs`; `bindings.ts` generated.
- Acceptance: on a fresh clone with no core.db: `pnpm build`; `cargo build -p quran-desktop`; `cargo test -p quran-types`;
  `cargo test -p quran-desktop`; `cargo clippy -p quran-types -p quran-desktop --all-targets -- -D warnings`;
  `pnpm bindings:check`.

**WP0B: Rust crate skeletons** (≈ 3.5 h)
- Owns (frozen): `crates/quran-core/{Cargo.toml, schema/**, migrations/**, src/lib.rs, src/error.rs, tests/support/mod.rs}`,
  `crates/quran-core/src/normalize.rs`, `crates/quran-core/tests/data/normalize_vectors.json`, `crates/quran-audio/{Cargo.toml,
  src/lib.rs, src/error.rs, src/traits.rs, src/shared.rs}`, `crates/quran-packs/{Cargo.toml, src/lib.rs, src/error.rs,
  src/adapters/mod.rs}`, `xtask/{Cargo.toml, src/main.rs, src/cli.rs, src/fixtures/mod.rs}`, `Cargo.lock` (generated).
  Creates and hands over: every other module file of §2.2–§2.5 and §4.1 (stubs with final signatures), the whole
  `crates/media-session/**`; takes over `src-tauri/src/{state, setup, media, audio_glue, packs_glue}.rs` from WP0A to add the
  crate-typed `AppState` fields, the inert boot path and the crate-typed hook stubs, then hands them to WP6a/WP6c/WP4d/WP5e.
- Depends on: WP0A
- Deliverables: §3 SQL verbatim; `normalize_ar` fully implemented with the golden vectors; frozen crate-internal contracts
  (`traits.rs`, `shared.rs`, `adapters/mod.rs`); full dependency lists (Cargo.lock final); inert constructors (§14.2).
- Acceptance: `cargo build --workspace`; `cargo test -p quran-core --lib normalize`; `cargo lint`;
  `pnpm tauri build --debug --no-bundle && node scripts/qa/app-driver.mjs --shot startup` writes a non-blank PNG and the app
  log contains no `panicked`.

**WP0C: Frontend contract and skeleton** (≈ 3.5 h)
- Owns (frozen): `src/main.ts`, `src/lib/ipc/index.ts`, `src/lib/ipc/mock/{index, runtime, result, state, fixtures,
  synthetic}.ts`, `src/lib/contracts/**`, `src/lib/stores/index.ts`, `src/lib/i18n/{en,ar}/{index, common, shortcuts,
  errors}.ts`, `src/lib/text/html.ts`, `src/components/ui/SafeHtml.svelte`, `src/styles/mushaf/index.css`.
  Creates and hands over: every component, store, shortcut, mushaf-lib, text-lib and domain-dictionary file of §7.1 and §11.1
  (placeholders with final names and props), `src/App.svelte`, the mock `handlers/*.ts` stubs, `src/lib/testing/qdtest.ts`.
- Depends on: WP0A (bindings.ts)
- Deliverables: §5.16 wrapper (`__MOCK_IPC__`, `call()` normalisation, `fontBytes`), §5.17 runtime/state/fallbacks, the
  synthetic generator, §7.9 contracts, the complete `shortcuts`/`common`/`errors` dictionaries in en and ar (§11.1), DOMPurify
  config and `SafeHtml` (§7.6).
- Acceptance: `pnpm check`; `pnpm lint`; `pnpm exec vitest run --project unit src/lib/ipc src/lib/i18n`;
  `pnpm build && pnpm check:dist`; `node scripts/qa/web-shot.mjs --serve 1520 --name shell` (shell with synthetic pages, no
  page errors).

**WP0D: Tooling and repository hygiene** (≈ 2.5 h)
- Owns: `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `vitest.config.ts`, `svelte.config.js`, `tsconfig*.json`,
  `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.gitattributes`, `index.html`, `src/env.d.ts`,
  `scripts/check-tooling.mjs`, `scripts/check-dist.mjs`, `docs/DEVELOPING.md`. Creates and hands over:
  `src/lib/about/thirdparty.json` (`[]` → WP3c), `.github/workflows/ci.yml` and `.github/actions/setup/**` (skeleton →
  WP-CI), `scripts/qa/**` (adopted, env vars renamed to `QD_TEST`/`QD_DATA_DIR`, output `artifacts/shots` → WP13a).
- Depends on: —
- Deliverables: §13.1 reconciliation (scripts, devDependencies, aliases, `--mode mock`), ESLint `no-restricted-imports` and the
  single `SafeHtml` exception, `.gitattributes`, the runbook.
- Acceptance: `pnpm i --frozen-lockfile`; `pnpm lint`; `pnpm format:check`; `pnpm build && pnpm check:dist`;
  `git check-attr eol -- src/lib/ipc/bindings.ts` prints `lf`.

**WP0E: Working L0 stores** (≈ 3 h)
- Owns (then hands to WP7c and WP10a): `src/lib/stores/{app, settings, ui, shortcuts, i18n, quran}.svelte.ts`,
  `src/lib/i18n/index.ts`, `src/lib/shortcuts/{index, app}.ts`.
- Depends on: WP0C
- Deliverables: §14.2 minimal working stores, including the §7.7 listener (two phases, widget guard, hybrid matching).
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores src/lib/shortcuts src/lib/i18n`; `pnpm check`;
  `node scripts/qa/web-shot.mjs --serve 1520 --name shell-stores` shows every sidebar tab.

#### Wave 1
**WP1a: CoreDb, mushaf/quran commands, page fixtures** (≈ 3.5 h)
- Owns: `crates/quran-core/src/core_db/**`, `crates/quran-core/tests/support/mini_core.rs`, `crates/quran-core/tests/core_*.rs`,
  `crates/quran-core/tests/data/copy_vectors.json`, `src-tauri/src/commands/{mushaf, quran}.rs`, `xtask/src/fixtures/mushaf.rs`.
- Depends on: WP0B. Until WP3a's M1 core.db lands: the synthetic `mini_core.rs`; then real-DB tests and fixture export.
- Deliverables: §2.2.4 (incl. `unavailable()`), §3.1.4 queries, page assembly, the mushaf/quran commands, `copy_vectors.json`
  (incl. 38:24, 22:77), `export-fixtures --only mushaf` (index, pages, ayahs) on day 1.
- Acceptance: `cargo test -p quran-core --lib core_db`; `cargo test -p quran-core --test 'core_*'`;
  `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core --test 'core_*' -- --ignored`;
  `cargo test -p quran-desktop --lib -- commands::mushaf commands::quran`; `cargo clippy -p quran-core --all-targets -- -D warnings`;
  `cargo xtask export-fixtures --only mushaf`.

**WP1c: ContentDb, PackDb, timings** (≈ 3.5 h)
- Owns: `crates/quran-core/src/{content_db, pack_db}/**`, `crates/quran-core/src/timings.rs`,
  `crates/quran-core/tests/{content_*, pack_*, timings_*}.rs`, `xtask/src/fixtures/content.rs`.
- Depends on: WP0B
- Deliverables: §2.2.7 (pinned rows, `clear_unpinned`, `open_or_recover`), §3.3, §3.4, `sanitize_qdc`, synthetic
  translation/tafsir/WBW/timing fixtures (§4.6).
- Acceptance: `cargo test -p quran-core --lib -- content_db pack_db timings`; `cargo test -p quran-core --test 'content_*' --test
  'pack_*' --test 'timings_*'`; `cargo clippy -p quran-core --all-targets -- -D warnings`; `cargo xtask export-fixtures --only
  content`.

**WP2b: UserDb core, study data and settings** (≈ 3.5 h)
- Owns: `crates/quran-core/src/user_db/{mod, migrations, positions, history, search_history, memo, presets, settings, packs,
  backup}.rs`, `crates/quran-core/tests/support/user.rs`, `crates/quran-core/tests/userdb_*.rs`,
  `src-tauri/src/commands/{user_study, settings}.rs`.
- Depends on: WP0B. Delivers `user_db/packs.rs` first (WP5b needs the registry).
- Deliverables: open/`open_or_recover`, migrations, `SETTING_FIELDS`, settings persistence per key, memo scheduling (§5.10),
  positions/history/search history (scope JSON), presets, backup, `SettingsChanged`/`UserDataChanged` emission, the
  `settings_set` hook calls (window, packs, audio).
- Acceptance: `cargo test -p quran-core --lib -- user_db::migrations user_db::positions user_db::history user_db::search_history
  user_db::memo user_db::presets user_db::settings user_db::packs user_db::backup`; `cargo test -p quran-core --test
  'userdb_*'`; `cargo test -p quran-desktop --lib -- commands::settings commands::user_study`;
  `cargo clippy -p quran-core --all-targets -- -D warnings`.

**WP3a: qdc build pipeline (M1)** (≈ 4 h + network time)
- Owns: `xtask/src/build/{mod, model, qdc, tanzil, derive, write}.rs`, `xtask/data/**`, `xtask/tests/build_*.rs`.
- Depends on: WP0B
- Deliverables: §4.2 and §4.4 (D6 per-field division sources, `division_exceptions.toml`), deterministic `write.rs`;
  `verify.rs` is still WP0B's stub until WP3b.
- Acceptance: `cargo test -p xtask --test 'build_*'`; `cargo xtask build-core --source qdc` writes
  `src-tauri/resources/core.db` (warm cache < 10 min); two builds with the same `SOURCE_DATE_EPOCH` have identical sha256;
  `cargo clippy -p xtask --all-targets -- -D warnings`.

**WP4a: DSP (WSOLA, resampler, mix)** (≈ 3.5 h)
- Owns: `crates/quran-audio/src/dsp/**`, `crates/quran-audio/tests/dsp_*.rs`.
- Depends on: WP0B
- Deliverables: §2.3.5 (`p_k = round(k·Hs·α)`, `nominal_input_pos()`), rubato wrapper with exact frame ratio and delay, fades
  and channel map.
- Acceptance: `cargo test -p quran-audio --lib dsp`; `cargo test -p quran-audio --release --test 'dsp_*'` (±1 hop over 10 min,
  ±5 ms after 5 min at 44.1 kHz, sine continuity, ±1 % pitch at 1.5×, CPU < 3 %); `cargo clippy -p quran-audio --all-targets
  -- -D warnings`.

**WP5a: Catalog** (≈ 3 h)
- Owns: `crates/quran-packs/src/catalog.rs`, `crates/quran-packs/tests/catalog_*.rs`, `src-tauri/resources/{catalog.json,
  catalog.schema.json}`, `xtask/src/catalog.rs`, `xtask/src/fixtures/packs.rs`.
- Depends on: WP0B
- Deliverables: §2.5.4 model and seed content (`versionSource`, `wordLevel`, `decor.nastaliq`), starter-set definition,
  `catalog-check [--online]` (HEADs every URL incl. every QuranEnc zip; one-time `wordLevel` probe), `fixtures/packs/list.json`.
- Acceptance: `cargo test -p quran-packs --lib catalog`; `cargo test -p quran-packs --test 'catalog_*'`;
  `cargo xtask catalog-check`; `cargo xtask catalog-check --online`; `cargo xtask export-fixtures --only packs`;
  `cargo clippy -p quran-packs --all-targets -- -D warnings`.

**WP6c: media-session (model, Windows SMTC, noop) and media glue** (≈ 3 h)
- Owns: `crates/media-session/{Cargo.toml, src/{lib, error, model, windows, noop}.rs, tests/**, examples/**}`,
  `src-tauri/src/media.rs`.
- Depends on: WP0B
- Deliverables: §2.4 Windows backend; **first task: the runtime check** of `GetForWindow` on the MTA thread
  (`examples/smtc_check.rs`), with the `run_on_main_thread` fallback if it fails (recorded in `docs/deviations/WP6c.md`);
  media.rs mapping (localised metadata).
- Acceptance: `cargo test -p media-session`; `cargo run -p media-session --example smtc_check` on Windows prints `SMTC ok`;
  `cargo clippy -p media-session --all-targets -- -D warnings`.

**WP7a: Tokens and base styles** (≈ 2.5 h)
- Owns: `src/styles/{tokens, base, fonts}.css`, `src/app.css`, `src/styles/tokens.test.ts`, `scripts/check-logical-css.mjs`.
- Depends on: WP0C, WP0D
- Deliverables: §9.1–§9.4 verbatim (incl. HC dark, `.quran-text`, translucency rule), the contrast test (§9.2), the logical-CSS
  and Quran-text lint.
- Acceptance: `pnpm exec vitest run --project unit src/styles`; `pnpm lint:css`; `pnpm check`.

**WP7b: UI primitives** (≈ 3.5 h)
- Owns: `src/components/ui/**` except `SafeHtml.svelte`.
- Depends on: WP0C, WP7a
- Deliverables: §9.5 (dir pass-through, floating registration, input borders, toast durations), browser tests.
- Acceptance: `pnpm exec vitest run --project browser src/components/ui` (Dialog focus trap, Menu keyboard and typeahead,
  Slider keys, Select in RTL); `pnpm check`; `pnpm lint`; `pnpm lint:css`.

**WP7c: Shell, L0 store completion and shortcut runtime** (≈ 4 h)
- Owns: `src/App.svelte`, `src/components/shell/**`, `src/components/dialogs/{ShortcutSheet, ShortcutTable,
  ConfirmDialog}.svelte`, `src/lib/stores/{app, settings, ui, shortcuts, i18n}.svelte.ts`, `src/lib/i18n/index.ts`,
  `src/lib/i18n/{en,ar}/shell.ts`, `src/lib/shortcuts/{index, app}.ts`, `src/lib/util/**`,
  `src/lib/ipc/mock/handlers/{app, settings}.ts`, `tests/e2e/scenarios/S26.mjs`.
- Depends on: WP0E, WP7b
- Deliverables: §7.2–§7.4 for the owned stores, §7.7 complete with the widget-guard tests, §9.6 shell (PaneLayout with
  `paneCanDock`, zen, Snap Layouts tooltip, landmarks), `FatalScreen`/`StartupBanner`, §11 runtime, undo-toast plumbing.
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores src/lib/shortcuts src/lib/i18n src/lib/util`;
  `pnpm exec vitest run --project browser src/components/shell src/lib/shortcuts`; `pnpm check`; `pnpm lint`;
  `pnpm shots:web --only S26`.

**WP8a: Geometry, page and glyph layer** (≈ 4 h)
- Owns: `src/lib/mushaf/geometry.ts`, `src/components/mushaf/{MushafPage, GlyphLayer}.svelte`,
  `src/styles/mushaf/{page, lines}.css`, `src/lib/stores/pages.svelte.ts`, `src/lib/ipc/mock/handlers/mushaf.ts`,
  `src/lib/i18n/{en,ar}/mushaf.ts`, `tests/e2e/scenarios/{S07, S12}.mjs`.
- Depends on: WP7a, WP0C. Until WP1a's fixtures: synthetic pages.
- Deliverables: §8.2 (`fitLayout`, `paneCanDock`, constants, acceptance table), §8.3, §8.4 (bounded line-fit), pages store,
  mushaf mock handler (fixture pages, synthetic outside the list).
- Acceptance: `pnpm exec vitest run --project unit src/lib/mushaf/geometry`; `pnpm exec vitest run --project browser
  src/components/mushaf/MushafPage`; `pnpm check`; `pnpm shots:web --only S07,S12`.

**WP10a: Quran index store, navigation and Go to** (≈ 3 h)
- Owns: `src/lib/stores/quran.svelte.ts`, `src/lib/text/{normalize.ts, refparse.ts, refparse.vectors.json}`,
  `src/components/index/**`, `src/components/dialogs/GoToDialog.svelte`, `src/lib/i18n/{en,ar}/navigation.ts`.
- Depends on: WP0E, WP7b
- Deliverables: quran store completion (`surahMatches`, `surahRange`, `juzRange`), the TS normaliser (shared vectors),
  refparse, IndexPanel/SurahList (§9.7), `ContinueCard` (§7.8), Go to.
- Acceptance: `pnpm exec vitest run --project unit src/lib/text src/lib/stores/quran`; `pnpm exec vitest run --project
  browser src/components/index`; `pnpm check`.

**WP13a: QA harness** (≈ 2.5 h)
- Owns: `scripts/qa/**` (from WP0D), `tests/e2e/lib/**`, `tests/e2e/scenarios/smoke.mjs`, `src/lib/testing/qdtest.ts`.
- Depends on: WP0C, WP0D
- Deliverables: scenario registry and `--only` (§12.6), page/console-error failure, `window.__QD_TEST__`.
- Acceptance: `pnpm shots:web --only smoke`; `pnpm tauri build --debug --no-bundle && pnpm shots:app --only smoke` (Windows).

**WP-Brand: App icon and brand assets** (≈ 2 h)
- Owns: `assets/brand/**`, `src-tauri/icons/**`, `src/assets/**`.
- Depends on: —
- Deliverables: §9.9 (master SVG, OS exports, tray template icons, `app-icon.svg`, `star8.svg`).
- Acceptance: `pnpm tauri icon assets/brand/icon.png` regenerates the committed set without diff; `src-tauri/icons/icon.png`
  differs from the Tauri default; lead sign-off.

#### Wave 2
**WP1b: Search** (≈ 3.5 h)
- Owns: `crates/quran-core/src/search/**`, `crates/quran-core/tests/search_*.rs`, `src-tauri/src/commands/search.rs`,
  `xtask/src/fixtures/search.rs`.
- Depends on: WP1a, WP1c (PackDb for pack scope), WP2b (notes scope via UserDb)
- Deliverables: §2.2.5 (SQL range filters, Rust snippets from `plain`, `words`/`first_word_id`), search fixtures (§4.6).
- Acceptance: `cargo test -p quran-core --lib search`; `cargo test -p quran-core --test 'search_*'`;
  `QD_CORE_DB=src-tauri/resources/core.db cargo test -p quran-core --test 'search_*' -- --ignored` (G12 goldens, §3.5
  budgets); `cargo xtask export-fixtures --only search`; `cargo clippy -p quran-core --all-targets -- -D warnings`.

**WP2a: UserDb library** (≈ 3.5 h)
- Owns: `crates/quran-core/src/user_db/{bookmarks, highlights, notes, collections, tags, marks}.rs`,
  `crates/quran-core/tests/userlib_*.rs`, `src-tauri/src/commands/user_library.rs`.
- Depends on: WP2b (mod.rs, migrations)
- Deliverables: library methods incl. `reading_bookmark_clear`, highlight overlap splitting, tombstones/undo, `marks`.
- Acceptance: `cargo test -p quran-core --lib -- user_db::bookmarks user_db::highlights user_db::notes user_db::collections
  user_db::tags user_db::marks`; `cargo test -p quran-core --test 'userlib_*'`; `cargo test -p quran-desktop --lib
  commands::user_library`; `cargo clippy -p quran-core --all-targets -- -D warnings`.

**WP3b: verify-core gates** (≈ 3 h)
- Owns: `xtask/src/verify.rs`, `xtask/tests/verify_*.rs`.
- Depends on: WP3a
- Deliverables: G1–G16 incl. G5b, G11 (allowlist) and G11b, JSON report.
- Acceptance: `cargo test -p xtask --test 'verify_*'`; `cargo xtask verify-core --report target/verify-core.json` all green on
  the qdc core.db; `cargo clippy -p xtask --all-targets -- -D warnings`.

**WP3c: Assets, licences, dev packs** (≈ 2.5 h)
- Owns: `xtask/src/{assets, licenses, dev_packs}.rs`, `xtask/assets.lock`, `xtask/tests/assets_*.rs`,
  `src/lib/about/thirdparty.json` (content).
- Depends on: WP0B, WP5a (catalog URL templates)
- Deliverables: §4.7, §4.8 (`--all-pages` for the glyph-scale measurement), `licenses`.
- Acceptance: `cargo xtask fetch-assets` (TTF 301,356 B); `cargo xtask fetch-dev-packs` populates `data/dev-packs/`
  (3 × 47 + 3 files); `cargo xtask licenses`; `cargo clippy -p xtask --all-targets -- -D warnings`.

**WP3d: qul adapter** (≈ 3 h)
- Owns: `xtask/src/build/qul.rs`, `xtask/tests/qul_*.rs`, `data/sources/README.md`, `data/sources/qul/manifest.toml`.
- Depends on: WP3a
- Deliverables: §4.3 (valid TOML manifest, rub from metadata 67), parsers unit-tested on synthetic SQLite/JSON until real files
  arrive.
- Acceptance: `cargo test -p xtask --test 'qul_*'` (incl. parsing the §4.3 manifest snippet); `cargo clippy -p xtask
  --all-targets -- -D warnings`.

**WP4b: Planner and decode** (≈ 3.5 h)
- Owns: `crates/quran-audio/src/{plan, decode, fake_out}.rs`, `crates/quran-audio/tests/{plan_*, decode_*}.rs`,
  `crates/quran-audio/tests/data/**`.
- Depends on: WP4a
- Deliverables: §2.3.3 (offline basmala skip), §2.3.4 (Sync markers, rational rate, flush generations, repeats/gaps/A-B).
- Acceptance: `cargo test -p quran-audio --lib -- plan decode`; `cargo test -p quran-audio --test 'plan_*' --test 'decode_*'`
  (marker frames ±0, Sync every ~100 ms); `cargo clippy -p quran-audio --all-targets -- -D warnings`.

**WP4c: Output, ticker, control and engine** (≈ 4 h)
- Owns: `crates/quran-audio/src/{output, sink, ticker, control, engine}.rs`, `crates/quran-audio/tests/engine_*.rs`.
- Depends on: WP4b
- Deliverables: §2.3.2 engine (idempotent `shutdown(&self)`, `thread::Builder`), §2.3.6 (host selection, device-event policy,
  debounce, id polling only on ALSA/PulseAudio), the `QD_AUDIO_SINK` null/WAV sinks, status machine.
- Acceptance: `cargo test -p quran-audio --test 'engine_*'` (with the WAV sink: 1:1–1:7 synthetic plan → marker log equals the
  plan ±1 frame; an injected `OutCmd::Rebuild` resumes within 2 s; a second Rebuild for the same generation is ignored);
  `cargo clippy -p quran-audio --all-targets -- -D warnings`.

**WP4d: Streaming source, audio glue and audio commands** (≈ 3.5 h)
- Owns: `crates/quran-audio/src/source.rs`, `crates/quran-audio/tests/source_*.rs`, `src-tauri/src/audio_glue.rs`,
  `src-tauri/src/commands/audio.rs`.
- Depends on: WP4c, WP1c. Until WP5e lands: a fixture-backed fake `TimingsSource` and a local-files-only source.
- Deliverables: §2.3.7 (`.stream.part`, live-stream reuse, promotion rule, `StreamRegistry`), `AudioService` (async
  `timings`, `to` resolution, media command routing, listen history), the audio commands.
- Acceptance: `cargo test -p quran-audio --test 'source_*'` (in-repo HTTP server: reuse, promotion only on full coverage, host
  fallback); `cargo test -p quran-desktop --lib -- audio_glue commands::audio`; `cargo clippy -p quran-audio -p quran-desktop
  --all-targets -- -D warnings`.

**WP5b: HTTP, jobs, install and writers** (≈ 4 h)
- Owns: `crates/quran-packs/src/{http, jobs, install, writers}.rs`, `crates/quran-packs/tests/support/**`,
  `crates/quran-packs/tests/{http_*, jobs_*, install_*, writers_*}.rs`.
- Depends on: WP5a, WP1c, WP2b
- Deliverables: §2.5.5 (lanes, limits, retries, `.dl.part` + `received` resume, single-writer registry, integrity, atomic
  install, cancel/pause, progress, network tracking), the in-repo test HTTP server.
- Acceptance: `cargo test -p quran-packs --test 'http_*' --test 'jobs_*' --test 'install_*' --test 'writers_*'`;
  `cargo clippy -p quran-packs --all-targets -- -D warnings`.

**WP5c: Fonts, static files and QuranEnc** (≈ 3.5 h)
- Owns: `crates/quran-packs/src/fonts.rs`, `crates/quran-packs/src/adapters/{qcf_font_pages, static_files,
  quranenc_sqlite}.rs`, `crates/quran-packs/src/transform/**`, `crates/quran-packs/tests/{fonts_*, quranenc_*, transform_*}.rs`.
- Depends on: WP5b
- Deliverables: interactive font lane (hafs → Ready without IO), decor, QuranEnc (single-entry zip check, footnotes, ammonia
  policy with `a[data-ref]`, HTTP-validator updates).
- Acceptance: `cargo test -p quran-packs --test 'fonts_*' --test 'quranenc_*' --test 'transform_*'`;
  `cargo clippy -p quran-packs --all-targets -- -D warnings`.

**WP5d: QF adapters and revalidation** (≈ 3.5 h)
- Owns: `crates/quran-packs/src/adapters/{qurancom_tafsir, qurancom_wbw, qdc_audio}.rs`, `crates/quran-packs/src/revalidate.rs`,
  `crates/quran-packs/tests/{qf_*, revalidate_*}.rs`.
- Depends on: WP5b
- Deliverables: §2.5.6 QF adapters (pinning surah 1 with any surah), §2.5.7 (pinned audio keeps the old pair), QuranEnc update
  checks.
- Acceptance: `cargo test -p quran-packs --test 'qf_*' --test 'revalidate_*'`; `cargo clippy -p quran-packs --all-targets --
  -D warnings`.

**WP5e: PackManager, packs glue and content/packs commands (IC2)** (≈ 3.5 h)
- Owns: `crates/quran-packs/src/manager.rs`, `crates/quran-packs/tests/{manager_*, live}.rs`, `src-tauri/src/packs_glue.rs`,
  `src-tauri/src/commands/{packs, content}.rs`.
- Depends on: WP5c, WP5d, WP4d (for IC2)
- Deliverables: §2.5.2 (`items`, `remove_items`, `clear_cache` + re-sync, `apply_settings`, cap enforcement), `PackEventsImpl`,
  the commands; **IC2** (§12.6).
- Acceptance: `cargo test -p quran-packs --test 'manager_*'`; `QD_NET_TESTS=1 cargo test -p quran-packs --test live --
  --ignored` (installs `tr.en.saheeh`, `mushaf.v2` pages 1–3 and `audio.qdc.7` surah 1 into a tempdir, kills mid-download and
  resumes); `cargo test -p quran-desktop --lib -- packs_glue commands::packs commands::content`; IC2 on Windows;
  `cargo clippy -p quran-packs -p quran-desktop --all-targets -- -D warnings`.

**WP6a: App state, setup, protocol and app commands (IC1)** (≈ 4 h)
- Owns: `src-tauri/src/{state, setup, protocol}.rs`, `src-tauri/src/commands/{app, system}.rs`.
- Depends on: WP1a, WP2b (IC1), WP0B
- Deliverables: **day-1 spike** on the font transport (WebKitGTK ≥ 2.50 and WKWebView, §6.1) recorded in
  `docs/deviations/WP6a.md` and in `AppInfo.fontTransport`; §2.8.2 setup (never `Err`, non-blocking fatal dialog, debug degrade,
  recovery notices); §6 protocol and `font_bytes`; `app_bootstrap` (os version/locale via plugin-os); **IC1**.
- Acceptance: `cargo test -p quran-desktop --lib -- protocol setup state commands::app commands::system`; IC1
  (`pnpm tauri build --debug --no-bundle && node scripts/qa/app-driver.mjs --scenario tests/e2e/scenarios/smoke.mjs`);
  `cargo clippy -p quran-desktop --all-targets -- -D warnings`.

**WP6b: Window, tray, per-OS config and Rust strings** (≈ 3.5 h)
- Owns: `src-tauri/src/{window, tray, i18n}.rs`, `src-tauri/tauri.{windows, macos, linux}.conf.json`,
  `src-tauri/capabilities/**`.
- Depends on: WP0B, WP-Brand (tray icons)
- Deliverables: §2.8.4 window/tray hooks (zoom, run events incl. macOS Reopen, close-to-tray question), §9.6 per-OS chrome
  config, Snap Layouts investigation, §11.4 string table.
- Acceptance: `cargo test -p quran-desktop --lib -- window tray i18n`; `cargo clippy -p quran-desktop --all-targets -- -D
  warnings`; `pnpm tauri build --debug --no-bundle` succeeds on the windows, macos and ubuntu CI runners. Mica, flyout and tray
  behaviour go to the release manual checklist (WP13b).

**WP6d: macOS and Linux media backends** (≈ 3 h)
- Owns: `crates/media-session/src/{macos, linux}.rs`.
- Depends on: WP6c
- Deliverables: §2.4 macOS (`playbackState`) and Linux (MPRIS executor, `desktop_entry` pinned from the built .deb).
- Acceptance: `cargo clippy -p media-session --all-targets -- -D warnings` and `cargo test -p media-session` on the macos and
  ubuntu CI runners; the .deb's desktop-file name recorded in `docs/deviations/WP6d.md`.

**WP8b: Fonts, renditions and palettes** (≈ 4 h)
- Owns: `src/lib/stores/fonts.svelte.ts`, `src/lib/mushaf/{fontRegistry, palettes, colrProbe, metrics}.ts`,
  `src/components/mushaf/RenditionStack.svelte`, `src/lib/ipc/mock/handlers/fonts.ts`, `vite/dev-packs.ts`,
  `scripts/measure-glyph-scale.mjs`,
  `src/lib/i18n/{en,ar}/fonts.ts`, `tests/e2e/scenarios/{S05, S09, S10, S11, S30}.mjs`.
- Depends on: WP8a, WP3c (dev packs)
- Deliverables: §8.5 (both transports, Failed/Retry), §8.6 (opaque ink, HC overrides, COLR probe on the end-marker glyph,
  cached), measured `--glyph-scale` per style in `metrics.ts`.
- Acceptance: `pnpm exec vitest run --project unit src/lib/mushaf/palettes src/lib/mushaf/colrProbe`; `pnpm exec vitest run
  --project browser src/components/mushaf/RenditionStack` (CLS 0 on a simulated swap); `node scripts/measure-glyph-scale.mjs`;
  `pnpm shots:web --only S05,S09,S10,S11,S30`.

**WP8c: Page furniture and margin marks** (≈ 4 h)
- Owns: `src/components/mushaf/{PageFrame, SurahCartouche, HeaderLine, BasmalaLine, RunningHead, PageFooter, MarginMarkers,
  MarginMarks, OpeningMedallion, SurahInfoPopover}.svelte`, `src/lib/mushaf/ornaments.ts`, `src/styles/mushaf/frame.css`,
  `src/lib/i18n/{en,ar}/furniture.ts`, `tests/e2e/scenarios/{S03, S04, S06, S08, S13, S33}.mjs`.
- Depends on: WP8a, WP7c
- Deliverables: §8.8, §8.9 (frame band pattern, khatam corners, fallback cartouche, opening medallion, label size rules,
  `--marker-ink`, margin marks incl. the ribbon, edge stack).
- Acceptance: `pnpm exec vitest run --project unit src/lib/mushaf/ornaments`; `pnpm shots:web --only
  S03,S04,S06,S08,S13,S33`; lead sign-off on S03.

**WP8d: Highlights, accessibility and interactions** (≈ 4 h)
- Owns: `src/lib/mushaf/{layout, a11y, interactions}.ts`, `src/components/mushaf/{HighlightLayer, A11yLayer, WordTooltip,
  AyahActionBar}.svelte`, `src/styles/mushaf/highlights.css`, `src/lib/i18n/{en,ar}/interactions.ts`,
  `tests/e2e/scenarios/{S15, S18, S31, S34}.mjs`.
- Depends on: WP8a, WP7c
- Deliverables: §8.7 (shape-separated layers, one fill per word, dark alphas, composite contrast test), §8.14 pointer rules,
  §8.15 a11y (`toSpeech`, roving items, landmarks), §8.17 (tooltip dwell rule, action bar), the glide ≥ 58 fps browser test
  (moved here from WP9).
- Acceptance: `pnpm exec vitest run --project unit src/lib/mushaf/layout src/lib/mushaf/a11y`; `pnpm exec vitest run
  --project browser src/components/mushaf/HighlightLayer` (glide ≥ 58 fps with mock playback); `pnpm shots:web --only
  S15,S18,S31,S34`.

**WP8e: Reader, spread, turns, zoom, follow-along and copy** (≈ 4 h)
- Owns: `src/lib/stores/reader.svelte.ts`, `src/components/mushaf/{MushafView, SpreadStage, FollowChip}.svelte`,
  `src/lib/mushaf/{copy, transitions, wheel}.ts`, `src/lib/shortcuts/{navigation, view}.ts`, `src/styles/mushaf/spread.css`,
  `src/lib/i18n/{en,ar}/reader.ts`, `tests/e2e/scenarios/{S28, S29, S32}.mjs`.
- Depends on: WP8b, WP8c, WP8d
- Deliverables: §7.3 reader (cursor, action target, pane follow), §7.8 startup restore, §8.10 (single-mode paper shift),
  §8.11 turns and flipping, §8.12, §8.13 (wheel gestures), §8.14 copy, navigation/view shortcuts.
- Acceptance: `pnpm exec vitest run --project unit src/lib/mushaf/copy src/lib/mushaf/wheel src/lib/stores/reader`;
  `pnpm exec vitest run --project browser src/components/mushaf/MushafView` (single-mode block x stable ±0.5 px on 261/262);
  `pnpm shots:web --only S28,S29,S32`.

**WP8f: Page navigation affordances** (≈ 3 h)
- Owns: `src/components/mushaf/{PageTurnZones, FlipHUD, PageRail, HintChip, DivisionChip}.svelte`,
  `src/lib/i18n/{en,ar}/pagenav.ts`, `tests/e2e/scenarios/S35.mjs`.
- Depends on: WP8e, WP9a (resume pill for S35)
- Deliverables: §8.11 zones, HUD, rail; §8.12 division chip; the first-run hint.
- Acceptance: `pnpm exec vitest run --project browser src/components/mushaf/PageRail` (slider keys, RTL order);
  `pnpm shots:web --only S35`.

**WP9a: Player store and dock** (≈ 4 h)
- Owns: `src/lib/stores/player.svelte.ts`, `src/components/player/**`, `src/lib/shortcuts/audio.ts`,
  `src/lib/ipc/mock/handlers/audio.ts`, `src/lib/i18n/{en,ar}/player.ts`, `tests/e2e/scenarios/{S16, S17}.mjs`.
- Depends on: WP7c, WP8d (S16 word highlight)
- Deliverables: §7.3 player (resume candidate), §9.7 dock (bar/compact/side placement, narrow behaviour, tick density, live
  repeat badge, Arabic monogram, LTR transport), audio shortcuts, audio mock.
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores/player` (interpolation, `activeWord` with backward
  positions, `cycleRepeat`, `abMark`); `pnpm exec vitest run --project browser src/components/player`; `pnpm shots:web --only
  S16,S17`.

**WP9b: Memorisation** (≈ 3.5 h)
- Owns: `src/lib/stores/memo.svelte.ts`, `src/components/memo/**`, `src/components/dialogs/SelfTestDialog.svelte`,
  `src/lib/shortcuts/memorize.ts`, `src/lib/ipc/mock/handlers/memo.ts`, `src/lib/i18n/{en,ar}/memo.ts`,
  `src/styles/mushaf/memo.css`, `tests/e2e/scenarios/S27.mjs`.
- Depends on: WP9a, WP8d
- Deliverables: §8.16 (incl. the per-frame budget), memo panel, heatmap, presets, self-test.
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores/memo`; `pnpm exec vitest run --project browser
  src/components/memo`; `pnpm shots:web --only S27`.

**WP10b: Search UI** (≈ 3.5 h)
- Owns: `src/lib/stores/search.svelte.ts`, `src/components/search/**`, `src/lib/ipc/mock/handlers/search.ts`,
  `src/lib/i18n/{en,ar}/search.ts`, `tests/e2e/scenarios/S19.mjs`.
- Depends on: WP10a, WP8e (S19 hit highlight on the page)
- Deliverables: §9.7 search (word windows from `SearchHit.words`, "+N more", 22 px), §9.8 search states, F3 navigation, mock
  search over `search/ayahs.json`.
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores/search`; `pnpm exec vitest run --project browser
  src/components/search` (scrolling 2,000 hits); `pnpm shots:web --only S19`.

**WP10c: Command palette** (≈ 3 h)
- Owns: `src/components/palette/**`, `src/lib/i18n/{en,ar}/palette.ts`, `tests/e2e/scenarios/S20.mjs`.
- Depends on: WP10a, WP7c
- Deliverables: §9.7 palette (sura-names code points, providers, settings labels from `settingsMeta` or field names).
- Acceptance: `pnpm exec vitest run --project unit src/components/palette`; `pnpm exec vitest run --project browser
  src/components/palette` (keyboard flows); `pnpm shots:web --only S20`.

**WP11a: Translations store and translation mode** (≈ 4 h)
- Owns: `src/lib/stores/translations.svelte.ts`, `src/components/translation/**`, `src/lib/ipc/mock/handlers/content.ts`,
  `src/lib/i18n/{en,ar}/content.ts`, `tests/e2e/scenarios/{S21, S36}.mjs`.
- Depends on: WP7c
- Deliverables: §9.7 translation mode, footnote popovers via `SafeHtml`, §9.8 translation states, content mock (translations,
  tafsir, WBW fixtures).
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores/translations`; `pnpm exec vitest run --project browser
  src/components/translation` (scroll restore by ayah within ±2 px); `pnpm shots:web --only S21,S36`.

**WP11b: Side pane** (≈ 3.5 h)
- Owns: `src/components/sidepane/**`, `src/lib/i18n/{en,ar}/sidepane.ts`, `tests/e2e/scenarios/{S14, S22, S37}.mjs`.
- Depends on: WP11a, WP8e (S14 selection and pane follow)
- Deliverables: §9.7 side pane (AyahHeader with pin and "Follow recitation"), tabs and their §9.8 states.
- Acceptance: `pnpm exec vitest run --project browser src/components/sidepane`; `pnpm shots:web --only S14,S22,S37`.

**WP11c: Library stores, panels, study shortcuts and context menu** (≈ 4 h)
- Owns: `src/lib/stores/{library, history}.svelte.ts`, `src/components/library/{BookmarksPanel, HighlightsPanel, NotesPanel,
  HistoryPanel}.svelte`, `src/components/mushaf/AyahContextMenu.svelte`, `src/lib/shortcuts/study.ts`,
  `src/lib/ipc/mock/handlers/user.ts`, `src/lib/i18n/{en,ar}/library.ts`.
- Depends on: WP7c, WP8d
- Deliverables: §7.3 library/history (20-deep undo/redo incl. the highlight snapshot), panels with §9.8 empty states, study
  shortcuts (action target, toasts naming the target), the context menu, the user mock (overlap and tombstone logic).
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores/library src/lib/stores/history`; `pnpm exec vitest run
  --project browser src/components/library src/components/mushaf/AyahContextMenu` (typing `b` in the menu does not bookmark).

**WP11d: Note editor, Markdown and pickers** (≈ 3 h)
- Owns: `src/components/dialogs/NoteEditorDialog.svelte`, `src/lib/text/markdown.ts`, `src/components/library/{CollectionsPicker,
  TagPicker}.svelte`, `src/lib/i18n/{en,ar}/notes.ts`.
- Depends on: WP11c
- Deliverables: note editor (draft autosave, discard confirmation only for a non-empty unsaved body), the escaping Markdown
  subset renderer, pickers.
- Acceptance: `pnpm exec vitest run --project unit src/lib/text/markdown`; `pnpm exec vitest run --project browser
  src/components/dialogs/NoteEditorDialog src/components/library`.

**WP12a: Packs store and Downloads** (≈ 4 h)
- Owns: `src/lib/stores/packs.svelte.ts`, `src/components/downloads/**`, `src/lib/ipc/mock/handlers/packs.ts`,
  `src/lib/i18n/{en,ar}/downloads.ts`, `tests/e2e/scenarios/S23.mjs`.
- Depends on: WP7c
- Deliverables: §7.3 packs (items, starter set, retry/update/clear), §9.7 downloads with `SurahGrid` (`packs_items`), packs
  mock (2 MB/s simulation, failures, items).
- Acceptance: `pnpm exec vitest run --project unit src/lib/stores/packs` (job map, install/pause/resume/cancel/fail/retry/
  remove/update in the mock); `pnpm shots:web --only S23`.

**WP12b: Settings** (≈ 3.5 h)
- Owns: `src/components/settings/**`, `src/lib/i18n/{en,ar}/settings.ts`, `tests/e2e/scenarios/S24.mjs`.
- Depends on: WP7c, WP8a (preview page), WP12a (Storage section)
- Deliverables: §9.7 settings, every `Settings` field bound, `settingsMeta`, Clear cache.
- Acceptance: `pnpm exec vitest run --project unit src/components/settings` (every Settings key appears in `settingsMeta`);
  `pnpm exec vitest run --project browser src/components/settings` (settings round trip in the mock); `pnpm shots:web --only
  S24`.

**WP12c: Onboarding and About** (≈ 3 h)
- Owns: `src/components/{onboarding, about}/**`, `src/lib/about/attributions.ts`, `src/lib/i18n/{en,ar}/{onboarding, about}.ts`,
  `tests/e2e/scenarios/{S01, S02, S25}.mjs`.
- Depends on: WP12a, WP8a, WP-Brand
- Deliverables: §9.7 onboarding (4 steps, v1.2: 5; exact starter set and total, Match system, offline behaviour, preview) and About.
- Acceptance: `pnpm exec vitest run --project browser src/components/onboarding` (starter set equals §2.5.4; Work offline
  disables downloads); `pnpm shots:web --only S01,S02,S25`.

**WP-CI: Continuous integration** (≈ 2.5 h)
- Owns: `.github/workflows/ci.yml`, `.github/actions/**`, `scripts/check-artifacts.mjs`.
- Depends on: WP0D, WP3a, WP1a
- Deliverables: §13.3 (shared setup, job matrix, licensing guards, fetch-assets cache, size check with the placeholder core),
  and a `cargo xtask licenses` drift check on the committed `src/lib/about/thirdparty.json` (like the bindings check).
- Acceptance: CI green on a docs-only PR; a PR that changes a DTO without regenerating bindings fails `test-web`
  (`pnpm bindings:check`); `node scripts/check-artifacts.mjs src-tauri/resources/core.db` exits non-zero on a qdc core.db.

#### Wave 3
**WP13b: Release, budgets and cross-OS smoke** (the lead plus one; ≈ 4 h)
- Owns: `.github/workflows/release.yml`, `scripts/size-budget.mjs`, `tests/e2e/metrics/**`, `docs/RELEASE_CHECKLIST.md`.
- Depends on: all wave-2 packages
- Deliverables: §13.4, the §12.6 metric assertions (CLS, render, flip, glide, CSP), the manual smoke checklist, the final
  attribution audit.
- Acceptance: `pnpm tauri build --debug --no-bundle && pnpm shots:app --only metrics` meets §8.18; `node
  scripts/size-budget.mjs` meets §13.6; macOS and Linux bundles built in CI; checklist completed (or budgets waived in
  `docs/deviations/WP13b.md` with a reason, which the lead folds in).

### 14.4 Definition of done (every package)
- The package's acceptance commands pass on a branch rebased on main.
- `cargo clippy -p <each owned crate> --all-targets -- -D warnings` (Rust) and `pnpm check`, `pnpm lint`, `pnpm format:check`,
  `pnpm lint:css` (frontend) are clean. Workspace-wide `cargo lint` runs only in CI and at the integration checkpoints.
- No `NotImplemented` / `Unsupported("not implemented")` remains in owned paths (`rg -n "NotImplemented|not implemented"
  <owned paths>` is empty), except in files the package hands over.
- en and ar strings exist for every key in the package's own dictionary files.
- Owned mock handlers implement realistic behaviour (other packages develop against them).
- Owned scenario PNGs exist without page or console errors; lead review is a separate merge gate.
- Deviations from this document are written to `docs/deviations/WPxx.md`, never to this file.

---

## 15. Risks, mitigations and non-goals

### 15.1 Risks
| # | Risk | Mitigation |
|---|---|---|
| R1 | **Release data licence**: QUL layout/glyph data has no published licence and originates from QF/KFGQPC (FACT §8.1). QF terms forbid bundling QF API content. | Release builds only from `--source qul` after **written permission** (Tarteel/QUL, ideally QF). Dev builds use qdc and are never distributed. Attributions in About. |
| R2 | Legacy QF endpoints (QDC timings, Quran.com tafsir/WBW) change or close; the 7-day rule. | Catalog-driven sources and isolated adapters; content keeps working offline; revalidation policy §2.5.7; QF Content Sync via a proxy is the planned successor (non-goal v1). |
| R3 | Audio rights (QuranicAudio personal use; no redistribution). | Stream and cache per user only, in private app storage. No export or share of audio files. No mirror. |
| R4 | The own WSOLA sounds metallic on some voices at 0.5× or 2×. | Parameters in §2.3.5 tuned by listening tests (3 reciters × 5 speeds) in WP4a (with the WAV sink, §2.3.6). A `signalsmith` feature flag (off by default, needs libclang) remains possible behind the same `Wsola` interface. |
| R5 | Audio engine untested on macOS/Linux (only cargo-checked on Windows); the SMTC sketch was never run. | Output owned by a dedicated thread (Send-safety); host chosen via `available_hosts()` (no panicking `default_host()`); CI builds on all OSes from wave 1; fake-output and WAV-sink tests are OS-independent; WP6c's first task is the SMTC runtime check with a main-thread fallback; macOS/Linux smoke in wave 3. kira 0.12.5 is the documented emergency fallback. |
| R6 | WebKitGTK: COLRv0/font-palette, View Transitions, backdrop-filter untested; Safari 17.0–17.1 COLRv0 regression; **cross-origin `FontFace` loads from `quran://` may be rejected** (wry registers the scheme as secure but not CORS-enabled). | Runtime COLR probe on the end-marker glyph → V2 fallback (§8.6); WP6a day-1 font-transport spike with the raw-bytes fallback (`fontTransport = bytes`, D30); View Transitions feature-detected; opaque chrome and no backdrop-filter on Linux. |
| R7 | Upstream `v4/colrv1` files replaced with true COLRv1 (WKWebView can't render it). | The probe catches it at runtime → V2 fallback. Downloads are cached locally, never hotlinked. |
| R8 | tauri-specta/specta RC churn. | Exact `=` pins; bindings drift check in CI; documented fallback (ts-rs types + hand-written invoke wrappers) without changing DTOs. |
| R9 | Layout or glyph mixing (C1/C4/C5) breaks pages. | Everything keyed by layout; one-span multi-glyph words; verify-core G2–G10; golden page tests per layout. |
| R10 | CLS from font swaps or late data. | D13 two-layer cross-fade; fixed geometry; e2e CLS = 0 assertion. |
| R11 | `panic = "abort"` turns a stray unwrap, an out-of-bounds slice, a `block_on` in async code or an `Err` from Tauri's setup closure into a crash. | Clippy `unwrap_used`/`expect_used` deny everywhere plus `indexing_slicing`/`panic`/`todo`/`unimplemented`/`unreachable` deny in quran-audio, quran-packs and src-tauri; `thread::Builder`; no `block_on` outside qd-audio-ctl (debug-asserted); setup never returns `Err` and uses a non-blocking dialog (§2.8.2); `catch_unwind` is not relied on. |
| R12 | Windows MAX_PATH with SQLite. | Short data root (`%LOCALAPPDATA%\com.quran.labs.desktop`); startup check warns if any DB path is ≥ 240 chars. |
| R13 | Code signing / notarisation not researched (FACT §8.9). | Unsigned builds for internal testing; release blocked on a signing decision (open question). |
| R14 | Stream cache grows unbounded. | `stream_cache_cap_mib` + LRU eviction of unpinned files; Disk usage UI. |
| R15 | A fresh checkout can't compile `src-tauri` (missing `dist/`, missing generated `core.db` listed in `bundle.resources`). | build.rs creates a 0-byte core.db placeholder (fails instead under `QD_REQUIRE_CORE=1`); the shared CI setup runs `pnpm build` and the apt line before any `src-tauri` compile; debug builds degrade to a "core data missing" screen (§5.15, §2.8.2). |
| R16 | TypeScript 7 or other unpinned upgrades break the toolchain. | Exact pins; `pnpm` lockfile; Renovate rules exclude typescript ≥ 7 until svelte-check supports it. |
| R17 | QDC data quirks beyond pages 1–2 (`line_number`) in dev builds. | G6/G7/G8 gates fail loudly; D4 is the only known quirk (verified). |
| R18 | mpris-server docs/build drift on Linux; wrong MPRIS `DesktopEntry` hides the player's name and icon. | Own thread + noop fallback; the app never depends on media-session success; `desktop_entry` pinned from the built .deb (WP6d). |
| R19 | CI distributes QF-derived data (qdc core.db, fixtures, raw responses, installers) from a public repository. | §13.3 licensing rules: in-job builds only, no uploads or caches of QF-derived files while public, fork PRs excluded, `check-artifacts.mjs` guard, release requires `meta.source = 'qul'`. |
| R20 | Linux systems lack Bengali/Devanagari/Tamil fonts; Urdu readers expect Nastaliq. | Startup `document.fonts.check` per installed script with an install hint; optional `decor.nastaliq` pack (§9.3). |
| R21 | 50 parallel packages drift from this document or collide on shared files. | Strict per-package ownership (§14.3), frozen contract files, generated lockfiles never hand-merged, deviations in `docs/deviations/`, two integration checkpoints, the wave-0 exit gate with `check:tooling`. |

### 15.2 Explicit non-goals for v1
- Mobile platforms and a web deployment.
- Accounts, cloud sync, cross-device backup (the schema is sync-ready: UUIDv7 + tombstones).
- QF Content Sync proxy / OAuth (QF-only content uses the legacy endpoints with 7-day revalidation).
- Root/lemma (morphology) search, transliteration search, full-text tafsir search.
- Indo-Pak and other script layouts, other qira'at, image-based Mushaf pages.
- Per-verse QCF fonts in translation mode (D18).
- An output-device picker (D19); per-word audio playback (WBW audio).
- Stretch items (designed for, not required): presentation/projector mode, khatmah planner, share ayah as image, always-on-top
  mini-player window, `quran-desktop://` deep links, JSON/CSV export/import of user data.
- Auto-updater (needs signing keys).
- Custom user themes beyond the 5 themes × 6 accents.
- Telemetry or analytics of any kind (never).

### 15.3 Open questions (owner: lead)
1. Written permission for QUL/QF-derived layout and glyph data in a distributed `core.db` (blocks release).
2. A QF Developer Console account and credit text, required for caching QCF page fonts (FACT §2.1). Confirm the account exists
   and the exact attribution wording for About.
3. The code-signing approach (Windows Authenticode certificate type, Apple Developer ID + notarisation) and whether to ship the
   updater in v1.1.
4. Decorative fonts (QCF_SurahHeader, quran-common, sura_names) carry no licence string. Confirm on-demand download is acceptable,
   or rely on our SVG/Unicode fallbacks only.
5. ~~Whether to commit the KFGQPC Hafs V30 TTF to the repo (EULA allows redistribution unmodified) instead of fetching it in CI
   (D23).~~ Resolved by LEAD 24 (2026-10-11): it is committed as the fallback of `fetch-assets`; the download stays first.
6. Whether the repository and its Actions stay **private** until item 1 is resolved. While private, CI may upload qdc
   core.db/fixtures for developers (§13.3); once public, the stricter rules apply automatically.
7. Print-scan verification items delegated to WP8c: opening-page medallion shape and hidden running heads on pages 1–2, and
   the sajda-word overline in the hafs rendition (§8.9).


---

## Review log (v1.1 revision pass, 2026-10-10)
Three reviews (correctness, UX, implementability) produced 100 findings. Every blocker and major finding is applied; the
cheap and right minors are applied too. Reviewer claims that disagreed with v1.0 were re-verified before editing:
- **Division data (finding 1):** re-ran the reviewer's comparison scripts on the 114 cached QDC `verses/by_chapter`
  responses and the research `tanzil_quran-data.xml`: juz/hizb/manzil 0 mismatches, rub 1 (106: QDC 15:49, Tanzil 15:50),
  ruku 2,904 ayahs (QDC 558 rukus), QDC `sajdah_number` missing 22:77. The by_key probes also show that only 9 of the 15 sajda
  words carry "space + ۩" in `text_qpc_hafs` (the other 6 attach ۩ directly), which shaped G5b.
- **Tauri/cpal/wry/reqwest sources (findings 2, 3, 6, 13, 15, 19, 21, 25, 49, 65):** checked in the local cargo registry
  (tauri-build 2.7.1 `copy_resources`, tauri-utils 2.10.1 `resources.rs` and `html.rs`, tauri 2.12.2 `app.rs` setup panic and
  window creation order, `manager/mod.rs` CSP nonces, `set_webview_zoom` permission, tauri-plugin-dialog 2.8.1
  `blocking_show`, cpal 0.18.2 `error.rs`/WASAPI/`default_host`, wry 0.57.0 WebKitGTK scheme registration, reqwest 0.13.5
  default features). All confirmed.
- **Scaffold divergence (finding 72):** compared with the repository's `package.json`, `Cargo.toml`, `.cargo/config.toml`,
  `.gitignore`, `vite.config.ts`, `vitest.config.ts`, `scripts/qa/*`, `src-tauri/{tauri.conf.json, capabilities/default.json}`
  and the installed pnpm (10.24.0); the document now follows the scaffold's names.
- **Token values (findings 40, 41):** contrast recomputed; the `--accent-text` table covers all 6 accents for paper and sepia.

**Adopted with a variation (one line each):**
| # | Variation and reason |
|---|---|
| 7 | A stream that starts while a job writes the same surah uses its own `.stream.part` and "first complete wins", instead of adopting the job; jobs do wait for a live stream. Simpler, and two writers still never share a file. Promotion also requires full byte-range coverage. |
| 8 | One `content.db` with a per-row `pinned` flag instead of a separate `content.db` + disposable `cache.db`: same guarantees, no row migration when a surah gets pinned. |
| 21 | Extra clippy denials are crate-root `#![cfg_attr(not(test), deny(..))]` attributes, because Cargo forbids extra `[lints]` keys beside `lints.workspace = true`. |
| 29 | The docking rule uses the single-page footprint `SINGLE_W = PW + 1.0` and the geometry's bar reserve, so S32 lands at qfs 22.75 (compact bar) rather than 22.2. |
| 37 | The single-page paper offset is ±0.50·qfs with footprint PW + 1.0: the finding's 0.55/1.1 came from the mis-summed PW 20.90 (finding 16). |
| 40 | Black `--text-faint` is #6b6761, not #635f59, because #635f59 is 2.85:1 on the new black `--surface-raised` #161616 from finding 41. |
| 49 | UI zoom is applied from Rust (`WebviewWindow::set_zoom` in `window::apply_settings`/setup) instead of JS `setZoom`, so no `core:webview:allow-set-webview-zoom` capability is granted. |
| 61 | Missing-script detection uses a canvas tofu comparison instead of `document.fonts.check()`, which reports load state, not system-font coverage. |
| 67 | WP0B starts after WP0A (it needs `quran-types` and the app skeleton to compile) instead of fully in parallel; the critical path 0A → 0C → 0E is unchanged. |
| 68 | `export-fixtures` is split per domain (WP1a mushaf, WP1b search, WP1c content, WP5a packs) rather than owned wholly by WP1a, so each part serialises through its owner's API. `xtask catalog-check` moved to WP5a for the same reason. |
| 69 | WP8 is split into six packages (8f added for the page-navigation affordances of findings 35/36); `metrics.ts` is owned by WP8b, which measures the glyph scales; the mock handler `fonts.ts` is split from `mushaf.ts` so 8a and 8b stay disjoint. |
| 70 | Cross-package scenarios (S14, S16, S19, S27, S35) are owned by the later package with an explicit dependency instead of separate integration packages; IC1/IC2 remain as proposed. |
| 76 | Every package gets its own dictionary domain file (the WP8 domain is split into `mushaf`, `fonts`, `furniture`, `interactions`, `reader`, `pagenav`) instead of sharing one file; `shortcuts`/`common`/`errors` are frozen as proposed. |
| 83 | Uploading the qdc `core.db`/fixtures as CI artifacts is allowed only while the repository is private: finding 12 (QF terms, BRIEF §4) takes precedence. |
| 89 | The proposed hard gate "no U+0020 in `word.text_hafs`" would fail on real data (finding 26), so its stated fallback is taken: `SearchHit.words`/`firstWordId` and `WbwEntry.text`; G5b asserts that spaces occur only before ۩. |

**Rejected:** none. Two sub-options were not chosen where a finding offered alternatives: finding 1's "allowlist the 4 QDC ruku
differences" (ruku is Tanzil-only without a per-ayah check instead) and finding 13's "lint-only" option (both the config key and
the no-`<style>` check are applied).

**Disposition of the remaining findings:** 1–6, 9–20, 22–28, 30–36, 38, 39, 41–48, 50–60, 62–66, 71–75, 77–82, 84–88 and 90–100
are applied as proposed (with the exact values or commands in the sections cited by each finding).
