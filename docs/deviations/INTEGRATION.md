# Integration (lead roles; LEAD.md item 18 and the integration phase)

Each integration role appends one section: what it changed and why.

## Identity sweep (LEAD.md items 16 and 18)

The app now carries the github.com/quran (Quran.com) identity everywhere outside `docs/research/` and the historical
deviation files. A grep for `Quran Desktop|QuranDesktop|com\.qurandesktop|qurandesktop` finds only those files and two
"it was …" notes (ARCHITECTURE §2.8.3, DEVELOPING). Images were already done (assets/brand).

- **Names.** `productName`, every per-OS window title and `index.html`: "Quran". Full name "Quran for Desktop" in the
  About header, the onboarding, the Settings ▸ About row, the attribution ledes, the Cargo and package descriptions and
  the log line. New `common.appFullName` (additive to the frozen `common`); `common.appName` is "Quran" / "قرآن" (the
  Arabic UI used to show the Latin name, and Settings' group "مصحف سطح المكتب"). Rust gains `RustText::AppName`, so the
  tray tooltip, the tray notice's title and the close-to-tray caption follow the UI language (`TrayView::of(model)` and
  `close_question(lang, macos)` lost their `app_name` parameter). English Rust strings say "Quran …"; the Arabic ones
  already said "التطبيق". FatalScreen, the IPC "Run Quran in Tauri" error and the palette's "About Quran" use the product
  name.
- **Identifier/AUMID** `com.quran.labs.desktop`: `tauri.conf.json`, `APP_ID`, the media-session fixtures and the mock
  (`C:/mock/com.quran.labs.desktop`). MPRIS track ids live under `/com/quran/labs/desktop/track`. `DESKTOP_ENTRY` is
  "Quran" (the bundler writes `{productName}.desktop`, re-read in tauri-bundler at `tauri-cli-v2.12.1`). The bus name
  stays `org.mpris.MediaPlayer2.quran_desktop`, after the binary: a bare `…quran` would be too generic a well-known name.
  The Win32 snap-target class is `QuranSnapTarget`. The data directory follows the identifier; the old
  `com.qurandesktop.app` directory is not migrated (no release shipped; DEVELOPING says how to carry user.db over).
- **Installer metadata.** `bundle.publisher` is "Quran for Desktop contributors" (otherwise the exe's CompanyName and the
  Apps-list publisher would be "quran", the identifier's second element). `bundle.license` is "GPL-3.0-or-later".
  Copyright is "© Quran for Desktop contributors". The built exe reports ProductName/FileDescription "Quran". No
  `licenseFile`: the NSIS licence page needs an "I agree", and the GPL needs no acceptance (product decision if wanted).
- **Guards.** `lib.rs` tests that `APP_ID`, `productName`, `mainBinaryName`, the licence, the copyright and the publisher
  match `tauri.conf.json` and `CARGO_PKG_LICENSE`. `media.rs` tests that `DESKTOP_ENTRY` is `productName` and that the
  session config validates. `i18n.rs` tests that `RustText::AppName` is `common.appName` in both dictionaries.
  `setup::USER_AGENT` has a product-token test.
- **Linux icons.** `tauri.linux.conf.json` lists `tray/tray-32.png` first, then `tray-16`, `tray-24`, `64x64`,
  `128x128`, `128x128@2x` and `icon.png`. tauri-codegen makes the first PNG the window icon, which was the soft Lanczos
  `32x32.png`. The deb bundler keeps one hicolor icon per size, so 16/24/32 px are now tuned. `window.rs`'s config test
  checks the order and that no size repeats, and `brand.test.ts` checks the files exist. The `tauri icon` files
  themselves are untouched, so the acceptance command still reproduces them.
- **User-Agent** `QuranForDesktop/<version>` (`setup::USER_AGENT`), and `QuranForDesktop-xtask/<version>` for xtask.
  Test fixtures and docs follow.
- **Licence.** `LICENSE` is the unmodified GNU GPL v3 text from gnu.org (sha256 `3972dc97…b36986`). The workspace
  `license` and `package.json` `license` are `GPL-3.0-or-later`, and `README.md` is new (name, identity, building,
  sources, licence notice). The xtask licence policy now reads "compatible with distributing the app under
  GPL-3.0-or-later" and drops the GPL-incompatible `OpenSSL` id from `ALLOWED`. No dependency used it:
  `cargo xtask licenses` reports `thirdparty.json` unchanged. A test was added.
- **About.** A first attribution group, "This app" / "هذا التطبيق", has two entries. The first is the app: © line,
  GPL-3.0-or-later with the gnu.org link, and "Show the licence", which loads the repository's `LICENSE` as a lazy
  `?raw` chunk. A served copy would drift, and Tauri types an extensionless asset as HTML. The second is the icon credit
  "Quran.com / quran_android contributors", GPL-3.0, linked to quran_android, with the note that the app is built to the
  Quran.com project's identity. The hero shows `common.appFullName`, and its icon is decorative (`alt=""`), per the
  brand README's rule. Tests: attributions, about.browser and S25 (the group order now starts with `app`, plus the GPL
  text and the Arabic name).
- **Docs.** BRIEF (title, an identity note, §1, §5 identifier, product name and UA), ARCHITECTURE (title, an identity
  note, §2.1 licence, §2.4 SessionConfig and trackid, §2.5 UA, §2.8 AUMID and data directories, §4.2 UA, §5.3
  AppInfo, §5.16 message, §9.6, §9.7 About, §9.8, §9.9 rewritten to the new brand, §11.4 AppName, §13.5 config and Linux
  icons, R12), each marked "Changed by LEAD 16". Also DEVELOPING (name, a data-directory table, the migration note),
  assets/brand/README (Linux icons), a note on the WP6d Requests and LEAD item 2.
- **Verified.** `pnpm check`, `pnpm lint`, `pnpm format:check`, `pnpm bindings:check`, `cargo fmt --all -- --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, and media-session clippy for
  `x86_64-unknown-linux-gnu` and `aarch64-apple-darwin`. Browser tests pass for about, onboarding, shell and settings,
  and S01 and S25 pass in the mock. The real app (app-driver) shows the window title "Quran" and the SMTC session
  "Quran", and About in English and Arabic was checked with the GPL text open, as were Settings ▸ About and the
  onboarding in both languages. `pnpm test` has one failure unrelated to this sweep: `qdtest.test.ts` "opens overlays
  with QA defaults" expects `reader.actionTarget` 8 from an off-screen cursor, which `reader.svelte.ts` no longer
  honours.

## Rust integration (crates, src-tauri, xtask)

### For the frontend: two additive commands (`bindings.ts` regenerated)

`pnpm bindings` was run; `pnpm bindings:check` is green. `src/lib/ipc/mock/index.ts` (`mockCommands satisfies Api`)
needs a handler for each new command, or `pnpm check` fails:

- **`userBackupRestore(srcPath: string) → null`** (§9.8 "Restore from backup…", requested by WP2b and WP7c). Replaces
  the whole library with a backup made by `userBackupCreate` (any absolute path; the dialog plugin's `open` is allowed
  by the capability). The file is verified first: a wrong file is `invalid_argument` (not a library, or from a newer
  app), a missing one `not_found`, and nothing changes. The current library is first kept as a new backup in
  `<data>/backups/`. Afterwards the app emits `settings-changed` (the restored settings), `user-data-changed` with all
  ten kinds and `packs-changed` for every pack (the registry is re-synced with what is on disk). Suggested mock:
  `user.ts` — accept a non-empty path, reset the user slice to its defaults, emit the same three events. UI: the
  `UserDbRecovered` banner (`StartupBanner.svelte`) can now offer "Restore from backup…" (file picker → command → dismiss).
- **`windowSetCaption(visible: boolean) → null`** (WP6b's request). Call it with `false` while zen hides the title bar
  (`ui.zen && !ui.zenTitleBar`) or a full-window overlay covers it, and `true` when it shows again (an `$effect` in
  `App.svelte`). On Windows 11 the native Snap Layouts target over the maximise button (a child window above the
  webview) otherwise stays active in the top corner while the title bar is hidden: the page under it takes no clicks,
  and a click maximises the window. Default: visible. Mock: `app.ts`, `handle(() => null)`.

The frontend integration picked both up (mock handlers in `app.ts`/`user.ts`, `TitleBar.svelte`,
`settings/backup.ts`); `pnpm check` then reported 0 errors. The restore also drops the `user_db_recovered` notice from
later bootstraps, so a webview reload no longer shows the banner.

### Requests harvested and implemented

- **Shutdown** (WP5e → WP6a): `AppState::shutdown` stops the pack manager's revalidator first, so its requests end with
  the app; jobs need nothing (their journals resume them).
- **Blocking pool** (WP5e → WP4d): `audio_list_reciters` reads user.db and content.db on the blocking pool.
- **Per-chapter delete** (WP5e → WP1c): `ContentDb::delete_chapter(pack, surah)` deletes a chapter's WBW rows or
  tafsir entries and its stamp in one transaction. `remove_items` uses it instead of WP5e deviation 10's "delete the
  pack, write the kept chapters back", which could lose the kept chapters if interrupted.
- **One-column stamp** (WP5d → WP2b): `UserDb::pack_set_checked`; the revalidator no longer read-modify-writes the
  whole `installed_pack` row, so a job finishing meanwhile keeps its columns.
- **Settings read-modify-write** (WP6b → WP2b): `UserDb::settings_edit` (one transaction) and `settings::ops::edit`
  (inside the writers' gate; a no-op edit applies no hook and emits nothing). `window::write_settings` (close-to-tray
  answer, tray hint) uses them and the now generic `settings::apply_hooks`, so it can no longer undo a concurrent
  `settings_set`, and it no longer repeats the hooks.
- **Statement cache** (WP2a → WP2b): user.db keeps 128 prepared statements (about 90 distinct ones exist; the default
  of 16 re-prepared hot paths).
- **Footnote order** (WP5c → WP1c): `PackDb::footnotes_for` orders by the marker's number in any script's digits
  (Bengali `১০` after `২`), then marker, then id. SQLite's `CAST` read non-ASCII markers as 0.
- **Copy text** (WP1c → WP1a): `quran_copy_text` reads the translation with `PackDb::plain_range` (one range query,
  not one query per ayah).
- **Rule 7** (WP4d/WP5d → WP5e): on a timings/file mismatch the glue calls `PackManager::refresh_surah_timings`
  (`TimingsFetcher::refresh`), which replaces the pair in one step: an unpinned changed file is dropped with its old
  timings; a pinned pair is kept and the revalidator woken. The glue used to delete the timings and refetch, leaving a
  window without timings and never waking the revalidator. Offline nothing is attempted; a failed attempt may be
  retried.
- **Stream-cache recency** (WP5e): every successful audio open calls `PackManager::audio_used`, which touches the
  surah's `pack_item` row on the blocking pool, so eviction is least recently *played*, not least recently streamed.
- **First-launch deep link** (WP6b → WP6a): `window_ready` (the frontend listens by then) opens a `quran-desktop:`
  argument the app was started with; `DeepLink::among(argv)` is shared with the second-instance path. Arguments that
  are not valid Unicode are skipped (`args_os`), never a panic.
- **Restore and caption** (WP2b, WP7c, WP6b): the two commands above. Rust pieces: `UserDb::check_backup` (verify
  read-only before anything changes), `settings::ops::replace_store`, `PackManager::registry_replaced` (re-sync, then
  every pack reported), `AppState::library_restored`, `window::set_caption_visible` (the snap target exists only while
  the caption does).
- **UI sink comment** (WP4d → WP6a): `AudioService::start` registers the sink (WP4d item 20); the obsolete marked
  comment in `setup::after_manage` now says so.
- **build-core** (WP3d, WP3b → WP3a): `--source qul` calls `qul::load(data/sources/qul)`, and the build verifies
  against its own Tanzil file (`verify_db_with`). `qul.rs` lost its module-wide `dead_code` allow; two items only the
  tests read (`Input::ALL`, `Manifest::get`) keep a scoped allow with a reason.
- **CI blocker** (WP-CI → WP1c): `real_qdc_files_sanitise_cleanly` returns with a `SKIPPED` note when
  `QD_QDC_TIMINGS_DIR` is unset, so `cargo test -p quran-core -- --ignored` (test-core) passes without QF responses.
- **media-session** (WP6d, WP6c): `objc2-foundation` uses WP6d's verified feature list (`default-features = false`);
  `async-executor` is dropped from the Linux dependencies (unused); stale comments are fixed; the `rate_command` allow
  is gone and `MediaSessionError::platform`'s is limited to macOS. `Cargo.lock` lost one dependency edge; no version
  changed. Clippy is clean for `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`.
- **Media artwork** (WP-Brand → WP6c): the OS media session shows `icons/media/artwork.png` (512 px, square, opaque)
  instead of the 256 px app icon, whose transparent corners the flyouts would frame.
- **Dependency** (WP6a): `regex` is no longer a `src-tauri` dependency (the protocol has its own parser).
- **Empty basmala** (WP5a's reciter-173 finding → WP4b): QDC reciter 173's surah-1 file has 1:1 at 80–80 ms (the file
  starts after the basmala). The planner now leaves an audio-less basmala out instead of planning a 0 ms segment that
  flashed "basmala" in the UI and the OS media session. Checked in the real app: reciter 7 plays
  `112:0 → 112:1 → 112:2`, reciter 173 plays `112:1 → 112:2`, both without error.

Already done by the packages (checked): the UI sink registration and the shared HTTP client (WP4d), `translation_db`
answering `NotFound` (WP5e), listen-history `UserDataChanged` (WP4d), the `RunEvent::Exit` shutdown and
`media::on_ui_language_changed` (WP6b), tombstoned notes kept out of search (WP1b), the G15 warm-up (WP3b), the
unbounded `CtlMsg` channel and `basmala_skipped` (WP4c), plain-pack query folding (WP1b), scope-All requirements and
recitation updates through the revalidator (WP5e), every requested page answered by `mushaf_ensure_page_fonts`
(WP5c), and the per-OS bundle icons (WP6b).

### Not done (reasoned)

- `search_history` `UserDataKind` (WP2b, optional): a contract change with no visible gain; the history kind refreshes
  both lists.
- `ContentDb::{chapter_touch, timings_touch}` (WP5d, optional): an unchanged revalidation rewrites at most 286 small
  rows after a network round trip, which does not justify more API.
- `user_db` limit re-exports (WP2a, optional): nothing outside quran-core needs them.
- Lazy planning (WP4d → WP4b/WP4c): an engine design change. The glue's prefetch (4 at a time) bounds the wait before a
  long uncached play; worth doing after release.
- OS registration of the `quran-desktop:` scheme (WP6b): a product decision (installer or deep-link plugin).
- Reciter 173's basmala: the recording has none upstream. Borrowing reciter 7's (the same reciter, Mishary Alafasy)
  would need a catalog field, so it is a product decision.
- Outside this role's files: the §14.3 multi-filter acceptance syntax and the spec fold-ins (docs); the root
  `Cargo.toml` still lists `async-executor` in `[workspace.dependencies]` though no member uses it (harmless); the
  `assets/brand/README.md` row that says WP6c embeds `128x128@2x.png` (it now embeds `media/artwork.png`).

### Verification (`CARGO_TARGET_DIR=C:\qdt\int-rust`)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean (media-session also for the macOS and Linux targets) |
| `cargo test --workspace` | 1,286 passed, 0 failed, 20 ignored (94 test binaries) |
| `QD_CORE_DB=… cargo test -p quran-core -- --ignored` | all pass on the fresh core.db |
| `pnpm bindings:check` | up to date |
| `cargo xtask build-core --source qdc` (warm cache) | 1,814 cached files reused, 0 fetched; 18/18 gates |
| `cargo xtask verify-core` | 18/18 gates, 139 checks |
| `QD_NET_TESTS=1 cargo test -p quran-packs -- --ignored` | live 2/2, quranenc_real 2/2 |
| `pnpm tauri build --debug --no-bundle` | built |
| IC1 `smoke.mjs --strict` (`QD_AUDIO_SINK=wav:…`) | passed: pages 1–2, goto 262, overlays, settings across a relaunch |
| IC2 `ic2.mjs --strict` (WAV sink) | passed: 1,392 ticks over 1:1–1:7, 0 word mismatches; QCF v2 pages 1–3 |

Scratch real-app checks (not committed) covered four things:
- the restore round trip: theme and bookmarks restored, the UI follows, two files in `backups/`, wrong paths refused;
- the Snap Layouts target hidden and shown by `windowSetCaption`, read back with Win32;
- the first-launch link `quran-desktop://page/50`;
- the reciter 7/173 basmala above.

The app-driver waits for every running `quran-desktop.exe`, because the app is single-instance. A user-installed
"Quran Preview" (another identifier) was running, so the runs used a renamed copy of the debug exe
(`quran-desktop-int.exe`).

## Frontend integration (src, tests/e2e, scripts, root configs)

Every open request in the frontend from the feature-build digest and the `Requests` sections was checked against the
code. Most were already done by their owners; the rest are below, then the ones left on purpose.

### Bugs fixed

