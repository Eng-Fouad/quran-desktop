# WP6a deviations (app state, setup, protocol, app commands; IC1)

Owned and written: `src-tauri/src/{state, setup, protocol}.rs` and `src-tauri/src/commands/{app, system}.rs`. No other file
was touched, no dependency was added, and `bindings.ts` is unchanged (`pnpm bindings:check` passes).

## Font-transport spike (D30, §6.1): result

| Platform | Webview | `AppInfo.fontTransport` | Evidence |
|---|---|---|---|
| Windows | WebView2 154.0.4258.62 | **`url`** | Runtime check in the real debug app; details in "Windows" below. |
| Linux | WebKitGTK **2.52.6** (Ubuntu 24.04) | **`url`** | Runtime check with wry's exact scheme setup; details in "Linux" below. |
| macOS | WKWebView | **`bytes`** (pending) | Not runnable here: there is no Mac. See "macOS" below. |

The choice is `setup::platform_font_transport(Platform)`. Debug builds can override it with
**`QD_FONT_TRANSPORT=url|bytes`**, a new D24-style variable that is compiled out of release builds. Any other value is
ignored and a warning is logged.

**Windows.** The check ran in the real debug app (`--exe C:\qdt\WP6a\debug\quran-desktop.exe`). Real dev-pack files
were copied into the app's `packs/` directory:

- `FontFace(url(http://quran.localhost/mushaf/v2/p1.woff2?v=…))` loads with status `loaded`. So does
  `decor/quran-common.ttf`, and `document.fonts.check` is true afterwards.
- `fetch` behaves as specified:
  - a full GET returns `200`, 40,956 B, `font/woff2`, `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges`;
  - `Range: bytes=100-199` returns `206` with `Content-Range: bytes 100-199/40956`;
  - `bytes=999999-` returns `416`;
  - `..%2F..%2Fuser.db` returns `403`;
  - unrouted or missing files return `404`;
  - `POST` returns `405`.
- The bytes path also works on Windows:
  - `invoke('font_bytes', { rel })` returns an `ArrayBuffer` of the exact file size (40 KB in about 2 ms);
  - `new FontFace(name, buffer)` loads;
  - an audio route or `../user.db` gives `invalid argument: …`, and a missing page gives `not found: …`.
- A percent-encoded dot segment (`mushaf/%2e%2e/%2e%2e/user.db`) never reaches the handler as such. The WHATWG URL
  parser resolves it before the request is sent, so it arrives as `/user.db` and gets `404`. An encoded slash is not
  resolved and does reach the handler, which answers `403`.

**Linux.** The check ran on WebKitGTK 2.52.6, the Ubuntu 24.04 package, under Xvfb. It used a locally present
`ubuntu:24.04`-based image (`docker run --pull=never --network none`): nothing was downloaded or installed.

