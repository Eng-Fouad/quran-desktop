# Quran for Desktop — Product & Engineering Brief

> Status: **decided** (2026-10-10). This brief is the input to `docs/ARCHITECTURE.md`. When the two disagree, the
> architecture doc wins only if it explicitly records why. Verified facts (URLs, versions, schemas) live in
> `docs/research/FACT_SHEET.md` and the per-topic reports in `docs/research/`.
>
> **Identity (Changed by LEAD 16, 2026-10-10; docs/deviations/LEAD.md item 16).** The owner plans to contribute the app
> to github.com/quran, so it adopts that organisation's (Quran.com) identity: product name **Quran**, full name
> **Quran for Desktop** (Arabic **قرآن** / **قرآن لسطح المكتب**), identifier `com.quran.labs.desktop`, licence
> **GPL-3.0-or-later**, and the Quran.com mark as the icon (ARCHITECTURE §9.9). A public release under this identity
> needs the approval of the quran organisation's maintainers. The working names (`quran-desktop` repository, crate and
> binary) are unchanged.

## 1. Product

A desktop Quran reader that feels like a beautifully printed Madani Mushaf on a large screen, with
the depth of a study tool and the polish of a premium native app. Windows, macOS and Linux.
It is a **rewrite inspired by quran/quran_android**, not a port. No code is copied from quran_android
(GPL-3.0) or quran.com-frontend-next (no licence). The app itself is GPL-3.0-or-later (Changed by LEAD 16), and its icon is
quran_android's (GPL-3.0), credited in About.

Quality bar: "perfect and impressive". Every surface must feel deliberate: instant start, no layout
shift, buttery page turns, crisp vector Mushaf at any zoom, keyboard-first, accessible, offline-first.

### 1.1 v1 feature set (all must work end to end)
1. **Mushaf reading** — font-based rendering of the 604-page Madani Mushaf.
   - Styles: `hafs` (bundled KFGQPC Hafs Unicode font on the V2 1421H layout, always available offline),
     `qcf_v2` (QCF V2 1421H per-page fonts, default once available), `qcf_v1` (1405H), `qcf_v4` (tajweed colours, CPAL palettes).
   - Per-page QCF fonts download on demand (+ prefetch ±2 pages) and swap in with **zero layout shift**.
   - Single page or **two-page book spread** (odd page right, even page left), auto by window width; fit-to-height; Ctrl+wheel / Ctrl± zoom.
   - Authentic page furniture: double-rule frame, surah header cartouche, basmala lines, centred lines,
     ayah-end markers, rub-el-hizb ۞ / sajda ۩ margin markers, running heads (surah · juz), page number in Arabic-Indic digits.
   - Hover an ayah → soft highlight; click → select (opens side pane); right-click → ayah context menu.
   - Word-by-word tooltip (translation + transliteration) when the WBW pack is installed.
   - Copy produces proper Unicode Uthmani text + reference (never PUA glyph codes).
2. **Translation mode** — verse-by-verse virtualised list (Arabic + 1..n translations, footnotes as popovers).
3. **Side pane** (resizable) — translations / tafsir / notes for the selected or playing ayah.
4. **Navigation** — sidebar index (surahs, juz, hizb, pages, bookmarks, history); **Ctrl+K command palette**
   (surah by ar/en/translit name, `2:255`, `p 262`, `j 15`, commands, settings, reciters); go-to dialogs.
5. **Search** — Arabic search with diacritic/alef/ya/ta-marbuta normalisation (FTS5, prefix match), translation search,
   results grouped by surah with in-context highlighting; jump to result highlights the ayah in the Mushaf.
6. **Recitation** — 14 QDC reciters with gapless surah audio + ayah **and word** timings.
   Native Rust audio engine: play from ayah/page/surah, gapless, ayah + word highlight synced (sample-accurate),
   follow-along auto page turn, repeat ayah ×N / range ×N / A-B loop, delay-between-repeats multiplier,
   speed 0.5–2.0× **pitch-preserving**, stream-while-caching, offline download per reciter,
   OS media controls (Windows SMTC, macOS Now Playing, Linux MPRIS), keeps playing when minimised / in tray.
7. **Bookmarks & study** — ayah/page bookmarks, colour highlights (5 colours), notes, collections/tags,
   automatic last-read position + reading history, movable "reading bookmark" with undo toast.
