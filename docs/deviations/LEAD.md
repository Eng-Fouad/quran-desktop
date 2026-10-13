# Lead decisions (binding on all packages; folded into ARCHITECTURE.md between waves)

Items 1–23 are folded into ARCHITECTURE v1.2 through [`../IMPLEMENTATION_NOTES.md`](../IMPLEMENTATION_NOTES.md) (its §0
summarises them); item 17's data rulings are also corrected in place in ARCHITECTURE §4 and FACT_SHEET.

## Wave-0 exit (2026-10-10)
1. **`pnpm bindings:check` is git-free**: `scripts/check-bindings.mjs` regenerates `bindings.ts` via `export_bindings`,
   fails on any difference and restores the original file. It works without commits.
2. **reqwest in src-tauri**: `src-tauri/Cargo.toml` now depends on `reqwest` (workspace version; Cargo.lock unchanged in
   versions). `AudioService` builds `CachingHttpSource` with a `reqwest::Client`. Preferred source of that client is
   `PackManager::http_client()` (WP5e adds it); until WP5e lands, WP4d's glue builds its own client with the same
   User-Agent (`QuranDesktop/<version>`; `QuranForDesktop/<version>` since item 16) and system-proxy settings, and WP5e
   switches it to the shared client at IC2.
3. **Wry vs generic runtime for tray/media hooks**: `AudioService` (WP4d) exposes
   `set_ui_sink(sink: Arc<dyn Fn(AudioUiEvent) + Send + Sync>)` (exact event type is WP4d's choice, documented in its
   deviations file). WP6a registers the sink in `setup::after_manage` (concrete `tauri::Wry` handle there) and the sink calls
   `tray::set_now_playing` (WP6b) and `media::on_audio_state` (WP6c). Hooks keep taking `&tauri::AppHandle`.
4. Accepted WP0A deviations: `#[allow(clippy::unreachable)]` scoped to `commands` (tauri macro), `dist/` not needed for plain
   cargo builds, extra `quran-types` helpers (`limits`, constants).
5. `src/lib/mushaf/metrics.ts` is owned by **WP8b** (§14.3 wins over §7.1). WP8a must not write it.
6. ripgrep (`rg`) is not installed: use the Grep tool / `git grep` equivalents wherever the DoD says `rg`.
7. `public/fonts/KFGQPC-Hafs-V30.ttf` is present in the working tree (gitignored). Its sha256 is
   `C9DD7E71A454565B13D89E5E6F2663A918ACB0A20A23EEA31ECCB32A3AEEC47A` (301,356 B); WP3c's `fetch-assets` must reproduce it.
8. **QDC raw data is already prefetched** (dev only, gitignored), all 1,812 pages, verified `pagination.next_page == null`:
   - `data/cache/qdc/chapters.json` ← `GET https://api.qurancdn.com/api/qdc/chapters?language=en`
   - `data/cache/qdc/by_page/m{1|2|19}/p{NNN}.json` ← `GET https://api.qurancdn.com/api/qdc/verses/by_page/{p}?mushaf={m}&per_page=all&words=true&word_fields=code_v1,code_v2,text_qpc_hafs,text_imlaei_simple,location`
   - `data/cache/tanzil/quran-data.xml` ← `GET https://tanzil.net/res/text/metadata/quran-data.xml`
   WP3a adopts this layout (or moves the files into its own layout once — never re-download needlessly).
9. **Never play audio through the real output device** in tests, examples or checks (the dev machine is the user's personal
   computer). Use the null/WAV sinks (`QD_AUDIO_SINK`).
10. Cargo target dirs: each package uses its own short dir `C:\qdt\<WP id>` (MAX_PATH + lock contention). The tauri-built
    debug exe is `C:\qdt\<WP>\debug\quran-desktop.exe` (pass `--exe` to app-driver).
11. The user's RustRover IDE may be open on the repo and run `cargo check`/build scripts into `target/`; ignore it.
12. No git commits/stages are authorised. Never run git commands that write (commit, add, reset, checkout, stash, clean).

## Wave 1–2 sign-offs (2026-10-10)
13. **S03 signed off** (first-run look: pages 1–2, hafs, paper, no decor — own SVG cartouche with rosettes, ogee medallion
    frame, Unicode basmala). WP-Brand icon signed off (interlaced khatam star + open book, gold on deep green).
