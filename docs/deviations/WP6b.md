# WP6b deviations (window, tray, per-OS config, Rust strings)

Owned and written: `src-tauri/src/{window, tray, i18n}.rs`, `src-tauri/tauri.{windows, macos, linux}.conf.json`.
`src-tauri/capabilities/default.json` was reviewed and kept byte-for-byte: it already is the §13.5 set, and a unit test
now pins it. No other file was touched and no dependency was added. Evidence (screen captures of the real window, the
probe reports and the probe tools) is in `artifacts/wp6b/` (gitignored).

## Snap Layouts investigation (§9.6): feasible, implemented

**Result:** hovering the custom maximise button opens the Windows 11 Snap Layouts flyout, and clicking it maximises and
restores the window. This works in the real app: Windows 11 build 26200, 150 % scaling, WebView2 154. See
`artifacts/wp6b/snap-flyout.png`.

**Why §9.6's approach (a subclass of the app window returning `HTMAXBUTTON`) cannot work as written.** The real window
tree (`artifacts/wp6b/wp6b-final.json`) is:

```
Tauri Window                      (app, main thread)
├─ QuranDesktopSnapTarget         (app, WP6b)
├─ TAURI_DRAG_RESIZE_BORDERS      (app, tauri-runtime-wry: the top resize strip)
└─ WRY_WEBVIEW                    (app, wry container)
   └─ Chrome_WidgetWin_0          (app)
      └─ Chrome_WidgetWin_1       (msedgewebview2 process)
         └─ Chrome_RenderWidgetHostHWND, Intermediate D3D Window   (other processes)
```

The pointer over the HTML button is hit-tested against the browser process's windows. The app window never receives
`WM_NCHITTEST` for that point, and `HTTRANSPARENT` does not cross threads.

**What WP6b does instead (the Windows Terminal pattern for XAML caption buttons).** WP6b adds a transparent child window
of its own, class `QuranDesktopSnapTarget`, above the webview container and exactly over the maximise button:

- It answers `WM_NCHITTEST` with `HTMAXBUTTON`, so Windows shows the flyout on hover. A click (button down then up on the
  target) toggles maximise through tauri; right clicks are swallowed.
- `noRedirectionBitmap` (Windows config) means it paints nothing: the HTML button stays visible under it.
- Hover and press are forwarded to the page as a DOM event, so `WindowControls` can show its hover/pressed look:
  `window.dispatchEvent(new CustomEvent('qd:caption-button', { detail: { button: 'maximize', state } }))`, with
  `state` = `hover` | `pressed` | `none`. Leaving is detected by polling the cursor every 60 ms while hovered
  (`TrackMouseEvent` needs a `windows` feature src-tauri does not declare).
- Geometry: the §9.6 caption button, 46 × 40 CSS px × DPI scale × UI zoom, second from the inline-end edge (the left
  edge in the Arabic UI). When restored, the top `SM_CYFRAME` px are left to tauri's resize strip, so the top edge
  still resizes; when maximised it starts at y = 0.
- It is re-laid-out on resize, DPI change, UI zoom and UI language change. It is not created on Windows 10 (build
  < 22000; no flyout there), with native decorations or a window narrower than three buttons, and it is hidden in full
  screen and while minimised.

**Measured in the real app** (shared-tree build `C:\qdt\WP6b\debug\quran-desktop.exe`):

| Check | Result |
|---|---|
| Restored target rect | 69 × 55 at client (2022, 5) |
| `WindowFromPoint` at the target's centre | `QuranDesktopSnapTarget` |
| `WM_NCHITTEST` at that point | 9 (`HTMAXBUTTON`) |
| 30 px to the left of the target | `Chrome_RenderWidgetHostHWND`: the page keeps all other input |
| Hover | the flyout appears; the page received `hover`, then `none` |
| Click | maximised; the target moved to 69 × 60 at y = 0; a second click restored the window |
| Click events seen by the page | `hover, pressed, hover, none` for each click |
| Arabic UI | x = 69 (second from the left) |
| UI scale 150 % | 104 × 85 |

**Limits (requests below).**
- **Zen mode.** Zen hides the HTML title bar, but Rust cannot see it, so the 46 × 40 corner stays a maximise target.
  The same holds while a full-window overlay covers the title bar.
- **Window controls.** Until WP7c ships `WindowControls`, the target covers part of the palette button at the right end
  of the placeholder title bar.

