# tauri-platform

## Tauri 2 platform research for Quran Desktop (verified 2026-10-10)

**Bottom line:** use **Tauri 2.12.x stable**. Tauri **3.0.0-alpha** now exists and adds a CEF runtime (`tauri-runtime-cef`). Do not use `@next` or `3.0.0-alpha` anywhere.

I built a probe app on this machine against tauri 2.12.2 (Windows 11, rustc 1.99.0, WebView2 = Edg/154):
- `cargo build` (debug and release) succeeded with **0 warnings**.
- It used tauri-specta typed commands and events, `ipc::Channel`, an async `quran://` custom protocol with HTTP Range, a tray icon, single-instance, window-state, window-vibrancy, `BaseDirectory::Resource`, and a capabilities file. The capability permission names were checked at build time.
- I ran the app hidden and tested both protocols from inside WebView2: fetch with Range, `<audio>` seeking, `FontFace`, MIME headers, scope and path-traversal denial.
- The official CLI (`tauri build --bundles nsis`) produced the installer.

Sources are in `probe/` under the research folder.

---
### 1. Versions (crates.io and npm, read live)
| Rust crate | stable | npm package | latest |
|---|---|---|---|
| tauri | **2.12.2** (2026-10-09, MSRV 1.90) | @tauri-apps/api | **2.12.2** |
| tauri-build | **2.7.1** | @tauri-apps/cli | **2.12.1** (2026-09-30) |
| tauri-plugin-opener | 2.7.0 | @tauri-apps/plugin-opener | 2.7.0 |
| tauri-plugin-dialog | 2.8.1 | plugin-dialog | 2.8.1 |
| tauri-plugin-fs | 2.6.0 | plugin-fs | 2.6.0 |
| tauri-plugin-store | 2.5.0 | plugin-store | 2.5.0 |
| tauri-plugin-window-state | 2.5.0 | plugin-window-state | 2.5.0 |
| tauri-plugin-single-instance | 2.5.2 | *(no JS package; npm 404)* | – |
| tauri-plugin-global-shortcut | 2.4.0 | plugin-global-shortcut | 2.4.0 |
| tauri-plugin-log | 2.10.0 | plugin-log | 2.10.0 |
| tauri-plugin-os | 2.4.0 | plugin-os | 2.4.0 |
| tauri-plugin-process | 2.4.0 | plugin-process | 2.4.0 |
| tauri-plugin-updater | 2.13.2 | plugin-updater | 2.13.2 |
| tauri-plugin-http | 2.8.1 | plugin-http | 2.8.1 |
| tauri-plugin-notification | 2.5.1 | plugin-notification | 2.5.1 |
| tauri-plugin-clipboard-manager | 2.4.1 | plugin-clipboard-manager | 2.4.1 |
| tauri-plugin-deep-link | 2.6.1 | plugin-deep-link | 2.6.1 |
| (extra) tauri-plugin-sql / autostart / upload | 2.5.0 / 2.7.0 / 2.5.0 | same | same |

**Other crates:**
- window-vibrancy 0.8.1, wry 0.57.0, tao 0.37.1, tauri-utils 2.10.1, tauri-runtime-wry 2.12.1
- specta =2.0.0-rc.25, tauri-specta =2.0.0-rc.25, specta-typescript 0.0.12
- taurpc 0.8.2 (npm `taurpc` 2.0.0), ts-rs 12.0.1, rusqlite 0.40.2, souvlaki 0.8.3 (last release 2025-06-24)
- tauri-driver 2.1.0

**Frontend packages:**
- svelte 5.57.2, vite 8.3.4, @sveltejs/vite-plugin-svelte 7.3.1, @tsconfig/svelte 5.0.8
- svelte-check 4.7.6. Its typescript peer range is `^5 || ^6`.
- typescript `latest` is now **7.0.2**, so **pin `typescript@~6.0.3`**. Both the create-vite and create-tauri-app templates pin TypeScript 6.0.x.
- vitest 5.0.3, jsdom 30.1.2, @wdio/tauri-service 1.5.0, create-tauri-app 4.7.5, create-vite 9.2.1, pnpm latest 12.10.1 (11.9.0 installed locally)

**Version pairing (taken from the CLI source, `crates/tauri-cli/src/info/plugins.rs`):**
- `tauri build` **fails** if the `tauri` crate and `@tauri-apps/api` differ in major.minor.
- The same check applies to each `tauri-plugin-X` and `@tauri-apps/plugin-X` pair.
- The bypass is `--ignore-version-mismatches`.
- The CLI's own patch version is not checked (CLI 2.12.1 with tauri 2.12.2 built fine).
- The cli-template Cargo manifest uses `edition = "2024"` and `rust-version = "1.90"`.