14. `cargo test` accepts a single TESTNAME filter; acceptance lines listing several module filters are satisfied by one run per
    filter (or the libtest `--` form). Not a defect.
16. **Identity change (owner decision, 2026-10-10): the app adopts the github.com/quran (Quran.com) identity** because the
    owner plans to contribute it to that organisation. This supersedes BRIEF §5's identifier and §9.9's "geometry only" rule:
    - Product name **"Quran"** (window title, taskbar, installer, tray, media flyout); full name **"Quran for Desktop"**
      (About, onboarding, descriptions) — mirrors quran_android's launcher label "Quran" / "Quran for Android".
      Arabic: **"قرآن"** (quran_android's Arabic `app_name`) and **"قرآن لسطح المكتب"**.
    - Bundle identifier / AUMID **`com.quran.labs.desktop`** (mirrors `com.quran.labs.androidquran`); data dir follows it.
    - Licence **GPL-3.0-or-later** (as quran_android). Dependencies are GPL-compatible (MPL-2.0, Apache-2.0, MIT, OFL; the
      KFGQPC font ships unmodified as an aggregate).
    - Icon: the org's current mark — gold calligraphic قرآن on navy — from quran_android
      `app/src/main/res/drawable-nodpi/ic_upcoming_app_icon.webp` (1024 px, GPL-3.0, added 2026-10-04 "Add new icon
      announcement") = the github.com/quran avatar. Attribution in About + assets/brand/README.md.
    - Brand approval from the quran org maintainers is required before any public release under this identity.
17. **Data rulings (feature-build exit):**
    - Cross-page surah headers: in the source layouts, 18 (v2) / 21 (v1) surahs have their `surah_name` line on line 15 of the
      *previous* page (split header). This is authentic print geometry — FACT C15's "never orphaned" claim is wrong. Keep the
      source geometry; the gates (G8) and the renderer support both shapes. Fold into FACT/§4.4 at docs time.
    - Inline ۞ in the text (≈198 words whose glyph code / text begins with "۞ "): keep **verbatim** — the printed Madani
      Mushaf shows ۞ inline at the start of the quarter's first ayah. The margin marker shows the *label* (e.g. ربع الحزب)
      and must not render a second ۞ glyph next to an inline one on the same line. (Superseded in the margin by the
      owner request of 2026-10-13, WP8c deviation 9: every rub start draws the print's lamp or medallion with its label,
      inline ۞ or not, and the ۞ fallback without decor; the text keeps its ۞.)
    - WP3a deviation 1 (Imla'i source fields / C13) is accepted as implemented.
    - Multi-filter `cargo test` acceptance lines: the `cargo test -p X --lib -- f1 f2` form is the valid equivalent.
18. **Integration owns the identity sweep** (LEAD 16): names, identifier/AUMID, licence fields + LICENSE, copyright, UA
    string, i18n, docs, tests, per-OS configs (incl. pointing the Linux window icon at the tuned PNGs).
15. Integration follow-ups collected for the integration phase: register `AudioUiSink` in `setup::after_manage`
    (WP4d handoff), `PackManager::http_client()` + `refresh_surah_timings` (WP5e), add `.vitest/` to `.gitignore`.

## Integration (2026-10-10)
19. **Dependencies** (integration gate): `webview2-com = "=0.39.1"` is pinned in `[workspace.dependencies]` and
    `src-tauri` uses `{ workspace = true }` (already in the tree through wry at that version: no new crate). The unused
    `async-executor` entry left the workspace table (no member used it). `Cargo.lock` is unchanged. Every crate inherits
    the workspace `authors`, now the publisher "Quran for Desktop contributors" (item 16; the deb's Maintainer).
20. **Contract** (integration gate, additive): `PlayRequest.record: bool` (serde default `true`, optional in TypeScript).
    `false` marks a preview (the onboarding's ▶ 1:1): no listen history, never replayed by "play with nothing loaded".
21. **No kashida justification of the Unicode text** (integration gate 3; the Mushaf round's open question). The hafs
    style stays fitted per spread (`unicodeFit.ts`: median words-to-line fill 75 %, word gaps 0.48 qfs median) and is
    not filled to 80 % with inserted tatweel. Inserting U+0640 into the Quran text changes the text the page draws (copy
    and search use the source text, but the a11y layer, the highlights' word boxes and the shaping warm-up would all
    have to agree on the extended forms), and placing kashidas at legal joins with the harakat and waqf marks above
    them needs a reviewed rule set per letter pair, which the bundled KFGQPC face does not provide (no `jalt`). The
    print-exact line is what the QCF styles are for. Revisit only with a reviewed justification table (for example
    from the KFGQPC or QUL layout data) and an Arabic-script review.
22. **Release build** (integration, release engineering; measured in INTEGRATION.md "Release engineering"):
    - `[profile.release]` builds for size, `opt-level = "z"`, with decode, resampling and WSOLA at opt-level 3
      (`symphonia-core`, `symphonia-bundle-mp3`, `rubato`, `realfft`, `rustfft`, `quran-audio`): the exe is 1.1 MB
      smaller and the DSP chain 2.6–3.3× faster than at `"s"`. The IPC paths measured the same.
    - `tauri` is built without its `dynamic-acl` default feature (`default-features = false` plus the other defaults):
      the app never adds a capability at runtime, so a release build carries no runtime ACL table. No crate added or
      removed; `Cargo.lock` unchanged. Re-check the feature list on every tauri bump.
    - The rustls provider stays aws-lc-rs: ring would save 28 KB of installer and drop the X25519MLKEM768 group.
    - Windows bundle: the setup and uninstall executables carry the app icon, and the MSI upgrade code is pinned to
      UUIDv5(DNS, `com.quran.labs.desktop`) (tauri's default derives it from the generic product name "Quran"). The
      release ships NSIS only; an MSI is not a release asset.
23. **Quitting saves first** (integration final gate; contract, additive): event `quit-requested` (`QuitRequested`,
    payload `null`). WebView2 tears the page down without `pagehide` or `visibilitychange`, so every debounced write of
    the last second before a quit was lost (the reading position written 1 s after a turn, the recitation's `audio`
    position, the history dwell, a note draft's 400 ms autosave). Every user quit (× with nothing kept in the tray, the
    tray's Quit, the close question's Quit, a close from the taskbar or Alt+F4) now goes through `window::quit`: the
    window hides at once, Rust emits `quit-requested`, the page runs its `app.beforeQuit` hooks (at most 800 ms) and
    calls `app_quit`; Rust exits anyway after 1.5 s (`QUIT_GRACE`). Before the first `window_ready`, for a second
    request, and from the WebView2 failure dialog the app exits at once (`window::exit_now`). `app_quit` itself is
    unchanged. macOS Cmd+Q (the default app menu's Quit) still ends the app directly; see INTEGRATION.md.

## After the macOS pass (2026-10-11)
24. **The bundled font is committed, as a fallback** (owner decision; changes D23, answers ARCHITECTURE §15.3 item 5):
    GitHub's runners time out connecting to fonts.qurancomplex.gov.sa, so CI's font cache (keyed by `xtask/assets.lock`)
    was never filled and every job that needs the font failed. The unmodified KFGQPC Hafs V30 TTF (the item 7 pin) is
    committed at `xtask/assets/KFGQPC-Hafs-V30.ttf`, beside a note that it is under the KFGQPC EULA, not the GPL.
    `cargo xtask fetch-assets` still downloads first; when the download fails it takes the committed copy, after
    checking its size and sha256 against the pin, and writes the same `public/fonts/` font and licence text (§4.7 step
    5). Never on first use or with `--force`, and never for a downloaded file of the wrong size or hash. A pin or re-pin
    rewrites the committed copy; a test checks that it matches the lock. CI still restores its cache first and saves
    it after the first run that fills `public/fonts/`.
25. **The print's own furniture calligraphy, bundled** (owner decision, 2026-10-11): the running heads «سُورَةُ name»
    and «الجُزۡءُ …» and the margin hizb labels, stacked as the print sets them («رُبُع» / «الحِزۡبُ» / «٢٧»; «الجُزۡءُ ١٤» /
    «الحِزۡبُ ٢٧» at a juz start), are drawn in the 1441H Madinah print's own calligraphy. The owner chose to bundle the
    font, like the Hafs font: `public/fonts/QuranPrintLabels.woff2` (family "Quran Print Labels", CSS `qd-print-labels`,
    CFF in a WOFF2 container, 111,228 B; the generator's OTF of the same tables is 1,235,388 B, which first shipped:
    +1.18 MiB of `dist/` against its 6 MiB, 114 KB as LZMA, `xz -9`) is committed with
    `QuranPrintLabels.LICENSE.txt` beside it, and `main.ts` loads it before the first paint like qd-hafs (CLS 0), and again
    once the stores are initialised (`fonts.settleBundledFaces`): WebKit drops loaded CSS faces when the Arabic UI sets
    the root's `lang` and `dir`, which left the Arabic UI with the Hafs text in place of the print's calligraphy.
    - **Source:** outlines cut from 123 pages of the Mushaf Database "Ligature-Based SVG Mushaf" V1.01
      (github.com/mushafdatabase/MushafDatabase-Ligature-Based-SVG, folder `SVG V1.01`), whose artwork derives from the
      KFGQPC printing-use Madinah Mushaf (free use in computer programs, dm.qurancomplex.gov.sa/rights). The generator,
      its pinned fontTools and the page list are in `assets/print-labels/` (deterministic; it reproduces the committed
      file byte for byte). It reads `core.db` only to know what each page carries; its `map.json`/`report.json`/QA
      sheets carry `core.db` names and stay out of the repository. The app reads a numbers-only metrics table
      (`src/lib/mushaf/printLabels.ts`) generated from the font itself (`print_label_metrics.py`).
    - **Licence:** the dataset's open permission (Sadaqa-e-Jaria: use, copy, modify, publish, distribute, derivative
      works, commercial use included; the Quranic content never altered; the font holds none). The font is a separate
      work, not covered by the GPL, and ships unmodified; About ▸ Fonts credits it with the full text.
    - **What it replaces:** the Hafs text of the running heads from qfs 20 (below, the compact text stays) and the
      quran-common juz calligraphy (U+E001 + juz − 1) there; the Hafs word lines under a rub marker (qfs ≥ 28). The
      quarter in the running head (when the margin labels are hidden) is composed of the face's words and digits as an
      RTL flex row. The ۞ / quran-common ornament above a label, its hizb number in the frame, the sajda labels and the
      tooltips (Hafs words) are unchanged. (Since the owner request of 2026-10-13, WP8c deviation 9, the margin label
      is drawn at every size at 0.88·qfs, inside the lamp or the medallion, or under the ۞ without decor; no number in
      a frame.) It is print furniture, not decor: drawn whatever `ornateHeaders` says; the
      surah-header cartouche, the basmala calligraphy and the margin ornaments stay gated by it. Without the face (a
      failed load) the furniture keeps its Hafs text.
26. **A universal macOS app has its own installed-footprint budget, 40 MB** (owner decision, 2026-10-12; §13.6): it
    carries the binary twice, an arm64 and an x86_64 slice, so the 35 MB that fits a single-architecture install left
    the universal app (34.8 MiB after deviation 11 of WP-CI.md, 35.5 MiB before) without room. Every single-architecture
    install (Windows, Linux, a one-arch macOS build) keeps 35 MB. `scripts/size-budget.mjs` holds the `installed` row to
    `INSTALLED_UNIVERSAL` when the measured .app's executable is a fat Mach-O of two or more slices.
27. **reqwest without its `charset` feature** (lead, 2026-10-12; a `[workspace.dependencies]` change, DEVELOPING §6):
    every body is read as JSON or bytes; only stream-download reads one as text, an HTTP error's, for its message, which
    is now decoded as lossy UTF-8. It drops encoding_rs, 333 KB of the universal macOS app (WP-CI.md deviation 11).
28. **The README shows the app** (owner decision, 2026-10-13; an exception to §12.6's "Mushaf images are never
    committed"): `docs/screenshot.png`, the browser mock at 1600 × 1000 (`web-shot`, English UI, paper, the index open)
    with the 261–262 spread in the default Madani style (QCF V2 page fonts, the decorated header of Al-Hijr and the juz
    14 / hizb 27 medallion), and the app icon (`src-tauri/icons/128x128@2x.png`) above the title. The owner chose this
    over a Hafs-only page or waiting for the release (QUL) data, knowing the page's layout and fonts come from the
    development data and the downloaded page fonts. It is the only Mushaf image in git; every QA screenshot stays under
    the gitignored `artifacts/`.