- **Body lock left behind** (WP9b's report). An overlay opened inside `OverlayHost`'s 260 ms exit window left
  `<body>` with `pointer-events: none; overflow: hidden`, so the app took no more clicks.
  - Cause: the closing instance's Dialog follows `ui.isTop(kind)`. A new entry of the same kind made it true again,
    so the instance being replaced opened once more and took a bits-ui scroll lock that it never released.
  - Fix: each instance knows its own entry (`OverlayInstance` sets it, `overlay.ts`). The seven overlay components open
    on `overlayOpen(kind)`, which is true while *their* entry is the top. A browser test reproduces the bug and now
    passes.
  - The same race made `AyahContextMenu` "creates a collection…" time out under load.
- **Floating content under dialogs** (WP7b requests from WP10c, WP11d and WP12c). A menu, select, combobox or popover
  opened inside a `Dialog` or `Sheet` rendered behind it. `Dialog`/`Sheet` now set a modal-layer context, and the
  floating primitives sit just above that layer (`floatingZ`): popovers at +1, menus at +2. The three local
  workarounds are gone: the note editor's `.note-popover`, the onboarding's `body:has()` rule and the palette's.
  A test checks that the options can be clicked.
- **Tests behind the real reader and player**: 1 unit and 7 browser failures. The action target is the *visible*
  cursor (§8.15), and `player.currentAyahId` comes from the heard ayah. The tests now do what the app does: they bring
  the cursor's page on screen first, emit `audio-state-changed`, or set `heard` with the snapshot. The speed-slider
  test now asserts the real `nav.prevPage` (the page stays put, then turns). None was weakened.
- **Shared pointer**: browser test files run in parallel and share the real mouse. The HighlightLayer tests therefore
  keep hover tinting off unless the test is about hover, so a stray pointer cannot tint an ayah under another test's
  assertions.

### Requests implemented

- **First run** (WP8f, WP12c): `App.svelte` opens the onboarding when `app.firstRun && !onboardingDone`, never in test
  mode. `bootApp` gains `firstRun` (default `false`, so tests start on the reader).
- **Restore from backup** (WP2b, WP7c; Rust added `user_backup_restore`): `settings/backup.ts` runs both flows.
  - The startup banner offers "Restore from backup…" (the §9.8 action): a file picker, a destructive confirm, the
    command, then the banner goes. "Show files…" stays.
  - Settings › Storage has a new "Library backup" group with "Back up…" and "Restore…". Before this, nothing in the
    UI created the backup a restore needs.
  - The mock keeps backups by path in memory. Restore keeps the current library as a new backup first, then emits
    the same three events as Rust.
- **Snap Layouts** (WP6b; Rust added `window_set_caption`):
  - `ui.captionVisible` is false while zen hides the title bar or a modal's backdrop covers it. Modals are counted by
    `trackModal` in `Dialog`/`Sheet`. `TitleBar` sends the value on Windows.
  - `WindowControls` shows the native target's `qd:caption-button` hover and pressed states.
  - The "Win+Z for snap layouts" tooltip is gone, with its `shell.window.snapHint` key.
- **Fit at the legibility floor** (WP8e → WP8a, S29): in `auto`, `fitLayout` ranks the floor above the 85 % spread
  preference (`floorSingle`):
  - a spread below `QFS_MIN` loses to a single page that does not drop below it;
  - when both drop below it, the spread loses to a single page that still fits the width at 18 px.
  - The §8.2 acceptance values are unchanged. S29 asserts a single page with vertical scroll only, in both modes.
- **Mock UI scale** (WP8e → WP7c):
  - The mock divides the window size by its CSS zoom, so the §9.6 rules see what the webview-zoomed app sees.
  - `.app` uses `calc(100vh / var(--qd-mock-zoom, 1))`, because viewport units inside a zoomed root are zoomed too.
  - S29 and S24 now fit the window, and S29's screenshot is no longer a full-page capture.
- **Breadcrumb** (WP8e, WP10a → WP7c):
  - The segments are keyed on the text, so a surah name of another width replaces them instead of moving them (no
    layout shift on a turn).
  - The Arabic UI separates the segments with the Arabic comma "،", set against the word before it. A middle dot next
    to Arabic-Indic digits reads as ٠.
- **Mistake key** (WP9b): `memo.mistake` (`m`, reader scope, only during a self-test) is a registry definition with the
  new label `shortcuts.memorize.mistake` (en/ar). By §7.7 precedence it beats the global mute, and it is listed in
  the shortcut sheet. The capture-phase listener and `isMistakeKey` are gone.
- **Primitives**:
  - An empty `TextInput`/`SearchInput` takes the UI direction, so the Arabic placeholder sits at the start; the four
    per-caller workarounds are gone (WP10a).
  - A full-width `Segmented` gives each option at least its label's width (WP10b).
  - `Tooltip` forwards `tabindex`, so `IconButton` keeps a roving `-1`, and the note editor's DOM workaround is gone
    (WP11d).
  - A keycap named in Arabic ("مسافة") uses the UI font (WP12c).
  - `Rosette` digits are size-aware: `min(0.42·size, size/6 + 7px)`, and `size/6 + 5px` for three digits. The
    overrides in `KeyBadge` and `AyahHeader` are gone (WP11a, WP11b).
  - `Sheet` gains `dismissible` and `onEscapeKeydown`, as `Dialog` has (WP11d).
- **Fonts**:
  - `fontBytes` accepts the `number[]` that Tauri's postMessage fallback delivers (`toArrayBuffer`; WP6a).
  - A face that fails by URL is retried once through `font_bytes`, and the session then stays on bytes (WP6a → WP8b).
  - Settings › Mushaf marks Tajweed "Not supported on this system" and does not select it when the COLR probe failed
    (WP8b → WP12b).
- **Translations store** (WP11b → WP11a):
  - `ensureWindow(…, { remember: false })` for the study pane's loads, so they never replace the feed's window.
  - `wbwForRange` asks for the exact range when an aligned chunk fails offline.
- **Mock fidelity**:
  - A page font fetched on demand is recorded as a cached item of its `mushaf.v*` pack. Rust also reports a fresh
    page with `packs-changed`; WP12a's optional request.
  - `FixtureManifest.queries` is typed `{ slug, request }[]` (WP1b, WP10b).
- **WordTooltip** hides while memorising a hidden word that hover does not reveal (WP9b → WP8d).
- **Smaller fixes**:
  - Scrubber ticks use the full `--text-muted`; at 70 % they were below §9.2's 3:1 (WP7a → WP9a).
  - The hide-style samples in Settings use `memo.css`'s values (WP12b ↔ WP9b).
  - `index.html` uses the app icon as its favicon (WP-Brand).
  - The onboarding's "memorise/memorisation" is now "memorize/memorization", as in the rest of the English UI.
- **Wave bridges removed** (WP8a, WP8d; lead's integration checkpoint). Gone:
  - `MushafPage`'s Hafs bridge and placeholder CSS;
  - `HighlightLayer`'s singleton bridge;
  - `MushafView`'s placeholder CSS and `OverlayHost`'s placeholder card;
  - `selectAyah`'s fallback (`nextSelection` is now the reader's, re-exported).
  - No component used `lib/contracts/Placeholder.svelte`, so it is deleted. Tests assert that no `[data-placeholder]`
    exists.
- **Scenarios**:
  - S36 uses the direct path: a paused play, then an ayah seek (WP9a → WP11a). It starts the reader at 1:1, so the
    follow brings 2:1 30 % down.
  - S30 downloads page 262's neighbours before the failure. Like the app, a fresh page anywhere in the style now
    retries failed pages, which would otherwise clear the failure it shows.
  - `tests/e2e/lib/tsconfig.json` type-checks every scenario and `scripts/measure-glyph-scale.mjs` (WP8b → WP13a).
- **Repository**: `.vitest/` is gitignored (LEAD 15). `vitest.config.ts` sets `attachmentsDir: artifacts/vitest-browser`,
  so failure screenshots land where DEVELOPING says. `package.json` gains `check:artifacts`, `check:ci`, `brand` and
  `brand:check` (WP-CI, WP-Brand; no dependency).

### Not done (reasoned)

- **Zen with the side card** (WP8f's observation): the book centres in the whole canvas in zen (WP8e deviation 3), so
  a revealed card can cover a page corner. The card appears only while the pointer is in the bottom 80 px, like a
  revealed toolbar. Reserving its space would put the book off-centre for good, which is what WP7c asked to avoid.
- **`player.previewReciter`** (WP12c → WP9a, optional): the onboarding's preview calls `audio_play`/`audio_stop` itself
  (WP12c deviation 10). It is isolated and tested, so moving it into the store brings no visible gain.
- **Docs**: the DEVELOPING §7 additions (WP13a, WP-CI) and the spec fold-ins are for the docs pass. This role's files
  do not include them.
- **Real-pointer browser suites** (WP8f's observation): the dwell tests can share one mouse when files run in parallel.
  Five full `pnpm test:browser` runs in this pass were green, so file parallelism stays on. A sequential run
  (`--no-file-parallelism`) takes 4 minutes instead of 30 s, and WP8d's three dwell tests in
  `interactions.browser.test.ts` fail there: they assume the pointer starts away from the page. Parking the pointer
  at the start of those tests is WP8d's to do.

### Verification

| Gate | Result |
|---|---|
| `pnpm check` | 0 errors, 0 warnings (5,351 files) |
| `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | clean · 201 files, 0 violations · clean |
| `pnpm test` | 72 files, 2,306 tests passed |
| `pnpm test:browser` (Edge) | 38 files, 497 tests passed |
| `pnpm build && pnpm check:dist` | built; check passed (3.27 MiB) |
| `pnpm shots:web --serve 1952` (S01–S37 + smoke) | 38 passed, 0 failed, 0 pending; no errors, warnings or console errors |
| `pnpm exec tsc -p tests/e2e/lib/tsconfig.json` · `node --test` (harness) | clean · 36 passed |
| `pnpm bindings:check` | up to date |
| `pnpm tauri build --debug --no-bundle` (`C:\qdt\int-web`), then `app-driver --strict` | smoke, S07, S24, S28, S29, S32 passed in the real app |

Every scenario PNG was read; nothing visual regressed.

## Integration gate (`CARGO_TARGET_DIR=C:\qdt\int-gate-1`)

The full verification ran on the merged tree, then again after the fixes below. Every gate is green.

### Fixed

- **`pnpm test` was red on a fresh clone** (CI's test-web), though green locally. Nine unit tests (`library.test.ts`
  toasts, `pagenav.test.ts` page label) hard-coded a real core.db's names ("Al-Baqarah", "Al-Fatihah"). test-web runs
  without the gitignored fixtures, so the mock serves the synthetic Tanzil index ("Al-Baqara", "Al-Faatiha"). The
  expectations now read the name from the loaded index (`quran.surah(n)?.nameSimple`, as the Arabic page-label test
  already did). They still assert the exact text and the right surah, so nothing is weaker. Found by running the gates
  on a copy of only the tracked files: no core.db, `data/cache`, fixtures or font. DEVELOPING §5 now states the rule.
- **Debug log readability** (`src-tauri/src/lib.rs`): `rusqlite_migration` is capped at Info like the other noisy
  targets. At Debug it printed the whole user.db and content.db DDL on every first launch: about 190 lines (157 from
  user.db's migration, 30 from content.db's). "Database migrated to version 1" stays. Checked in the final app run:
  no DDL in any scenario's log.

### Verification (final tree)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` | clean · clean |
| `cargo test --workspace` | 1,286 passed, 0 failed, 20 ignored (94 binaries) |
| `pnpm bindings:check` · `cargo xtask licenses` | up to date · `thirdparty.json` unchanged |
| `cargo xtask verify-core` | 18/18 gates, 139 checks, 0 warnings |
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,351 files) · clean · 201 files, 0 violations · clean |
| `pnpm test` · `pnpm test:browser` | 72 files, 2,306 passed · 38 files, 497 passed |
| `pnpm build && pnpm check:dist` | 6/6 checks, 3.27 MiB |
| `pnpm check:tooling` | 74 ok, 0 failed; pending: WP13b's `size-budget.mjs` (wave 3); warning: `rg` (LEAD 6) |
| CI lint extras: `node --test` (tooling and harness), `tsc` (actions, e2e), `pnpm check:ci` | 82 passed, 1 skipped (no 7-Zip/xz) · clean · policy passed |
| `pnpm shots:web --serve 1962 --strict` | 38/38 passed; 0 page errors, warnings or console errors |
| `pnpm tauri build --debug --no-bundle`, then `app-driver --registry tests/e2e/scenarios --strict` | 25/25 passed (IC2, smoke, S03–S13, S19, S24, S26–S35); no "panicked", no app ERROR, 1 WARN (symphonia skipping 45 junk bytes of the CDN MP3) |
| IC2 (WAV sink) | 1,391 ticks, ayahs 1:1–1:7 in order, every tick on its timed word; QCF v2 pages 1–3 downloaded, page 1 fitted |
| Fresh-clone parity (copy of the tracked files) | `cargo test --workspace` 1,286 passed (placeholder core.db); `pnpm test` 2,295 passed, 11 skipped; `pnpm check`, `lint`, `format:check`, `lint:css`, `build && check:dist` clean |

All 114 web and 61 app PNGs were read; nothing visual regressed. The app runs used a renamed copy of the debug exe
(`quran-desktop-int.exe`) because the user's "Quran Preview" install was running.

Notes:
- `pnpm test:browser` and `pnpm shots:web` need the exported fixtures. On a fresh clone without them, 41 browser tests
  fail on fixture data (names, catalog sizes, timings). This is by design: §12.5 and §13.3 run them in test-core after
  `export-fixtures`.
- `check:dist` is for production builds. After `pnpm tauri build --debug`, `dist/` is unminified with source maps:
  11.6 MiB, and `__MOCK_IPC__` appears in a doc comment. The check then fails until `pnpm build` runs again. No mock
  module is bundled (the source-map check passes).
- Vite warns that the main chunk is 1.56 MB (456 kB gzip). This is not a gate; splitting rarely used overlays into
  lazy chunks could speed the first paint, which is now about 280 ms in the debug app.
- Not verifiable here: the macOS and Linux CI runners (`cargo test -p media-session` on macOS, the deb/AppImage
  bundles) and a real GitHub run of `ci.yml`.

## Mushaf fixes, round 1 (`src/components/mushaf`, `src/lib/mushaf`, `src/styles/mushaf`, the fonts and reader stores)

Five review findings, fixed at the root. Scratch scenarios and crops: `C:\qdt\int-fix1-mushaf-qa`.

### Renderer crash after Tajweed V4 (blocker)

**Root cause: `override-colors` with two or more entries.** Deleting the V4 faces after leaving V4 was not enough. The
suggested fix is in (below), and the headless mock passed with it. But the real app still crashed in round 5, and
headed Edge (GPU raster, like WebView2) in round 8. Bisected in headed Edge with the reviewer's loop (`scen/M5.mjs`:
V4 on page 42, then language × view switches and theme flips, 14 rounds), changing one thing at a time:

| Palette rule | Runs | Result |
|---|---|---|
| none (`font-palette: normal`) | 2 | no crash |
| `base-palette` 0, 1 or 3 only | 3 | no crash |
| one override (entry 0, 13 or 14; base 0 or 1) | 5 | no crash |
| two overrides (`0, 13`) | 1 | crash, round 11 |
| three overrides (the app's `0, 13, 14`; or `0, 1, 2`; same or distinct colours; any order) | 5 | crash, rounds 7–11 |
| all sixteen entries | 1 | crash, round 12 |
| the app's rule, staying on V4 (never leaving it) | 2 | crash, rounds 6 and 8 |
| `base-palette` 0 plus an SVG `feColorMatrix` filter on the lines (leaving V4; staying on V4) | 2 | no crash |

- Without the COLR probe it still crashed, and without the lines' `transform` too. Without V4 the same loop runs 14
  rounds in the app and in headed Edge.
- So any page that ever drew V4 through a multi-entry `override-colors` rule crashes the renderer later. A
  deliberate `0x80000003` break in msedge.dll. It happens even while V4 is still shown, once the language, the views
  and the theme have changed a few times.
- This is a Chromium defect (Edge and WebView2 154.0.4258.62). It is worth a report upstream with `scen/M5.mjs`.

**Fix** (`palettes.ts`, `fonts.svelte.ts`). The rule carries **no `override-colors`** (`MAX_OVERRIDES = 0`), only the
base palette. One entry would be safe, but the ink lives in more than one entry: entry 0, the diacritics' 14 (#040000
in palette 0, #fbffff in palette 1), the marker digits' 13, and 1–9 in the plain palettes. Overriding only entry 0
left the diacritics and the plain rule letters off-tone, about 15–25 levels: measured with S10's ink check, which
failed with Δ 15. The theme is applied instead by a colour map on the V4 lines:
- the map is an SVG `feColorMatrix` in sRGB, in a hidden `<svg id="qd-v4-ink-svg">`;
- lines.css's `font-palette` selector (`V4_LINES_SELECTOR`) gets `filter: url(#qd-v4-ink)`;
- a base palette plus an SVG filter passes the loop: 2 headed runs.

What the map does:
- **Ink.** It takes the palette's ink to `--ink` exactly, in every ink entry:
  - light pages: `c·(1−t) + t`, black → ink, white stays white;
  - night and black: `c·F·k + P·(1−k)`, white → `#e9e4d8` at brightness `k` over the page, which is how `--ink` is
    made. `F` is recovered from `--ink` and the page.
  - Other colours follow the same map: they lighten by the ink's few levels on a light page, and dim with the text on
    a dark page.
  - Checked in the browser: S10's drawn-ink measurement gives exactly the resolved ink, (161 158 151) at 65 % and
    (233 228 216) at 100 %.
- **High contrast** (the theme, or `prefers-contrast: more`) with tajweed. Before, nine HC overrides on palette 0 and
  two on palette 1. Now the map is multiplied by the mildest factor that brings every rule colour to ≥ 4.5:1 on the
  page (`contrastLift`).
  - The factor works like Chromium's `brightness()`, measured in Edge: sRGB channels × f, truncated. The check holds
    for both roundings.
  - Results: white 0.71, paper 0.69, sepia 0.64, black 1.04.
  - Night with `prefers-contrast: more` has no factor in range: pure red reaches 4.3:1 at most on `#1a1c1f`. V4 then
    draws its plain palette (ink only), the one case where high contrast drops the tajweed hues.
  - `HC_LIGHT_OVERRIDES`/`HC_DARK_OVERRIDES` are gone.

**Hygiene kept** (the suggested fix; it also frees memory) (`fonts.svelte.ts`, `fontRegistry.ts`,
`RenditionStack.svelte`):
- `init` watches `mushafStyle`, and the style it moves away from is *left*. A left style's LRU budget is 0
  (`evictFaces` takes a budget per group), so its faces go as soon as nothing draws them. A late prefetch answer for it
  is never loaded.
- A style change cross-fades, so every QCF rendition holds its face (`fonts.track`) while it is in the stack, a
  fading-out one included. Without the holds the old page drew 26 frames without its font.
- Returning to a style is a normal `ensure`.
- `deleteFace` now also removes a face that is still loading.

**Tests.**
- `palettes.test.ts`:
  - a sweep of every theme × tajweed × contrast preference × ink × page × brightness: never `override-colors`;
  - every ink entry mapped to the theme ink, and the night dimming;
  - every HC case at ≥ 4.5:1 for both roundings, with the mildest lift and the plain fallback on night;
  - the `feColorMatrix` values and the hidden SVG filter;
  - the filter math against Edge's measured values;
  - lines.css naming `V4_LINES_SELECTOR`.
- `fontRegistry.test.ts`: the per-group budget and deletion while loading.
- `RenditionStack.browser.test.ts` ("leaving a style"):
  - the neighbours go at once and the shown page keeps its face on every frame of the swap;
  - no `qcf-v4-*` face, family or palette rule is left afterwards;
  - V4 loads again on return;
  - a late answer for a left style is never loaded.

**Loops after the fix** (14 rounds each, no crash, no V4 face left after leaving V4):
- headed Edge: leaving V4, staying on V4, and staying on plain V4 (the colour map with no tajweed);
- the real app: leaving V4 (`appreg/M2`) and staying on V4 (`M2S`), with the language, view and theme switches. The
  same build without the palette change crashed in round 5.
- `scen/M6.mjs` shows V4 in paper, sepia, night, black and HC light/dark, with and without tajweed, in the mock and in
  the real app. The hues, the exact ink and the HC darkening are right.

### Double ۞ on quarter starts (LEAD 17)

- `pageMarkers` marks a rub start `inline` when its ayah's first word (`firstWordId`, position 1) begins with ۞. About
  198 of the 240 quarter starts are inline. The ones without an inline ۞ are the surah starts.
- An inline marker is the **label alone**, centred on its line, with the existing tooltip and click target. It never
  draws a ۞ or an ornament beside the inline one.
- Below qfs 28 an inline marker is **not drawn**. This is the finding's alternative, and the rest is unchanged: the
  inline ۞ marks the place and the running head names the quarter, as for every marker at that size.
  - The first option (the label at 11 px at every size) does not fit the margin. "¾ الحزب ٢٧" is 4.0 em, 44 px at
    11 px, and `M_OUT` is 34–50 px between qfs 18 and 26.
  - §8.9's legibility rule hides labels there anyway.
  - A sajda on the same line then centres alone (`placeMarkers` leaves undrawn markers out). `MarginMarks` stacks
    after the same layout.
- **Tests.**
  - `ornaments.test.ts`: page 42 (2:253, "۞ تِلۡكَ") is a label-only marker at qfs 30 and none at 20; a surah-start
    rub keeps its glyph; a ۞ word that is not the ayah's first word is not inline; a sajda sharing the line centres
    alone.
  - `furniture.browser.test.ts`, on the real page 42: label only and centred on line 1 at qfs 30; nothing in the
    margin at 24, where the running head names "الحزب ٥".

### Faint, empty decor ornaments

- **Ornaments only with their labels** (qfs ≥ 28): below that the margin draws the solid ۞ even with decor loaded
  (`markerInk(m, decor, labels)`). At that size the hairlines are sub-pixel and the frame's text could not be read.
- **Thickened.** `-webkit-text-stroke: max(0.5px, 0.018em) currentColor; paint-order: stroke fill`
  (`decorStroke`, `--mk-stroke`), halved at ≥ 2 dppx. A 2× hairline already covers whole device pixels, and the
  full stroke filled the crests' filigree into blobs (checked at 3×).
- **The frame holds the division**, in `--marker-ink`, as in print (`markerInset`, `insetBox`):
  - U+FC23 holds the hizb number. A juz start opens a hizb too.
  - U+FC22 holds ¼ ½ ¾.
  - The size is 0.34·qfs, or smaller so the text takes at most 80 % of the frame's inner width less the thickening.
    Digit and fraction advances were measured in qd-hafs.
  - The text's ink is centred on the frame. The frame centres were measured off the centre line, because both frames
    have a notch there that biased the first measurement upward.
  - U+FC23's frame is only 0.207 em wide, so that ornament is now drawn a line tall (1.75·qfs). U+FC22 stays at 1.45.
  - The full label stays below the ornament and in the tooltip.
- **Measured** with `darkest.mjs` on 1× shots (`scen/M1.mjs`, pages 262 and 187 at qfs 29, crest regions):
  - paper 5.86:1, sepia 6.09:1, night 4.55:1, black 4.52:1, high contrast 21:1. Before: 2.40–2.85:1.
  - The small-size ۞ is 4.52–6.02:1.
- **Harness** (`layout.contrast.test.ts`): it checks the markers' CSS. Markers, ornaments, frame text and labels are
  drawn in `--marker-ink` (no other colour inside a marker), and the ornament's stroke is in the same ink. It also
  checks `--marker-ink` ≥ 4.5:1 on the page in every theme and contrast preference.
- **Tests.**
  - `ornaments.test.ts`: the thickening; and the frame text for qfs 28–60, which never exceeds 0.34·qfs, fits the
    frame (widest hizb number "٤٨") and is centred.
  - `furniture.browser.test.ts`, page 262:
    - at qfs 30 the stroked U+FC23 with "٢٧" centred in it, and "الجزء ١٤" below;
    - at qfs 24 the solid ۞, with no frame text.

### The memorisation toolbar covered the page footer

- `MushafView`'s overlay slot now renders the transient chips (follow, division, hint) first and the persistent bars
  (`MemoToolbar`, `SelfTestBar`) at its foot, in a measured wrapper (hidden while empty, so it adds no gap).
  - A chip appearing no longer pushes the toolbar up over the page or out from under the pointer.
  - §7.5 lists the bars between the follow chip and WP8f's chips. This is the one deviation from that order.
- While a bar is up, the book ends 12 px above it. `slotClearance(dock, barH)` is the slot's bottom, plus the bar,
  plus 12 px. The reader gets it through `setViewport(w, h, clearBottom)`. `fitLayout`'s new `clearBottom` caps
  `qfs`, and the stage reserves the room, so the book centres above the bar.
- **Deviation from the suggested fix** (passing a reduced height): the fit would then decide the dock on the smaller
  canvas. At 1600 × 1000 in auto, hide mode would flip the bar-dock spread to a side-dock spread, moving the player.
  With `clearBottom` the spread and dock decisions keep the full canvas and only `qfs` shrinks. The book re-fits once
  when the mode starts and once when it ends.
- **Tests.** `geometry.test.ts` covers the cap, the unchanged dock and spread, and the clearances per dock.
  `MushafView.browser.test.ts` checks a side-dock single page and a bar-dock spread with the toolbar up:
  - the toolbar starts ≥ 12 px below every visible page;
  - `.mv-slot` does not intersect any `.mp-foot`;
  - the dock and spread stay, and `qfs` comes back when the mode ends.
  - S27 (web) shows page 50's number above the toolbar.

### Translucent WBW tooltip

`.word-tooltip` uses `--glass-fill` with `backdrop-filter: var(--backdrop-palette)`, like the palette. On Linux and
under reduced transparency that is the opaque `--surface-raised` with no blur. `WordTooltip.browser.test.ts` checks
the blur with a translucent fill, and an opaque fill with no blur on Linux. S15's close-up no longer shows "بسم" through
the tooltip.

### Cross-area

- **e2e (S27, `tests/e2e/scenarios`).** Add the finding's assertion that `.mv-slot` and every visible `.mp-foot` do
  not intersect. `MushafView.browser.test.ts` asserts it today.
- **Docs.** Fold-ins for the docs pass:
  - §7.5: the slot order (persistent bars at the foot) and the clearance;
  - §8.9: inline label-only markers, ornaments only with labels, the thickening, the frame text, U+FC23 at 1.75·qfs;
  - §8.5: a left style's faces are unloaded once nothing draws them.
  - §8.6 / D14 (deviation for the lead to accept), forced by the Chromium crash:
    - no `override-colors`;
    - the theme ink as an SVG colour map on the V4 lines;
    - high contrast through a computed lift instead of the HC override tables;
    - the plain palette for night + `prefers-contrast: more` + tajweed.
- **e2e (S09, S10, WP8b's `tests/e2e/scenarios`).** Both assert the old rule text: S09 that `0 rgb(<ink>)` is in it,
  S10 that every ink entry 0–9 and 13–15 is. They fail now: `shots:web` reports 36 passed and these 2 failed. Replace
  those lines with:
  `check(!palette.rule.includes('override-colors') && palette.rule.includes('filter: url(#qd-v4-ink)'), …)`
  Scratch copies with exactly that change pass in the mock (`scen/S09x.mjs`, `scen/S10x.mjs`).
  - S09: tajweed pixels 1.89 %, drawn ink (28 26 22).
  - S10: drawn ink (161 158 151) at 65 % and (233 228 216) at 100 %, which equals the resolved ink.
  - The drawn-ink checks are kept, and with the colour map they hold exactly. `tests/e2e/metrics` only checks that the
    rule exists, so it is unaffected.
- **Upstream.** A Chromium bug report for the multi-entry `override-colors` crash, with `scen/M5.mjs` as the repro.
  Once a fixed WebView2 ships, the HC override tables can come back.

### Verification (`CARGO_TARGET_DIR=C:\qdt\int-fix1-mushaf`; no Rust or contract change)

| Gate | Result |
|---|---|
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,353 files) · clean · 201 files, 0 violations · clean |
| `pnpm test` | 73 files, 2,360 passed |
| `pnpm test:browser` (Edge) | 39 files, 525 passed |
| `pnpm shots:web --strict` (port 1933) | 36 passed; S09 and S10 fail on the old palette-rule text (Cross-area above; their adjusted copies pass) |
| V4 crash loops (`scen/M2`, `M5`; 14 rounds of language × view switches and theme flips) | headed Edge: 3 runs, 0 crashes (leave, stay, plain stay). Real app: `M2` (leave) and `M2S` (stay) passed, no crash. Before: crash in rounds 5–12 |
| `pnpm tauri build --debug --no-bundle`, then app-driver (renamed exe `quran-desktop-mf1.exe`, CDP 9431–9435) | S27, S13, S08, S06, smoke, `M1app` (markers, 4 themes × 2 sizes) and `M6` (V4, 6 themes × tajweed) passed |
| Marker contrast (`darkest.mjs`, real app, qfs 29) | U+FC23 / U+FC22: paper 5.93 / 5.86, sepia 6.09 / 6.09, night 4.55 / 4.55, black 4.52 / 4.52 :1 (before 2.40–2.85) |

PNGs read: S27 (web and app), S08, S12, S13, S15 and S33, the marker crops (1× and 3×, every theme) and the V4 theme
shots (mock and app). No other change showed in those scenarios.

## Rust-core fixes, round 1 (`crates/quran-core`, `crates/quran-types`, `xtask`; `CARGO_TARGET_DIR=C:\qdt\int-fix1-rust-core`)

### A library from a newer version is refused, not quarantined (minor)

- **New error.** `CoreError::NewerSchema { found, supported }` is additive and maps to `AppError::Database`. Its text
  is "it was written by a newer version of Quran for Desktop (schema N; this version reads up to M); update the app to
  open it". No DTO changed, so `bindings.ts` is unaffected.
- **Refused before any write.** The crate-private `quran-core/src/migrate.rs` adds `refuse_newer`. It reads
  `PRAGMA user_version` as the first statement of `UserDb::open_checked` and `ContentDb::open_checked`, so it runs
  before `journal_mode`, `quick_check`, the migrations or `optimize` can write. `to_latest` maps rusqlite_migration's
  `DatabaseTooFarAhead` to `NewerSchema` as a backstop; the restore path uses it too.
- **Never quarantined.** Both `needs_quarantine` functions answer false for `NewerSchema` and for the raw
  `DatabaseTooFarAhead`. Real corruption, foreign schemas and failed migrations still quarantine.
- **Result.** After a downgrade, user.db and content.db stay byte-for-byte as they were, pinned timings and chapters
  included. Startup takes the existing fatal path (`Fatal::Database`, the native dialog, exit 1) with the text above,
  and updating the app opens the library again.
- **Tests.**
  - `user_db::tests::a_library_from_a_newer_version_is_refused_and_left_untouched` also reopens the file intact.
  - `transient_errors_never_quarantine` now asserts the opposite of the finding's cited line.
  - `migrate::tests` and `error::tests`.
  - `userdb_open::a_database_from_a_newer_build_is_refused_and_left_in_place` and
    `content_db::a_newer_schema_is_refused_and_left_in_place` replace the two tests that asserted the quarantine.
    `a_foreign_schema_is_quarantined` keeps the foreign case.
  - The directory checks in these tests look only for `.corrupt-` copies. Windows can briefly list a transient
    `CONTENT.DB-SHM.tmp` while SQLite removes a closed connection's `-shm`, and an exact listing failed 2 runs in 8.

### Backing up into the live library is refused (minor)

- **The check.** `UserDb::backup_to` returns `InvalidArgument` when the destination names the open database or its
  `-wal`, `-shm` or `-journal` file. The open database comes from `Connection::path` (`sqlite3_db_filename`). The
  check runs before `VACUUM INTO`, so nothing is written.
- **How paths compare.**
  - Two existing paths compare by identity: device and inode on Unix, the final path on Windows. Symlinks, junctions,
    `..`, 8.3 names and letter case are all resolved.
  - A path that does not exist, such as the `-journal` in WAL mode, compares by canonical directory and name. On
    Windows and macOS the name comparison ignores ASCII case.
- **Test.** `backup::tests::the_live_database_and_its_companions_are_never_a_destination` covers every companion,
  `backups/../user.db`, the case variants, that nothing changed, and that later writes persist.

### Third-party notices are complete (major)

- **The gate.** `cargo xtask licenses` fails, listing every problem at once and writing nothing, unless each shipped
  package's texts contain the text of every licence in `used`.
  - Texts are recognised by their wording, not their file name (`policy::text_families`). Comment leaders, quotes and
    line wrapping are ignored.
  - An SPDX document, a README pointer, an Apache or MPL file header, or a bare copyright line does not count.
  - Every allowed licence now has a family. `0BSD` has its own, because it has no conditions; it used to count as
    `bsd`.
- **Reviewed stand-ins.**
  - Location: `xtask/licenses/<cargo|npm>/<name>/` (npm scopes nest), holding the texts and a `source.toml`. The
    `source.toml` lists the exact reviewed `versions` and, for each file, its `kind` (`licence` or `notice`), its
    `source` and an optional `heading`. `xtask/licenses/README.md` describes the process.
  - Stand-ins are used only while the package's own files lack the text.
  - These entries fail the command: a package that is no longer shipped, a listed version that is not shipped, a
    shipped version that is not listed (forcing a re-review after a bump), a package that now ships its own text, and
    an undeclared, missing or empty file.
- **The 43 entries.** They cover the 39 bare packages and the 4 `@tauri-apps/plugin-*` npm packages, whose only file
  is `LICENSE.spdx`.
  - **Upstream files.** These come from the upstream licence file at the crate's commit (`.cargo_vcs_info.json`) or
    at the release tag: alloc-stdlib (BSD-3-Clause), dasp_sample, defmt-parser, dlopen2 and dlopen2_derive, Inflector
    (BSD-2-Clause), libappindicator-sys, rusqlite_migration (Apache-2.0), the five specta crates, the two tauri-specta
    crates, the three webview2-com crates, and the four plugins (`LICENSE_MIT`).
  - **No upstream text.** These use the SPDX text from license-list-data v3.29.0, as the finding allows.
    - The 17 objc2 crates: the repository's `LICENSE.md` only names MIT. It is kept, followed by the MIT text with the
      Cargo authors as holders, or "the objc2 project contributors" when a crate declares none.
    - realfft: "HEnquist".
    - is-reference and locate-character: "Rich Harris".
    - selectors: MPL-2.0. servo/stylo has no licence file.
- **The WebView2 SDK notice.** webview2-com-sys carries the `LICENSE.txt` of Microsoft.Web.WebView2 1.0.3800.47, with
  a heading. That is the version webview2-rs pins at the crate's commit. The crate's `x64/WebView2LoaderStatic.lib`
  is byte-identical to the SDK's (sha256 `89c6b872…f25d8`). The package's `NOTICE.txt` covers only the wv2winrt
  generator, which is not shipped.
- **Content-aware choice.** The licence a package is credited under is now chosen by what its files contain:
  - brotli-decompressor's generic `LICENSE` is the BSD text, so it is credited as `BSD-3-Clause` (it was `MIT`);
  - dunce's is CC0, so it is `CC0-1.0` (it was `Apache-2.0`);
  - dompurify's generic `LICENSE` is Apache-2.0, which the policy prefers when both texts ship. It is now `Apache-2.0`
    with that text; it was `MPL-2.0`, while About showed the Apache text anyway.
- **Order.** SPDX documents are kept for their copyright line but now come after the licence texts. This reorders the
  7 tauri-plugin crates, and the npm plugins open with the MIT text.
- **Output.** `thirdparty.json` has 572 packages, none without text (there were 39 bare and 4 SPDX-only). It has 294
  segments and is 328,290 B. This supersedes WP3c deviation 4 ("nothing is invented", `texts: []`).
- **Tests.** `xtask/tests/assets_licenses.rs` has 17 tests. They cover:
  - content recognition;
  - the gate;
  - the order of stand-ins and notices;
  - vendored validation and staleness;
  - the committed file: every package's texts contain each `used` licence, the WebView2 notice is present, the plugins
    lead with the MIT text, brotli-decompressor and dunce are credited correctly, and the vendored tree matches the
    shipped versions.

### Cross-area

- **Frontend test.** `src/components/about/about.browser.test.ts:181` (frontend area) expects dompurify's
  `.pkg-licence` to be `'MPL-2.0'`. The test must expect `'Apache-2.0'` (see "Content-aware choice" above). It is the
  only failure in that file (8 of 9 pass), and S25 passes.
- **Frontend fallback.** About's "ships no licence file" text (`about.openSource.noText`, the `.pkg-none` branch of
  `OpenSourceList.svelte`) can no longer occur with generated data. Keep it as a defensive fallback or remove it. Also:
  - the `thirdparty.ts` comment "empty when the package ships no licence file" is out of date;
  - `thirdparty.test.ts` or S25 could assert that every package of the committed file has texts.
- **Newer-library dialog (src-tauri, `setup.rs` and `i18n.rs`).** A newer library already ends in the fatal dialog with
  the English detail above, followed by the generic "Reinstalling the app usually fixes this." A dedicated localised
  body would read better, in English and Arabic: for example, "This library was saved by a newer version of Quran.
  Install the latest version to open it; nothing was changed." It would be a new `RustText` key, chosen when the source
  is `CoreError::NewerSchema`.
- **Other live databases (src-tauri, `commands/user_study.rs` `resolve_backup_dest`).** `backup_to` only knows user.db.
  `<data>/content.db`, its companions and the pack databases carry the same Unix hazard. The command should refuse
  destinations inside the data directory other than `backups/`.
- **Docs.**
  - ARCHITECTURE §2.2.6 ("a failed migration … Never fatal") and §2.8.2 step 3 should say that a newer schema is
    refused: fatal, and the file is left untouched.
  - §4.1 and DEVELOPING should mention the licence-text gate and `xtask/licenses/`.
  - WP3c deviation 4 is superseded.

### Verification

| Gate | Result |
|---|---|
| `cargo fmt -p quran-core -p quran-types -p xtask -- --check` · `cargo clippy -p quran-core -p quran-types -p xtask --all-targets -- -D warnings` | clean · clean |
| `cargo test -p quran-core -p quran-types -p xtask` | 37 binaries, 0 failed; 5 repeated runs clean |
| `cargo test -p quran-packs --lib` | 70 passed |
| `cargo xtask licenses` | 572 packages, 0 without their licence text; second run "unchanged" |
| Gate check (one vendored entry moved aside) | fails, names the package and the directory to create; `thirdparty.json` untouched |
| Independent check (node, over the committed file) | 0 packages lacking the text of a `used` licence (45 before) |
| `vitest` `thirdparty.test.ts` · `about.browser.test.ts` | 5 passed · 8 of 9 (dompurify expectation, see Cross-area) |
| `pnpm shots:web --serve 1938 --only S25`, plus a scratch scenario | passed; both were read. About ▸ Open-source licences lists 572 packages with no "ships no licence file". webview2-com-sys ends with the Microsoft notice, and plugin-dialog opens with the MIT text. |

Not run: `src-tauri` tests and the real app. `quran-desktop` currently fails to compile on another area's in-flight
change (`unresolved import quran_audio::TIMINGS_FILE_MISMATCH`). This area's changes reach src-tauri only through the
additive error variant, which src-tauri only uses with `matches!`, and through the unchanged `backup_to` signature.

## Tooling fix, round 1 (`scripts`, `tests/e2e`, `.github`, root configs, `docs`; `CARGO_TARGET_DIR=C:\qdt\int-fix1-tooling`)

The finding: WP13b's release pipeline, budgets, metric assertions and checklist did not exist, and the NSIS installer
was over budget. They exist now. Decisions, deviations to fold in and the measurements are in
`docs/deviations/WP13b.md`.

### The NSIS installer is under 8 MiB again

The installer was 8,395,872 B. Fontsource's IBM Plex Sans Arabic CSS lists a WOFF 1 fallback after each WOFF2 source,
and no webview the app runs in reads it. Vite still emitted the nine files (203 KiB, already compressed) and Tauri
embedded them. `vite/woff2-only.ts` (a build-only plugin in `vite.config.ts`, unit-tested in `vite/woff2-only.test.ts`,
which the `unit` project now includes) drops those `src` entries and the orphaned files. `check:dist` fails on any
WOFF 1 file or `format("woff")` source. The release NSIS build is now **8,063,841 B (7.69 MiB)**. The real app's Arabic
UI renders in IBM Plex Sans Arabic (S24 "ar", S26). The budget stays 8 MiB; §13.6's "MB" means MiB (WP13b.md item 1).

### Release pipeline (§13.4)

- **`.github/workflows/release.yml`.** A `v*` tag creates a draft release (`scripts/check-version.mjs` first checks
  that the tag matches `package.json`, `tauri.conf.json` and Cargo). It then builds on windows-latest (NSIS),
  macos-latest (`--target universal-apple-darwin`, one dmg) and ubuntu-22.04 (deb + AppImage). Each job:
  - builds core.db from the private QUL store: `./.github/actions/core` with `source: qul` (secrets `QUL_SOURCES_URL`
    and `QUL_SOURCES_TOKEN` in the environment `release`; the committed manifest's SHA-256s decide);
  - asserts it is > 1 MiB, has `meta.source = 'qul'` and passes verify-core;
  - builds with `tauri-apps/tauri-action@1deb371b…` (v1.0.0, build only), under `QD_REQUIRE_CORE=1`;
  - unpacks and checks every installer, enforces §13.6 and uploads through `./.github/actions/release-upload`. That
    action runs `check-artifacts --release` first and refuses a release that is no longer a draft.

  `workflow_dispatch` on a branch is a dry run. A person publishes after `docs/RELEASE_CHECKLIST.md`.
- **Signing.** macOS is signed ad hoc with the hardened runtime (`APPLE_SIGNING_IDENTITY=-`), or with a Developer ID
  and notarised when the `APPLE_*` secrets exist. Windows stays unsigned until the lead picks a certificate (Azure
  Trusted Signing or SignPath Foundation recommended). The release notes (`.github/release-notes.md`) explain both
  first-launch prompts.
- **`scripts/check-artifacts.mjs`.** It reads `ar` archives, so a deb is inspected down to its core.db. It gains the
  release rules (`--release`): installers and executables are allowed, and a database only as a qul core.db. An
  installer it cannot open (NSIS, dmg, AppImage) is refused unless `--verified` names a `check-bundles` manifest that
  verified it by size and SHA-256.
- **The policy check** gains `release-uploads`:
  - `gh release upload` runs only in the guarded action, after `--release`;
  - tauri-action may not take `releaseId`, `tagName`, `uploadWorkflowArtifacts` or `uploadPlainBinary`;
  - no other release-upload action;
  - `gh release create` only with `--draft`, and no `gh release edit`.

### Installers checked and budgets enforced in CI

- **`scripts/check-bundles.mjs --core placeholder|qul`** unpacks every installer: 7-Zip for NSIS (with tauri's
  `installer.nsi` and the files it packs), `hdiutil` for the dmg, Node for the deb, `--appimage-extract` for the
  AppImage. It checks:
  - the identity, the resources and the core.db (the 0-byte placeholder, or qul);
  - the deb's Depends (an appindicator, webkit2gtk-4.1, gtk3, ALSA) and `Quran.desktop`: Name, Exec, Icon and
    StartupWMClass, which is the MPRIS DesktopEntry WP6d pinned;
  - one hicolor icon per configured PNG, and the AppImage's bundled appindicator;
  - Info.plist (identifier, minimum macOS 13.3), a universal binary, and `codesign --verify --deep --strict` with the
    `runtime` flag;
  - check-artifacts' release rules on everything unpacked.
- **`scripts/size-budget.mjs`** measures every §13.6 row it can find: the four installers, the install footprint
  (Windows exe + resources, the macOS .app, the deb's Installed-Size), `dist/` and the runtime report. With
  `--placeholder-core` it adds the real core.db as each format compresses it. `BUDGETS` is the single table, which the
  metrics scenario imports too.
- **CI `build` job**, on all three OSes: `./.github/actions/size-check` (reworked) moves the in-job qdc core.db aside
  and builds this OS's release installers around the placeholder. It runs both scripts with `enforce: 'true'`, then
  puts the core.db back. macOS builds universal on pushes to the default branch and the runner's architecture
  otherwise. `size-check.mjs` keeps only `aside`/`restore`, since the LZMA measurement moved to `size-budget.mjs`.
  CI's tooling tests now run `scripts/*.test.mjs`, and `.github/actions/tsconfig.json` type-checks the new scripts.
- **WP6b's request** (does the deb depend on libayatana-appindicator?): tauri-cli 2.12.1 adds it, and the AppImage
  library, whenever the `tray-icon` feature is on, as it is. `check-bundles` now asserts both on every CI run; no
  `tauri.linux.conf.json` change is needed.

### Metric assertions (§12.6, §8.18) and runtime rows (§13.6)

- **`tests/e2e/metrics/metrics.mjs`** is run with `pnpm shots:app --only metrics`. One real-app process, in phases:
  - cold start;
  - a 20-page qcf_v2 navigation (4 turns, 5 cold jumps, back to page 1) with a playback start: CLS, long tasks,
    `qd:page` p95;
  - FontFaces per style;
  - prefetched page-turn latency, measured from the keydown to the frame that paints the new page;
  - flip pace and frame times under key repeat;
  - the word glide, memory and app CPU at 1.0× and 1.5× on the null sink;
  - qcf_v4 `#qd-v4-palettes`, and `cspViolations === 0` summed over every metrics window.

  It fails on every §8.18 or §12.6 miss and names the cause: the layout-shift sources with their rectangles, and the
  long tasks per action. It writes `metrics-report.json`, which `size-budget.mjs` enforces. Helpers:
  `_probes.mjs` (in-page probes) and `_process.mjs` (CIM samples of the app's process tree).
- **`scripts/qa/idle-cpu.mjs`** measures idle CPU on the debug build without `QD_TEST` and without remote debugging.
  An A/B run of the same build idled at 0.0–0.2 % without the hook and 0.4–14 % with it. The tool adds its row to
  the report.
- **Harness.** In app mode, `ctx.process` gives `{ pid, launchedAt }` (`scripts/qa/lib/{app,web,runner}.mjs`,
  `tests/e2e/lib/types.d.ts`). `tests/e2e/lib/tsconfig.json` also checks `tests/e2e/metrics`.
- **Results** (WP13b.md has the table):
  - Within budget: idle 0.23 %, playback CPU, the glide at 120 fps, `qd:page` p95 12 ms, 24 FontFaces, the
    palettes, no CSP violation, and 58 cold font loads in the session.
  - Missed: CLS 0.01, long tasks, page turn p95 87–119 ms, flip frames up to 117–200 ms, memory 388–488 MiB, and cold
    start 811–1,993 ms (debug build, remote debugging on).

  So `pnpm shots:app --only metrics` fails today, on the app's numbers, not on the tooling. The fixes belong to the
  areas below.
- **`docs/RELEASE_CHECKLIST.md`** covers:
  - the blockers: QUL permission, brand approval, attribution wording, signing;
  - data, version and secrets, and the quality gates (CI, metrics, shots);
  - tagging and the draft;
  - the manual smoke tests from §12.6, WP6a, WP6b, WP6d, WP8d and WP9b, for every OS, Windows, macOS and Linux;
  - R4's listening test, and publishing.

  DEVELOPING §3, §7 and the new §9 describe the tools. README points at the release process.

### Cross-area

- **Player dock (frontend, WP9a/WP7c): CLS on playback start.** `div.dock.m-bar` widens from 505 to 839 px over eight
  frames, moving left. Each frame is a layout shift (0.0002–0.0009 each, 0.005–0.01 in all), and nothing excuses it
  when playback starts without input (the follow-along, a hook, the media keys). Animate the expansion with
  `transform`/`clip-path`, or keep the dock's box fixed and animate its content.
- **Page turns and flips (frontend, WP8a/WP8e).**
  - Every prefetched turn takes 78–88 ms from the key to the painted page (§8.18: < 50 ms) and runs a 61–138 ms long
    task.
  - Flipping misses frames: up to 117–200 ms, about 25 frames over 32 ms in 2 s, at 71–96 ms per page.
  - The jump back to page 1 runs a 230 ms task.
  - Suspects: the view-transition snapshot of a full spread, and `readyForInstantRender` calling `fonts.ensure` and
    `pages.ensure` on every turn. The report's `diagnostics` (per-action long tasks, turn times, flip frames) shows
    where.
- **Memory (frontend).** A spread plus playback holds 388–488 MiB of private working set, against 350 MB. The app
  process is 25–42 MiB; the rest is WebView2's renderer and GPU processes, with 24 QCF FontFaces loaded. Worth
  profiling: the 1.56 MB main chunk, the font registry's eviction, and decoded glyph caches.
- **Cold start (frontend and src-tauri).** 811–1,993 ms from spawn to first contentful paint on the debug build.
  The native part (Rust setup and WebView2) is 310–495 ms; the web part (load to paint) is 424–620 ms. Splitting
  rarely used overlays out of the main chunk (an earlier note) is the frontend's lever. A release-build measurement
  needs a release QA mode (D24 compiles the data-dir override out).
- **QA hook (frontend, `src/lib/testing/qdtest.ts`).**
  - Run the frame sampler only while audio plays: start the rAF loop when `player.isPlaying` turns true, and stop it
    after. Today it requests every frame for the whole test session, which distorts idle and frame measurements.
  - Expose `pages.size` (§8.18: PageCache ≤ 48) and the FontFace count per style in `metrics()`, so the scenario can
    assert them. Today only their unit tests do.
- **Docs (lead fold-ins, WP13b.md).**
  - §13.6: MiB, and the definitions of the runtime rows.
  - §13.3: the `build` job now builds and checks installers on every OS.
  - §13.4: the tauri-action pin, the QUL archive and environment, `release-upload`, and the dry run.
  - §15.3 item 3: the signing decision.
  - §12.6: `tests/e2e/metrics` and `idle-cpu.mjs`.
  - WP6b's appindicator request is resolved without a config change.

### Verification

| Gate | Result |
|---|---|
| `node --test scripts/*.test.mjs .github/actions/*/*.test.mjs tests/e2e/lib/*.test.mjs scripts/qa/lib/*.test.mjs` | 109 passed, 0 failed (check-artifacts 26, size-budget 10, check-bundles 9, check-version 3, policy and the actions, the harness) |
| `pnpm exec tsc -p .github/actions/tsconfig.json` · `-p tests/e2e/lib/tsconfig.json` · `pnpm check:ci` | clean · clean · policy passed (8 checks, including `release-uploads`) |
| `act -l` on `release.yml` and `ci.yml` | both parse: 3 and 6 jobs. A YAML cross-check found every composite `with:` key declared and every required input given |
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,353 files) · clean · 201 files, 0 violations · clean |
| `pnpm test` | 2,347 passed, including `vite/woff2-only.test.ts` (6) |
| `pnpm build && pnpm check:dist` | "dropped 9 WOFF 1 fallback font file(s), 203 KiB"; 7/7 checks, 3.08 MiB |
| `pnpm check:tooling` | 75 ok, 0 pending (WP13b's `size-budget.mjs` resolves), 1 warning (`rg`, LEAD 6) |
| `pnpm tauri build --bundles nsis` (local measurement, `QD_ALLOW_DEV_CORE=1`, never shared) | `Quran_0.1.0_x64-setup.exe` 8,063,841 B. `size-budget`: NSIS 7.69 MiB, installed 25.50 MiB, both ok. `check-bundles --core qul` correctly refuses its qdc core.db |
| `pnpm tauri build --debug --no-bundle`, then `app-driver --only metrics` (×6) and `--only S03,S24,S26` | metrics: fails on the app's §8.18 misses above; CSP 0, palettes applied. S03, S24 and S26 passed. PNGs read (metrics, S24 "ar") |
| `node scripts/qa/idle-cpu.mjs` | 0.23 % of one core, written to the report |
| `web-shot --serve 1957 --only S01,S25 --strict` | 2 passed (the runner change in the mock) |

The app runs used a renamed copy of the debug exe (`quran-desktop-tooling.exe`), because the user's installed "Quran
Preview" was running. Other agents were building and testing at the same time, so frame and CPU numbers vary between
runs (WP13b.md gives ranges). Not verifiable here: the macOS and Linux bundles, release.yml on a runner, and 7-Zip
unpacking of the NSIS installer (WP13b.md).

## UI fixes, round 1 (`src/**` outside the Mushaf area; `CARGO_TARGET_DIR=C:\qdt\int-fix1-ui`)

All 22 review findings are fixed at the root in this area. Each one has a test that failed before the fix. Scratch
scenarios and shots are in `C:\qdt\int-fix1-ui` (`scen\V1.mjs`, `V2.mjs`, `A1.mjs`, `shots\`). The reviewer's
`explore5/9/10/13/14/17/28` scenarios now report the fixed behaviour.

### Primitives

- **Segmented never overflows its group** (findings 1 and 15, major).
  - `.s-sm` options use 8 px inline padding.
  - `fit()` measures the options against the group's content box and switches to the roomiest look that fits:
    normal; then `data-fit="tight"` (6 px, `text-xs`, labels still whole); then `data-fit="clip"` (equal shares,
    ellipsis, the full label as `title`, the accessible name untouched).
  - It runs on every resize, label, direction or size change, and on web-font `loadingdone`.
  - The sum is taken from the options themselves: `scrollWidth` would count the absolutely placed pill at its old
    offset. A full-width group is `min-inline-size: 0`, so it can shrink as a flex item.
  - At the 300 px sidebar the Memorize picker now fits in the normal look, in English and Arabic. The Search scope's
    Notes pill keeps its 2 px inset.
  - Tests (`primitives.browser.test.ts`): four options in a 240 px group, in en and ar, stay inside the border and
    inset with whole labels. The group compacts at 200 px, clips at 120 px and relaxes again at 600 px.
- **Tooltip is floating glass** (2): `--glass-fill` with `backdrop-filter: var(--backdrop-palette)`, as the palette
  and the WBW tooltip. This is §9.5's surface-overlay with §9.4's blur rule: opaque `--surface-raised` under reduced
  transparency, on Linux and in forced colours. In S34 the page's glyphs no longer show through "Bookmark B".
  - Tooltip content now uses `escapeKeydownBehavior="defer-otherwise-close"`. Inside a dialog, sheet or popover,
    Escape belongs to that layer. A tooltip that came up with the layer's first focused control (finding 16 below)
    therefore no longer takes the first press. On the page, Escape still closes the tooltip. Both cases are tested.
- **Initial focus lands** (16, major).
  - `firstTabbable` skips `:disabled` elements in every selector arm.
  - `focusInitial` checks that focus moved. Otherwise it tries the next candidate, then the container itself
    (`tabindex=-1`).
  - A disabled `IconButton` drops the tooltip trigger's `tabindex`.
  - Test: a Sheet whose first control is a disabled icon button starts on the first enabled one, and a Sheet with
    nothing focusable holds focus itself. The S32 shell test now also checks that focus is inside the study-pane sheet,
    and that one Escape closes it.
- **Toasts stay above the bottom-centre overlays** (14, major).
  - `ui.setOverlayReach(source, px)` and `ui.overlayReach` record how far each overlay reaches above the canvas
    bottom. `components/shell/overlayReach.ts` measures an element with a ResizeObserver on it and on the canvas
    (`trackOverlayReach`, or the `overlayReach(source)` attachment).
  - `App.svelte` tracks the Mushaf view's `.mv-slot` through the canvas's children. TranslationView's "Return to
    recitation" publishes its own reach.
  - The Toaster's offset is `max(dock offset, reach + 8)`, and the list glides there (`transition: bottom`).
  - Shell test: an Undo toast shows above the FollowChip, the chip takes its own clicks, and the reach goes back to 0
    once the chip is dismissed. The old code failed it (toast bottom 904 > chip top 876). explore5 now reports the
    toast at 720–768 above the chip at 776–812.

### Translation mode (`TranslationView.svelte`)

- **Jumps without a flash land on their verse** (12, major). The view caught up in the order flash, page, cursor, so a
  `goToAyah` that moved page and cursor together showed the page's first verse.
  - Now a cursor that moved to an off-screen verse comes to the top when the page moved with it or the move was more
    than one verse. This covers search hits with words, word cards, the study pane's chevrons, memorisation and
    back/forward. A one-verse step (↑/↓, j/k) still scrolls the least.
  - In translation mode the reader store keeps focus where it is for a `focus` jump (it only announces). The search
    opener (`search/open.ts`) therefore moves focus to the hit's verse itself. `ui.focusWhenRendered` gained a frame
    budget and checks that focus landed.
  - Tests: `goToAyah(2:163, { select, highlightWords })` puts `#tv-a170` at the top and focuses it. A hit opened from
    a field outside the view takes focus to its verse. explore9 shows 2:255 at 52 px; explore10 shows 2:163 at the top
    with focus.
- **A navigation while the feed opens is kept** (3): `seen` is no longer advanced before `ready`. The open sequence
  remembers the reader state it opened at and replays the difference once ready, with the same rules as the follow
  effect. Test: `goToSurah(2)` right after mounting at 2:255 shows the Al-Baqarah card at the top.
- **The side card no longer covers the column** (10).
  - With `reader.dock === 'side'` (not in zen), the column and its paper share `--_cw` and `--_cstart`. They stay
    centred, but move toward the inline start just enough to clear the card's footprint (24 + 272 + 16 px). They
    narrow for it, down to 520 px, only on a small canvas.
  - The follow chip centres in the remaining room.
  - Test, at 1426 × 1006 in en and ar: the paper and every row end before the card, at the full 760 px.
- **One polite failure summary** (18): VerseRow and the study pane's TranslationTab render a failed verse or pack as
  plain text with its Retry link, with no `role="alert"`. The view (for the rows on screen) and the tab (for its
  ayahs) each have one visually hidden `role="status"` line. Browser tests in both check that there is no alert and
  exactly one status.

### Player and onboarding

- **The onboarding preview is no part of the listening** (6, major).
  - `player.preview(reciterId, ayah)` and `player.stopPreview()` play the preview. It writes no `audio` position and
    never touches `resumeDismissed`.
  - Its ayah edges and its end or stop edge are ignored. An idle answer before the play starts is not taken as its
    end.
  - It is not `#lastRequest`, so Space never replays it. A failure stays out of the dock: the flow toasts it.
  - Another play started over it (dock, tray, media key) counts again.
  - Unit tests: the preview ends with no position and no candidate, and Space plays the visible page (ayah 100). A
    stopped preview keeps the previous play's resume point. A play over the preview is recorded.
  - Browser test: after the onboarding preview, `resumeCandidate` is null and Space plays the requested ayah.
  - The listen-history half needs Rust (Cross-area).
- **The starter set's reading packs are put to use** (7, major). `#settingsPatch` walks the starter set. A pack that
  is installed, or fetched as you read (`on_demand`), is applied: the chosen translation, a tafsir if none is chosen,
  and the UI language's word-by-word pack if none is chosen. Onboarding tests assert `wbwPackId = 'wbw.en'` after
  "Download now" and "Start reading". A pack the user already chose is kept, and the Arabic set has none.
- **A stale offline error clears** (9). An effect on `app.online && settings.networkAllowed` dismisses an `offline`
  failure once network use is possible again. Other failures stay. Unit-tested.
- **Repeat popover** (13, major): the open effect depends on `open` only (`untrack`). Browser test: a typed
  `2:255-257` survives two `audio-state-changed` edges (the next ayah, then a speed change), and
  `loop_preset_list` is not called again. explore17 keeps the text for 6 s of playback.
- **Bounded timings** (20): `player.timings` is an `LRU` of 12 surahs. The loaded play's needed keys are re-inserted
  when evicted: the heard surah and the next one, plus the whole range when it spans fewer than 6 surahs. Unit test:
  20 more surahs leave at most 12, and the playing `7:2` stays.
- **Positions and search history follow a restore** (17).
  - `history.reloadPositions()` reads the positions again through `app_bootstrap`, the only command that answers
    them. Concurrent callers share one read.
  - The history store reloads them on `positions`. The player re-reads its `audio` candidate on the same event.
  - The search store reloads its recent searches on `history`, debounced by 300 ms because the audio glue also reports
    listening as `history`. `clearHistory()` resets `#recorded`.
  - The mock's backup image now includes the search slice, as Rust backs up the whole file.
  - Tests: mock restore, search store, and player restore.
- **Onboarding step 1 fits in Arabic** (11). Under `:lang(ar)` the sections are 16 px apart (not 20), and the language
  row's top padding is 12 px. The body was 442 > 433. Now it is 433 = 433, and the theme cards end above the footer
  divider. A browser test checks every step in en and ar for no body overflow.

### Text, library, About

- **Mod+B, type, Mod+B** (8): `toggleInline` with a caret finds the span of the same mark around it, pairing
  delimiter runs from the line start as the renderer does. A bullet's `* ` never opens a span. At the span's end the
  caret steps past the closing marker. Inside the span, the span's markers are removed. Thirteen new vectors, plus the
  typed sequence `abc **Key p**oint **more**`.
- **Highlights empty state digits** (4): `'{from}–{to} to highlight'` / `'من {from} إلى {to} للتظليل'` with
  `i18n.num`. Browser test: the Arabic text reads ١ and ٥, as the chips do.
- **"Mark as" in Arabic** (5): `تحديد الحالة`. At the 300 px panel the button is 116 px and reads whole
  (`V1-memorize-ar.png`).
- **Source code link** (21): `AttributionEntry.sourceUrl`. The app entry links `SOURCE_URL` as "Source code" /
  "الشيفرة المصدرية", which opens outside the webview. A unit test holds `SOURCE_URL` equal to the workspace
  `repository` in `Cargo.toml`, so the two cannot drift.
- **Core-data credit per build** (22).
  - The text group credits QUL only for `coreSource === 'qul'` and the Quran.com API only for `qdc`; a synthetic
    mock gets neither.
  - QUL's licence line no longer claims a basis: "QUL publishes no licence for this data". `QUL_PERMISSION`
    (`null`) is where the written permission's wording goes once it is recorded.
  - Unit tests cover both sources and the line. The About browser test reads the expected head from
    `app.info.core.source`.
- **Heavy unit tests** (19): `check-logical-css.test.ts` (a Node spawn per assertion) runs its describes with
  `{ timeout: 30_000 }`, and `initIpc()`'s mock-import test with 30 s. No assertion changed.

### Coordination with the Rust-core fixes

- `about.browser.test.ts` no longer hard-codes dompurify's licence. It renders the `used` licence from the generated
  file and checks that it is one of the declared alternatives (now `Apache-2.0`, after the content-aware choice).
- `thirdparty.ts`'s comment states the xtask gate. `thirdparty.test.ts` asserts that every committed package carries
  licence text. The `.pkg-none` fallback stays as a defence.

### Cross-area

- **Rust (`quran-types` `PlayRequest`, `src-tauri/src/audio_glue.rs`): finding 6's listen history.** The glue records
  every ayah heard for 3 s. The onboarding preview of 1:1 therefore still adds "Al-Fatihah · Listened" to History, and
  the OS media key's "Play with nothing loaded" would replay the preview.
  - Suggested: an additive `PlayRequest.record: bool` (default true; serde default). A play with `false` records no
    listen history and is not the last recitation the media key replays.
  - Then run `pnpm bindings`, have the mock's `audioPlay` accept the field, and have `player.preview` send
    `record: false`. The frontend half is done and tested.
- **Optional contract**: a `position_list` command would let a restore reload positions without the whole bootstrap
  (index included). Restores are rare, so `app_bootstrap` is used meanwhile.
- **Mushaf area / reader store.**
  - `MushafView` can publish its slot itself with `{@attach overlayReach('mushaf-slot')}` on `.mv-slot`. App's lookup
    of `[data-qd-view="mushaf"] > .mv-slot` would then go.
  - In translation mode, `reader.goToAyah(…, { focus: true })` could focus the verse itself (as `#arrive` does for
    cursor moves) instead of each caller. Today only search hits pass `focus` there, and the search opener handles
    them.
- **e2e (`tests/e2e/scenarios`).**
  - S01/S02: assert that the onboarding body does not scroll (`.qd-onboarding > .body` scrollHeight ≤ clientHeight)
    on every step in en and ar (finding 11). `onboarding.browser.test.ts` asserts it today.
  - S25: assert `[data-entry="app"] a.source` and its URL (finding 21). `about.browser.test.ts` asserts it today.
- **Docs and release.**
  - The final public repository URL (`SOURCE_URL` = Cargo `repository`) and the QUL permission wording
    (`QUL_PERMISSION`, `data/sources/README.md`) are release-checklist items that block the first public build.
  - Spec fold-ins:
    - §9.5: Segmented's compact and clip modes, and the tooltip as glass with Escape deferring to its layer;
    - §7.5: toasts stay above the overlay slot;
    - §9.7: translation mode clears the side card;
    - §2.5.4: the on-demand reading packs are applied at onboarding.

### Verification

| Gate | Result |
|---|---|
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,353 files) · clean · 201 files, 0 violations · clean |
| `pnpm test` | 73 files, 2,347 passed |
| `pnpm test:browser` (Edge, machine shared with other agents) | 39 files, 524 of 525. Last run: one failure, RenditionStack's "ready within 120 ms" (Mushaf area, under that area's edits, and passed in the previous run). The run before that failed only memo's frame budget, which passes alone, 3 of 3. Every new test was also seen to fail on the old code. |
| `pnpm shots:web --serve 1938` (registry) | 38 of 38 passed. The PNGs that touch these fixes were read: S01, S17, S21, S24, S25 and S34 (no glyphs through the tooltip). |
| Scratch web scenarios `V1`, `V2`, plus the reviewer's explore5/9/10/13/14/17/28 | Read. Memorize en/ar, Search Notes en/ar, Highlights ar, onboarding ar 433 = 433. Translation beside the side card in en and ar, and while playing. 2:163 at 12 px. |
| `pnpm tauri build --debug --no-bundle`, then `app-driver` A1 (renamed exe, `QD_AUDIO_SINK=null`) | Passed in the real app. After the onboarding preview of 1:1: the dock offers "Play An-Naml from 27:1" and only the `mushaf` position is stored. Finish leaves `wbwPackId = wbw.en`. Space on page 377 plays page 377. The translation-mode race shows the Al-Baqarah card at 12 px with the cursor on 2:1 and the breadcrumb on page 2. A search hit comes to the top with focus. An Undo toast shows above "Return to recitation" (toast 826–874, chip 882–918, hit test on the chip). |

## Rust-app fixes, round 1 (`src-tauri`, `crates/quran-audio`, `crates/quran-packs`; `CARGO_TARGET_DIR=C:\qdt\int-fix1-rust-app`)

All 15 findings are fixed at the root. No contract changed: `quran-types` is untouched and `bindings.ts` is unchanged.
Scratch scenarios and shots: `C:\qdt\int-fix1-qa`.

### Window and webview (`window.rs` + `window/{placement,guard,webview2}.rs`, `lib.rs`, `setup.rs`, configs)

- **The main window is built in code** (`window::create_main`, before `setup::init`). Every `tauri.*.conf.json` says
  `"create": false`, and `create_main` uses `WebviewWindowBuilder::from_config`.
- **The webview never navigates (finding 14)** (`window::guard`).
  - `on_navigation` allows only the app itself: `tauri://localhost`, `http(s)://tauri.localhost`, `about:blank`, and
    `devUrl` under `tauri dev`.
  - `on_new_window` always answers `Deny`.
  - An `https:`/`mailto:` target (a navigation or a new window) opens in the system handler instead. It goes through
    `system_open_external`'s own checks (`external_url`, now `pub(crate)`). Anything else is refused and logged.
  - On Windows the same hook turns external drops off (`SetAllowExternalDrop(false)`). WKWebView and WebKitGTK have
    no such switch, so a drop there is a navigation the guard refuses.
- **WebView2 crash recovery (finding 1, Windows)** (`window::webview2`). This hooks `ICoreWebView2::ProcessFailed`
  through `with_webview`, on the real Wry window only.
  - The page's renderer exited or hangs: warn, then `Reload()`. The frontend and the Rust state already survive a
    reload.
  - At most 3 reloads per minute (`ReloadBudget`). After that, a native dialog offers Reload / Quit / Cancel instead of
    looping.
  - The browser process exited: the controller is dead. Recreating the window would orphan what is bound to its HWND
    (SMTC's `GetForWindow`, the Snap Layouts target). So a dialog offers Restart (`AppHandle::request_restart`: the
    orderly exit runs and single-instance releases its mutex) or Quit.
  - GPU and helper processes are only logged, because WebView2 restarts them by itself.
  - The dialogs use 5 new `RustText` keys (en/ar).
  - macOS and Linux get no automatic recovery: wry exposes no such event there.
  - `webview2-com = "=0.39.1"` is now a direct Windows dependency of `src-tauri`. It is already in the tree at that
    version through wry and tauri-runtime-wry, so `Cargo.lock` gains no package.
- **Window size drift and fit (finding 3)** (`window::placement`).
  - Cause: tauri-plugin-window-state saves `inner_size()` and restores it with `set_size()`. tao sizes the
    undecorated, shadowed Windows window by adding its *current* window-minus-client offset to the size asked for. A
    window just created (hidden) has not had its frame calculated (`WM_NCCALCSIZE`) yet, so it still reports the
    client area of a captioned window, 43 physical px shorter at 150 %. The restore sized the window for that phantom
    caption, and it came back 43 px taller on every launch. (Traced in the real app: created 2160×1367 inside a
    2182×1423 frame, 2160×1410 once shown.)
  - The plugin still saves (SIZE | POSITION | MAXIMIZED | FULLSCREEN), but `skip_initial_state("main")`.
    `placement::restore` reads its file and applies the saved state itself:
    - `Geometry::settle_frame` first has Windows calculate the frame (`SetWindowPos(SWP_FRAMECHANGED | SWP_NOMOVE |
      SWP_NOSIZE | …)`), so every size read and set is the one the shown window has;
    - `set_inner_size_exact` checks what `set_size` produced: a request skewed by a stale frame is made again, and a
      platform that overshoots by a constant is asked for the size less it, once;
    - `fit` places the frame inside a monitor's work area: the monitor it overlaps most, no larger than its work area,
      moved inside it, and centred on the primary monitor when it is on none;
    - maximised and fullscreen are applied after.
  - A first launch fits the config size the same way: 940 logical px at 150 % is taller than a 1392 px work area.
  - Tests: `placement::tests` model tao exactly (insets, the stale caption, offset-based `set_size`). Save → restore →
    save is stable over 5 launches from 1410, 1367 and 1300 px. Without `settle_frame`, two tests fail; the first
    real-app run of the earlier measure-and-correct fix alternated 1410 → 1367 → 1410 → 1367.
- **Isolated debug runs (finding 7)** (`setup::dev_root` and its helpers). A debug run with `QD_DATA_DIR` keeps
  everything under that folder:
  - the log folder `<data>/logs` (`TargetKind::Folder`; `AppInfo.logDir` follows);
  - the window state `<data>/window-state.json` (the plugin's `with_filename` with an absolute path);
  - the WebView2/WebKitGTK profile, `localStorage` included, `<data>/webview` (`data_directory`).

  One leftover: on exit the window-state plugin still creates (but does not write into) the `%APPDATA%` config
  folder.
- **Log readability (findings 2, 6).** `NOISY_LOG_TARGETS` adds `html5ever`, `markup5ever` and `selectors`. ammonia
  itself never logs; `html5ever::{tokenizer,tree_builder}` wrote 9,000+ lines per install. A test pins the list.
- **Capabilities (finding 13).** `core:default`, `log:default` and `allow-set-always-on-top` are gone. The grant is
  exactly:
  - events: `listen`, `unlisten`;
  - window: `minimize`, `toggle-maximize`, `internal-toggle-maximize` (the drag region's double click),
    `is-maximized`, `close`, `start-dragging`, `set-fullscreen`, `is-fullscreen`;
  - dialog: `open`, `save`.

  `removeUnusedCommands` now strips the tray, menu, image, path, app, webview, resources and log commands from the
  build. The window.rs test pins the exact list and that none of those permission families is granted.
- **Installer metadata (finding 15).**
  - `bundle.homepage` is `https://quran.com`, giving the Apps list's support and help links and the deb `Homepage`.
  - `src-tauri` overrides Cargo `authors` with the publisher, "Quran for Desktop contributors" (the deb Maintainer).
  - NSIS `languages: ["English", "Arabic"]`, picked from the OS language. Tauri's NSIS template has Arabic strings.
  - The identity test covers homepage and authors; the per-OS test covers the NSIS block.
- **Release core guard (finding 12).** `build.beforeBundleCommand` runs `node src-tauri/scripts/check-release-core.mjs`.
  It reads `meta.source` with check-artifacts' own SQLite reader (`readSqliteFile`).
  - Accepted: `qul`, and a 0-byte placeholder with a loud warning (CI's size check; such a bundle cannot start).
  - Refused, with exit 1: `qdc`, any other source, unreadable files and a missing file.
  - `QD_ALLOW_DEV_CORE=1` lets a qdc core.db through for a private preview, with a banner (and a GitHub warning
    annotation on CI).
  - `--no-bundle` builds (QA) never run it. Tests: `node --test src-tauri/scripts/check-release-core.test.mjs` (4).
- **Requests from the rust-core round (their Cross-area).** Both are done. Their "Not run" note
  (`unresolved import quran_audio::TIMINGS_FILE_MISMATCH`) was this round's change in flight; `quran-desktop` builds
  and its 186 tests pass.
  - A library saved by a newer version (`CoreError::NewerSchema`) gets its own localised fatal text (`fatal_body`,
    `RustText::StartupNewerLibrary`).
  - `user_backup_create` refuses a destination inside the data folder other than `backups/` (canonical comparison:
    `..`, links and case resolved). `backup_to` only guarded user.db, and a backup over content.db or a pack database
    would corrupt it.

### Packs (`crates/quran-packs`)

- **An all-empty tafsir chapter is valid (finding 4).**
  - `group_rows` fails only when upstream sent no record of the chapter's own ayahs (none, or wrong keys). Records
    that are all empty make an empty chapter, stored with its stamp. Ibn Kathir (169) on 105 is the case.
  - The item counts as present, so "Download all" completes. A revalidation of it is `Unchanged`.
  - `tafsir_entry` answers `NotFound("… has no commentary on surah 105")` without a request once stored.
  - Tests: the adapter (`a_chapter_without_commentary_is_stored_empty_and_completes_the_download`, unit tests) and the
    manager.
  - The side pane's message for it is the frontend's (see Cross-area).
- **Interactive budget (findings 9, 10)** (`http.rs`). An interactive request (someone waits) has a deadline:
  - each attempt must start answering within 10 s (`interactive_response_timeout`);
  - no attempt or retry wait begins, and no response is awaited, past 15 s after the request began
    (`interactive_deadline`);
  - running out is the new `PackError::Timeout` (`network` over IPC; `Offline` for the planner, like a connect
    timeout).

  On a link that accepts and never answers, a request now fails in ≤ 15 s instead of ≈ 130 s. Fast failures keep the
  full backoff ladder (so three refused connects still go offline), a flowing body is never cut, and background work
  (jobs, the revalidator, font prefetch) is unchanged. Tests: the plan deadline (unit) and
  `an_interactive_request_has_a_deadline_and_background_work_does_not`, which uses a gated server, a throttled body
  and a background request.
- **Stale-while-revalidate for on-demand chapters (finding 10)** (`PackManager::ensure_chapter`).
  - A stored chapter older than its period is refetched in a task of its own. The reader waits at most
    `REVALIDATE_GRACE` (1.5 s), then gets the stored copy marked `stale`.
  - The refetch completes, stores the new copy and reports `PacksChanged`. A fresh chapter still makes no request, and
    a missing one is waited for.
  - Test: `a_stale_chapter_is_served_at_once_and_refreshed_in_the_background`, with a slow upstream added to the QF
    test server.

### Audio (`crates/quran-audio`, `audio_glue.rs`)

- **Cancellable plays (findings 8, 9).** The new `CancelToken` is one per play. The engine handle replaces the token
  on `play` and cancels the replaced one right after sending the command; `stop` and `shutdown` cancel the current
  one.
  - **Planning.** `TimingsSource::surah_timings_for` and `SourceProvider::open_for` are defaulted trait methods (the
    old methods are unchanged). Control loads timings and opens sources for the play's token.
    - The glue's fetch (`TimingsStore::get_blocking`) selects against the token.
    - `CachingHttpSource`'s connect selects against the token.
    - The rule-7 refresh selects against the token.

    A newer play or a stop no longer waits behind a stalled fetch. Measured: the next play started in < 1.5 s after
    the cancellation, and a stop took < 1.5 s.
  - **Stalled streams.** Each stream cursor belongs to its play. Once the play is cancelled, a read waiting for bytes
    returns `ReadCancelled` within one 100 ms poll. Its kind is `ConnectionAborted`: never `Interrupted`, which
    symphonia retries forever.
    - Decode maps it to `AudioError::Cancelled` and drops the queue quietly (no ERROR line, no `DecodeFailed`).
    - Control ignores any decode failure while a newer play or a stop is waiting.
    - The stream itself is abandoned when its last cursor goes, but a replay of the same surah reuses it.

    The cached surah started 28 s after the play command before; now it starts in < 1 s
    (`a_new_play_never_waits_for_a_stalled_stream_of_the_old_one`, with the real `CachingHttpSource` and a stalling
    server). With the cursor check removed, the test times out.
  - Not covered: a seek or a speed change *inside* a play whose own stream stalls still waits for the stall watchdog.
    It is the same play, and its data is what is missing.
- **Stale-while-revalidate timings (finding 9).** A play uses stored timings at once even when they are stale, and
  refreshes them in the background, so a downloaded surah never waits on the network before it plays.
  `audio_get_timings` waits up to `REVALIDATE_GRACE` for the refresh. Missing timings are fetched, cancellably. The
  rest of the policy is unchanged: fresh → no request, offline → stored copy.
- **Rule 7 retries (finding 11).** `AudioError::FileMismatch(String)` replaces matching the `TIMINGS_FILE_MISMATCH`
  string (the constant is gone). `AudioError::Cancelled` is the other new variant. They map to `network` and
  `cancelled`.
  - For the play's first file, control plans again once with the timings the glue just stored.
  - For a later file (`NeedSource`), decode stops at that file. The play then continues from its first ayah, re-planned
    with the same token, repeats and gap:
    - what decode already wrote plays out first (`PendingLoad::drain`: the `Load` waits for the ring to run dry, at
      most 1.5 s), so nothing is cut;
    - a basmala already written is not planned again;
    - the range shown stays the one asked for.
  - Tests: `a_changed_first_file_is_planned_again_and_plays` and `a_changed_later_file_continues_the_play_from_it`.
    The basmala is heard once.
- **`audio_play` returns `loading` (found while verifying).** `Hub::announce_play` writes an optimistic `loading`
  before control has the play, but every control publish rewrote the snapshot. A publish in between (its first one,
  an output message, a fence poll) put the previous state back, so `audio_play` could return `idle` for the play it
  had just started. `engine_wav` failed this way under load.
  - Each announced play is numbered (under the snapshot's write lock), and `CtlCmd::Play` carries the number. Control
    does not overwrite the snapshot while a newer announced play has not been served, and it publishes once it has.
  - Control's first publish (the idle engine) now happens in `control::spawn`, before the engine handle exists, so it
    always precedes any play's events.
  - Tests: `announce_play_is_optimistic` covers the overwrite rule. `engine_wav` passed 28 of 28 runs, 18 of them
    6 at a time; before the fix it failed under load.
- **Live repeat badge (finding 5).**
  - Each marker now carries its segment's `plays` and `passes` in-band. The callback publishes them with the segment
    index in one packed word (`Shared::repeat_progress`), so they can never belong to another segment.
  - `Hub::snapshot` derives `ayah_repeat_left`/`range_repeat_left` from that progress and the counts in force. A
    `set_repeat` is therefore published at once with the heard play's counter: "2 more", not "left 0" (shown as 3/3).
  - The ticker emits a state edge on every new play or pass of the same segment, so the badge counts 1/3 → 2/3 → 3/3
    live.
  - Tests: `repeat_iterations_are_state_edges_with_live_counters` (ayah ×3 gives state counters 2, 1, 0; `set_repeat`
    while paused publishes 2) and the ticker and shared unit tests.

### Cross-area

- **Frontend.**
  - TafsirTab: for an on-demand pack (`meta.onDemand`), `not_found` means "no commentary for this surah in this
    tafsir". Show that state without Retry. Today it falls to the generic failure with Retry.
  - `App.svelte`: a window-level `dragover`/`drop` `preventDefault` (the app accepts no drop). This is the second layer
    the finding asks for on WKWebView and WebKitGTK.
  - A stale on-demand chapter is now served at once with `stale: true` while it refreshes. The pane's existing "refresh
    stale entries once online" re-request picks up the new copy, so no change is needed.
- **Docs.**
  - DEVELOPING §4: `QD_DATA_DIR` now also covers the logs, `window-state.json` and the webview profile. Also document
    `QD_ALLOW_DEV_CORE` and the bundle guard.
  - ARCHITECTURE:
    - §13.4: the guard runs at bundling for every bundle, not only in release.yml.
    - §13.5: `create: false`; the capability list above; homepage; NSIS languages; the window state restored by the
      app.
    - §2.3.2/§2.3.7: `CancelToken`, `open_for`/`surah_timings_for`, `FileMismatch`, `Cancelled`, stale-while-
      revalidate timings, the continuation.
    - §2.5.5: the interactive budget and `PackError::Timeout`.
    - §2.5.7: stale-while-revalidate chapters and empty chapters.
    - §6.4 (optional, not done): the CSP's `blob:` and `media-src quran:` sources are unused.
  - The macOS/Linux smoke checklist: a crashed page (by hand), a refused navigation and a dropped file.
- **Rust core and contract (the UI round's finding 6).** The onboarding preview still adds listen history. The UI
  round's suggested contract is an additive `PlayRequest.record: bool` (serde default `true`) in `quran-types`, outside
  this area. Once it lands, the glue's half is small:
  - `AudioGlue::play` (audio_glue.rs) does not keep a `record: false` request as `last_request`, so the media key never
    replays the preview;
  - `GlueShared`'s `ListenTracker` records nothing for that play.
- **Tooling.** CI's tooling tests run `scripts/*.test.mjs`. They should also run
  `src-tauri/scripts/check-release-core.test.mjs`. check-artifacts could absorb this as `--release-core`; the script
  already imports its reader.
- **Root `Cargo.toml` and LEAD.md.**
  - `[workspace.package] repository` still names `github.com/fouad/quran-desktop`; point it at the final location
    once the github.com/quran move is settled.
  - The other crates still inherit `authors = ["Fouad"]`.
  - The `webview2-com` pin could move to `[workspace.dependencies]` with a LEAD.md "Integration" note. It adds no
    package.
- **Product decision.** Debian requires an email in `Maintainer`. None was invented: the owner chooses the contact
  address for `authors`.

### Verification

| Gate | Result |
|---|---|
| `cargo fmt -p quran-desktop -p quran-audio -p quran-packs -p media-session -- --check` · `cargo clippy` (same crates) `--all-targets -- -D warnings` | clean · clean |
| `cargo test -p quran-desktop -p quran-audio -p quran-packs -p media-session` | 57 binaries, 714 passed, 0 failed |
| `engine_wav` repeated (`announce_play` fix) | 10 of 10 alone, 18 of 18 with 6 runs in parallel |
| Regression checks | Without `settle_frame`, `save_restore_save_keeps_the_size_across_launches` fails. Without the cursor's cancel check, `a_new_play_never_waits_for_a_stalled_stream_of_the_old_one` times out |
| `node --test src-tauri/scripts/check-release-core.test.mjs` | 4 passed |
| `pnpm tauri bundle --debug --bundles nsis` (the dev core.db in place) | refused by `beforeBundleCommand`, exit 1, no installer written |
| `pnpm bindings:check` | up to date |
| `pnpm tauri build --debug --no-bundle`, then `app-driver` with scratch scenarios (renamed exe, `QD_AUDIO_SINK=null`) | `qa-window`: 2160×1410 over 4 relaunches. A 6140 px state fits as 2160×2075 at (840, 0) in the 3840×2088 work area; an off-screen state is centred. The logs, `window-state.json` and the WebView2 profile are under `QD_DATA_DIR`, the user's files are untouched, and `localStorage` starts empty. `qa-guard`: 8 probes denied (image, tray, menu, path, log, always-on-top, devtools, emit); `is_maximized`/`is_fullscreen` allowed; `settings-changed` heard. An `http:` navigation and window are refused and logged, and `file:` links are blocked by WebView2. Tafsir 105 gives "no commentary on surah 105", 1:1 gives 53,072 chars, and the log has no html5ever line. `qa-crash`: `Page.crash` reloads the page in 0.5–1.1 s, back on the reader with no fatal error; 3 crashes reload, and the 4th within a minute asks. PNGs read |

The app runs used a renamed copy of the debug exe (`quran-desktop-rustapp.exe`), because the user's installed "Quran
Preview" was running. The work area in the scenarios is this machine's (3840×2160 at 150 %). Not verifiable here: the
macOS and Linux window placement, guard and drop behaviour, and the browser-process restart dialog (WebView2 offers no
way to kill only its browser process).

## Integration gate 2, after fix round 1 (`CARGO_TARGET_DIR=C:\qdt\int-gate-2`)

Every gate ran on the merged tree, then again on the final tree, and all are green. The five fix rounds' cross-area
remainders are resolved, except those under "Remaining". Scratch scenarios, profiles and traces are in
`C:\qdt\int-gate-2-qa` (`scen/`, `tools/analyze.mjs`, `tools/drill.mjs`).

### Cross-area remainders resolved

- **e2e.**
  - S09 and S10 assert the crash-fix palette: no `override-colors`, the lines' `filter: url(#qd-v4-ink)`, and the
    `feColorMatrix` (`paletteState().matrix`). S09 also checks the drawn ink against the resolved ink (Δ ≤ 8).
  - S27: `.mv-slot` misses the page footer, and the toolbar starts ≥ 12 px below the page.
  - S01 and S02: the onboarding body never scrolls (step 1 in en and ar, step 2 in ar: 433 = 433).
  - S25: the "Source code" link opens the Cargo `repository`.
- **Contract: `PlayRequest.record`** (UI round finding 6; LEAD.md item 20). It is additive, serde default `true`, and
  `record?: boolean` in TypeScript (`#[specta(optional)]`). `false` marks the onboarding preview:
  - the glue's `ListenTracker` records nothing for that play (`begin(record)`);
  - the play never becomes `last_request`, so a media key with nothing loaded replays the recitation before it;
  - `player.preview` sends `false`, and the mock validates the type.

  Tests: the DTO default and wire shape, `a_preview_is_not_listening_and_the_next_play_is`,
  `a_preview_records_no_history_and_is_never_replayed` (the real engine on the null sink), and the mock, player and
  onboarding tests. `pnpm bindings` was regenerated and §5.8 updated.
- **Tafsir without commentary** (Rust-app round). An on-demand tafsir that answers `not_found` now shows "Ibn Kathir
  (abridged) has no commentary on Al-Fil", with a hint and no Retry (en/ar). The mock reproduces the upstream case
  (Ibn Kathir on surah 105).
- **No drop** (Rust-app round; the WKWebView and WebKitGTK layer). `components/shell/dropGuard.ts` runs on the
  window, with a "not allowed" cursor:
  - a file is refused everywhere;
  - an outside link is refused everywhere except in a text field;
  - text moved inside the app, and a drop a target accepted, are left alone.

  Unit-tested.
- **Overlay slot reach** (UI round). `MushafView` publishes its slot with `{@attach overlayReach('mushaf-slot')}`, and
  the App's MutationObserver lookup is gone.
- **QA hook** (tooling round).
  - The glide sampler requests frames only while audio plays (`watchPlaying`, a `$effect.root`).
  - `metrics()` adds `pageCacheSize` and `qcfFontFaces`; the metrics suite asserts PageCache ≤ 48 from them.
  - `waitIdle` also waits for a queued shaping warm-up (`shaping`) and a scheduled neighbour prefetch (`prefetch`), so
    "prefetched" turns really are measured prefetched.
- **CI.** The tooling tests run `src-tauri/scripts/*.test.mjs`, and `.github/actions/tsconfig.json` type-checks
  `check-release-core`.
- **Cargo** (LEAD.md item 19). `webview2-com` is pinned in `[workspace.dependencies]`, and the unused `async-executor`
  entry is gone. Every crate now inherits the workspace `authors`, the publisher. `Cargo.lock` is unchanged.
- **Docs.**
  - brand README: the media artwork row;
  - DEVELOPING: the scope of `QD_DATA_DIR`, `QD_ALLOW_DEV_CORE`, and the licence-text gate;
  - RELEASE_CHECKLIST: a dropped file or link, and a crashed WebContent or WebKitWebProcess on macOS and Linux.

### Performance (§8.18; the tooling round's misses)

Profiled in the real app with CDP tracing (`scen/P1.mjs`, `P3.mjs`), then fixed at the causes:

- **Page turns: cold glyphs.** The cause of a turn's 60–80 ms long task was the first layout of the new spread. Inside
  `fitLines`' forced layout, `InlineNode::ShapeTextIncludingFirstLine` ran 320 times, ≈ 0.18 ms per word, since each
  word is its own flex item and glyph. Chromium keeps glyph metrics per face and size, and keeps shaped words until the
  font set changes. `lib/mushaf/warmup.ts` therefore lays pages out off screen ahead of time, 3 lines per slice, each
  slice removed at once:
  - MushafView warms the next and the previous spread in idle time, at the bit-exact `.ln` size (`.qd-warm-ln` takes
    `calc(var(--qfs) * var(--glyph-scale))`). After a font-set change (`fonts.faceEpoch`, from the registry's
    `onFaceSetChange`), it warms them again, which is cheap.
  - A cold page on screen (a jump, a late font) is warmed urgently (`need`). RenditionStack waits for that warm-up
    within its 120 ms font wait, plus `GLYPH_WAIT_MS` for a late face. It no longer lays the page out in one long
    task.
  - A turn animates only into warm pages (`isInstantReady` includes the glyphs, through `TurnHost.glyphsReady`).
- **Playback-start CLS: the dock's morph.** The dock's box is now the canvas width and the bar height in every mode.
  - The pill (`.shell`, `[data-qd-dock-pill]`) is anchored at the box's inline-start corner and centred with
    `translate`. As measured in Edge, layout shifts follow the inline-start corner and ignore transforms.
  - Its width, height and radius are registered custom properties (`--qd-dock-w/h/r`) that transition.
  - Each mode's pane is laid out at its final place and revealed by a `clip-path` derived from those properties.
  - Consumers now measure the pill: PageRail, AyahActionBar, the tests and the scenarios.
- **CLS in the index.** The recitation-availability dot keeps its space when empty (`.dot.none`). A dot that appears
  as the recitation streams no longer moves the row.
- **System font fallback.** The hidden a11y list drew its Arabic in Segoe UI, which costs a synchronous fallback
  lookup and cold glyphs on every page. It now uses the bundled Hafs face (`.quran-text`), and
  `CSS.getPlatformFontsForNode` finds no system font in the page.
- **Flips** (§8.11: a page every 70 ms, no frame over 32 ms). Each flip step drew a new spread whose glyphs were laid
  out (≈ 35 ms) and rasterised for the first time. The raster runs on its own threads, but it delays the next frame,
  and an off-screen layout cannot rasterise in advance. So, while flipping:
  - a page shows its QCF rendition only if it was painted in that font before (`shapeWarmer.wasPainted`);
  - otherwise it shows the Hafs fallback, whose one face is always drawn, and the QCF rendition cross-fades in when
    the flip ends;
  - a surah header not painted before shows the cartouche. The QCF header is a colour glyph 3.3 em wide, which
    WebView2 rasterises in ≈ 100 ms.

  §8.11 already allows the fallback "if the font isn't ready"; ready now also means drawable within the frame budget.
- **Tried and reverted:** painting the neighbours' header glyphs in a 1 px layer made turns and flips worse (p95 55 →
  110 ms). With `will-change`, the stage was promoted; without it, the raster contended with the turns.

| `pnpm shots:app --only metrics` | Tooling round (before) | Now |
|---|---|---|
| CLS (20 pages, cold fonts, playback start) | 0.01 (the dock) | **0** |
| Long tasks > 50 ms during navigation | 8 (4 turns 61–84 ms, 4 jumps 76–231 ms) | 1 (`goto 1`, 235 ms) |
| Page turn key → painted p95 | 87–119 ms | 29–31 ms; p95 55 ms (one turn of 12) |
| Flip pace | 86–97 ms per step | **65–72 ms** |
| Flip frames over 32 ms | 23–27 of ≈ 80, up to 167 ms | 2–5 of ≈ 200, up to 67–75 ms |
| `qd:page` p95, FontFaces, PageCache, glide, CSP | ok | ok (13 ms, 24, 48, 120 fps, 0) |

### Verification (final tree)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` | clean · clean |
| `cargo test --workspace` | 1,330 passed, 0 failed, 20 ignored (94 binaries) |
| `pnpm bindings:check` · `cargo xtask verify-core` | up to date · 18/18 gates, 139 checks, 0 warnings |
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,358 files) · clean · 201 files, 0 violations · clean |
| `pnpm test` · `pnpm test:browser` | 75 files, 2,378 passed · 39 files, 530 passed |
| `pnpm build && pnpm check:dist` · `pnpm check:tooling` | 7/7 checks, 3.09 MiB · 75 ok, 0 failed (warning: `rg`, LEAD 6) |
| CI extras: `node --test` (tooling, actions, release-core, harness) · `tsc` (actions, e2e) · `pnpm check:ci` | 113 passed · clean · policy passed |
| Fresh-clone parity (a copy without fixtures, `pnpm i --offline`) | `pnpm test` 2,367 passed, 11 skipped; `check`, `lint`, `format:check` clean |
| `pnpm shots:web --serve 1977 --strict` | 38/38 passed; no page or console error |
| `pnpm tauri build --debug --no-bundle`, then `app-driver --registry tests/e2e/scenarios --strict` | 25/25 passed (IC2, smoke, S03–S13, S19, S24, S26–S35); no "panicked"; the only WARN is symphonia skipping 45 bytes of the CDN MP3 |
| IC2 (WAV sink) | 1,391–1,392 ticks over 1:1–1:7 (two runs), every tick on its timed word; WAV 18.6 MB |

PNGs read: S01, S02, S09, S10, S16, S17, S25, S26, S27 and S35, in the web and the app where both ran, and the dock in
en and ar. The app runs used a renamed copy of the debug exe (`quran-desktop-gate2.exe`), because the user's "Quran
Preview" was running.

### Remaining

- **`pnpm shots:app --only metrics` still fails, on three §8.18 rows.**
  - `goto 1` is one long task of ≈ 235 ms. Its cause is a 332 ms raster task for the two opening-page surah headers.
    Each is a QCF colour glyph 3.3 em wide. WebView2 rasterises it through DirectWrite colour-glyph runs the first time
    it is drawn at a size (again once the strike cache has dropped it), and the next frame waits for that raster.
    Hiding elements narrowed it down: hiding `.sh-line` alone removes it. A fix would take the headers off the
    compositor's path: either `ImageBitmap`s drawn by an `OffscreenCanvas` in a worker (cached per glyph, size, ink and
    DPR), or header images shipped with the decor pack.
  - One turn in twelve takes ≈ 55 ms (the others 29–31 ms).
  - A flip has 2–5 frames over 32 ms in ≈ 200, up to 75 ms: the first raster of new glyphs.
- **§13.6 runtime rows** (enforced by `size-budget`, not this scenario).
  - Memory with a spread and playback is 470–510 MiB against 350. Most of it is WebView2's renderer and GPU processes;
    the app itself is ≈ 26 MiB.
  - Cold start is 0.9–1.3 s on the debug build with CDP.

  Both still need a release-build measurement. Memory also needs a profile of the renderer heap and glyph caches.
- **Docs fold-ins for the docs pass.** The ARCHITECTURE items listed by the fix rounds: §2.2.6, §2.3, §2.5, §2.8.2,
  §4.1, §6.4, §7.5, §8.5, §8.6/D14, §8.9, §9.5, §9.7, §12.6, §13.3–13.6 and §15.3. This gate adds:
  - §8.5, §8.11 and §8.18: the shaping warm-up, the glyph wait, and the flip's painted-only rule (the cartouche
    included);
  - §9.7: the dock's fixed box and its pill;
  - §6.4: the drop guard;
  - §12.6: `waitIdle`'s `shaping` and `prefetch`, and the PageCache row.
- **For a person to decide or do:**
  - file the Chromium report for the multi-entry `override-colors` crash (Mushaf round; the repro is `scen/M5.mjs`);
  - choose the final `repository` URL;
  - choose the Debian Maintainer e-mail;
  - record the QUL permission wording.
- **Optional, not done:**
  - a `position_list` command. Restores are rare, and `app_bootstrap` serves them.
  - focusing the verse in `reader.goToAyah(…, { focus })` in translation mode. The search opener does it, and it is
    the only caller.
- **Not verifiable here:** macOS and Linux (WKWebView, WebKitGTK), the installers, and a real GitHub run.

## Rust-core fixes, round 2 (`crates/quran-core`; `CARGO_TARGET_DIR=C:\qdt\int-fix2-rust-core`)

### A restore no longer waits forever on another program's lock (minor)

- **Cause.** `UserDb::restore_from` held the library's writer lock and retried `Backup::step(-1)` on Busy/Locked with
  no limit, each step waiting out the connection's 5 s busy timeout. A write transaction held by another program on
  user.db (a database browser, a sync tool) therefore froze every library call, and through `replace_store`'s
  `WRITE_GATE` every settings write, and the restore never answered.
- **Fix** (`user_db/backup.rs`).
  - An attempt never waits for a lock while it holds the writer lock: both connections' busy handlers are off for the
    copy. `NoBusyWait` puts the library's 5 s back on drop, also after an error or a panic. A Busy/Locked step
    (extended codes such as `SQLITE_BUSY_SNAPSHOT` included) has committed nothing, and `sqlite3_backup_finish` rolls
    back whatever it began.
  - Between attempts the writer lock is released for 20 ms (`RESTORE_RETRY_PAUSE`), so other library calls run.
  - After 10 s (`RESTORE_BUSY_BUDGET`) it returns `CoreError::Sqlite(SQLITE_BUSY)`, which maps to `AppError::Database`:
    "the library is in use by another program, which holds a lock on user.db (or on `<src>`); close that program and
    try again. Nothing was restored". The library is unchanged, and the safety copy in `backups/` stays.
  - The successful copy and the migrations still run under one hold of the writer lock.
  - `user_db/mod.rs`: the 5 s busy timeout is the named constant `BUSY_TIMEOUT`, shared with the restore.
- **Measured** with the reviewer's scenario on the public `restore_from` (another connection in `BEGIN IMMEDIATE`):
  - the restore gives up after 10.0 s (before: it ran until the lock went);
  - 1,289 library reads during the wait took a median of 85 µs and at most 1.6 ms (before: blocked);
  - when the lock goes during the wait, the restore completes 14 ms later.
- **Tests.**
  - `backup::tests::a_lock_held_by_another_program_fails_the_restore_promptly_and_never_freezes_the_library` uses
    a 1.5 s budget through the private `restore_within`. It asserts a `Database` error with that message within the
    budget + 2 s, every read during the wait under 500 ms, an unchanged library, the busy timeout back at 5000, and
    the same restore going through once the other connection rolls back.
  - `restore_replaces_the_library_in_place_for_every_clone` also asserts that the busy timeout is back.

### Cross-area

None required. Optional:
- **UI** (`src/components/settings/backup.ts`): this failure shows the generic `errors.database` toast. A dedicated
  "close the other program and try again" text would need src-tauri to tell the case apart (for example by its own
  error kind), so it is a contract decision.
- **src-tauri** (`commands/user_study.rs` `user_backup_restore`): `replace_store` now holds `WRITE_GATE` for at most
  about 10 s on this failure. The safety copy it made just before duplicates the unchanged library; it is harmless
  and could be removed on failure.

### Verification

| Gate | Result |
|---|---|
| `cargo fmt -p quran-core -p quran-types -p xtask -- --check` · `cargo clippy -p quran-core -p quran-types -p xtask --all-targets -- -D warnings` | clean · clean |
| `cargo test -p quran-core -p quran-types -p xtask` | all passed |
| `cargo test -p quran-core --lib`, 5 runs | 205 passed each time |
| The new test, 5 runs on its own | passed, 1.6–1.7 s each |
| `cargo test -p quran-desktop --lib -- commands::user_study commands::settings` | 18 passed |

No contract change: `pnpm bindings:check` reports `bindings.ts` up to date.

## Tooling fix, round 2 (`tests/e2e/metrics`, `scripts`, `.github`, `docs`; `CARGO_TARGET_DIR=C:\qdt\int-fix2-tooling`)

### Playback CPU is enforced on the app and its webview (minor)

The finding: the §13.6 rows "playback CPU at 1.0× / 1.5× ≤ 3 % / ≤ 6 % of one core" were recorded and enforced from
the `quran-desktop` process alone. The app plus webview total was only a note. The word glide and the scrubber run in
the webview, so about 30 % of a core passed a 3 % gate, while the memory row next to it already counted the webview.

- **`tests/e2e/metrics/metrics.mjs`.** Both rows take their value and their verdict from the process tree: the app and
  every WebView2 process it started, as the memory and idle rows do. The report carries the tree too. Each row's notes
  give:
  - the app's own share (audio engine, IPC) and the WebView2 share;
  - the share of each process: renderer, GPU, browser, utilities;
  - the window and the glide's frame rate. The 1.5× window now gets its own metrics window, so its glide reading is
    its own.

  The 1.0× row also says what drives the frames. A new probe, `frameWork` in `_probes.mjs`, counts the
  `requestAnimationFrame` callbacks per second by source and lists the running CSS and Web animations. It runs for 2 s
  after the CPU window, never inside it. The memory note gains the same per-process breakdown, and
  `diagnostics.playback` keeps the raw samples.
- **`tests/e2e/metrics/_process.mjs`.** The CIM query reads each process's Chromium `--type` and
  `--utility-sub-type` (only those switches, not the whole command line). `roleOf` names each process; `cpu()` and
  `memory()` return `byRole`, and `cpu()` also returns `webviewPercent`; `describeRoles` formats the breakdown. The
  arithmetic is unit-tested in `tests/e2e/metrics/process.test.mjs` (6 tests), which CI's tooling-test step now runs.
- **`scripts/size-budget.mjs`.** The CPU rows say "(webview included)", like RSS; idle CPU says so too, as it always
  counted the tree. The report format is now `qd-metrics-report/2`. A `/1` report is refused, with the reason and the
  command that replaces it, so a stale app-only figure cannot pass the gate (2 new tests).
- **`scripts/qa/idle-cpu.mjs`** writes the same per-process breakdown into its note.
- **Docs.** WP13b.md decision 5 (the definition, marked as changed in this round) and its measurement row; DEVELOPING
  §9; RELEASE_CHECKLIST (`size-budget --require runtime`).

**Is the tree a fair measure in test mode?** The QA hook's glide sampler requests a frame on every frame while audio
plays. A scratch scenario in the real app suppressed it by wrapping `requestAnimationFrame`, alternating three times
in 15 s windows: 21, 36 and 54 % with the sampler, 35, 39 and 49 % without it. The difference is within the noise. The
sampler adds one trivial callback to frames the player's own loop requests anyway. Paused, the tree used 0.6–2.6 %
(three sessions).

Measured in this round's run, on a machine loaded by parallel builds: **1.0× 68.44 %** (app 2.50 %; renderer 40.1 %,
GPU 23.2 %, browser 2.3 %) and **1.5× 78.29 %** (app 2.13 %), both with the glide at ≈ 119 fps on a 120 Hz display.
`node scripts/size-budget.mjs --require runtime` now fails `playback-cpu-1x` and `playback-cpu-1.5x`. It also fails
cold start (1,126 ms) and memory (470.78 MiB), as before. Idle CPU (no hooks) was 0.30 % and then 0.84 % in a second
run.

### Also fixed: a debug `dist/` was measured as the production bundle

This turned up while verifying. The checklist's flow (`pnpm tauri build --debug`, the metrics, then `size-budget`)
leaves `dist/` as the debug build: source maps and no minification (`TAURI_ENV_DEBUG` in `vite.config.ts`), 11.58
MiB. `size-budget` reported that as the §13.6 dist row and failed it. Now `isDebugDist` (any `.map` file) leaves the
row unmeasured and prints a NOTE that says `pnpm build` makes the bundle the row budgets. A `--require dist` still
fails, and CI's release builds are measured as before (1 new test).

### Cross-area

- **UI (the player's glide and scrubber; the UI finding on the webview's playback cost).** The gate now fails until
  the webview's playback cost drops by about 10×. What `frameWork` found at 1.0×:
  - the player's loop (`player.sample` on every display frame), 120/s on this 120 Hz display;
  - Svelte's `raf` task loop (`run_tasks`, a tween or transition), about 68/s;
  - the QA sampler, 120/s (test mode only, and without measurable cost, as above);
  - no CSS or Web animation running.

  With the player's loop and the sampler both suppressed, the tree still used 17–23 %, while the tween loop kept
  running. Levers:
  - write the DOM only when something visible changes: a word boundary, or a scrubber move of ≥ 1 device pixel;
  - glide with a compositor animation (a transform animated to the next word boundary) instead of per-frame style
    writes;
  - update the time text at a few hertz.
- **Docs fold-ins (lead).** §13.6: "playback CPU at 1.0× / 1.5× ≤ 3 % / ≤ 6 % of one core, app and webview
  processes". §12.6: the report format `qd-metrics-report/2` and the per-process notes.

### Verification

| Gate | Result |
|---|---|
| `node --test scripts/*.test.mjs .github/actions/*/*.test.mjs src-tauri/scripts/*.test.mjs tests/e2e/lib/*.test.mjs tests/e2e/metrics/*.test.mjs scripts/qa/lib/*.test.mjs` | 122 passed, 0 failed (size-budget 13, the new process-tree tests 6) |
| `pnpm exec tsc -p tests/e2e/lib/tsconfig.json` · `-p .github/actions/tsconfig.json` · `pnpm check:ci` | clean · clean · policy passed |
| `pnpm check` · `pnpm lint:css` · `pnpm check:tooling` | 0 errors (5,360 files) · 201 files, 0 violations · 75 ok, 0 failed (warning: `rg`, LEAD 6) |
| `eslint` and `prettier --check` on every file this round touched | clean. Repo-wide `pnpm lint` and `format:check` fail only on `src/` files other fix engineers are editing now (`unicodeFit.ts`, `App.svelte`, `Summary.svelte`, `AyahScrubber.svelte`, `SearchPanel.browser.test.ts`) |
| `pnpm tauri build --debug --no-bundle`, then `app-driver --only metrics` (renamed exe, CDP :9432) | the playback rows are recorded from the tree with their breakdown (above). The run fails on §8.18 rows: turn p95 87 ms, flip 92 ms per page, the glide's longest frame 166 ms, one 240 ms long task (`goto 1`). Gate 2 measured turns at 29–31 ms on a quieter machine, so these misses are load (parallel builds and app runs), not this round's change |
| `node scripts/qa/idle-cpu.mjs --report <that report>`, then `node scripts/size-budget.mjs --metrics <it> --require runtime` | the report keeps format 2 and gains the idle row. size-budget prints the CPU rows "(webview included)" with their notes, fails them, and leaves the debug `dist/` unmeasured with its NOTE |
| `size-budget --metrics <a qd-metrics-report/1 file>` | FAIL: "its playback CPU rows count the app process alone, not the webview (re-run `pnpm shots:app --only metrics`)" |

The app runs used a renamed copy of the debug exe (`quran-desktop-fix2tooling.exe`), because the user's "Quran Preview"
was running. The A/B scenario is a scratch file (not in the repository).

## Rust-app fixes, round 2 (`src-tauri`, `crates/quran-audio`, `crates/quran-packs`; `CARGO_TARGET_DIR=C:\qdt\int-fix2-rust-app`)

All 7 findings are fixed at the root. No contract change: `quran-types` is untouched and `bindings.ts` is unchanged.
No dependency was added. The real-app scenarios are in `C:\qdt\int-fix2-rust-app\qa` (`vis2.mjs`, `fail.mjs`), and
their shots are in `qa-shots`.

### Audio engine (`crates/quran-audio`)

- **A play that fails before it starts keeps what failed (finding 1).**
  - `fail_play` keeps the play's reciter and range (`failed_play`, taken from `loading` or `pending_load`).
    `AudioSnapshot.range` and `reciter_id` report them while the status is `error`.
  - The next play, a stop, or an output failure that replaces the error clears them.
  - The dock's fallback in `player.error` now works for every entry point: the media key's and the tray's replay
    of `last_request`, and a play sent straight over IPC.
  - Real app (`fail.mjs`, network off, `audio_play` over IPC): "Offline — As-Saffat isn't downloaded for Mishary
    Rashid Alafasy [Download when online]" (`F1-offline-ipc-play.png`).
- **Play after a mid-way failure continues where it stopped (finding 5)** (`control.rs` `retry`).
  - Trigger: `resume`, and so `toggle`, the OS media session's Play and the tray's Play/Pause, on a session that
    decode failed (a stalled or offline stream, a later file offline, a decode error).
  - It plans the original request again, with the repeats and gap now in force. It starts at the segment that was
    heard (`StartAt`, found again by kind, surah and ayah; a basmala that is no longer planned gives its surah's
    first ayah), in the pass it was heard in.
  - `DecodeCmd::Load` gained `passes` (crate-internal), so range repeats keep counting.
  - The range shown stays the one asked for.
  - It keeps the play's `CancelToken` rather than registering a fresh one, and this is race-free. A newer play or a
    stop cancels it exactly as it would have cancelled the failed play. If the engine handle already replaced the
    token for a newer play on its way, the retry does nothing.
  - The failed session and its view stay until the new queue loads. What was heard therefore still shows, and a
    retry that fails again before it starts (still offline) leaves the failed play as it was, so the next Play tries
    from the same place.
  - An output-device error with an active session behaves as before.
  - Real app (`fail.mjs`): 112:1..113:2 with network use turned off while 112 played failed at 113:0. After network
    use came back, `audio_resume` played 113:1 at once, with the range still 112:1..113:2 (`F5-continued.png`).
- **Positions on the file timeline stay in the queue (finding 6).** There is a new `plan::file_run`/`file_run_span`:
  the run of consecutive segments around the heard one that play its file in order. A basmala that the surah-1
  file backs elsewhere in the queue is a run of its own.
  - Decode's `seek` (`seek_in_run`) bounds `FileMs`/`RelativeMs` to that run and picks the segment within it:
    - before the run, its start: the OS scrubber dragged to 0, a ←/→ nudge at the range start;
    - past the run, its end, which ends the run's last segment at once, as before;
    - from 1:7 of 1:6..2:2, a seek to 0 now goes to 1:6, not to the basmala's 1:1 audio.
  - The A-B wrap to A uses the same rule.
  - Control bounds `set_ab_loop`'s A and B to the heard run, so the snapshot reports the loop that plays. A loop
    left shorter than 300 ms (`MIN_AB_LOOP_MS`) is ignored like an inverted one, which clears the loop in force.
- **Next at the last ayah does what its end would do (finding 7).** While range repeats remain (∞, or fewer passes
  started than asked for), Next starts the next pass. `DecodeCmd::NextPass` is decode's `Next::Restart`, applied
  now. On the last pass, Next stops the play as before.
  - The pass comes from the callback's in-band progress, which is the same number `range_repeat_left` derives from.
    `media::playback_state`'s `can_next` (`more_in_range || range_repeat == 0 || range_repeat_left > 0`) is now
    true to the engine, and the tray's Next wraps too.
- **Tests.**
  - Engine (null sink):
    - `a_play_that_fails_before_it_starts_keeps_its_range_with_the_error`;
    - `a_play_that_failed_mid_way_plays_again_from_where_it_stopped`: the scratch scenario with range ×2; still
      offline, it fails again at 113:0, also before it starts; online, Play/Pause continues the first pass, then
      the second pass runs, then the end;
    - `file_positions_are_bounded_to_the_playing_range`: the scrubber at 0, a nudge back, A-B from 0, a loop
      before the range, past the end, and the surah-1-file case;
    - `next_at_the_last_ayah_starts_the_next_pass_while_range_repeats_remain`, with ×2 and ∞.
  - Decode: `seeks_stay_in_the_queued_run_of_the_file`, `next_pass_and_a_load_in_a_later_pass_count_the_passes`.
  - Units: `plan::file_runs_bound_seeks_to_the_queue`, `control::retries_find_the_heard_segment_in_the_new_plan`.
  - With the four fixes mutated back, all five engine and decode regression tests fail.
  - `engine_control` passed four runs in parallel, 19/19 each.

### OS media session, tray and glue (`media.rs`, `tray.rs`, `setup.rs`, `audio_glue.rs`)

- A failed play (`error` with an ayah loaded) shows paused with Play only.
  - `playback_state` turns off `can_next`/`can_previous`/`can_seek`, and the tray turns off Previous/Next
    (`TrayModel.failed`). The engine skips and seeks only within a running play, so these were controls that did
    nothing.
  - `tray::set_now_playing` takes the engine's status, and `setup::is_playing` (a copy of `tray::is_playing`) is
    gone.
- Glue test `an_os_play_after_a_failure_mid_way_continues_the_recitation`: surah 1 cached, surah 2 uncached
  (cached files only), so the play fails at surah 2. Once surah 2's file exists, `handle_media_command(Play)` plays
  2:1, with 1:6 heard once, and the play ends normally. `replay_if_unloaded` is unchanged: a failure mid-way keeps
  `current`, so Play reaches the engine's resume.

### Window (`window.rs`, `window/webview2.rs`)

- **The page knows when it is not seen (finding 2).**
  - `sync_webview_visibility` sets the WebView2 controller's `IsVisible` from the window: `webview2::set_visible` →
    `put_IsVisible`, through `with_webview`.
  - It runs after `hide_to_tray`, in `show_main` (before the focus moves), and on `Resized` when the minimised
    state changes.
  - Shown into a focused window, the controller also gets `MoveFocus`, so the keyboard works at once.
  - The hidden startup window is never marked invisible, so show-after-ready still paints first.
  - Real app (`vis2.mjs`, no CDP client attached while the window changed; the page logged its own timeline):

    | State | Page | rAF | CPU of the process tree |
    |---|---|---|---|
    | visible, reciting | `visible` | 120/s | 11.7–15.2 % |
    | hidden in the tray | `hidden` | 0 | 2.5–6.4 % |
    | minimised | `hidden` | 0 | 0.4–4.1 % |
    | shown again / restored | `visible` | 120/s | (page catching up) |

    These are the final build's numbers, from a run under the shared app lock. The keyboard focus was in the page after
    the restore, the audio played on throughout, and the webview's CPU in the tray fell from ≈ 0.9 to ≈ 0.2 s per
    8 s. The rest is the engine, which streams and decodes on.
  - A CDP client attached through playwright makes the page report `visible` (focus emulation), although rAF stays
    at 0. Measure with none attached.
- **Close-to-tray keeps a recitation only (finding 4).**
  - `close_action` hides to the tray only while reciting and with a tray icon; with nothing playing, × closes. This
    matches the setting's text ("Keep reciting after closing the window") and the question.
  - `window::reciting` counts a play still loading (its `current` is empty) as reciting, as the docs always said.
  - The decision table and its test follow, and `reciting_means_playing_or_about_to` is new.
  - Real app: after a pause, × with close-to-tray on exits the app.

### Packs (`crates/quran-packs`)

- **A paused download keeps its partial progress (finding 3).** `jobs.rs`: an item stopped by a pause or a cancel
  calls `settle_stopped`, which keeps its bytes and share, because its temps are kept and the resume continues from
  them. `settle_failed` is now for real failures, and for the abort after the job failed.
  - Tests:
    - `a_stopped_item_keeps_its_progress_and_a_failed_one_leaves` (unit);
    - `pause_keeps_temps_and_resume_continues_them` now asserts the paused snapshot: at least item 1 plus the 1 MiB
      on disk, out of exactly item 1 + item 2's real length + item 3's estimate. Before, it was 48 of 59 KiB.

### Cross-area

- **Frontend (`src/lib/stores/player.svelte.ts`).**
  - `player.error` takes the surah from `range.from` first. After a mid-way failure that is the range's start, not
    the surah that failed: 112:1..113:2 failing at 113 says "Al-Ikhlas isn't downloaded" (`F5-failed-mid-way.png`).
    Prefer `s.current?.surah` when the snapshot has `current`. A pre-start failure has none, so `range.from` still
    applies.
  - `toggle()` in status `error` replays `#lastRequest` from its start. When the snapshot has `current`, call
    `audioToggle`/`audioResume` instead, because the engine continues where it stopped.
  - `next()` doc: Next at the last ayah starts the next pass while range repeats remain.
- **Audio mock (`src/lib/ipc/mock/handlers/audio.ts`), to match the engine.**
  - `skip('next')` at the last segment: the next pass while passes remain.
  - `file_ms`/`relative_ms` seeks bounded to the heard file's run (today `flushTo(s, best, ms)` plays positions
    before the range).
  - `setAbLoop` bounded the same way, and ignored under 300 ms.
  - Resume after a mid-way failure continues where it stopped.
  - A pre-start failure's snapshot keeps `range`/`reciterId`.
- **Docs.**
  - WP4c deviation 11: Next at the last segment (the next pass while range repeats remain); seeks and A-B bounded to
    the queue; `set_ab_loop` under 300 ms after bounding is ignored.
  - ARCHITECTURE:
    - §2.3.2: the failed-play retry, the failed play's range, `NextPass`, the bounded seeks;
    - §2.8.4 (`on_window_event`: "hide when close_to_tray" → while reciting) and §9.6;
    - §7.3: the controller visibility.
  - RELEASE_CHECKLIST, macOS/Linux smoke: hide to the tray and minimise while reciting, then check
    `document.visibilityState === 'hidden'` and that animation stops (Web Inspector). WKWebView follows window
    occlusion and WebKitGTK an unmapped or iconified toplevel, so no code is expected there. Also, Play on a
    recitation that failed mid-way (network off then on) continues it from the media keys/MPRIS.
- **e2e (tooling).** An app scenario could keep finding 2 fixed: close to the tray while reciting, then read the
  page's own visibility timeline after the restore (as `vis2.mjs`).
### Two flaky tests in this area (found by the repeated runs; test-only causes)

- `quran-packs` `revalidate_pass::the_scheduler_runs_waits_for_the_network_and_stops` waited for two of the first
  pass's three due entries before moving the test clock on. When the third (WBW) had not been revalidated yet, it was
  stamped with the later time (left t2, right t1). It now waits for all three.
- `quran-audio` `source_stream::a_new_file_for_the_same_surah_replaces_the_old_stream` asserted that the old
  stream's `End(None)` came before the new stream's `Begin`. `StreamRegistry::end` is called from the blocking pool
  (by design: the decode thread may be the caller, and the registry may write SQLite), and the writers registry only
  counts streams. The test now asserts the events, not their order: two begins, the old stream unpromoted, the new
  one cached.
- Both passed 15 of 15 runs alone.

### QA note (tooling)

The single-instance lock is keyed by the bundle identifier, not the exe name. Concurrent real-app runs of different
renamed exes and data dirs therefore forward to each other: the later launch focuses the earlier one's window and
exits.
- My first scenario runs (≈ 20:36–20:40 and 20:58–21:01) did not take `scripts/qa`'s app lock. They may have
  absorbed launches of the Mushaf and UI rounds' app runs: my app's log shows "second instance started" from them.
  Those runs may need a re-run.
- `vis2.mjs` and `fail.mjs` now take the lock (`acquireAppLock`).
- Every ad-hoc scenario should do the same, or `app-driver` could warn when a launch forwards (its CDP never comes
  up).

### Verification (`CARGO_TARGET_DIR=C:\qdt\int-fix2-rust-app`)

| Gate | Result |
|---|---|
| `cargo fmt -p quran-desktop -p quran-audio -p quran-packs -p media-session -- --check` · `cargo clippy` (same crates) `--all-targets -- -D warnings` | clean · clean |
| `cargo test --no-fail-fast -p quran-desktop -p quran-audio -p quran-packs -p media-session`, 3 runs on the final tree | 57 binaries, 727 passed, 0 failed, 5 ignored, each run |
| Regression checks | With the four engine fixes mutated back, the 5 new engine and decode tests fail. `engine_control` passed 4 runs in parallel |
| `pnpm bindings:check` | up to date |
| `pnpm tauri build --debug --no-bundle`, then `qa/fail.mjs` (renamed exe `quran-fix2ra.exe`, CDP :9433/:9438, `QD_AUDIO_SINK=null`) | finding 1: range 37:1..37:182 and reciter 7 kept with the offline error, and the dock reads "Offline — As-Saffat isn't downloaded for Mishary Rashid Alafasy [Download when online]". Finding 5: failed at 113:0, and `audio_resume` → 113:1 with the range unchanged. PNGs read |
| Then `qa/vis2.mjs` (CDP :9437, under the app lock) | finding 2: page `hidden`, rAF 0 in the tray and minimised, `visible`/120 per s when shown or restored, focus in the page. Finding 4: × while paused exits the app |

## Mushaf fixes, round 2 (`src/components/mushaf`, `src/lib/mushaf`, `src/styles/mushaf`, the reader store; `CARGO_TARGET_DIR=C:\qdt\int-fix2-mushaf`)

All six findings are fixed, plus one Mushaf-side change that the UI round's onboarding test needed. No contract or
dependency change: `bindings.ts` and the mock handlers are untouched. The scratch scenarios (`fit.mjs`, `head.mjs`,
`flip-hafs.mjs`, `turns-hafs.mjs`, app-mode copies of the reviewer's `rangejump.mjs` and `turnfocus.mjs`) and their
shots stayed in the session's scratch directory.

### The hafs style is fitted per spread (major, finding 1)

- **New `src/lib/mushaf/unicodeFit.ts`.** `scale = clamp(floor2(0.98 / max demand), 0.82, 0.92)`.
  - A line's **demand** is its natural width (its words plus the 0.22 em minimum gaps) over its line box: 16.5 qfs,
    or 12.1 qfs inside the opening medallion.
  - The **floor** is the measured hafs `glyphScale`, which stays unchanged in `metrics.ts`, so the measure script's
    `--write` and the e2e `glyphScaleOf` keep working.
  - The **cap** is 0.92, about a 12 % step between spreads.
  - A spread with no justified line keeps the floor: pages 1–2 look as signed off (S03).
- **One value per spread.** `SpreadStage` provides `setSpreadContext({ pages })`, and `RenditionStack` fits the hafs
  rendition to the pages on screen with it in the same style.
  - While a facing page is still loading, or still in the previous style, the hafs page waits for it, at most
    `FONT_WAIT_MS`. It is then laid out once, at its final size.
  - A later change refits in place.
  - Single-page mode fits the page alone. Previews and thumbnails fit themselves.
- **Deviation from the suggested fix** (measure in `fitLines`). The demand is measured from the page data before the
  first layout, with the canvas `measureText` of each word in qd-hafs at 100 px. It is cached per word text (about
  21,500 in the Mushaf) and per `PageData`.
  - Measuring and then rescaling would lay every page out twice, the second time at a new size: cold glyph metrics and
    shaping, the 30 ms a page that warmup.ts measured.
  - It would also move words after their first paint (CLS), and the warm-up needs the value before the page exists.
  - Canvas and DOM agree within 0.0013 em a line over all 3 × 604 pages in Edge.
  - The cost is at most 8 ms for a page of unseen words, 0.5 ms typically.
  - `fitLines` is unchanged and stays the safety net.
- **The warm-up uses the same size.** `glyphKey` and `warmPageOf` take the glyph scale. `MushafView` warms a hafs
  neighbour at its spread's scale (`reader.pagesFor`), measured once a turn has ended, never during a turn or a flip.
  An idle-time measurement was tried first: under load it pushed the warm-up past the browser test's 5 s.
- **The fallback of a QCF style keeps the floor.** It is transient, never faces the same rendition for long, and it is
  what a flip draws, where one size keeps the glyph caches warm.
- **Measured** with core.db qdc, all 604 pages in Edge (scratch copy of the measure script's method):

  | | Global 0.82 | Per spread |
  |---|---|---|
  | words-to-line fill, median (p5) | 0.703 (0.590) | 0.751 (0.641) |
  | word gap, median / p95 (qfs) | 0.577 / 1.045 | 0.483 / 0.898 |
  | lines below fit 0.98 | 29 | 29 (all on spreads at the floor) |

  - Scales over the 302 spreads: 0.82 for 62 (pages 1–2 included), 0.83–0.91 for 160, 0.92 for 80.
  - Mock, the reviewer's 47 fixture pages (596 lines): fill p50 0.705 → 0.760; gap p50 0.577 → 0.469 qfs, p95
    1.03 → 0.87, max 1.83 → 1.54.
  - Real app, sample of 1,480 lines: fill 0.745, gap 0.503 qfs. Spreads 41–42 draw at 0.91, 261–262 at 0.89, 255–256
    at 0.92.
- **What it cannot do (for the lead).** The median fill stays at about 75 %, under the 80 % the finding set for the
  global-scale alternative.
  - With fixed line breaks and one size per spread, the widest line bounds the others. With no cap the median is
    0.759; a 0.15 em minimum gap would give 0.78.
  - The rest of the slack is what print takes up with kashida. Chromium has no kashida justification and the KFGQPC
    face has no `jalt`, so filling it would need tatweel inserted at legal joins: a typographic feature to decide on,
    not a fix. The few-word lines of page 41 (2:251) show it.
- **Performance.** The QCF path does not run the new code: the metrics suite (qcf_v2) gives the same rows on the gate-2
  build and on this one.

  | Row | gate-2 build | this round |
  |---|---|---|
  | CLS | 0 | 0 |
  | `qd:page` p95 | 12.2 ms | 15 ms |
  | turn p95 | 55.4 ms | 55.5 ms |
  | flip longest frame | 66.9 ms | 66.7 ms |
  | long task `goto 1` | 238 ms | 243 ms |

  - The misses are the machine's load, as the tooling round recorded.
  - hafs, interleaved A/B against the gate-2 build: flips of 29–30 pages in 2.1 s with a longest frame of 33–42 ms in
    both. Turns took 27–39 ms in both while the machine was quiet, and 56–73 ms in both under other agents' load.
- **Tests.**
  - `unicodeFit.test.ts`: demand, gaps, the opening box, floor, cap and two decimals, the opening floor, no canvas.
  - `MushafView.browser.test.ts`:
    - both pages of 261–262 at one scale, equal to `unicodeScale` of the spread and above the floor, with every line
      unsqueezed and the fill up;
    - a single page fits itself;
    - the opening pages stay at the floor;
    - the warm-up keys carry the spread scale.
  - `RenditionStack.browser.test.ts`: the fallback stays at the floor.
  - `warmup.test.ts`: the key carries the scale. `layout.test.ts`: the bars clear the em box at 0.92.
  - S11's hafs sweep, S03 and S12 pass unchanged, in the mock and in the app.

### The running head reads as one line (minor, finding 2)

- **Fix.** `.mp-head-juz-glyph` takes `translate: 0 calc(var(--fs) * 0.47 - var(--mp-head-fs) * 0.41)`, which puts the
  calligraphy's ink centre on the head text's (`--mp-head-fs`, the head's size, is now a variable on `.mp-head`).
- **Derivation.** The constants come from the two faces' metrics:
  - the calligraphy's baseline is 0.285 em above its box bottom, and its ink is centred 0.185 em above the baseline
    (median of the 30 juz);
  - the Naskh baseline is 0.207 em above its line box, and its ink is centred 0.20–0.23 em above the baseline.
- **Checked** over the 602 heads with canvas ink boxes: the median offset is 0.03 em to the quarter label and 0.04 em
  to the surah name, whose own centre moves ±0.15 em with its descenders.
- **Page 256** at qfs 26.25 (S12's head, real app): ink centres at 97.25 (calligraphy), 97.16 (quarter) and 98.66
  ("سورة ابراهيم", deep descenders). That is 0.1 px from the label, 1.4 px from the name and 0.7 px from the middle of
  the two. Before, the calligraphy sat 7 px above. Page 262 is within 0.6 px of both.
- **Test.** `furniture.browser.test.ts` measures the ink centres (a baseline probe plus the canvas ink box) on page 262
  at qfs 24. Both the surah name and the quarter label must be within 0.05·qfs; before the fix the gap was 4.5 px. The
  test loads the decor face from `data/dev-packs` and skips without it.

### Translation mode: visible means on screen (major, finding 3)

- **New state.** `reader.translationRows` (`{ from, to } | null`) holds the verse rows of the feed inside its viewport.
  - It is measured a frame after the feed scrolls (a capture `scroll` listener), the window resizes, the view reports
    its reading verse (`translations.topAyahId`) or text loads (`translations.version`).
  - It reads the feed's DOM: `[data-qd-view="translation"] .qd-virtual-list` and the `#tv-a{id}` rows, which the reader
    already used for focus. TranslationView needs no change.
- **What it changes.** `isVisible` tests against it, falling back to the reading verse. `actionTarget`, `#canExtend`,
  `#here` and the start of `moveCursor` follow.
- **Result.** A cursor left behind by Mushaf mode is no longer the target. In the real app the reviewer's
  `R2a-trmode-target.mjs` passes: B bookmarks 290, which is on screen (was 262).
- The cursor does not move on T: the target rule makes that unnecessary.
- **Test.** `reader.test.ts`: "in translation mode, a cursor outside the verses the feed shows is not the action target".

### Range jumps flash, focus and announce (major, finding 4)

- **New option.** `GoToAyahOptions.selectTo` lets the reader select the range itself. The first ayah flashes, takes
  focus and is announced with the range ("Al-Baqarah 2:255–257, page 42").
- **New arrival guard.** It no longer compares the cursor with the jump's own ayah. It uses a jump sequence number (a
  newer jump, or back/forward, wins) and the cursor the jump left, read once the calling task has ended.
  - The current callers (`openTarget`, `openSpan`, which call `select(to, true)` right after) therefore work
    unchanged.
  - A user who moves the cursor before the jump lands still cancels it.
- **Repros.** The reviewer's `rangejump.mjs` and `palette.mjs` "2:255-257", in the mock and in the app: focus on
  `LI#a11y-42-262`, the flash seen, selection 262–264.
- **Tests.**
  - `reader.test.ts`: `selectTo`; the older call form; a newer jump, or a cursor move, cancels.
  - `MushafView.browser.test.ts`: Go to "2:255-257" through the real dialog. It fails with the old guard.

### Focus survives a page turn (minor, finding 5)

- **Fix.** `setPageNow` notes whether focus was on a roving item (`.mp-a11y`) of the pages that are leaving. Once the
  turn renders, focus moves to the new view's tab stop (`A11Y_TAB_STOP`); after a flip, once the flip settles.
  - This happens only when focus was lost (it is still on `<body>`).
  - It does not happen when the navigation moves focus itself (`CommitMeta.focuses`: focused jumps, cursor moves).
  - The reader never sets the cursor. A11yLayer's focus handler puts it on the focused item, as for Tab.
- **Repro**, mock and app (`turnfocus.mjs`): skip link → `LI#a11y-49-290`, ← → `LI#a11y-51-303`, PageDown →
  `LI#a11y-53-316`. Before, focus dropped to `BODY`.
- **Tests.** `MushafView.browser.test.ts`: ←, PageDown and → from the tab stop; a flip; focus elsewhere stays where it
  is. Both new tests fail without the fix.

### The C hint follows the copy format (minor, finding 6)

- **Fix.** In Copy ▸, `C` marks the row that does what C does:
  - "Arabic with reference" by default;
  - "Arabic only" with the reference off;
  - "With translation" when a copy translation is set. There C does the same as Ctrl+Shift+C.
- No new strings.
- **Test.** `AyahContextMenu.browser.test.ts` covers the three settings.

### Running head and footer are `div`s

The UI round's onboarding test forbids `header` and `footer` elements inside the dialog. It failed on the ThemePreview
pages, because RunningHead and PageFooter used those elements. They are `aria-hidden` decoration, so they are now
`div`s; the CSS and every selector are class-based and unchanged.

### Cross-area

- **Tooling** (`scripts/measure-glyph-scale.mjs`).
  - Record the hafs per-spread distribution: `clamp(floor2(0.98 / max demand), 0.82, 0.92)` per spread, its
    histogram, and the fill and gap percentiles. This round's numbers come from a scratch copy of its method.
  - `--write` must keep leaving `UNICODE_FIT` (unicodeFit.ts) alone. The floor stays `STYLE_METRICS.hafs.glyphScale`.
- **UI** (WP10a `src/components/index/navigate.ts`, WP11c `src/components/library/library.svelte.ts`). Pass
  `selectTo: to` to `reader.goToAyah` instead of calling `reader.select(to, true)` afterwards. Both forms work now.
- **TranslationView.** Keep `data-qd-view="translation"`, the `.qd-virtual-list` scroller and the `#tv-a{ayahId}` row
  ids, which the reader measures. If the view ever publishes its rows itself, `reader.translationRows` is where they
  go.
- **e2e.** S11/S12 could assert the hafs spread scale (`--glyph-scale` equal on both pages, within 0.82–0.92) and the
  head's ink centres.
- **Docs.**
  - §8.2/§8.4: the per-spread fit of the hafs style; the fallback stays at the floor.
  - §8.9: the head alignment; furniture as `div`s.
  - §8.15: what visible means in translation mode; focus across turns.
  - §7.4/§10.4: range jumps and `selectTo`.
  - §10.3: the C hint.
- **Lead decision (open).** Kashida (tatweel) justification of the Unicode text, if 80 % fill is wanted (above).

### Verification (`CARGO_TARGET_DIR=C:\qdt\int-fix2-mushaf`; no Rust or contract change)

| Gate | Result |
|---|---|
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,365 files) · clean · 201 files, 0 violations · clean (repo-wide, final tree) |
| `pnpm test` | 79 files, 2,414 passed |
| `pnpm test:browser` (Edge) | 39 files, 553 passed |
| New tests without their fixes | the focus, flip and Go to browser tests fail with the turn refocus and the old arrival guard put back; the head test fails at 4.46 px with the old `translate` |
| `pnpm shots:web --serve 1960 --jobs 4` | 37 passed. S24 fails on a Settings string ("150 %" vs "150%"), outside this area |
| `pnpm tauri build --debug --no-bundle`, then app-driver (renamed exe `quran-desktop-fix2mushaf.exe`, CDP 9451–9459, `QD_AUDIO_SINK=null`) | S03, S05, S06, S08, S11, S12, S13, S27, S29 and smoke passed. So did the reviewer's `R2a-trmode-target.mjs` and the app copies of `rangejump`/`turnfocus` |
| `app-driver --only metrics`, this build vs gate-2 | the same rows on both (table above) |

PNGs read: spreads 3–4, 49–50, 255–256 and 261–262 (mock) and 41–42 (app); the heads of pages 4, 256, 262 and 293 at
3×; S03.

## UI fixes, round 2 (`src/**` outside the Mushaf area; `CARGO_TARGET_DIR=C:\qdt\int-fix2-ui`)

All 17 findings are fixed in this area. The parts that belong to other areas are listed under "Cross-area". No contract
or dependency changed: `quran-types`, the commands and `bindings.ts` are untouched. Each fix has a test that fails on
the old code. The scratch scenarios and shots are in `C:\qdt\int-fix2-ui\scen` and `…\shots`.

### Arabic ink (finding 1, major)

- **Ellipsis labels clip the inline axis only.**
  - Every one-line ellipsis rule (69 rules in 47 files) and base.css's `.truncate` now use `overflow-x: clip;
    overflow-y: visible`.
  - They also get `min-inline-size: 0`. `clip`, unlike `hidden`, does not make an element a scroll container, so a
    flex or grid item would otherwise stop shrinking.
  - `PaletteRow .text`, `AyahHeader .title/.meta` (the Naskh name) and `SurahList .end` also clip sideways only.
  - The two-line clamps (`PackRow .name`, `SideDockCard .idle-title`) must clip both axes, so Arabic gets a 1.6 line
    box there instead.
- **Text fields lost their dots too, from a second cause.**
  - Blink resets a single-line `<input>`'s line box to `normal` when the input has a percent height, or a fixed height
    taller than its line-height.
  - IBM Plex Sans Arabic's `normal` line box (20 + 7 px at 18 px) is smaller than its ink (15 + 8 px). The palette
    field drew «ابحث فى». So did Go to, `TextInput` (and `SearchInput`, which uses it) and `Combobox`.
  - These fields now stretch in their flex row (`align-self: stretch`) instead of `block-size: 100%`, so they keep
    their own line-height. The dots are back in the mock and in WebView2.
- **The index rows were never clipped.** A 15 px weight-500 «البقرة» has no overflow on any ancestor. Its ب dot is a
  1–2 px mark at DPR 1, which shows in the real app at 10× (`shots/a2`).
- **Guards.**
  - `src/styles/text-guards.test.ts` scans every style rule. It fails on an ellipsis rule that clips the block axis
    or lacks `min-inline-size`, on an `<input>` sized by a fixed or percent height, and on informative `--text-faint`
    text (finding 17).
  - `primitives.browser.test.ts` renders a Button «التالي» and a PaletteRow in the Arabic UI and checks
    `clip`/`visible` on every ellipsis element. It also checks that the label box is shorter than the font's ink (the
    case it guards) and that a narrow button still ellipsises.
  - The reviewer's clip probe (R12) now finds 0 clipped elements.

### Player

- **Space in translation mode (finding 6, major).**
  - `idleTarget()` plays the verse at the top of the view (`translations.topAyahId`).
  - Until the view has reported one (it is still laying out, or no translation is installed yet), it plays from where
    the view opens: the reading cursor when it is on the visible pages.
  - Mushaf mode is unchanged. The idle pill uses the same function.
  - The unit test covers both cases and the return to Mushaf mode. In the real app, Space after "Go to 2:255, T" now
    plays 2:255–286, not 2:249.
- **Dock popovers never reopen by themselves (finding 7, major).**
  - `closeOnLeave` (`dock.svelte.ts`) is an attachment on each pane. Its cleanup resets the open state of that pane's
    popovers when the pane leaves. The idle pane's reciter picker has its own state.
  - SideDockCard ties More (through a `display: contents` wrapper) and Repeat and Speed to its active rows the same
    way.
  - Browser test, for Repeat, Speed and More: open the popover, stop, play again. No popover and no layer remain, and
    ArrowLeft turns the page. It fails on the old dock.
  - Real app (112:1 played once, Repeat left open): after the next play the popover is gone, `layerOpen=false`, and
    ArrowRight turns 603–604 to 601–602.
- **The scrubber no longer writes every frame (finding 8, major).**
  - The thumb moves on the device-pixel grid: `Math.round(x · dpr) / dpr`, with `dpr` followed through `matchMedia`.
    An unchanged derived value does not propagate, so the DOM changes only on a new pixel.
  - The played part is a full-length fill under a rounded `overflow: clip`, moved with `translate`. It no longer
    rebuilds a `clip-path` every frame, and its leading edge lies under the thumb.
  - TimeReadout and the side card's elapsed time derive from whole seconds. The collapsed pill's 36 px progress moves
    in whole pixels.
  - Real app, 2 s at 1.5×: the dock mutates only the slider's `aria-valuenow`/`aria-valuetext` and the readout, about
    1.5 times a second. Before, the reviewer counted 219 + 219 style writes.
  - A CDP trace with invalidation tracking, with the Mushaf hidden, finds no style invalidation from the scrubber.
  - What still runs every frame is the word glide (`.hl-word`, ≈ 100 inline-style writes a second, even while hidden),
    its Svelte spring loop and the player's own `sample` loop. See Cross-area.
- **The Repeat popover's steppers keep focus (finding 15).**
  - At a limit the steppers are `aria-disabled` no-ops instead of `disabled`. `IconButton` styles `aria-disabled` like
    `disabled` but stays focusable.
  - Browser test: Fewer down to once keeps focus in the popover, Enter does nothing, and Tab moves on.

### Downloads

- **"Download when online" is a request, not a failing job (finding 9, major).**
  - `packs.installWhenOnline(id, scope)` starts at once when downloads can run (`packs.canDownload`).
  - Otherwise it waits in `packs.waiting`, merged per pack, and the connectivity effect starts it (`#startWaiting`,
    beside `#resumeOfflineJobs`).
  - If a job started this way still fails with `offline`, it goes back to waiting, with no failure toast and no
    Failed row.
  - `packs.isWaiting` also covers a job that failed for being offline while the app still is.
  - The Downloads row reads "Waiting · Waits for a connection" («بانتظار الاتصال · يبدأ التنزيل عند الاتصال
    بالإنترنت») with Cancel. The SurahGrid shows the waiting surahs as queued.
  - The dock's button toasts "Maryam will download when you're online" when it has to wait, else "Downloading …".
  - Unit tests:
    - network use off: no `packs_install`, requests merge, the download starts on reconnect and pins surahs 1, 2 and
      18, and no danger toast is shown;
    - an offline failure of such a job waits again;
    - Cancel drops a pure wait without `packs_cancel`.
  - Real app (network off, Maryam not downloaded): one toast, the row reads "Waits for a connection · Waiting". Once the
    network is allowed, surahs 1 and 19 download (19 MB) with no failure on the way.
- **"Download the rest" (finding 10).**
  - `remainingKib` counts every item `packs_items` reports as present, whether pinned or fetched as you read
    (`kib > 0 || !queued`). An install pins such items in place: the adapter reports them `Present`.
  - Only the missing items are estimated. Unit test: 86 fetched QCF V2 pages and 30 fetched WBW chapters leave exactly
    the missing items' estimate.
- **Units (finding 3).**
  - `i18n.sizeUnitDisplay` is `narrow` in Arabic, which gives one style: «ك.ب / م.ب / غ.ب / ت.ب». CLDR's short forms
    mixed «كيلوبايت» with «م.ب». `bytes()`, the progress pairs and the onboarding total use it.
  - `i18n.unitDisplay` is `long` in Arabic, so the search summary reads «٢٤٣ ملي ثانية».
  - The unit test covers all four size steps.

### Text, shell, library, settings

- **Toasts and the Quran text (finding 2).**
  - `components/shell/toastPlacement.ts` measures how far the book's text block (`[data-qd-stage]` less its head and
    foot bands, `BLOCK_TOP`/`BLOCK_BOTTOM` in qfs) stays from the canvas edges. It measures again on resizes, on
    scrolls inside the canvas, and on every refit.
  - `toastSide` keeps toasts at the bottom when they fit under the text, else moves them to the top edge (12 px, or
    below a zen title bar or hint), else to the edge that covers less text.
  - In zen, toasts rest 16 px above the canvas bottom, under the text, and a zen dock called up lifts them.
  - `Toaster` gained `placement="top"` and `offsetTop`.
  - Browser tests, both failing on the old shell: in zen an Undo toast lies outside the text block; with qfs held at
    18 (1024 × 560), the toast sits at the top over at most a sliver of the first line.
- **End-of-ayah marks never wrap alone (finding 11).**
  - `lib/text/endmark.ts` binds "۝N", and a standalone sign before it such as the sajda mark ۩, to the last word with
    U+00A0, which the shaper draws with the font's space glyph.
  - This applies to translation mode's rows, the side pane's translation tab and the note editor's ayah. Search hits
    join the mark's word with U+00A0.
  - Unit tests, plus a browser test of the NBSP and the mark's line at 1280 and 720 px.
- **Escape is decided after propagation (finding 12, major).**
  - `ShortcutsStore.handleCapture` now defers every capture Escape, not only while a layer is open. `handleBubble`
    re-resolves it against the state its handlers left and runs it unless one of them called `preventDefault()`.
  - If its `when` no longer holds, an ordinary Escape may still apply.
  - Browser tests, all failing on the old store:
    - Escape in the Settings and Downloads search clears the text and stays in the view;
    - in a narrow window, the sidebar filter clears before the sidebar closes;
    - the preset editor cancels, and the selection survives.
- **A restore forgets undo (finding 13, major).**
  - `user-data-changed` naming `positions` (only a restore sends it) now clears both undo stacks, dismisses the undo
    and redo toasts and empties the marks cache.
  - Unit test: after a restore, Mod+Z says "nothing to undo", and the restored green 8–12 stays whole.
- **Delete keeps focus (finding 14).**
  - `focusAfterRemoval(row)` (components/library) waits for the row to leave and for a closing item menu to let go.
  - It then focuses the row now in its place, else the last row, else the panel's filter, else the panel's tab in the
    rail. It finds the rows again first, because Highlights re-creates a group keyed by its first item.
  - Delete and the item menus' Delete use it in Bookmarks, Highlights and Notes.
  - Browser tests per panel, plus one for the menu down to an empty list.
  - The range jumps (`navigate.ts`, `openSpan`) now pass `selectTo` (the Mushaf round's request).
- **Reordering translations keeps focus (finding 15).**
  - After a move, focus returns to the moved row's same arrow, or to the other arrow when the row reached an end.
  - The buttons are named "Move Saheeh International up" / «نقل … لأعلى».
  - The settings test moves an item there and back from the keyboard.
- **Percentages (finding 4).** `formatValue('pct')` uses `Intl.NumberFormat(…, { style: 'percent' })`, giving "100%"
  and «١٠٠٪» as elsewhere in the app. The `settings.units.pct` messages are gone.
- **Smart-mode advice (finding 5).** New messages `search.none.body{Quran,Translation,Notes}Smart` (en and ar) do not
  suggest Smart mode while it is on. The browser test checks both bodies.
- **No landmarks in dialogs (finding 16).**
  - The Dialog's header and footer, the onboarding `StepHeader`, and the Repeat and Speed popover heads are now
    `div`s.
  - Tests assert that no `header` or `footer` is left inside a dialog or those popovers. The Mushaf round made the
    ThemePreview's furniture `div`s for the same test.
- **`--text-faint` (finding 17).**
  - These now use `--text-muted`: the heatmap's juz labels, About's licence labels and package ecosystem, the
    Downloads section counts, the theme preview caption, the translation order numbers, the empty note preview, the
    shortcut sheet's "or", and the Settings section links that have no search matches.
  - The guard allows `--text-faint` text only on disabled, inactive, locked and blocked states, separators (`.sep`,
    `.plus`), placeholders, orphan footnote markers and the status dot.

### Cross-area

- **e2e (`tests/e2e/scenarios/S24.mjs:90`).** It expects "150 %". Since finding 4 the readout is "150%", so S24 fails
  until that string is changed.
- **Mushaf area.**
  - `SurahInfoPopover.svelte` `.si-title`/`.si-subtitle` need the same ellipsis fix (`overflow-x: clip; overflow-y:
    visible; min-inline-size: 0`). `text-guards.test.ts` lists the file in `PENDING_ELSEWHERE` until then.
  - `AyahActionBar.svelte`: call `e.preventDefault()` when its window `keydown` listener dismisses the bar. Escape is
    now decided after propagation, so the first Escape will then close only the bar (finding 12, case 4).
  - The word glide is now the playback cost (finding 8; the tooling round's gate). It writes `.hl-word`'s inline style
    about 100 times a second, even while hidden, and Svelte's spring loop runs with it. A compositor transform toward
    the next word boundary, and no writes while hidden, are the levers.
  - Optionally, `MushafView` could publish the book's text clearance itself (`trackTextClear`), as it does the slot's
    reach. Today `App` measures `[data-qd-stage]`.
- **Rust app (`quran-packs`).** While a job resumed after an `offline` failure runs, `packs_list` still reports the
  pack as `failed: internal "the last download … did not finish"`; it should read as downloading. The UI shows the
  live job over the pack state, so nothing visible depends on it.
- **Docs.**
  - §9.3: the inline-only clip and the field-sizing rule.
  - §9.5: Toast `placement="top"`; `IconButton`'s `aria-disabled`.
  - §7.5: toasts never cover the Quran text.
  - §10.1: Escape is decided after propagation; Space in translation mode.
  - §2.5.5: a download that waits for a connection.
- **Not verifiable here.** WKWebView and WebKitGTK: `overflow: clip` needs Safari 16 or WebKitGTK 2.38, both below the
  supported floors.

### Verification (final tree)

| Gate | Result |
|---|---|
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,365 files) · clean · 201 files, 0 violations · clean (repo-wide) |
| `pnpm test` | 79 files, 2,414 passed |
| `pnpm test:browser` (Edge) | 39 files, 553 passed |
| New tests without their fixes | the dock, Escape and toast tests were run with the old file swapped back, and they fail. The others assert behaviour the old code lacks: the idle target, units, waiting downloads, the rest size, restore, focus, end marks, landmarks and the guards |
| `node scripts/qa/web-shot.mjs --serve 1933 --registry tests/e2e/scenarios` | 37 of 38 passed. S24 fails only on "150 %" (Cross-area) |
| The reviewer's clip probe R12 (web, ar) | 0 clipped element kinds |
| Scratch web scenarios `V2ar`, `V3en`, `fields`, `ph`, `scrub`, `trspace` | read: «التالي» and the palette rows with their dots; «ك.ب/م.ب» units; the Waiting row; "100%"; the Smart-mode advice; the zen toast under the text; the fields centred with dots; the scrubber at 0, 45 % and 95 % in en and ar |
| `pnpm tauri build --debug --no-bundle`, then app-driver (renamed `quran-desktop-fix2ui.exe`, CDP 9431–9432, `QD_AUDIO_SINK=null`) | `A1`: Space in translation mode plays 2:255–286; no popover after the replay, and ArrowRight turns 603–604 to 601–602; 2 s at 1.5× brings only the slider's aria and the readout from the dock. `A2ar` at DPR 1 in WebView2: «التالي», «في يبني» in the palette, and the units. `A3`: "Download when online" gives one toast and a Waiting row, then downloads surahs 1 and 19 once allowed. `P1`–`P5`: the CPU split and the invalidation trace |

Process-tree CPU at 1.5× read 18–36 % of a core here, with four other agents building and testing on the machine. A
noise-free split is only possible with the trace (no scrubber invalidations). The paused tree reads 0–0.8 %. The §13.6
gate stays open on the word glide (Cross-area).

## Integration gate 3, after fix round 2 (`CARGO_TARGET_DIR=C:\qdt\int-gate-3`)

Every gate ran on the merged tree, then again on the final tree. The five round-2 areas' cross-area remainders are
resolved, except those under "Remaining". No dependency was added; the IPC contract is unchanged (`bindings.ts` up to
date). Scratch scenarios and measurements are in `C:\qdt\int-gate-3-qa` (`cpu-split*.mjs`, `cpu-ab.mjs`).

### Cross-area remainders resolved

- **Mushaf area (from the UI round).**
  - `SurahInfoPopover.svelte`: `.si-title`/`.si-subtitle` clip the inline axis only (`overflow-x: clip; overflow-y:
    visible; min-inline-size: 0`). `text-guards.test.ts` loses its `PENDING_ELSEWHERE` exemption.
  - `AyahActionBar.svelte`: the Escape that dismisses the bar calls `preventDefault()`, so the shortcut store's deferred
    Escape skips it: the first Escape closes only the bar, the next clears the selection. New browser test in
    `MushafView.browser.test.ts`.
  - The word glide: see Performance.
- **e2e.** S24 expects "150%" (Intl percent). S11 asserts the hafs per-spread fit: every page of the 50-page sweep
  draws between the floor (0.82) and the cap (`UNICODE_FIT.max`, read from `unicodeFit.ts`), and in spread mode both
  pages of 1–2, 255–256, 261–262, 601–602 and 603–604 share one scale (1–2 at the floor). Web: 0.82 / 0.92 / 0.89 / 0.9
  / 0.91. New **S38** (both modes): a recitation requests no frame loop of the app's own and writes the word pill once
  per word; app only, closed to the tray while reciting, the page draws no frame while the engine plays on (the
  rust-app round's finding 2, kept by a test). `scripts/qa/lib/app.mjs` retries the data-dir removal for up to 15 s
  (Windows refuses the directory with EPERM for a few seconds after a window hidden in the tray) and says why when it
  gives up.
- **Player store (from the rust-app round).** A play that failed mid-way keeps `current`:
  - `player.error` names the surah that failed (`current` first, then the range's start);
  - Space (`toggle`, also with a resume candidate or an idle target), `resume()` and the dock's Retry send
    `audio_resume`, which continues where it stopped; a failure before the start (no `current`) still replays the
    request;
  - `next()` documents the next pass while range repeats remain.
  Test: "a play that failed mid-way names the surah that failed; Space and Retry continue it where it stopped" (each of
  the three changes, reverted, fails it).
- **Audio mock (from the rust-app round), now at parity with the engine:** Next at the last segment starts the next
  pass while passes remain; file-timeline seeks and the A-B wrap stay in the heard run (`fileRun`/`seekInRun`, as
  `plan::seek_in_run`); `set_ab_loop` is bounded to the run and a loop left under 300 ms is ignored and clears the one in
  force; a failed play takes no transport command. New: a stream stalls while network use is off (progress counts
  only online, buffering is measured in ms of audio, not whole percent), so a play can fail **mid-way**, keeping its
  segment and range; Play retries from that segment in its pass (`StartAt::index_in`), and while still offline the
  failed play stays as it was. Five new mock tests.
- **quran-packs (from the UI round).** `pack_state`: a paused or failed job that runs again reads as what the pack holds
  (`partial`, or `not_installed`), not as the stop its row keeps until the job ends ("the last download … did not
  finish"). Test `a_resumed_job_reads_as_downloading_not_as_its_last_stop` (fails without the fix with exactly that
  error).
- **Tooling (from the Mushaf round).** `measure-glyph-scale.mjs` measures every hafs ayah line (centred ones too) and
  reports the per-spread fit with the renderer's own constants (read from `unicodeFit.ts` and `geometry.ts`): the
  scales' histogram and the fill and gap percentiles, globally and per spread; `--json` gains `hafsSpreads`. `--write`
  still writes only `metrics.ts`. Run on core.db qdc: 302 spreads, 62 at the floor, 80 at the cap
  (`0.82×62 0.83×15 0.84×17 0.85×18 0.86×22 0.87×22 0.88×17 0.89×14 0.90×16 0.91×19 0.92×80`); fill median 0.703 → 0.751
  (p5 0.590 → 0.641), gap median 0.577 → 0.483 qfs (p95 1.045 → 0.898); 29 lines below fit 0.98 either way, the Mushaf
  round's numbers exactly.
- **Range jumps** pass `selectTo` in both callers (`navigate.ts`, `library.svelte.ts` `openSpan`): done in the UI round,
  checked.
- **Docs.** WP4c deviation 11 (Next at the last segment, seeks and A-B bounded to the run, the mid-way retry, the mock);
  RELEASE_CHECKLIST (× closes when nothing plays; a mid-way failure continues from the dock, a media key, the tray and
  MPRIS; hidden/minimised while reciting draws nothing on macOS and Linux); WP13b decision 5 and DEVELOPING §9 (the
  sampler switch); LEAD.md item 21.
- **Lead decision** (the Mushaf round's open question): no kashida justification of the Unicode text (LEAD.md item 21).

### Performance: a recitation costs the webview no frame loop (§13.6 playback CPU; the tooling round's gate)

The tooling round's `frameWork` probe found three per-frame sources; with them suppressed the tree still used 17–23 %.
All three are gone, and the webview's IPC is cut too:

- **The player's clock** (`player.svelte.ts`). The rAF loop that set `positionMs` on every frame is replaced by a
  scheduled sample: at each tick, and in between exactly when the UI shows a change, i.e. the next word's start or the
  next boundary of the finest step a component asked for (`player.needPosition(stepMs)`: the scrubber one device pixel
  of its track, the collapsed pill one of its 36 px; else whole seconds for the readouts). Interpolation (§7.3) is
  unchanged. Paused or hidden nothing is scheduled. Test: 1.1 s of recitation takes 4 samples (a frame loop: 66–132),
  a finer step is honoured at the speed played, and released again.
- **The word glide** (`lib/mushaf/glide.ts`, `HighlightLayer.svelte`). The Svelte `Spring` (a script loop writing the
  pill's transform and size on every frame) is replaced by FLIP: a word change writes the pill's final box once and
  plays a Web Animation of its `transform` from the box it showed (a translate and a scale). The compositor runs it.
  The motion is the spring's: `GLIDE_SPRING` simulated as Svelte ticks it, as a `linear()` easing of 33 samples over
  360 ms (to 99.8 %, no overshoot), a cubic Bézier where `linear()` is missing (WebKit before 17.2). Mid-glide, a new
  word starts from the drawn box (the computed transform). Tests: `glide.test.ts` (the curve against the spring at 60
  and 120 Hz, the FLIP transforms) and the glide browser test, which now also asserts one running animation per glide
  and no write to the pill's style while it glides.
- **Ticks** (`audio_glue.rs` `TickFilter`). The engine ticks at 30 Hz; each tick that reaches the webview is an IPC
  message and a turn of its event loop. Now a tick goes through when it changes what the UI shows (status, generation,
  surah, ayah, word, speed, gap), when its position is more than 40 ms off the webview's interpolation (a repeat, an A-B
  wrap, a stall), and otherwise every 250 ms; not playing, every tick (one per change) goes through: about 5 a second
  during al-Fatihah (4 re-anchors and the word changes) instead of 30. The frontend reads no other tick field
  (`seq` and `bufferedPct` are unused there). ARCHITECTURE §5's "≤ 30 Hz" holds (the table's "30 Hz while playing" is a fold-in). Test
  `the_webview_gets_the_ticks_that_change_what_it_shows_and_a_resync_four_times_a_second`; the end-to-end glue test
  counts the channel against the engine's rate.
- **The metrics suite** measures the app, not the instrumentation: the QA hook's glide sampler requests a frame on
  every vsync and was now most of the window, so the CPU windows run with it off (new hook
  `__QD_TEST__.sampleFrames(on)`, typed in `types.ts` and the e2e client, unit-tested), and the glide's pacing is
  sampled in its own 6 s window before each CPU window. The 1.0× row's note lists the frames the app drives with the
  sampler off: "no requestAnimationFrame".

Measured in the real app (debug build, CDP attached, a machine shared with other agents' builds; 120 Hz display):

| | Before | Now |
|---|---|---|
| `pnpm shots:app --only metrics`, playback CPU 1.0× (app + webview) | 68.44 % (tooling round, sampler on) | **5.31 %** (app 0.53, browser 1.59, GPU 1.52, renderer 1.29) |
| the same at 1.5× | 78.29 % | **7.85 %** (app 1.37, GPU 3.58, renderer 2.67) |
| A/B scratch `cpu-ab.mjs` (Mushaf, word glide, full dock; sampler dropped in both builds), 3 × 12 s windows per run | the UI round's build: median 10.0 / 13.8 %, min 9.4 / 10.8 % | median 4.6 / 5.6 / 6.6 %, min 2.5 / 2.9 / 3.1 % |
| frames the app requests while reciting (`frameWork`, sampler off) | 120/s player loop + ≈ 68/s Svelte spring | **none**; one Web animation on `div.hl.hl-word` |
| the word pill's style writes | ≈ 100 a second | one batch per word (S38: 8 records for 2 glides in 5.5 s) |
| hidden in the tray while reciting (S38) | — | 0 frames in 2 s, the engine playing |

The glide row of §8.18 holds (120 fps, longest frame 8.9 ms). What is left of the webview's share is the
compositor drawing the glide (about 360 ms per same-line word) and the dock's per-pixel thumb, and the runs vary by
±2 % with the machine's load: whether the 3 % budget is met needs a quiet machine and the release build (Remaining).

### Verification (final tree)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` | clean · clean |
| `cargo test --workspace --no-fail-fast` | 94 binaries, 1,344 passed, 0 failed, 20 ignored; no "panicked" |
| `pnpm bindings:check` · `cargo xtask verify-core` | up to date · 18/18 gates, 139 checks, 0 warnings |
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,367 files) · clean · 201 files, 0 violations · clean |
| `pnpm test` · `pnpm test:browser` (Edge) | 80 files, 2,428 passed · 39 files, 554 passed |
| `pnpm build && pnpm check:dist` · `pnpm check:tooling` | passed, 3.10 MiB · 75 ok, 0 failed (warning: `rg`, LEAD 6) |
| CI extras: `node --test` (scripts, actions, release-core, e2e lib, metrics, qa lib) · `tsc` (e2e, actions) · `pnpm check:ci` | 121 passed, 1 skipped (the NSIS LZMA estimate: no 7-Zip or `xz` on the PowerShell PATH) · clean · policy passed |
| `node scripts/qa/web-shot.mjs --serve 1947 --registry tests/e2e/scenarios --strict` | 39/39 passed (S38 new); no page or console error |
| `pnpm tauri build --debug --no-bundle`, then `app-driver --registry tests/e2e/scenarios --strict` (renamed `quran-desktop-gate3.exe`, CDP :9447) | 26/26 passed (IC2, smoke, S03–S13, S19, S24, S26–S35, S38); no "panicked", every data dir removed |
| IC2 (`QD_AUDIO_SINK=wav:`) | 1,392 ticks over 1:1–1:7, every ayah and its words in order; WAV 18.4 MB |
| `app-driver --only metrics` (CDP :9448) | fails on the §8.18 rows of gate 2 only (Remaining); CLS 0, `qd:page` p95 11.3 ms, glide 120 fps / 8.9 ms, FontFaces 24, PageCache 48, CSP 0 |

PNGs read: S11, S24 and S38 (web and app), the word pill of S38 at 4×. The app runs used a renamed copy of the debug
exe, because the user's "Quran Preview" was running.

### Not done (reasoned)

- **Rust-core round, optional.** A dedicated "close the other program" text for a locked restore needs its own error
  kind (a contract change) for a rare case; the `errors.database` toast stands. The safety copy made before a restore
  that then fails is kept: it is the guarantee when a failure comes after the copy started (the migrations), and an
  extra backup is harmless.
- **`MushafView` publishing the text clearance** (UI round, optional): `App` measures `[data-qd-stage]` correctly today.
- **Docs fold-ins.** ARCHITECTURE stays untouched for the docs pass. Added to gate 2's list: §7.3 (the scheduled
  position clock, `needPosition`), §8.7 (the compositor glide), §5 table (ticks filtered to the webview), §12.6
  (`sampleFrames`, the glide window), §2.5 (a resumed job's pack state), and the round-2 areas' own lists.

### Remaining

- **`pnpm shots:app --only metrics` still fails on gate 2's three §8.18 rows**, unchanged by this gate: `goto 1` is one
  long task of ≈ 240 ms (the first raster of the opening spread's colour-glyph surah headers); one turn in twelve takes
  ≈ 56 ms; a flip has 4–5 frames over 32 ms (67–75 ms). New evidence for the turn: it is never the order but the first
  visit of a spread whose page fonts just loaded (`turns.mjs`: from 50, 55–56 and 61–62 took 55 and 47 ms on a fresh
  data dir, every turn ≈ 30 ms on the second pass), i.e. the first raster of new glyphs, which no off-screen warm-up
  reaches (gate 2).
- **§13.6 runtime rows** (`size-budget --require runtime`): playback CPU 5.31 % / 7.85 % against 3 % / 6 % (see
  Performance; down from 68 % / 78 %), memory 431 MiB against 350 (the renderer 274 MiB, the GPU process 88 MiB; the app
  26 MiB), cold start 0.95–1.2 s against 0.8 s on the debug build with CDP. All three need the release build on a quiet
  machine; memory also a profile of the renderer heap and its glyph caches.
- **For a person, as at gate 2:** the Chromium report for the multi-entry `override-colors` crash, the final
  `repository` URL, the Debian Maintainer e-mail, the QUL permission wording.
- **Not verifiable here:** macOS and Linux (the new RELEASE_CHECKLIST rows), the installers, a real GitHub run.
- **Housekeeping note:** removing this session's leftover `%TEMP%\qd-qa-*` QA data dirs (before the driver's cleanup
  fix) used a 3-hour age filter, so a concurrent agent's temporary QA dir from that window may have been removed too.

## Documentation (`README.md`, `docs/**`; `CARGO_TARGET_DIR=C:\qdt\int-docs`)

Every "docs fold-in" left by the packages, the fix rounds and the gates is resolved here. No code, contract or dependency
changed.

- **`docs/IMPLEMENTATION_NOTES.md` (new): the v1.2 fold-in.** Every accepted deviation (`WP*.md`), lead decision (LEAD
  1–21) and integration change, organised by ARCHITECTURE's sections, each with its source (`WP4b 5`,
  `INT fix 1 rust-app`, `LEAD 17`). Superseded package choices appear only in their final form, with what they were. It ends with
  what remains for a person, the measured misses and what this machine cannot verify.
- **`docs/ARCHITECTURE.md`:** a v1.2 banner (read with the notes; the notes win where they disagree), and in-place
  corrections marked **(v1.2)** where leaving the text would mislead someone acting on it:
  - §3.1 and §4.2: the search seed is QDC `text_imlaei` (QUL 54), with the inline ۞ and 2:181 source facts;
  - §4.3: resource ids 54 and 63, the optional juz/hizb/manzil inputs, `sha256 = ""`; the committed manifest is
    authoritative. The example snippet itself is unchanged, since `data/sources/qul/manifest.toml` describes its
    differences from it and `qul_adapter` parses it;
  - §4.4 rule 1 (cross-page headers, LEAD 17), §4.5 G4, G5b, G8, G14, G15, and §8.9 (the inline ۞ marker);
  - §14.3: the ten acceptance lines with several test filters now use `cargo test -p <crate> --lib -- <filters>`
    (LEAD 14, 17). `check:tooling` reads them: 194 commands, 75 ok.
- **`docs/contract-changes.md` (new).** The spec's change process names it, but it never existed. It lists the post-freeze
  contract changes: `userBackupRestore`, `windowSetCaption`, `PlayRequest.record`, `common.appFullName`,
  `FixtureManifest.queries`, `shortcuts.memorize.mistake`, and the deleted `Placeholder.svelte`.
- **`docs/research/FACT_SHEET.md`:** "Corrected:" and "Added:" notes beside the original text, which stays as history:
  - C15 (cross-page headers) and the §2.3 derivation;
  - the inline ۞ (§2.3), the margin ۞ (§4.2), the 2:181 end marker, and spaces inside words;
  - C13 and §2.2 (the search seed is 54);
  - C5 (198 spaced codes);
  - `cargo test` takes one test-name filter (§1);
  - the QCF mirrors are not byte-identical (§4.1);
  - quran-common's juz ligatures are U+E001… (§4.2);
  - reciter 173's basmala, QuranEnc's constant `Last-Modified`, the Sa'di and Ibn Kathir gaps;
  - the @tauri-apps/api 2.12.2 event-mock bug, and WebKitGTK's missing CORS check on scheme loads.

  A legend entry explains the convention. BRIEF §4's script list says 54 too.
- **`README.md`** rewritten:
  - what the app is, with its identity pending the quran organisation's approval;
  - a feature tour, with a shortcut table taken from the registered definitions;
  - a screenshots policy: no images are committed; a table of the scenarios that show each feature, with the commands
    to generate them;
  - the architecture: the crate graph checked against the Cargo manifests, and each crate's role;
  - a build, run and test quickstart for Windows, macOS and Linux;
  - data sources and licensing: a development core.db is never distributed, and a release needs QUL plus written
    permission;
  - credits, and the GPL-3.0-or-later notice.
- **`docs/DEVELOPING.md`** refreshed:
  - the xtask command table and the `cargo test` filter rule;
  - every `QD_*` variable the code reads, found with a grep over the tree: `QD_FONT_TRANSPORT`, `QD_UPDATE_SNAPSHOTS`,
    `QD_QDC_TIMINGS_DIR`, `QD_QURANENC_DIR`/`OUT`, `QD_DSP_LISTEN`, the stress seeds, `QD_KEEP_IC2_WAV`,
    `QD_QA_DEBUG` and `SOURCE_DATE_EPOCH` were missing;
  - the data directory's contents, with the log and window-state locations per OS;
  - the tooling tests CI runs, and the repository rules for contract changes and CSS;
  - the visual QA section: both drivers' options, the single-instance lock, writing a scenario;
  - a new "Preview builds" section (`QD_ALLOW_DEV_CORE`, never published, and the AUMID caveat of a side-by-side
    identifier);
  - new common-failure rows. Stale rows are fixed: `bindings:check` is git-free, `fetch-assets` exists, and the CDP port
    is chosen automatically.
- **`docs/RELEASE_CHECKLIST.md`:** three blockers the gates named for a person: the QUL permission wording
  (`QUL_PERMISSION`), the final `repository` URL, and the Debian Maintainer e-mail. **`LEAD.md`** points at the fold-in.

### Verification

| Check | Result |
|---|---|
| `pnpm format:check` (README is the only Prettier-checked file; `docs/` is ignored) | clean |
| `node scripts/check-tooling.mjs` (parses the edited ARCHITECTURE.md) | 194 commands; 75 ok, 0 failed (warning: `rg`, LEAD 6) |
| `cargo test -p xtask --test qul_adapter -- the_snippet the_section_4_3 the_committed_manifest` | 3 passed (the §4.3 snippet still parses from the spec) |
| `pnpm shots:web --list` | lists every scenario (the README's command) |
| `web-shot --serve 1971 --only S03,S04,S09,S16,S19,S20,S21,S22,S24,S26,S27,S33 --jobs 4` (the README's screenshot set) | 12 passed; S03, S09, S16, S21, S26, S27 read, and they show what the README's table says |
| Code spans and accidental block quotes in the edited Markdown (a script over every changed file) | none split across lines |

## Release engineering (WP13b, LEAD 16; `CARGO_TARGET_DIR=C:\qdt\int-release`, installers `C:\qdt\final`)

The release build is smaller and its audio path faster; the Windows installers are built, branded and checked; the
§12.6 metrics ran in the real app; the checklist carries every gate a public release still needs. Decisions for the
fold-in: LEAD.md item 22. No crate or npm package added; `Cargo.lock` unchanged; contract unchanged.

### Size: what was measured, what was applied

A snapshot of the tree (01:51) was built once per variant, release profile, same frontend. "LZMA" is what NSIS stores
(`xz --format=lzma`, 9e, 8 MiB dictionary, as `size-budget.mjs` estimates it).

| Variant | exe (B) | exe, LZMA (B) | |
|---|---|---|---|
| baseline: `opt-level = "s"`, rustls on aws-lc-rs, tauri defaults | 14,210,560 | 5,687,262 | |
| rustls on ring (`reqwest/rustls-no-provider`, `rustls/ring`, provider installed in `Http::new`) | −350,720 | −28,493 | not applied |
| tauri without `dynamic-acl` | −139,264 | −28,791 | applied |
| `opt-level = "z"` | −1,411,072 | −397,879 | — |
| `"z"`, audio hot path at 3 | −1,103,360 | −268,302 | applied |
| **final** (both applied, the real tree) | **13,002,240** (−1,208,320) | **5,401,685** (−285,577) | |

- **Profile.** `"z"` alone slows the DSP chain by 20 % (`dsp_cpu`: 0.28 → 0.34 % of a core). With decode, resampling
  and WSOLA at opt-level 3 (`symphonia-core`, `symphonia-bundle-mp3`, `rubato`, `realfft`, `rustfft`, `quran-audio`:
  the dev overrides plus rubato's FFT crates) the chain runs at 0.104–0.109 % of a core at 0.5/1.5/2× and 0.037 % at
  1× (was 0.276–0.278 / 0.050), WSOLA 1.5× at 0.078 % (was 0.254): 2.6–3.3× faster than the previous release build.
  The rest measured the same at `"z"`: `CoreDb::pages` median 105 → 107 µs over 1,812 pages (budget 5 ms), every §3.5
  search p99 within ±10 % (`"ال"` 8.9 → 9.2 ms, budget 25), brotli decompression of the main JS and CSS 4.0 → 4.6 ms.
- **No `dynamic-acl`**: hardening as much as size; the app never calls `add_capability`. Debug builds keep the ACL
  table (tauri gates it on `debug_assertions` too).
- **ring, not applied.** 28 KB of installer, and it drops X25519MLKEM768, which aws-lc-rs offers today. It would also
  need a process-wide provider installed before every client: without one, reqwest panics, and `panic = "abort"` ends
  the process.
- **core.db, unchanged.** Already VACUUMed (freelist 0), page size 4096 (G14). 8 KiB pages save 316 KiB on disk but add
  10 KB compressed; 16 and 64 KiB are worse. What is in it: `word` 5.70 MB, `ayah` 5.06 MB (13 % of its pages unused:
  rows of ≈ 700 B on 4 KiB pages), FTS 0.62 MB, `line` 0.56 MB. Smaller means dropping the derived text columns
  (`ayah.text_*` are joins of `word` rows): a core.sql change, not a release-engineering one.
- **Installer compression, unchanged.** A 64 MiB dictionary saves 5 KB. A BCJ x86 filter would save 263 KB (3.3 %),
  but makensis 3.11 has no filter option, and a forked NSIS template is not worth it.
- **Frontend, unchanged.** `dist/` 3.10 MiB. tauri embeds it brotli-compressed (quality 9, not configurable; the
  1.59 MB main chunk becomes 389 KB). Every font is WOFF2. Inter's Cyrillic, Greek and Vietnamese subsets (85 KB) serve
  translations in those scripts, and Noto Naskh's symbols subset carries the ﷺ-type signs of tafsir: kept.

### Installers (`pnpm tauri build --bundles nsis msi`, `QD_ALLOW_DEV_CORE=1`)

| | Before (snapshot, same core.db) | Now |
|---|---|---|
| NSIS `Quran_0.1.0_x64-setup.exe` | 8,091,295 B (7.72 MiB) | **7,923,528 B (7.56 MiB)**, budget 8 MiB; the branded icons cost ≈ 113 KiB of it |
| MSI `Quran_0.1.0_x64_en-US.msi` | — | 10,792,960 B (10.29 MiB, MSZIP), not a release asset |
| installed footprint (exe, core.db, catalog.json) | 26,790,715 B (25.55 MiB) | 25,582,395 B (24.40 MiB), budget 35 MiB |
| `dist/` | 3.10 MiB | 3.10 MiB, budget 6 MiB |

- Copied to `artifacts/release/` (gitignored) with `SHA256SUMS` and `PRIVATE-PREVIEW.txt`. They carry the qdc core.db
  and are unsigned, so they are private previews: `check-release-core` let them through only under
  `QD_ALLOW_DEV_CORE=1`, and `check-bundles --core qul` refuses them for exactly that reason (7-Zip is also missing
  here). Every NSIS-script check passes.
- **Branded setup and uninstaller** (`tauri.windows.conf.json` `installerIcon` and `uninstallerIcon`: the tuned
  `icons/windows/icon.ico`). Before, both showed NSIS's generic icon, which on an unsigned download reads as untrusted.
  `check-bundles` now asserts both defines (tested), and the window.rs config test pins them.
- **MSI upgrade code pinned** to UUIDv5(DNS, `com.quran.labs.desktop`) = `aac524f6-dd12-56b5-9a7a-14fe4e2a7d28`.
  tauri-bundler 2.12 derives the default from `"{productName}.exe.app.x64"`, so any Tauri app named "Quran" would
  share it. The MSI installs per machine with an English UI and stamps the AUMID on its Start-menu shortcut.
  `release.yml` and the checklist keep NSIS as the only Windows asset (§13.4).
- **Pitfall** (building with an isolated `dist/`, because other agents rebuild the shared one with source maps): an
  absolute `build.frontendDist` such as `C:/qdt/final-dist` parses as a URL with the scheme `c:`, so tauri embeds no
  frontend and the app loads that "URL". The first installers here were 6.34 MiB for that reason and were discarded.
  Use a relative path in the `--config` file (`../../../../../qdt/final-dist` from `src-tauri`).

### §12.6 metric assertions in the real app (debug build, `--only metrics`, quiet machine, 120 Hz)

| Row | Budget | Run 1 | Run 2 |
|---|---|---|---|
| cold start (native + web) | ≤ 800 ms | 1,146 (494 + 652) | 972 (344 + 628) |
| CLS, 20 pages, 58 cold QCF loads, playback start | 0 | **0** | **0** |
| long tasks > 50 ms | none | 1: `goto 1` 240 ms | 1: `goto 1` 237 ms |
| `qd:page` p95 | < 16 ms | **10.5** | **11.8** |
| FontFaces per style · PageCache | ≤ 24 · ≤ 48 | **24 · 48** | **24 · 48** |
| page turn p95 (12 turns) | < 50 ms | 205 (the first turn; the others 30–39) | 55 (one turn; the others 29–38) |
| flip pace · longest frame | 70 ms · ≤ 32 ms | **66.1** · 66.7 (4 over 32) | **64.7** · 66.7 (5 over 32) |
| word glide | ≥ 58 fps, ≤ 32 ms | **120 fps, 9.3 ms** | **120 fps, 8.9 ms** |
| `#qd-v4-palettes` · CSP violations | applied · 0 | **applied · 0** | **applied · 0** |
| memory, spread + playback | ≤ 350 MiB | 412.6 (renderer 258, GPU 86, app 26) | 422.3 |
| playback CPU 1.0× / 1.5× (the app's share) | ≤ 3 / ≤ 6 % | 6.85 (0.84) / 6.95 (1.15) | 5.18 (0.91) / **3.59** (0.76) |
| idle CPU (`idle-cpu.mjs`, no hooks) | ≈ 0 (≤ 0.5 %) | 0.84 (renderer 0.76, crashpad 0.08) | |

`size-budget --require nsis,installed,dist,runtime` (the installers above, the run-2 report): NSIS, installed and
dist within budget; cold start, RSS, idle CPU and playback CPU 1.0× over. The PNGs (`metrics.png`, the V4 tajweed
spread with the dock, and the final-state shot) were read.

**The release build**, built with a side-by-side identifier (`com.quran.labs.desktop.relqa`, so it never touched the
user's data; each data dir removed afterwards), CDP attached:
- cold start 991–1,077 ms over four warm runs (1,937 ms the first, cold file cache), native 331–405 ms. No
  `__QD_TEST__` (D24 holds), no CSP violation, no page error;
- where the web part goes (three runs): the JS and CSS are served in 15–24 ms, DOMContentLoaded comes at 166–190 ms,
  `app_bootstrap` takes 6–7 ms, the first `mushaf_get_pages` comes at 270–300 ms, the pages render (`qd:page`) by
  340–390 ms and `window_ready` goes out at 323–398 ms. The first contentful paint lands **230–270 ms after
  `window_ready`**, together with a *second* `mushaf_get_pages`;
- idle with the onboarding open: 0.69 % of a core (renderer 0.46), 179 MiB private (app 18 MiB). An 8 s CPU profile of
  the renderer's main thread has no JavaScript sample, no animation and no rAF: the idle residue is WebView2's own.

### Cross-area

- **Cold start (src-tauri window, reader).** The release build starts no faster than the debug one. The app's own work
  is done ≈ 330–400 ms after navigation; showing the window then costs 230–270 ms and re-fetches the pages. Suspect:
  the window is shown at its restored size, so the webview relayouts and the reader re-requests its spread. Creating
  the hidden window at its final size (the window state applied before the first layout), and not re-fetching when
  the spread is unchanged, would remove most of the gap. The timings come from `performance` entries over CDP
  (resource entries of `ipc.localhost`, `qd:page` measures, paint entries), reproducible with any CDP client.
- **§8.18 (Mushaf):** unchanged since gate 3: the `goto 1` raster (≈ 240 ms), a first-visit turn (55–205 ms) and flip
  frames of 67 ms.
- **§13.6 runtime rows (lead):** idle CPU sits at WebView2's floor (0.23–0.84 % across the rounds, with no app work).
  Either the row becomes "no app work while idle" (no script, animation or rAF in a profile; tree ≤ 1 %), or 0.5 %
  stays and is re-measured until a quiet window passes. Playback CPU and memory as at gate 3.

### Verification

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` | clean · clean |
| `cargo test -p quran-desktop` · `pnpm bindings:check` | 191 + 1 passed · up to date |
| `cargo test -p quran-audio --release --test dsp_cpu` (the final profile) | passed: chain 0.106–0.109 % (0.038 % at 1×), WSOLA 0.078 % |
| `node --test` (scripts, actions, release-core, e2e lib, metrics, qa lib) | 121 passed, 1 skipped (no 7-Zip or xz on the PowerShell PATH) |
| `pnpm exec vitest run --project unit src/assets/brand.test.ts` | 38 passed |
| prettier and eslint on the changed files · `tsc -p .github/actions/tsconfig.json` · `pnpm check:ci` | clean · clean · policy passed |
| `pnpm tauri build --bundles nsis msi` · `check-bundles --core qul` · `size-budget` | built · the NSIS-script checks pass, the qdc core.db is refused (expected) · the size rows within budget |
| `app-driver --only metrics` ×2 (CDP :9463) · `idle-cpu.mjs` | as tabled: fails only on the app's known rows |

### What blocks a public release

1. The QUL data permission (§15.3 item 1): without it there is no qul core.db, and `release.yml` cannot run.
2. The quran org's written approval of the identity (LEAD 16).
3. Signing: a Windows Authenticode certificate, and an Apple Developer ID with notarisation, or a pre-release with the
   unsigned-install notes (WP13b.md).
4. The QF attribution wording and account (§15.3 item 2), the decorative-font answer (item 4), the repository URL and
   the Debian Maintainer e-mail.
5. The app's own misses above (three §8.18 rows; §13.6 cold start, memory, playback CPU at 1.0× and idle CPU), unless
   the lead waives them in WP13b.md.
6. Not verifiable here: the dmg, deb and AppImage (CI builds and checks them), `release.yml` end to end, and 7-Zip
   unpacking of the NSIS installer.

## Integration final gate (`CARGO_TARGET_DIR=C:\qdt\int-final-gate`)

Every gate ran on the tree after the release and documentation rounds, then again after the fixes below. Logs are in
`C:\qdt\int-final-gate-logs`, screenshots in `C:\qdt\int-final-gate-shots`, the scratch drivers in
`C:\qdt\int-final-gate-qa` (`release-smoke.mjs`, `exit-flush.mjs`). The first pass was green throughout; the release
smoke (below) found one defect, fixed at its root. No crate or npm package was added; `Cargo.lock` is unchanged.

### A page turn just before quitting was lost (LEAD 23; contract, additive)

The release smoke jumped to 2:255, quit within a second, and the relaunch opened pages 1–2. The reader writes its
position 1 s after a turn settles and flushes it on `pagehide`/`visibilitychange`, but WebView2 tears the page down
without either. Measured on the debug build (`exit-flush.mjs`: a turn to page 297, then an immediate exit): the title
bar's ×, a WM_CLOSE from outside (`taskkill /PID`, what the taskbar's Close sends) and `app_quit` all reopened on pages
1–2 with nothing stored. The same second was lost for the player's `audio` position (Resume after the tray's Quit),
the history dwell and a note draft's 400 ms autosave.

- **Rust** (`window.rs`): every user quit (× with nothing to keep in the tray, the tray's Quit, the close question's
  Quit, Alt+F4 or the taskbar's Close) goes through `window::quit`: the window hides at once (the page is told it is not
  seen), Rust emits the new `quit-requested` event, and a grace thread exits after 1.5 s (`QUIT_GRACE`) if the page
  never calls `app_quit`. `quit_path` exits at once before the first `window_ready` (`window::page_ready`, set by
  `window_ready`) and on a second request; the WebView2 failure dialog's Quit uses `exit_now` (the page is dead).
  `app_quit` is unchanged. Tests: the decision table, and on the mock runtime that `begin_quit` emits the event once the
  page is ready and exits on a second request.
- **Frontend**: `app.beforeQuit(hook)` registers work that must reach Rust before an exit; `app.quit()` awaits every hook
  (≤ `QUIT_FLUSH_MS`, 800 ms, logged when cut short), then calls `app_quit`; `markReady` subscribes to `quit-requested`
  before it sends `window_ready` (on the fatal screen too). Hooks: the reader writes its pending position and the dwell
  due, and waits for every position or history write still on its way (one that the window's hiding just flushed
  included); the player writes its pending `audio` position and waits for it; a note draft with a pending autosave
  writes it. New tests, each failing with its hook removed: the app store (hooks land before `app_quit`, a second
  request joins the first, nothing before `markReady`, the cap), the reader, the player and the note draft.
- **Mock**: closing the window emits `quit-requested`, as Rust does with nothing to keep in the tray (test).
- **QA harness**: `ctx.relaunch({ close: true })` quits as a user does (the window's close, then the page's own
  `app_quit`); app mode fails the scenario when the app is still running 10 s later, web mode waits for the mock's
  `app_quit`. **S35** now also turns to page 301 and closes inside the debounce: it reopens on 301 in both modes. Run
  against the pre-fix debug build (`C:\qdt\int-release`), the new check fails with "expected 301, got 297".
- After the fix, `exit-flush.mjs`: × reopens on 297 (exit 98 ms after the click), WM_CLOSE on 297 (273 ms). A raw
  `app_quit` invoke still exits at once by design: only `app.quit()` calls it, after the hooks.
- Docs: LEAD.md 23 (and the header now says items 1–23 are folded in), `contract-changes.md`, IMPLEMENTATION_NOTES §0
  (LEAD 22 and 23 rows), §8, §9, §14, §16, RELEASE_CHECKLIST (a row for every OS; Cmd+Q on macOS to be recorded),
  DEVELOPING §7.

### Also fixed

- **Tooling tests' temp-dir cleanup** (the 13 `after` hooks in `scripts/`, `.github/actions/`, `src-tauri/scripts/`,
  `tests/e2e/lib/` and `scripts/qa/lib/`): one `node --test` run failed with `EPERM` removing `qd-size-check-*`
  (Windows keeps a just-written 1 MiB file busy for a moment). `rmSync` now retries (`maxRetries: 10, retryDelay: 100`,
  Node's own retry for EBUSY/EPERM). No assertion changed; three consecutive runs pass.
- **The release installers** were rebuilt from the final tree (they predated the fix): `pnpm tauri build --bundles nsis
  msi` with an isolated `dist` (`../../../../../qdt/int-final-gate/dist-final` in a `--config` file) and
  `QD_ALLOW_DEV_CORE=1`, copied to `artifacts/release/` with a new `SHA256SUMS`; `PRIVATE-PREVIEW.txt` says so.

### Release build smoke

A release build of the final tree with a side-by-side identifier (`com.quran.labs.desktop.finalqa`, so the user's data
root was never touched; both of its directories were created fresh and removed afterwards), driven over CDP as a user
would (`release-smoke.mjs`: a release build has no `QD_TEST` hooks and no `QD_DATA_DIR`, D24). Its exe has the size of
the installers' (13,005,824 B). First boot: words on screen 1.0 s after spawn, page 1 in hafs, the onboarding, no
`__QD_TEST__`; Skip; Ctrl+End renders 604, Ctrl+Home 1; `settings_set` with theme sepia applies; the palette's "2:255"
renders page 42; the window is closed 189 ms later and the app exits with code 0. Relaunch: pages 41–42, sepia, no
onboarding; `app_quit` exits with code 0. No page error, console error or CSP violation; the log has no "panicked" and
no ERROR line. Before the fix, the same flow (quitting through `app_quit`) reopened on pages 1–2.

### Verification (final tree)

| Gate | Result |
|---|---|
| `cargo fmt --all -- --check` · `cargo clippy --workspace --all-targets -- -D warnings` | clean · clean |
| `cargo test --workspace --no-fail-fast` | 94 binaries, 1,346 passed (2 new), 0 failed, 20 ignored; no "panicked" |
| `pnpm bindings:check` · `cargo xtask verify-core` | up to date (`quit-requested` added) · 18/18 gates, 139 checks, 0 warnings |
| `pnpm check` · `pnpm lint` · `pnpm lint:css` · `pnpm format:check` | 0 errors (5,367 files) · clean · 201 files, 0 violations · clean |
| `pnpm test` · `pnpm test:browser` (Edge) | 80 files, 2,434 passed (6 new) · 39 files, 554 passed |
| `pnpm build && pnpm check:dist` · `pnpm check:tooling` | passed, 3.11 MiB · 75 ok, 0 failed (warning: `rg`, LEAD 6) |
| CI extras: `node --test` (scripts, actions, release-core, e2e lib, metrics, qa lib) · `tsc` (actions, e2e) · `pnpm check:ci` | 122 passed, 0 skipped (`xz` from Git Bash), three runs · clean · policy passed |
| `pnpm shots:web --serve 1983 --strict --jobs 4` | 39/39 passed; no page or console error |
| `pnpm tauri build --debug --no-bundle`, then `pnpm shots:app --strict` (renamed `quran-desktop-finalgate.exe`, CDP :9483) | 26/26 passed (IC2, smoke, S03–S13, S19, S24, S26–S35, S38); no "panicked"; every data dir removed |
| IC2 (`QD_AUDIO_SINK=wav:`, set by the scenario) | 1,391 ticks over 1:1–1:7, every ayah and its words in order; WAV 18.5 MB; page 1 in qcf_v2, min fit 0.93 |
| Release build smoke (above) | passed |
| Installers in `artifacts/release/` | NSIS `Quran_0.1.0_x64-setup.exe` 7,920,065 B (sha256 `7d0a767c…26e76431`), MSI 10,797,056 B (`72e4bcf1…84f22441`); `sha256sum -c SHA256SUMS` OK |
| `check-bundles --core qul --require nsis` · `size-budget --require nsis,installed,dist` | the NSIS-script checks pass (current-user install, WebView2 bootstrapper, 2 resources); it fails only on the qdc core.db (a private preview, expected) and the missing 7-Zip · NSIS 7.55 MiB, installed 24.40 MiB, dist 3.11 MiB, all within budget |

PNGs read: web S01 and S23; app smoke, IC2, S09, S26 and S35. The app runs used a renamed copy of the debug exe because
the user's "Quran Preview" (`quran-desktop.exe`) was running.

### Remaining

- **For a person:** an empty (0-byte), untracked `window.rs` at the repository root (created 2026-10-10 18:42, apparently
  by a stray shell redirect; nothing reads it) should be deleted. This gate deletes no file it did not create.
- **macOS Cmd+Q** is expected to end the app without `quit-requested` (the default app menu's Quit terminates
  directly), so a turn in its last second would not be kept; not verifiable here (RELEASE_CHECKLIST row, LEAD 23).
- Unchanged since the release round: the §8.18 rows and the §13.6 runtime rows (cold start, memory, playback and idle
  CPU) listed there, and everything under "What blocks a public release".