### 2. Typed IPC: recommend tauri-specta, pinned exactly
- tauri-specta is still an RC. Its crate docs say "still in beta" and to pin with `=`.
- Last release: rc.25 on 2026-05-08. The repo was last pushed 2026-07-26 and has 32 open issues.
- It depends on `tauri = "2"` with `features=["specta"]`. Tauri itself provides `specta::Type` for `ipc::Channel`.
- This setup compiled with tauri 2.12.2:
```toml
specta = { version = "=2.0.0-rc.25", features = ["derive"] }
specta-typescript = "=0.0.12"
tauri-specta = { version = "=2.0.0-rc.25", features = ["derive", "typescript"] }
```
```rust
#[derive(Serialize, Deserialize, specta::Type, Clone)] #[serde(rename_all="camelCase")]
pub struct AyahKey { pub surah: u16, pub ayah: u16 }
#[derive(Serialize, specta::Type, Clone)]
#[serde(rename_all="camelCase", rename_all_fields="camelCase", tag="event", content="data")]
pub enum DownloadEvent { Started{pack_id:String,total_bytes:u32}, Progress{pack_id:String,received_bytes:u32}, Finished{pack_id:String} }
#[derive(Serialize, Deserialize, Debug, Clone, specta::Type, tauri_specta::Event)]
pub struct PlaybackTick { pub key: AyahKey, pub position_ms: u32 }
#[tauri::command] #[specta::specta]
fn get_ayah(key: AyahKey) -> Result<Ayah, String> { … }
#[tauri::command] #[specta::specta]
async fn download_pack(pack_id: String, on_event: tauri::ipc::Channel<DownloadEvent>) -> Result<(), String> { … }
let specta = tauri_specta::Builder::<tauri::Wry>::new()
  .commands(tauri_specta::collect_commands![get_ayah, download_pack])
  .events(tauri_specta::collect_events![PlaybackTick]);
#[cfg(debug_assertions)]
specta.export(specta_typescript::Typescript::default(), "../src/lib/bindings.ts").unwrap();
tauri::Builder::default().invoke_handler(specta.invoke_handler())
  .setup(move |app| { specta.mount_events(app); PlaybackTick{..}.emit(app)?; Ok(()) })
```
- **Generated TS** (saved as `probe/src/lib/bindings.ts`):
  - `commands.getAyah(key)` returns `Promise<{status:"ok",data}|{status:"error",error}>`.
  - `commands.downloadPack(packId, onEvent: Channel<DownloadEvent>)`.
  - `events.playbackTick.listen(cb)`.
  - `rename_all_fields` is honored.
- **Caveats** (from the specta-typescript 0.0.12 source):
  - Export **errors on `usize/isize/i64/u64/i128/u128`** (to avoid BigInt precision loss), so use `u32`/`i32` in DTOs. SQLite rowids are `i64`; convert them.
  - `f32/f64` become `number | null`.
  - `tauri::ipc::Response` (raw ArrayBuffer return) has no specta Type, so serve binary data through the custom protocol or a `Channel<InvokeResponseBody>`.
- **Alternatives:**
  - taurpc 0.8.2: trait-based. It uses the same specta rc.25 plus `tauri 2.10.2` and tokio, so it has the same RC risk.
  - ts-rs 12.0.1: types only. You hand-write the `invoke` wrappers.
- **Fallback if tauri-specta breaks on a future tauri:** ts-rs types plus a thin hand-written `commands.ts`.

### 3. Streaming and serving local binaries
**`ipc::Channel`** (source: `crates/tauri/src/ipc/channel.rs` @2.12.2):
- Messages arrive in order (index-buffered on the JS side).
- JSON under 8192 B is delivered via `eval`; larger payloads go through an IPC fetch. Raw payloads under 1024 B use `eval`.
- `Channel<InvokeResponseBody>` sending `InvokeResponseBody::Raw(bytes)` arrives in JS as an **ArrayBuffer**.
- `Channel<Vec<u8>>` or `Channel<&[u8]>` is **serialized as a JSON number array**. The docs example `Channel<&[u8]>` is the slow path.
- Clones share the same callback. Dropping the last clone unregisters the JS side.
- JS side: `import { Channel } from '@tauri-apps/api/core'; const ch = new Channel<T>(); ch.onmessage = …`.

**Events** (`tauri::Emitter`):
- `app.emit(name, payload)` (global), `emit_to(label, …)`, `emit_filter(…, |EventTarget| …)`.
- Payloads are JSON only. The docs say events are not for high throughput; use Channel for progress and audio ticks.

**Serving files: custom protocol vs asset protocol** (both tested at runtime on Windows/WebView2):
| | `register_asynchronous_uri_scheme_protocol("quran", …)` | asset protocol (`convertFileSrc`) |
|---|---|---|
| Cargo feature | none | `tauri` feature **`protocol-asset`** + `app.security.assetProtocol {enable:true, scope:[…]}` |
| URL on Windows | `http://quran.localhost/<path>` (`https://` if `useHttpsScheme`) | `http://asset.localhost/<encodeURIComponent(absPath)>` |
| URL on macOS/Linux | `quran://localhost/<path>` | `asset://localhost/<enc path>` |
| Range / 206 | whatever you implement. My handler returned 206 `bytes 100-199/2097152` | built in: 206 + `Content-Range`, each range capped at **1000 KiB** (`MAX_LEN`), multipart ranges supported |
| `<audio>` seek | works (seek to 50 s of a 60 s WAV; readyState 4) | works (same result) |
| MIME | yours, e.g. `font/woff2` (observed) | detected by the `infer` 0.22 crate (magic bytes): woff/woff2 give **`application/font-woff`**, ttf gives `application/font-sfnt`, wav gives `audio/x-wav`. An unrecognized `.woff2` (e.g. CFF-flavored) falls back to **`text/html`** |
| Font loading (FontFace) | loaded (needs `Access-Control-Allow-Origin`; I sent `*`) | loaded (sends ACAO = window origin) |
| Scope or security | your own path checks (`..%2F..` returned 403 in my handler) | out-of-scope path returned 403, plus a log line |

App page origin on Windows is `http://tauri.localhost`.