8. **Memorisation mode** — hide/peek (blur words, reveal on hover/key), range repeat presets, random-start self-test.
9. **Downloads manager** — packs (mushaf fonts per style, translations, tafsir, recitations, WBW) with progress,
   pause/cancel/resume, delete, disk usage; first-run onboarding suggests a sensible starter set.
10. **Settings** — theme (Paper, Sepia, Night, Black/OLED, High-contrast, follow system), accent colour,
    Mushaf style, font size/zoom, translations & order, reciter, playback defaults, UI language (English, Arabic with RTL UI),
    night-mode ink brightness, reduced motion, keyboard shortcut sheet (`?`).
11. **Desktop integration** — custom title bar (Windows 11 Mica on chrome, macOS overlay traffic lights), single instance,
    window-state restore, system tray with mini-player controls, close-to-tray option, deep links `quran-desktop://2:255` (stretch),
    about/attribution screen with all data & font licences.

Stretch (design for, implement if time allows): presentation/projector mode on a second monitor, khatmah planner,
share ayah as image, always-on-top mini player window.

## 2. Stack (pinned — see FACT_SHEET §1)
- **Rust** 1.99.0 (`rust-toolchain.toml`), edition 2024, workspace `rust-version = "1.95"`.
- **Tauri** 2.12.2 / tauri-build 2.7.1 / `@tauri-apps/api` ~2.12.2 / `@tauri-apps/cli` ~2.12.1. Never 3.0 alpha.
- Plugins (crate == npm major.minor): single-instance 2.5.2, window-state 2.5.0, log 2.10.0, opener 2.7.0, dialog 2.8.1, os 2.4.0
  (add others only when needed; `pnpm tauri add` keeps versions paired).
- Typed IPC: `specta =2.0.0-rc.25`, `tauri-specta =2.0.0-rc.25`, `specta-typescript =0.0.12`. DTOs use `u32/i32/f64/String/bool`
  (no `u64/i64/usize` — the TS exporter rejects them).
- Data: `rusqlite 0.40.2` (`bundled` ⇒ SQLite 3.53.2 with FTS5), `r2d2 0.8.10` + `r2d2_sqlite 0.35.0`, `rusqlite_migration 2.6.0`.
  No sqlx / tauri-plugin-sql (libsqlite3-sys `links` conflict).
- Audio: `cpal 0.18.2`, `symphonia 0.6.1` (`default-features=false`, `["mp3","opt-simd"]`), `rtrb 0.4.0`, `rubato 5.0.1`,
  `crossbeam-channel 0.5.17`, `stream-download 0.24.4` (`reqwest-rustls`). **Time-stretch: our own pure-Rust WSOLA**
  (no signalsmith/libclang build dependency). Linux: cpal feature `pulseaudio`.
- Media controls: our own `media-session` crate — Windows `windows 0.62.2` SMTC, macOS `objc2-media-player 0.3.2`,
  Linux `mpris-server 0.10.0` (zbus, on its own thread).