- The probe is a small C program (built in WSL, every symbol resolved with `dlsym`). It reproduces what wry 0.57 does on
  Linux:
  - the page is served from the custom scheme `tauri://localhost/` (Tauri's production origin on Linux);
  - `quran` and `ipc` are registered with `webkit_web_context_register_uri_scheme`, then **only**
    `register_uri_scheme_as_secure`, never as CORS-enabled;
  - answers are `WebKitURISchemeResponse` objects with status, content type and `SoupMessageHeaders`.
- Results:
  - `urlFontFace: loaded` and `urlFetch: 200 40956`;
  - `ipcFetch: 200 40956` for a POST with Tauri's custom IPC headers, then `bytesFontFace: loaded`;
  - a **control font served without `Access-Control-Allow-Origin` also loads**: WebKitGTK applies no CORS check to
    scheme-handler loads at all.
- The concern in §6.1 (secure-only registration) therefore does not block `url`.
- Not checked: 2.50.x (Ubuntu 22.04 / Debian 12), which is not available on this machine. Debug builds can confirm it
  there with the env override.

**macOS.** WKWebView uses the same WebKit scheme-handler machinery, and Tauri's own macOS IPC relies on the same kind of
cross-origin custom-scheme fetch (`tauri://` to `ipc://`), so `url` very likely works. It is not verified at runtime,
though, so macOS ships the transport that needs no cross-origin font load at all.

To decide, run on a Mac:

```
QD_FONT_TRANSPORT=url pnpm tauri dev
```

Then check that QCF pages render without the hafs fallback (or run `new FontFace('t',
'url(quran://localhost/decor/quran-common.ttf)').load()` in the devtools console). If it works, change the `Platform::Macos`
arm to `Url`.

## Deviations from ARCHITECTURE.md

1. **Acceptance command syntax (§14.3).** `cargo test -p quran-desktop --lib protocol setup state commands::app
   commands::system` is rejected by cargo 1.99, which accepts only one TESTNAME (WP1a and WP2b report the same). It
   was run as `cargo test -p quran-desktop --lib -- protocol setup state commands::app commands::system`.
2. **Startup is split into testable parts** (`setup.rs`, additive public API). `build_state(app, policy)` keeps its
   signature and composes the parts below:
   - `StartupEnv::resolve(app)`: the paths plus the D24 overrides, `os_locale` and the font transport;
   - `build_state_with(app, policy, env, started_at) -> (AppState, Settings)`;
   - `open_stores(paths, policy) -> Stores`: steps 1–3. It starts no thread and touches no device, so the spec's
     corrupt/0-byte core.db and corrupt user.db tests run without the audio service.

   Also public: `platform_font_transport`, `AudioUiSink`, `tray_now_playing` and `is_playing`.
3. **First-launch UI language (D22).** When user.db did not exist, or was just quarantined and recreated, the OS locale
   decides `ui_language`: a primary subtag of `ar` gives Arabic. The guess is **stored** before step 5, so the tray, the
   media session and the first paint agree. Later launches never re-guess.
4. **`AppState` additions** (`state.rs`):
   - `started_at: Instant`: `window_ready` logs the time to first paint, measured at 260–320 ms in the debug build;
   - `chrome: Mutex<Option<ChromeAppearance>>`: the last applied appearance;
   - a private shut-down flag;
   - `AppState::new(..)`;
   - `AppState::shutdown()`: idempotent and blocking. It stops the audio engine, hides the OS media session (state
     `STOPPED`) and runs `PRAGMA wal_checkpoint(TRUNCATE)` on user.db, so a copy of `user.db` taken after quitting is
     self-contained. Also `is_shut_down()`;
   - `AppPaths::backups()`.
5. **`app_bootstrap`** takes `app: AppHandle` and does all of its work in one blocking task. It measured 3.7–4 ms in
   the debug app (budget: 40 ms).
   - Required parts, whose errors reach the frontend's fatal screen: the core index, settings, `first_run`, positions
     and reading bookmark.
   - `PackManager::summaries()` errors degrade to `packs: []`. A not-implemented stub is logged at debug level,
     anything else at warn, so a broken pack registry never keeps the reader from starting.
   - Startup notices are returned on every bootstrap, including after a webview reload.
6. **`window_set_chrome`** (§9.6) maps the appearance to the native backdrop per platform:
   - `off` clears the effect everywhere;
   - Windows 11 (build ≥ 22000) gets `MicaDark`/`MicaLight` from `dark`. These set the backdrop's own dark mode,
     independently of the OS theme;
   - Windows 10 answers `Unsupported` (there is no Mica);
   - macOS gets the `Sidebar` material with `FollowsWindowActiveState`;
   - Linux answers `Unsupported` for `auto`.

   A repeat of the last applied appearance does nothing. `set_theme` is deliberately **never** called. It would change
   the webview's `prefers-color-scheme` (WebView2 `PreferredColorScheme`, NSAppearance on macOS), the frontend would
   then resolve `system` from our own override, and the app could never return to the OS theme.
7. **`app_quit`** runs `AppState::shutdown()` on the blocking pool, then calls `app.exit(0)`.
8. **`system_open_external`** accepts:
   - `https:` with a host and **without embedded credentials**, so `https://quran.com@evil.example/` is refused;
   - `mailto:`;
   - at most 2048 bytes.

   The OS receives the parsed, percent-encoded form. `system_reveal_data_dir` opens the data folder **itself**, creating
   it if needed, rather than its parent with the folder selected. Both use the opener's free functions on the blocking
   pool, and neither takes the `app` parameter.
9. **Protocol details beyond §6.3:**
   - invalid UTF-8 after percent-decoding answers `400`;
   - before `AppState` is managed (the fatal path, where the window is hidden) file requests answer `503`;
   - `405` carries `Allow: GET, HEAD, OPTIONS`;
   - the preflight adds `Access-Control-Max-Age: 86400`;
   - `HEAD` returns GET's headers (including `Content-Length`) without a body;
   - a directory at a route path is `404` (Windows answers "access denied" when a directory is opened as a file);
   - the path rules also reject empty, `.` and `..` segments **as written**. `Path::components` silently drops interior
     `.` and empty segments, so it is not enough on its own;
   - `Range`: `-0` and any range on an empty file answer `416`. A header that is not a valid byte range is ignored and
     answered `200` (RFC 9110 §14.2), as are `b < a`, overflowing numbers and other units. Whitespace and the unit's
     case are tolerated;
   - routes are matched by a small exact parser rather than `regex`. The semantics are the §6.2 regexes, case-sensitive
     and without leading zeros. Paths are rebuilt from the validated parts, never from the request. The `regex`
     dependency is therefore unused by the protocol.
10. **`font_bytes`** behaves as follows:
    - `rel` must be a font route under the same path rules: no leading `/`, not percent-decoded;
    - files over 16 MiB are refused (`MAX_FONT_BYTES`, `Integrity`);
    - errors are `AppError` display strings (`"not found: pack font mushaf/v2/p2.woff2"`, `"invalid argument: …"`),
      because the command's error type is `String`.
11. **LEAD item 3 (AudioService UI sink).** `setup::AudioUiSink` is ready. On every edge it calls
    `media::now_playing`, then `media::on_audio_state`, then `tray::set_now_playing` with the localised "Now: {ref}"
    label and a playing flag (playing, loading or buffering). It never touches user.db from the audio thread: the UI
    language is cached in an atomic and kept current by a Rust listener on `settings-changed`. WP4d's
    `AudioService::set_ui_sink` does not exist yet, so the registration is a marked comment in `setup::after_manage`
    (see Requests).
12. **Tests** (33 WP6a tests; the acceptance filters select 35 because `state` also matches two of WP6c's media tests):
    - every spec'd setup case;
    - a full `AppState` on `tauri::test::mock_app()` for both policies, plus `app_bootstrap` on the real core.db, which
      is skipped with a note when only the placeholder exists;
    - protocol routes, path rules, Range and status cases against a temp packs root;
    - chrome mapping, URL validation and shutdown idempotency.

    Tests that start the audio service first set `QD_AUDIO_SINK=null` for the test process (`std::env::set_var` once,
    behind `Once`), so a future real engine can never reach the speakers (LEAD item 9).
13. **Long-path-safe data directory (§2.8.2 step 1, Windows).** Found in the real app: with a `QD_DATA_DIR` whose
    `user.db` path was 272 characters, startup took the fatal path with `user.db cannot be opened: sqlite: unable to
    open database file`. Rust's std reaches paths longer than `MAX_PATH` (260) on its own (it adds `\\?\` internally),
    but SQLite's Win32 VFS does not, so a perfectly healthy deep data directory made the app unusable.
    - `resolve_paths` now passes the data directory through `long_path_safe` after `dunce::simplified`. On Windows it is
      made absolute (`std::path::absolute`, which normalises `/` and `..`). When fewer than 160 characters
      (`DATA_TREE_RESERVE`) would remain below it within `MAX_PATH`, it is rewritten into its verbatim form:
      `C:\…` → `\\?\C:\…`, `\\server\share\…` → `\\?\UNC\server\share\…`. 160 characters fit the deepest database the
      app opens, `packs\translation\{pack id}\{version dir ≤ 64 B}~{n}\pack.db-journal`.
    - Every path below is built component by component (`Path::join`: the protocol's `Route::file`, quran-packs'
      `install::resolve`), so it inherits the prefix safely. core.db is untouched: quran-core opens it through a
      `file:` URI, and it lives in the install directory or the repo.
    - The default `%LOCALAPPDATA%\com.qurandesktop.app` is far below the threshold, so nothing changes for it. macOS and
      Linux are unaffected. JS still gets plain paths where they exist (`util::to_js_path` is dunce-simplified), and
      `system_reveal_data_dir` hands the file manager the simplified form.
    - Tests (Windows): the conversion cases (default location unchanged, deep disk and UNC paths, verbatim kept, a short
      verbatim `QD_DATA_DIR` plain again, relative made absolute). A corrupt user.db in a data directory 300+ characters
      deep is quarantined with its notice and replaced by a working one. A SQLite database at full pack depth opens.

## IC1 (§12.6)

- `pnpm tauri build --debug --no-bundle` succeeds.
- `node scripts/qa/app-driver.mjs --scenario tests/e2e/scenarios/smoke.mjs --exe C:\qdt\WP6a\debug\quran-desktop.exe`
  **fails before its first step**: `window.__QD_TEST__ is not installed`, because nothing calls `installQdTest()` yet
  (WP7c, `App.svelte`). Its failure screenshot shows the real app rendering pages 1–2 in hafs from the real core.db.
- The IC1 substance was verified with the same driver and raw IPC instead of the hook:
  1. The real app boots on the qdc core.db (bootstrap: source `qdc`, schema 1, 114 surahs, first run).
  2. `mushaf_get_pages(hafs, [1])` returns 8 lines, and page 1 is in the DOM (`section.mp[data-page="1"]`,
     `data-style="hafs"`, 36 words).
  3. `settings_set` (theme `sepia`, UI scale 110 %) is stored, echoed by `settings_get` and applied by the UI
     (`html[data-theme=sepia]`).
  4. After `app_quit` and a relaunch on the same `QD_DATA_DIR`, bootstrap returns `sepia`/110 % with no notices, and
     page 1 renders again in sepia at 110 % zoom.
  5. `settings_reset` round-trips.
- Also verified in the real app:
  - the debug degrade path: `QD_CORE_DB` pointing at a 0-byte file gives the FatalScreen "core.db missing — run pnpm
    core:qdc", the window is shown and there is no panic;
  - a corrupt `user.db` (prepared `--data-dir`) is quarantined as `user.db.corrupt-<ms>`, `app_bootstrap` returns
    `user_db_recovered` with that path, and the reader boots on a fresh DB;
  - the media session starts (SMTC);
  - `window_set_chrome` applies dark, light and off Mica, and skips repeated values.
- Re-run on 2026-10-10 against the current tree (a fresh `pnpm tauri build --debug --no-bundle`):
  - smoke.mjs still stops at its first step, for the same reason: no `installQdTest()` call in `src/` (WP7c).
  - The real app's log for that run reads: test mode on, fonts by `url`, setup ready in 45 ms, `app_bootstrap` in 4 ms,
    first paint 174 ms after start, then `app_quit` → shutdown in 3 ms → exit.
  - The raw-IPC IC1, protocol and degrade scenarios passed again.
  - The recovery scenario on a plain (non-`\\?\`) data directory whose `user.db` path is 272 characters exposed
    deviation 13 (fatal startup, "unable to open database file").
  - With the fix, the same scenario passes in the real app:
    - the corrupt file becomes `user.db.corrupt-<ms>`, next to a fresh `user.db` and `content.db` (WAL files included);
    - `app_bootstrap` returns `user_db_recovered`;
    - page 1 renders.
  - The unit test for that case fails with `CannotOpen` when the fix is removed from it, so it guards the regression.

## Requests

- **WP7c:**
  - call `installQdTest()` when `bootstrap.app.testMode`. IC1's `smoke.mjs` cannot run without it.
  - In `settings.applyEffects()`, when `window_set_chrome` fails with kind `unsupported` (Windows 10, Linux), drop
    `html[data-chrome="vibrant"]` for the session. Otherwise the translucent chrome sits over a backdrop that does not
    exist.
- **WP4d:** expose `AudioService::set_ui_sink(..)` (LEAD item 3) and add the registration at the marked line in
  `setup::after_manage`. Adapt your event type to the snapshot `AudioUiSink::on_edge` takes:
  `state.audio.set_ui_sink(AudioUiSink::new(app, settings.ui_language).into_sink())`. WP6a hands over exactly that line.
  The lead may also add it.
- **WP6b:** call `state.shutdown()` from `RunEvent::Exit` (`app.try_state::<AppState>()`), so that tray Quit and the
  window close button get the same orderly shutdown as `app_quit`. The call is idempotent.
- **WP0C / lead (frozen `src/lib/ipc/index.ts`):** `fontBytes` should accept a plain `number[]` and turn it into an
  `ArrayBuffer`. If the custom-protocol IPC is blocked, Tauri falls back to postMessage and serialises raw responses as a
  JSON array (tauri-2.12.2 `ipc/protocol.rs`, always on macOS in that path), and `new FontFace(name, number[])` would
  fail.
- **WP8b:** as a safeguard for `url` on platforms checked only by probe, retry once through `fontBytes(rel)` when a
  `Ready` font fails to load by URL, and stay on bytes for the rest of the session.
- **Lead:** fold in the spike result (D30, §6.1, R6) and `QD_FONT_TRANSPORT` (D24, `docs/DEVELOPING.md`), and run the
  macOS check above at the first Mac smoke (§12.6 checklist). `regex` in `src-tauri/Cargo.toml` is no longer used by the
  protocol (see deviation 9).