**Recommendation:**
- Use the custom `quran://` protocol for downloaded packs (fonts, audio, images): exact MIME, immutable caching, a single root under `app_data_dir()/packs`.
- Keep the asset protocol off unless needed.
- To get URLs, use `convertFileSrc(relPath, 'quran')`, or build them per platform as `isWindows ? http://quran.localhost/… : quran://localhost/…`.
- Tauri 2.12 also adds a Rust-side `WebviewWindow::convert_file_src`.

The verified handler is in `probe/src-tauri/src/lib.rs`. Its key parts:
- `spawn_blocking` file IO
- single-range parse
- 1 MiB cap per 206 response
- `Accept-Ranges: bytes`
- `Access-Control-Allow-Origin: *`
- `Access-Control-Expose-Headers: content-range, content-length`
- `Cache-Control: immutable`
- `Path` components restricted to `Normal`

### 4. Capabilities and CSP
**Capabilities:**
- Files live in `src-tauri/capabilities/*.json|toml` and are **all auto-enabled** unless `app.security.capabilities` lists identifiers.
- Schema: `"$schema": "../gen/schemas/desktop-schema.json"`.
- Permission identifiers are validated at build time. All of these compiled: `core:default`, `core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `core:window:allow-close`, `core:window:allow-start-dragging`, `core:window:allow-set-effects`, `opener:default`, `log:default`, `window-state:default`.
- Use `"platforms": ["linux","macOS","windows"]` for desktop-only permissions.
- App commands are allowed for all windows unless you use `tauri_build::AppManifest::commands`.
- With `build.removeUnusedCommands: true`, the CLI stripped about 100 unused core and plugin commands. This shrank the exe by 10%.

**CSP** (object form; worked at runtime):
```json
"csp": {
 "default-src": "'self' ipc: http://ipc.localhost",
 "connect-src": "'self' ipc: http://ipc.localhost quran: http://quran.localhost asset: http://asset.localhost",
 "img-src": "'self' data: blob: asset: http://asset.localhost quran: http://quran.localhost",
 "font-src": "'self' data: blob: quran: http://quran.localhost asset: http://asset.localhost",
 "media-src": "'self' blob: quran: http://quran.localhost asset: http://asset.localhost",
 "style-src": "'self' 'unsafe-inline'"}
```
- Leaving `asset:` out of **connect-src** made `fetch()` fail ("Failed to fetch") while `<audio>` and `FontFace` still worked.
- List both scheme forms (`quran:` for macOS/Linux and `http://quran.localhost` for Windows).

### 5. Window polish
These `WindowConfig` fields were checked against `tauri-utils` config.rs @2.12.2:
- `decorations`, `transparent`, `shadow`
- `windowEffects {effects[], state, radius, color, interactive}`
- `titleBarStyle` (`visible|transparent|overlay`), `hiddenTitle`, `trafficLightPosition {x,y}`
- `noRedirectionBitmap` (new in 2.12; avoids the white flash on transparent Windows windows)
- `backgroundColor`, `backgroundThrottling` (**macOS 14+/iOS 17+ only; not supported on Windows or Linux**)
- `scrollBarStyle: "fluentOverlay"` (Windows, WebView2 125.0.2535.41 or newer)
- `useHttpsScheme` (changing it later **loses localStorage/IndexedDB**)

**Effect names** (camelCase): `mica|micaDark|micaLight|tabbed|tabbedDark|tabbedLight|acrylic|blur` (Windows) and `sidebar|underWindowBackground|hudWindow|windowBackground|…|liquidGlassRegular|liquidGlassClear` (macOS 26+; `interactive` needs 27+).
- Effects need `transparent: true`. Linux is not supported.
- Acrylic and blur have resize/drag performance problems on some Windows builds.
- At runtime: `window.set_effects(EffectsBuilder::new().effect(Effect::Mica).build())`.
- tauri 2.12.1 removed the need for `macos-private-api` / `macOSPrivateApi` to use transparency.
- Tauri already depends on window-vibrancy 0.8.1 internally. The crate is only needed for direct calls such as `window_vibrancy::apply_mica(&win, None)` (compiled) or `apply_liquid_glass`.

**Custom title bar:**
- Set `decorations:false` and put `data-tauri-drag-region` on the drag element. It applies only to that element, not its children.
- Buttons: `getCurrentWindow().minimize() / toggleMaximize() / close()`.
- Grant the `core:window:allow-start-dragging` / `minimize` / `toggle-maximize` / `close` permissions.
- On Windows, the CSS `app-region: drag` tip is useful for touch and pen input.

**macOS:**
- Prefer `titleBarStyle:"overlay"` + `hiddenTitle:true` + `trafficLightPosition` with decorations left on.
- Known issue: an overlay window can't be dragged while unfocused (tauri#4316).
- Use per-OS files `tauri.{windows,macos,linux}.conf.json` (JSON Merge Patch). **Arrays are replaced whole**, so repeat the full `app.windows` entry.

**Tray** (`tauri` feature `tray-icon`):
- `TrayIconBuilder::with_id("main-tray").icon(app.default_window_icon().cloned()?).tooltip(..).menu(&menu).show_menu_on_left_click(false).on_menu_event(|app,e| …).on_tray_icon_event(|tray, TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}| …).build(app)?` (compiled).
- `menu_on_left_click` is deprecated.
- On Linux, tray mouse events are **not emitted** (menu only). The Debian package depends on `libappindicator3-1`.

**macOS app menu:**
- `Builder::enable_macos_default_menu` defaults to true. Use `Builder::menu(|app| …)` or `app.set_menu(...)`.
- The first submenu becomes the app menu, and top-level items are ignored on macOS.