- Networking: `reqwest` (rustls), `tokio` (via tauri's runtime). Sanitising HTML: `ammonia 4.2.x` (Rust), `dompurify 3.4.x` (webview).
- Frontend: Svelte 5.57.2 (runes), Vite 8.3.4, `@sveltejs/vite-plugin-svelte` 7.3.1, **TypeScript ~6.0.3 (not 7)**, svelte-check 4.7.6,
  bits-ui 2.19.5 (+ `@internationalized/date`), `@lucide/svelte` 1.54.0, virtua 0.53.3, paneforge 1.0.2, svelte-sonner 1.2.1,
  fonts via `@fontsource-variable/inter`, `@fontsource-variable/noto-naskh-arabic`, `@fontsource/ibm-plex-sans-arabic`.
  **Hand-written CSS with design tokens** (no Tailwind). Own tiny typed i18n (no paraglide).
- Tests/lint: vitest 5.0.3 (+ jsdom for unit tests), eslint 10 + typescript-eslint 8.71 + eslint-plugin-svelte, prettier 3.9 +
  prettier-plugin-svelte, `cargo clippy -D warnings`, `cargo fmt`, `svelte-check`.
- Package manager: pnpm. Node ≥ 22.

## 3. Repository layout (Cargo workspace at repo root)
```
quran-desktop/
├─ Cargo.toml                # [workspace] members = ["src-tauri", "crates/*", "xtask"]
├─ rust-toolchain.toml       # 1.99.0
├─ .cargo/config.toml        # alias: xtask = "run -p xtask --"
├─ package.json, pnpm-lock.yaml, vite.config.ts, svelte.config.js, tsconfig*.json, index.html, eslint/prettier configs
├─ src/                      # Svelte app (see ARCHITECTURE)
├─ public/fonts/             # bundled KFGQPC Hafs V30 TTF (unmodified, EULA allows redistribution) + its licence
├─ src-tauri/                # Tauri app crate `quran-desktop` (thin: commands, state wiring, protocol, tray, window)
│  └─ resources/             # core.db (generated, gitignored), catalog.json (curated pack catalog)
├─ crates/
│  ├─ quran-core/            # domain model, normalize_ar, core.db queries, search, user.db (+migrations), cache.db — no tauri dep
│  ├─ quran-audio/           # native engine: decode → stretch → resample → ring → cpal; segments; markers; WSOLA — no tauri dep
│  ├─ quran-packs/           # catalog, downloads (resume, sha256), installers (QuranEnc sqlite, QDC timings, tafsir, fonts) — no tauri dep
│  └─ media-session/         # OS media controls (SMTC / Now Playing / MPRIS) — no tauri dep (takes raw HWND / runs own thread)
├─ xtask/                    # `cargo xtask build-core --source qdc|qul`, `verify-core`, `export-fixtures`, `fetch-assets`
├─ data/sources/             # README for obtaining QUL exports (human login required); downloaded inputs are gitignored
├─ docs/                     # BRIEF, ARCHITECTURE, research/
└─ .github/workflows/        # ci.yml (lint+test+build matrix win/mac/linux), release.yml (tauri-action)
```
Crates other than `src-tauri` must not depend on tauri, so they are unit-testable headless and reusable.

## 4. Data decisions (licensing-driven — see FACT_SHEET §2, §6, §8)
- **core.db is generated, never committed.** `cargo xtask build-core` with two source adapters producing the *same* schema:
  - `--source qul` (release-grade): QUL exports downloaded once by a human (login required) into `data/sources/qul/`
    (layouts 10/15/19, scripts 61/57/312/54, metadata 63–70; the search seed is script 54, not 60, corrected in
    ARCHITECTURE v1.2 §4.3) + Tanzil `quran-data.xml` cross-check.
  - `--source qdc` (development): fetches `https://api.qurancdn.com/api/qdc/verses/by_page/{p}?mushaf={1|2|19}&per_page=all&words=true`
    + chapters/metadata, cached raw under `data/cache/` (gitignored). QF terms forbid distributing a build-time bundle of QF content,
    so **qdc builds are for local development only**; release builds must use `qul` (pending permission from Tarteel/QUL).
  - Both adapters run the same CI-style invariant gates (`verify-core`): 6,236 ayahs, 83,665 word rows, 604 pages × ≤15 lines
    per mushaf, line-type derivation rule (C15), V1 page starts == Tanzil, every word covered by exactly one line, etc.
- Canonical **word id** = our own sequential index (1..83,665) in (surah, ayah, position) order; joins to sources by
  `location "s:a:w"`, never by source ids (QUL word_index has 3 extra slots; API ids are non-sequential).
- Layout tables are keyed by `mushaf_id` everywhere (V1/V2/V4 differ in page starts and line breaks). `hafs` style uses the V2 layout.
- Word glyph codes are TEXT of 1–4 PUA chars (waqf/sajda glyphs); render the whole string in one span.
- Bundled font: **KFGQPC Hafs V30** (`fonts.qurancomplex.gov.sa/fonts/KFGQPC-Hafs-V30.zip`), shipped unmodified.
  It needs U+06DD before ayah-number digits → done in the core.db `text_hafs` column at build time.
- On-demand **QCF page fonts**: `https://verses.quran.foundation/fonts/quran/hafs/{v1|v2|v4/colrv1}/woff2/p{N}.woff2`,
  mirrors `https://static-cdn.tarteel.ai/qul/fonts/quran_fonts/{v1,v2,v4-tajweed}/woff2/p{N}.woff2`. Decorative fonts
  (QCF_SurahHeader, quran-common) ship in the same on-demand pack; the installer works without them (own SVG cartouche + Unicode).
- **Translations**: QuranEnc SQLite zips (licence-clean, republish unmodified with attribution) as primary; curated
  `catalog.json` maps app resource ids → ordered source lists, sizes, versions, attribution. Never offer The Clear Quran.
- **Tafsir**: QuranEnc `arabic_moyassar`; Quran.com legacy `tafsirs/{id}/by_chapter/{ch}` (Ibn Kathir en 169, Ma'arif 168, Sa'di 91)
  as runtime downloads with **7-day revalidation when online** (QF cache rule); Tanzil/spa5k only with QA.
- **Audio**: QDC reciters (`api.qurancdn.com/api/qdc/audio/reciters`), surah files with `segments=true` timings.
  QDC chapter files have **no basmala** → play the same reciter's Al-Fātiḥa 1:1 segment before surahs 2–114 (not 9).
  Timings are tied to an exact file (store url + Content-Length); sanitise segments; revalidate ≤ 7 days when online.
  Audio is streamed + cached per user in app cache; never redistributed or mirrored.
- **WBW** (word-by-word translation/transliteration): runtime download from Quran.com legacy API per chapter, 7-day revalidation.
- **Attribution screen** lists every source with licence/terms (KFGQPC, QUL/Tarteel, Tanzil, QuranEnc, Quran Foundation, QuranicAudio).

## 5. Platform decisions (see FACT_SHEET §7)
- Custom protocol `quran://` (`http://quran.localhost` on Windows) serves files from `app_data_dir()/packs` with exact MIME,
  single-range 206 support, `Access-Control-Allow-Origin: *`, immutable caching, `Component::Normal`-only paths. Asset protocol off.
- CSP lists both protocol forms; `ipc: http://ipc.localhost`.
- Audio + memorisation logic live in Rust (webview background throttling cannot be disabled on Windows/Linux).
- Position ticks to UI over `tauri::ipc::Channel` (~30 Hz, UI interpolates with rAF); discrete events for ayah changes.
- Windows: `decorations:false, transparent:true, windowEffects mica` (chrome only, page canvas opaque), `noRedirectionBitmap`,
  window shown after first paint (no white flash), `SetCurrentProcessExplicitAppUserModelID(identifier)` for the media flyout.
- Product name `Quran` (window title, taskbar, installer, tray, media flyout), full name `Quran for Desktop` (About,
  onboarding, descriptions); HTTP User-Agent `QuranForDesktop/<version>` (Changed by LEAD 16).
- macOS: `titleBarStyle:"overlay"`, `hiddenTitle`, `trafficLightPosition`; `minimumSystemVersion` "13.3".
- Linux: WebKitGTK ≥ 2.50 target; tray is menu-only; deb depends `libasound2`.
- Release profile: `codegen-units=1, lto=true, opt-level="s", panic="abort", strip=true`; `build.removeUnusedCommands: true`.
  With `panic=abort`, **no `unwrap()`/`expect()` in commands, protocol handlers, audio threads**.
- Bundle identifier: `com.quran.labs.desktop` (must never change after first public release; Changed by LEAD 16, mirrors
  quran_android's `com.quran.labs.androidquran`). It is also the Windows AUMID and the name of the data directory.

## 6. Engineering principles
- Contract-first: Rust DTOs + command signatures → generated `src/lib/ipc/bindings.ts` (via a `cargo test export_bindings` test).
  Frontend never hand-writes IPC types.
- Browser dev mode: `pnpm dev:web` runs the Svelte app in a normal browser with `@tauri-apps/api/mocks` backed by fixtures
  exported from core.db (`cargo xtask export-fixtures`) — lets UI work proceed and be screenshot-tested without the native shell.
- Every crate has unit tests; `verify-core` gates the data; frontend has vitest unit tests for logic (normalisation, palette parsing,
  stores, timing interpolation). Real-app verification on Windows via WebView2 remote debugging (CDP) screenshots.
- Accessibility: one tab stop per page + roving tabindex over ayahs, glyph runs `aria-hidden` with visually-hidden Unicode text,
  focus rings, `prefers-reduced-motion`, `prefers-contrast`, `forced-colors`.
- i18n: all UI strings through `t()`; English + Arabic shipped; UI direction follows UI language, Mushaf always RTL.
- No telemetry. Network use is explicit and visible (downloads manager, offline indicator).