## Deviations from ARCHITECTURE.md

1. **Hooks are generic over the tauri `Runtime`** (`window::*`, `tray::*`), like WP0B's glue and WP6c's media hooks.
   Callers that pass `&tauri::AppHandle` and the frozen `lib.rs` compile unchanged. The generics make the hooks
   testable with `tauri::test::mock_app()`.
2. **Rust string table (§11.4).**
   - Added keys:
     - `TrayPlay` and `TrayPause`: the transport item follows the playback state. `TrayPlayPause` is now the disabled
       label shown while nothing is loaded.
     - `TrayStillPlaying` and `TrayStillRunning`: the one-time notice.
     - `CloseToTrayBody`: the question's explanation.
     - `CloseToTrayCancel`.
   - Added helpers: `fill`, `now_playing` and `RustText::placeholders`.
   - The existing strings are unchanged. WP6a's test pins `"Now: {ref}"`/`"الآن: {ref}"`.
   - Tests cover:
     - every key, in both languages, exactly once;
     - Arabic letters in every Arabic string and none in the English strings;
     - each template has exactly its placeholders;
     - Windows length limits.
3. **The close question has three buttons: [Keep playing in tray] [Quit] [Cancel].** tauri-plugin-dialog 2.8.1
   (`desktop.rs`) reports a dismissal (Esc, ×) as the *last* custom button. With §9.6's two buttons, Esc would have
   quit the app. Cancel, Esc and × keep the window open, record nothing, and ask again on the next close.
   - Verified in the real app on a copy-only build that fakes an active recitation:
     - Esc left the window open with `closeToTray=false`, `closeToTrayAsked=false`.
     - Enter (the first button) hid the window and stored `closeToTray=true`, `closeToTrayAsked=true`.
   - Screenshots: `artifacts/wp6b/dialog-{en,ar}.png`.
   - The dialog title is the app name and the text starts with the question. On macOS, NSAlert shows the title in bold,
     so the title is the question there.
   - Windows' TaskDialog lays the Arabic text out left-aligned: rfd sets no `TDF_RTL_LAYOUT`. The bidi order is
     correct.
4. **Hide and ask only when the tray icon exists.** With `showTrayIcon` off, hiding would leave no way back but a
   relaunch. In that case a close always closes and the app exits. This was verified in the real app with
   `closeToTray=true`, `showTrayIcon=false`: the app exited cleanly with an orderly shutdown.
5. **The one-time notice (§9.6) is a Windows tray notification.**
   - It is a `Shell_NotifyIconW(NIM_MODIFY, NIF_INFO)` balloon, shown as a toast, with `NIIF_RESPECT_QUIET_TIME`.
     tray-icon 0.25 does not expose the icon id, so the id is found by probing `(tray window, id)` pairs. The shell
     rejects a wrong pair harmlessly.
   - It is remembered in `settings.hintsSeen` as `"tray_background"`. The spec does not say where "one-time" lives.
   - macOS keeps its Dock icon and AppIndicator has no notifications, so the notice never shows there and the hint
     stays unset.
   - Verified: the shell accepted the notification and the hint was stored. The machine was in Do Not Disturb, so the
     toast went silently to the notification centre.
6. **Settings written from Rust** (the close answer, the hint) go through WP2b's `commands::settings::ops::write`,
   with the same three hooks as `settings_set`. The frontend therefore hears `settings-changed` (verified:
   `settings_get` shows the new values). The read-modify-write is not under WP2b's private `WRITE_GATE` (see
   Requests). The window that leaves a race is a frontend `settings_set` landing during the few milliseconds between
   the read and the write. It is negligible: the user is answering a modal dialog.