**Single-instance:**
- Register it **first**: `tauri_plugin_single_instance::init(|app, args, cwd| …)`.
- Linux uses the DBus name `org.{identifier with . and - replaced by _}.SingleInstance` (needs Snap/Flatpak manifest entries).
- It has no JS API, so no permission is needed.

**Window-state:**
- `tauri_plugin_window_state::Builder::default().build()` with window `visible:false` to avoid a flash.
- The file was observed at `%APPDATA%\<identifier>\.window-state.json`.
- WebView2 data was observed at `%LOCALAPPDATA%\<identifier>\EBWebView`, logs at `%LOCALAPPDATA%\<identifier>\logs`.

### 6. Size, bundling and resources
Release profile (from the docs; used in the probe):
```toml
[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
panic = "abort"
strip = true
```
Plus `"build": {"removeUnusedCommands": true}`, which needs `tauri-build ≥2.1` and `tauri-cli ≥2.4`.

**Measured on Windows x64 with all probe features:**
- `cargo build --release`: exe **3,800,064 B**
- `tauri build` with removeUnusedCommands: exe **3,413,504 B**
- NSIS installer (NSIS 3.11 auto-downloaded to `%LOCALAPPDATA%\tauri\NSIS`, default WebView2 `downloadBootstrapper`): **1,302,600 B (1.24 MiB)**

**WebView2 install modes (docs):** downloadBootstrapper 0 MB (default), embedBootstrapper ~1.8 MB, offlineInstaller ~127 MB, fixedVersion ~180 MB, skip.

**Linux (docs):**
- AppImage is 2–6 MB, but grows past 70 MB with `bundle.linux.appimage.bundleMediaFramework`, which is **required for audio/video playback in the webview** (GStreamer).
- Build on Ubuntu 22.04 or Debian 12 because of glibc and the webkit2gtk-4.1 requirement.

dmg/deb sizes were not measured (no macOS or Linux host).