7. **Tray.**
   - Menu: "Now: {ref}" (disabled, inserted only while something is loaded) · Play/Pause · Previous ayah · Next ayah ·
     Show Quran Desktop · Quit, with separators. Transport items are disabled while nothing is loaded.
   - Clicks: on Windows, left click or double click shows the window, and right click opens the menu. On macOS a click
     opens the menu.
   - Tooltip: "Quran Desktop" plus a line with "Now: …", cut to Windows' 127 UTF-16 units. `&` is escaped in menu
     texts.
   - Threading: every tray object is created, updated and dropped on the main thread only. The hooks queue one
     coalesced, non-blocking job that pushes only what changed (`TrayView` diff).
     - The reason: tauri's setters block the caller until the main thread runs them, and `set_now_playing` comes from
       the audio thread while the main thread may be joining it at exit.
     - `tray_icon::TrayIcon` must also be dropped on its own thread.
   - The tray follows `audio-state-changed` itself as well as `set_now_playing`, so its labels are right before WP4d's
     UI sink lands. The two paths produce the same model, and an unchanged model costs nothing.
   - Icons:
     - Windows: the `tray-{16,20,24,32}.png` matching the taskbar's DPI (`Shell_TrayWnd`, else the system DPI),
       re-picked on a scale-factor change.
     - macOS: `tray-template@2x.png` as a template.
     - Linux: `tray.png`.
   - **Linux guard.** `libappindicator-sys` *panics* when neither `libayatana-appindicator3.so.1` nor
     `libappindicator3.so.1` loads, which is an abort under `panic = "abort"`. `tray::build` first looks for the
     library on the loader's path: `LD_LIBRARY_PATH`, `$APPDIR`, `ld.so.conf` with its includes, and the standard
     directories. When none is found it returns an error, which setup logs, and the app runs without a tray.
   - The macOS and Linux tray modules use only std and tauri. They compile and are unit-tested on every OS (icons
     decode at 36/32 px, the template is pure black, the search order and the guard).