**Resources:**
- `"bundle": {"resources": {"resources/core.db": "data/core.db"}}`.
- Map form gives exact placement. In map form, globs flatten the directory structure.
- Resolve at runtime with `app.path().resolve("data/core.db", BaseDirectory::Resource)?`. In JS: `resolveResource()`.
- Observed on Windows: the path comes back with a **`\\?\` verbatim prefix** (`\\?\C:\…\target\release\data\core.db`).
- Treat `$RESOURCE` as read-only. Decompress or copy the core DB to `app_data_dir()` on first run.

### 7. Testing
**`@tauri-apps/api/mocks`** (2.12.2):
- `mockIPC((cmd, args) => …, { shouldMockEvents: true })` (event mocking since 2.7; `emitTo` is not supported)
- `mockWindows('main', …others)`
- `mockConvertFileSrc('windows'|osName)`
- `clearMocks()`

**Running the UI in a plain browser:**
- `import { isTauri } from '@tauri-apps/api/core'; if (!isTauri()) await import('./dev/mock-backend')`.
- For jsdom tests, polyfill `window.crypto.getRandomValues`.

**E2E:**
- The docs now recommend **WebdriverIO `@wdio/tauri-service` 1.5.0**. Its embedded driver (`tauri-plugin-wdio-webdriver` 1.5.0, plus optional `tauri-plugin-wdio` 1.5.0 for IPC mocks and logs) works on **Windows, macOS and Linux**.
- `tauri-driver` 2.1.0 works **only on Windows and Linux** (Edge WebDriver on Windows). macOS has no WKWebView driver.
- WDIO also has a "browser mode" for fast renderer-only tests.

### 8. Scaffolding
- create-tauri-app 4.7.5 flags (`src/args.rs`): `[PROJECTNAME] -m/--manager <pnpm|…> -t/--template <svelte-ts|…> --identifier <id> -y/--yes -f/--force --tauri-version 2`.
- **Its `svelte-ts` template is SvelteKit** (adapter-static, `src/routes`). It does not match the plain-SPA decision.

Recommended non-interactive setup (`C:\Users\fouad\RustroverProjects\quran-desktop` exists and is empty):
```powershell
cd C:\Users\fouad\RustroverProjects
pnpm create vite quran-desktop --template svelte-ts --no-interactive
cd quran-desktop
pnpm add @tauri-apps/api@~2.12.2
pnpm add -D @tauri-apps/cli@~2.12.1 typescript@~6.0.3
pnpm tauri init --ci -A "Quran Desktop" -W "Quran Desktop" -D ../dist -P http://localhost:1420 --before-dev-command "pnpm dev" --before-build-command "pnpm build"
```
- `--no-interactive` comes from the create-vite source on its main branch. The `tauri init` flags come from tauri-cli `init.rs` @2.12.2.
- Then set `identifier` in tauri.conf.json (`init` has no identifier flag).
- Make the Vite server use port 1420 with `strictPort:true` (the Tauri templates use 1420; create-vite defaults to 5173).
- `host: process.env.TAURI_DEV_HOST || false`, `hmr` on port 1421 when `host` is set, `watch.ignored: ['**/src-tauri/**']`, `clearScreen:false`.
- `envPrefix: ['VITE_','TAURI_ENV_*']`.
- `build.target`: `TAURI_ENV_PLATFORM=='windows' ? 'chrome105' : 'safari13'`, and `minify`/`sourcemap` driven by `TAURI_ENV_DEBUG`.
- Add plugins with `pnpm tauri add window-state` (same for single-instance, log, opener, …).

## Facts
- [V] Latest stable tauri crate is 2.12.2 (published 2026-10-09, rust-version 1.90); tauri-build stable 2.7.1; tauri-utils 2.10.1; tauri-runtime-wry 2.12.1 — curl https://crates.io/api/v1/crates/tauri (and tauri-build, tauri-utils, tauri-runtime-wry); saved crates_versions.txt and crates_stable_detail.txt
- [V] Tauri 3.0.0-alpha.4 (crate) and @tauri-apps/cli 3.0.0-alpha.4 / @tauri-apps/api 3.0.0-alpha.2 exist under the npm 'next' dist-tag. They ship a tauri-runtime-cef crate (3.0.0-alpha.5). All plugins also have 3.0.0-alpha.x releases. — https://api.github.com/repos/tauri-apps/tauri/releases (saved gh_tauri_releases.txt), npm registry dist-tags (npm_versions.txt)
- [V] npm latest: @tauri-apps/cli 2.12.1, @tauri-apps/api 2.12.2. Every @tauri-apps/plugin-* latest version equals its Rust crate's stable version (opener 2.7.0, dialog 2.8.1, fs 2.6.0, store 2.5.0, window-state 2.5.0, global-shortcut 2.4.0, log 2.10.0, os 2.4.0, process 2.4.0, updater 2.13.2, http 2.8.1, notification 2.5.1, clipboard-manager 2.4.1, deep-link 2.6.1). @tauri-apps/plugin-single-instance does not exist on npm. — https://registry.npmjs.org/<pkg> for each; saved npm_versions.txt
- [V] tauri build errors when the tauri crate and @tauri-apps/api (or tauri-plugin-X and @tauri-apps/plugin-X) differ in major or minor version; the bypass flag is --ignore-version-mismatches — https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.12.2/crates/tauri-cli/src/info/plugins.rs (check_mismatched_packages) and crates/tauri-cli/src/build.rs
- [V] tauri-specta 2.0.0-rc.25 (2026-05-08) requires specta =2.0.0-rc.25, specta-typescript 0.0.12 and tauri '2' with features=['specta']; its crate docs still call v2 'beta' and say to pin with '=' — crates.io download of tauri-specta 2.0.0-rc.25 (Cargo.toml + src/lib.rs docs); GitHub repo specta-rs/tauri-specta pushed_at 2026-07-26, 32 open issues
- [V] A tauri-specta app (typed commands, a Channel<T> argument, an Event derive, Typescript export) compiles with tauri 2.12.2 / tauri-build 2.7.1 on rustc 1.99.0 with zero warnings, and generates bindings.ts with commands.getAyah/downloadPack and events.playbackTick — cargo build in the probe project; saved probe/build-debug.log, probe/src-tauri/src/lib.rs, probe/src/lib/bindings.ts
- [V] specta-typescript 0.0.12 refuses to export usize/isize/i64/u64/i128/u128 (BigIntForbidden error) and maps f32/f64 to 'number | null' — crates.io source of specta-typescript 0.0.12, src/primitives.rs primitive_dt() and src/error.rs
- [V] taurpc 0.8.2 (2026-07-03) depends on specta =2.0.0-rc.25, tauri 2.10.2 and tokio; npm taurpc latest is 2.0.0; ts-rs latest is 12.0.1 (generates types only) — crates.io download of taurpc 0.8.2 Cargo.toml/README; crates.io API for ts-rs; npm registry for taurpc
- [V] ipc::Channel delivers messages in order. JSON under 8192 bytes and raw payloads under 1024 bytes go via eval; larger ones go via IPC fetch. Channel<InvokeResponseBody> with InvokeResponseBody::Raw arrives as an ArrayBuffer, while Channel<Vec<u8>> is sent as a JSON array — https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.12.2/crates/tauri/src/ipc/channel.rs (saved src/ipc_channel.rs)
- [V] Events (Emitter::emit/emit_to/emit_filter) carry JSON-only payloads and the docs say they are not designed for low latency or high throughput; the docs recommend channels for streaming — tauri-docs src/content/docs/develop/calling-frontend.mdx (saved docs/develop_calling-frontend.mdx)
- [V] Custom protocol URLs are http://<scheme>.localhost/<path> on Windows/Android (https with useHttpsScheme) and <scheme>://localhost/<path> on macOS/iOS/Linux. At runtime on Windows the app origin was http://tauri.localhost and http://quran.localhost/... worked — Builder::register_asynchronous_uri_scheme_protocol doc comment in crates/tauri/src/app.rs @tauri-v2.12.2 (saved src/app.rs) plus the runtime probe report (probe/runtime-probe-report.json)
- [V] A register_asynchronous_uri_scheme_protocol handler with manual Range parsing served 206 Partial Content (Content-Range bytes 100-199/2097152) to fetch(), let <audio> seek to 50 s in a 60 s WAV, and loaded a FontFace when it sent Access-Control-Allow-Origin: *; a '..%2F..' path returned 403 — runtime probe in WebView2 (Edg/154); saved probe/runtime-probe-report.json and probe/runtime-probe-index.html
- [V] The asset protocol needs the tauri Cargo feature 'protocol-asset' plus app.security.assetProtocol {enable, scope}. It supports Range (206, at most 1000 KiB per range, multipart ranges) and sets Access-Control-Allow-Origin to the window origin — crates/tauri/src/protocol/asset.rs and crates/tauri/Cargo.toml @tauri-v2.12.2 (saved src/protocol_asset.rs, src/tauri_Cargo.toml) plus a runtime 206 response from http://asset.localhost
- [V] The asset protocol picks Content-Type by sniffing magic bytes with the infer 0.22 crate: woff2 (TrueType flavor) gives application/font-woff, wav gives audio/x-wav, and an unrecognized .woff2 falls back to text/html. It never sends font/woff2 — tauri-utils src/mime_type.rs @2.10.1, infer 0.22 map.rs/matchers/font.rs, runtime probe (asset_woff2_head returned text/html with a fake header and application/font-woff with a 0x00010000 flavor)
- [V] Leaving asset:/http://asset.localhost out of CSP connect-src makes fetch() to the asset protocol fail ('TypeError: Failed to fetch'), while media-src and font-src loads still work — runtime probe, first run vs second run after adding asset to connect-src
- [V] An out-of-scope asset path returns 403 and logs 'asset protocol not configured to allow the path' — runtime probe stdout and report (asset_out_of_scope status 403)
- [V] Capability files in src-tauri/capabilities are all enabled automatically unless app.security.capabilities lists identifiers; the schema path is ../gen/schemas/desktop-schema.json; the capability 'platforms' field accepts linux/macOS/windows/iOS/android — tauri-docs security/capabilities.mdx (saved docs/security_capabilities.mdx)
- [V] The permissions core:default, core:window:allow-minimize, allow-toggle-maximize, allow-close, allow-start-dragging, allow-set-effects, opener:default, log:default and window-state:default pass build-time validation — probe build succeeded with probe/src-tauri/capabilities/default.json
- [V] build.removeUnusedCommands stripped about 100 unused core and plugin commands and cut the release exe from 3,800,064 to 3,413,504 bytes — probe/build-nsis.log ('Removed unused commands from ...') and probe/size-results.txt
- [V] With the recommended release profile (codegen-units=1, lto=true, opt-level='s', panic='abort', strip=true), the probe's NSIS installer is 1,302,600 bytes (1.24 MiB); the CLI auto-downloaded NSIS 3.11 and nsis_tauri_utils v0.5.3 — npx @tauri-apps/cli@2.12.1 build --bundles nsis; saved probe/build-nsis.log and probe/size-results.txt; profile from docs/concept_size.mdx
- [V] WebView2 install-mode installer size overheads: downloadBootstrapper 0 MB (default), embedBootstrapper ~1.8 MB, offlineInstaller ~127 MB, fixedVersion ~180 MB, skip — tauri-docs distribute/windows-installer.mdx (saved docs/distribute_windows-installer.mdx)
- [V] AppImage size is 2-6 MB but grows past 70 MB; apps that play audio/video in the webview need bundle.linux.appimage.bundleMediaFramework (GStreamer); build Linux on Ubuntu 22.04 or Debian 12 because of webkit2gtk-4.1 and glibc — tauri-docs distribute/appimage.mdx and distribute/debian.mdx (saved)
- [?] dmg and deb installer sizes for this app — Not measured: no macOS or Linux host is available in this session
- [V] BaseDirectory::Resource resolution works (app.path().resolve('data/core.db', BaseDirectory::Resource)) with bundle.resources map form; on Windows it returned a \\?\ verbatim path pointing at target/release/data/core.db — runtime probe log line 'core db: \\?\C:\...\target\release\data\core.db'; docs/develop_resources.mdx
- [V] WindowConfig has transparent, decorations, shadow, windowEffects{effects,state,radius,color,interactive}, titleBarStyle (visible|transparent|overlay), hiddenTitle, trafficLightPosition, noRedirectionBitmap, backgroundThrottling (macOS 14+/iOS 17+ only), scrollBarStyle (fluentOverlay on Windows), useHttpsScheme (changing it loses IndexedDB/localStorage) — crates/tauri-utils/src/config.rs and lib.rs @tauri-v2.12.2; the probe tauri.conf.json using these keys compiled
- [V] WindowEffect values include mica, micaDark, micaLight, tabbed*, blur, acrylic (Windows) and sidebar, hudWindow, underWindowBackground, liquidGlassRegular, liquidGlassClear (macOS 26+); effects require transparent windows; Linux is unsupported — tauri-utils src/lib.rs WindowEffect enum (serde camelCase) and config.rs WindowEffectsConfig docs @2.12.2
- [V] Since tauri 2.12.1 the macos-private-api feature / macOSPrivateApi config is no longer required for transparency or fullscreen on macOS — tauri-v2.12.1 release notes (saved gh_tauri_release_notes.md)
- [V] tauri 2.12.0 added app.appDirectoriesOverride, @tauri-apps/api/app exit(), Webview(Window)::convert_file_src, noRedirectionBitmap, setFullscreenOnMonitor, a permission handler API (including Autoplay and LocalFonts) and Liquid Glass effects — tauri-v2.12.0 release notes (saved gh_tauri_2.12.0_notes.md)
- [V] window-vibrancy 0.8.1 API: apply_mica(window, dark: Option<bool>), apply_acrylic, apply_blur, apply_tabbed, apply_vibrancy(window, NSVisualEffectMaterial, state, radius), apply_liquid_glass(window, LiquidGlassOptions) for macOS 26+; tauri 2.12.2 itself depends on window-vibrancy 0.8.1 — crates.io source of window-vibrancy 0.8.1 (saved window-vibrancy-0.8.1-README.md); tauri Cargo.toml @2.12.2; probe compiled apply_mica
- [V] TrayIconBuilder (tray-icon feature) has with_id, icon, tooltip, title, menu, icon_as_template, show_menu_on_left_click (menu_on_left_click is deprecated), on_menu_event and on_tray_icon_event; Linux does not emit tray mouse events — crates/tauri/src/tray/mod.rs @2.12.2; docs/learn_system-tray.mdx; probe compiled
- [V] The macOS default app menu is enabled by default (Builder::enable_macos_default_menu); on macOS top-level menu items are ignored and the first submenu becomes the app menu — crates/tauri/src/app.rs @2.12.2; docs/learn_window-menu.mdx
- [V] The single-instance plugin must be registered first; on Linux it uses the DBus name org.{identifier with . and - replaced by _}.SingleInstance; it has no JS API and needs no permissions — docs/plugin_single-instance.mdx
- [V] The window-state plugin stores .window-state.json in %APPDATA%\<identifier>; WebView2 data goes to %LOCALAPPDATA%\<identifier>\EBWebView and tauri-plugin-log writes to %LOCALAPPDATA%\<identifier>\logs — directory listing after the runtime probe (directories removed afterwards)
- [V] @tauri-apps/api/mocks 2.12.2 exports mockIPC(cb, {shouldMockEvents}), mockWindows(current, ...others), mockConvertFileSrc(osName) and clearMocks(); core exports isTauri() and convertFileSrc(path, protocol='asset') — packages/api/src/mocks.ts and core.ts @tauri-v2.12.2 (saved src/api_mocks.ts); npm exports map './*'
- [V] The docs recommend WebdriverIO @wdio/tauri-service (1.5.0) with an embedded WebDriver plugin, supported on Windows, macOS and Linux; tauri-driver (2.1.0) used directly supports only Windows and Linux — docs/develop_Tests_WebDriver_index.mdx; crates.io tauri-driver / tauri-plugin-wdio-webdriver 1.5.0; npm @wdio/tauri-service 1.5.0
- [V] create-tauri-app 4.7.5 accepts [PROJECTNAME] -m/--manager, -t/--template, --identifier, -y/--yes, -f/--force and --tauri-version; its svelte-ts template is SvelteKit with adapter-static, not a plain Vite SPA — https://raw.githubusercontent.com/tauri-apps/create-tauri-app/dev/src/args.rs (saved cta_args.rs) and templates/template-svelte-ts files
- [V] tauri init accepts --ci, -A/--app-name, -W/--window-title, -D/--frontend-dist, -P/--dev-url, --before-dev-command, --before-build-command, -f/--force; there is no identifier flag — crates/tauri-cli/src/init.rs @tauri-v2.12.2 (saved tauri_cli_init.rs)
- [V] create-vite supports --template svelte-ts and --no-interactive / --overwrite / -i(--immediate); its svelte-ts template pins typescript ~6.0.2, svelte ^5.57.1, vite ^8.3.3 and @sveltejs/vite-plugin-svelte ^7.3.1 — vitejs/vite main branch packages/create-vite/src/index.ts and template-svelte-ts/package.json; npm create-vite 9.2.1
- [V] svelte-check 4.7.6 has peerDependency typescript '^5.0.0 || ^6.0.0' while npm typescript latest is 7.0.2, so TypeScript must be pinned to ~6.0.3 — https://registry.npmjs.org/svelte-check/4.7.6 and https://registry.npmjs.org/typescript
- [V] Platform config files tauri.{linux,windows,macos}.conf.json are merged with JSON Merge Patch (RFC 7396) and arrays are replaced wholesale — tauri-docs develop/configuration-files.mdx (raw GitHub)
- [V] backgroundThrottling cannot be disabled on Windows or Linux, so timers in a hidden or minimized webview may be throttled — config.rs doc comment for background_throttling @2.12.2

## Recommendations
- Pin Tauri 2.12.x: tauri = "2.12.2", tauri-build = "2.7.1", @tauri-apps/api ~2.12.2, @tauri-apps/cli ~2.12.1, and keep each tauri-plugin-X at the same major.minor as its @tauri-apps/plugin-X. Never use npm @next or 3.0.0-alpha.
- Scaffold with create-vite, not create-tauri-app (its svelte-ts template is SvelteKit). Run: pnpm create vite quran-desktop --template svelte-ts --no-interactive, then pnpm add @tauri-apps/api@~2.12.2, pnpm add -D @tauri-apps/cli@~2.12.1 typescript@~6.0.3, then pnpm tauri init --ci -A "Quran Desktop" -W "Quran Desktop" -D ../dist -P http://localhost:1420 --before-dev-command "pnpm dev" --before-build-command "pnpm build". Set the identifier by hand and use Vite port 1420 with strictPort.
- Typed IPC: use tauri-specta =2.0.0-rc.25 + specta =2.0.0-rc.25 + specta-typescript =0.0.12 with exact pins, and export bindings to src/lib/bindings.ts under debug_assertions. Use u32/i32 (not i64/u64/usize) in every DTO and keep the export in CI so type drift fails the build. Fallback if tauri-specta breaks: ts-rs 12 plus hand-written invoke wrappers.
- Serve downloaded packs (QPC fonts, audio, images) through an async custom protocol 'quran' rooted at app_data_dir()/packs: Range support, exact MIME (font/woff2, audio/mpeg, audio/ogg), Access-Control-Allow-Origin: *, Cache-Control immutable, and a Component::Normal-only path check (see probe/src-tauri/src/lib.rs). Build URLs with convertFileSrc(rel, 'quran'). Keep the asset protocol disabled unless needed.
- Use ipc::Channel (typed via tauri-specta) for download progress and playback ticks. For binary streams use Channel<InvokeResponseBody> with InvokeResponseBody::Raw, never Channel<Vec<u8>>. Reserve global events for low-frequency app-wide notifications (tray actions, settings changed).
- CSP: list both scheme forms (quran: and http://quran.localhost) in font-src, media-src, img-src and connect-src, plus ipc: http://ipc.localhost. Add asset: http://asset.localhost to connect-src if the asset protocol is ever fetched.
- Window chrome: on Windows use decorations:false, transparent:true, windowEffects mica, noRedirectionBitmap:true, visible:false (shown by window-state) and a Svelte titlebar with data-tauri-drag-region. On macOS use tauri.macos.conf.json with decorations true, titleBarStyle overlay, hiddenTitle true, trafficLightPosition and the sidebar/liquidGlass effects. On Linux use plain decorations. Remember platform config arrays (app.windows) replace the base array entirely.
- Do recitation playback (gapless decode, A-B loop, speed) in Rust (symphonia/rodio-style engine plus souvlaki or the OS APIs for SMTC/Now Playing/MPRIS) and stream position ticks over a Channel. Reasons: webview background throttling can't be disabled on Windows/Linux, Linux webview audio needs GStreamer (bundleMediaFramework adds 70+ MB to the AppImage), and the tray mini-player should keep working with the window hidden. Use <audio> over quran:// only as a simple fallback; seeking works there (verified).
- Ship the compressed core DB via bundle.resources map form (e.g. 'resources/core.db.zst': 'data/core.db.zst'), resolve it with app.path().resolve(.., BaseDirectory::Resource), and decompress or copy it to app_data_dir() on first run (the resource dir is read-only). Strip the \\?\ prefix (dunce-style) before passing paths to JS or third-party code.
- Size: use the release profile codegen-units=1, lto=true, opt-level='s', panic='abort', strip=true plus build.removeUnusedCommands=true, list only the permissions you use, and target NSIS only on Windows. Expect a ~1.3 MB installer plus app data (core DB and font).
- Register tauri-plugin-single-instance first; add window-state (with visible:false), log, opener, updater, deep-link and global-shortcut as needed. Use 'pnpm tauri add <plugin>' so the crate and npm versions stay paired.
- Testing: in main.ts, when !isTauri(), dynamically import a dev-only mock backend using mockIPC (shouldMockEvents: true), mockWindows('main') and mockConvertFileSrc so the Svelte UI runs in a normal browser and in Vitest with jsdom. For E2E use @wdio/tauri-service 1.5.0 with tauri-plugin-wdio-webdriver for cross-platform coverage, including macOS.
- Use different names for the internal webview scheme (e.g. 'quran' or 'qpack') and any OS deep-link scheme registered with tauri-plugin-deep-link (e.g. 'quran-desktop'), to avoid confusion.

## Risks
- tauri-specta and specta are still release candidates (rc.25, last release 2026-05-08). A future tauri 2.x or the Tauri 3 migration may break them, and specta has stricter type rules (BigInt types forbidden, floats typed as number | null).
- Tauri 3.0 alpha (with a CEF runtime) is in progress. Plugin 3.0 alphas are already published, so docs, examples and community answers will increasingly target v3 APIs. Pin to 2.12.x and avoid copy-pasting v3 snippets.
- The asset protocol sniffs MIME from file contents (woff2 is reported as application/font-woff, unknown types fall back to text/html) and caps each range response at 1000 KiB. If the WebView ever enforces MIME types (e.g. nosniff-style), this could break font loads; the custom protocol avoids the problem.
- Fonts and fetch() from a custom-protocol origin are cross-origin to http://tauri.localhost, so the handler must send Access-Control-Allow-Origin, or @font-face and FontFace loads fail.
- panic='abort' in release means a panic inside any command or protocol handler kills the whole app instead of returning an error. Avoid unwrap in handlers.
- On macOS, an overlay titlebar window cannot be dragged while unfocused (tauri#4316). Window effects require transparent windows; Acrylic and Blur have resize/drag performance problems on some Windows 10/11 builds; Linux supports no effects and emits no tray mouse events.
- On Windows and Linux the webview's background throttling cannot be disabled, so JS timers in a minimized or hidden window may be throttled. This is risky for JS-scheduled gapless audio or memorization loops.
- Linux AppImage needs bundleMediaFramework (GStreamer) for webview audio, which pushes size past 70 MB. Linux builds must be made on an old-glibc base (Ubuntu 22.04 / Debian 12).
- Changing useHttpsScheme (or the app identifier) after release changes the origin or data directory and silently loses localStorage and IndexedDB data.
- TypeScript 7.0.2 is npm 'latest' but svelte-check 4.7.6 only supports TS ^5 or ^6. Unpinned installs (e.g. 'pnpm add -D typescript') will break 'svelte-check'.
- Not verified in this session: macOS/Linux runtime behavior (all runtime probes ran on Windows 11 / WebView2 154), dmg/deb/AppImage sizes, and create-vite's --no-interactive flag in the exact published 9.2.1 (verified from the main-branch source only).
- Git Bash/MSYS cannot start native Windows programs when the current directory path is longer than 260 characters (seen with the scratchpad path). The project path C:\Users\fouad\RustroverProjects\quran-desktop is short, so this only affects tooling run from deep temp directories.