8. **Exit (`RunEvent::Exit`).**
   - It runs `AppState::shutdown()` (WP6a's request; idempotent).
   - It removes the tray. The tray state holds clones of the icon, so without this the icon would outlive tauri's own
     cleanup and leave a stale icon in the notification area.
   - Every exit path ends there: the window close, the tray's Quit, the dialog's Quit, `app_quit`, Cmd+Q, and logoff.
9. **Deep links (BRIEF stretch).**
   - `on_second_instance` parses the first `quran-desktop:` argument and emits `navigate-requested` after resolving it
     against the core index, off the main thread.
   - Accepted forms (an ayah is checked against its surah's length):
     - ayahs: `2:255`, `2/255`, `ayah/2:255`, `ayah/2/255`;
     - surahs: `36`, `surah/36`;
     - pages: `page/604`;
     - search: `search?q=…`, `search/…`;
     - views: `view/{reader|downloads|settings|about}`.
   - Verified: a second launch with `quran-desktop://page/262` showed the hidden window, and the page received
     `{"type":"page","data":{"page":262}}`.
   - Not covered:
     - a deep link on the *first* launch (setup is WP6a's; see Requests);
     - OS scheme registration (needs the deep-link plugin or installer registry entries; lead).
10. **`set_ui_zoom` also lays out the Snap Layouts target,** whose size follows the zoom. It is the one window hook
    setup calls once the window exists.
11. **Per-OS configs** are exactly §13.5, plus WP-Brand's `bundle.icon` overrides (`icons/windows/icon.ico` first,
    `icons/macos/icon.icns` first). Each file repeats the full base window object.
    `per_os_configs_merge_onto_the_base_and_parse` fails when a base window key is not repeated or a value drifts from
    §9.6/§13.5. Verified: the shared-tree exe embeds the tuned ICO. `ExtractAssociatedIcon` at 32 px gives Δ 0 against
    `icons/windows/icon.ico` and Δ 183 against the plain `icons/icon.ico`.

## Acceptance: how each line was run

- **`cargo test -p quran-desktop --lib window tray i18n`** is not a valid cargo invocation: cargo accepts one test-name
  filter (`error: unexpected argument 'tray' found`). The equivalent `cargo test -p quran-desktop --lib -- window tray
  i18n` was run. 33 tests passed in the shared tree; the full lib suite was 121 passed in the private snapshot.
- **`cargo clippy -p quran-desktop --all-targets -- -D warnings`**: exit 0 in the shared tree.
- **`pnpm tauri build --debug --no-bundle`**:
  - **Windows:** succeeds in the shared tree.
  - **Windows NSIS bundle:** `pnpm tauri build --debug --bundles nsis` also built the NSIS installer with the
    Windows config, 6.50 MiB with a debug exe, from a private snapshot.
  - **macOS and ubuntu (no CI runners here), substitutes:**
    1. The unit test above deserialises each merged config into tauri-utils' own `Config` (`deny_unknown_fields`), on
       every OS.
    2. A schema check (`artifacts/wp6b/tools/validate-configs.cjs`) validates base + each platform file, merged by RFC
       7396 as the CLI does, against `node_modules/@tauri-apps/cli/config.schema.json` with ajv. All three are valid.
       Two negative controls are caught: a `titleBarStyle` typo and an unknown `macOS` key.
    3. The macOS and Linux tray code is compiled and tested on Windows (deviation 7).

    These do not replace the runners:
    - `cargo check --target aarch64-apple-darwin` stops at `objc2-exception-helper`, which needs a C compiler for
      Apple targets.
    - WSL has no GTK/WebKit development packages.
- **Real window.** It was checked with `app-driver --shot wp6b-startup` (passed) and with WP6b's native probe
  (`artifacts/wp6b/tools`): Mica (`DWMWA_SYSTEMBACKDROP_TYPE` = 2), `WS_EX_NOREDIRECTIONBITMAP`, rounded corners, the
  Snap Layouts results above, close-to-tray, second instance, and the tray built, removed and rebuilt from settings.
- **Private snapshot.** While the shared tree did not compile (`quran-packs` `revalidate.rs` and `quran-audio`
  `ticker` were in flight), WP6b's files were verified in a private copy (`C:\qdt\WP6b-ws`). In that copy only, the
  in-flight module was neutralised. Every acceptance line above was then re-run in the shared tree once it was green.

## Requests

- **WP7c (`WindowControls`, `TitleBar`):**
  - Keep the §9.6 geometry the snap target assumes, and tell WP6b about any change (`window::caption::{BUTTON_W,
    BUTTON_H}`):
    - 46 × 40 CSS px buttons;
    - flush with the top and the inline-end edge of the window;
    - DOM order minimise, maximise, close, so close is outermost and maximise second;
    - mirrored by logical CSS in the Arabic UI.
  - Reflect the native pointer state on the maximise button:
    `addEventListener('qd:caption-button', e => (maxBtn.dataset.nativeState = e.detail.state))`, and style
    `[data-native-state=hover|pressed]` like `:hover`/`:active`. Pointer events never reach that button on Windows 11.
    Keyboard and screen readers still use it.
  - The "Win+Z for snap layouts" tooltip is no longer needed. On Windows 11 the flyout is native. On Windows 10 Win+Z
    does not exist. A plain "Maximize"/"Restore" tooltip is enough.
- **Lead / contract (zen mode):** add a command such as `window_set_caption({ visible: bool })` (or a maximise rect).
  WP7c would call it when zen or a full-window overlay hides the title bar. WP6b has `caption::relayout` ready to honour
  it, as one more condition beside full screen.
- **WP2b:** expose a `pub(crate)` read-modify-write in `commands::settings::ops`, e.g.
  `edit(app, user, hooks, |s: &mut Settings| ..)`, that reads inside `WRITE_GATE`. Also expose the production
  `apply_hooks`. `window::write_settings` would then use them instead of repeating the three hooks.
- **WP6a:** handle a `quran-desktop:` argument on the *first* launch. After `window_ready`, call
  `window::on_second_instance(app, std::env::args().collect())`, or a dedicated `window::open_link`. The event has no
  listener before the first paint.
- **WP8e:** `navigate-requested` with a page target reaches the page (verified), but the reader stayed on page 1. The
  `ui.onNavigate` reader handler is still pending.
- **WP13b (release checklist, §12.6):**
  - **Windows:**
    - Mica in both tints.
    - The Snap Layouts flyout on the real `WindowControls`, and the forwarded hover/pressed look.
    - Tray: menu, labels during playback, left click.
    - The first-close question while reciting.
    - The one-time notice, outside Do Not Disturb.
  - **macOS:** Dock reopen after hiding to the tray; the template icon in light and dark menu bars.
  - **Linux:** the tray menu on GNOME (AppIndicator extension) and KDE. Also confirm that the deb's `Depends` (`dpkg-deb
    -I`) and the AppImage carry libayatana-appindicator. Without the library the app runs without a tray. *Resolved:*
    tauri-cli adds both through `[features]` in `src-tauri/Cargo.toml`, and CI's `check-bundles.mjs` asserts them
    (WP13b.md item 4).
- **Lead:** fold in the Snap Layouts outcome (§9.6), deviations 3–5 (§9.6) and 9 (§5.14 stretch). Also fix the
  multi-filter acceptance syntax in §14.3 (here and in WP6a/WP5e/…): `cargo test -p <crate> --lib -- a b c`.
