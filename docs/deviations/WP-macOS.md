# WP-macOS: the first pass on a Mac

The app was built and tested on Windows only. This pass built it on macOS 27.0.1 (Apple silicon, WKWebView 22625, one
3840×1080 display at 1×), ran every test suite, and drove the real app (a debug build with its own identifier,
`QD_AUDIO_SINK=wav:…`/`null`, so nothing reached the speakers; LEAD 9) through onboarding, the qcf_v4 Mushaf, search,
copy, recitation, settings, themes, zen, the close-to-tray question, the Dock's reopen and the quit paths.

## What ran

| Command | Result |
|---|---|
| `pnpm i --frozen-lockfile`, `pnpm assets`, `pnpm core:qdc` | ok (18/18 gates) |
| `pnpm tauri build --bundles app` (release, `APPLE_SIGNING_IDENTITY=-` as `release.yml`) | ok |
| `pnpm test` | 2,424 passed, 11 skipped |
| `cargo test --workspace` | 1,339 passed, 20 ignored, after fixes 4 and 5 (it did not compile before) |
| `pnpm check`, `pnpm lint`, `pnpm format:check`, `pnpm lint:css`, `cargo fmt --check`, `cargo lint` | ok |
| `pnpm bindings:check`, the `node --test` tooling suites (122), both tooling `tsc` projects, `pnpm check:ci` | ok |
| `pnpm test:browser` (chromium, the local default) | 554 passed, after fixes 8 and 9 (68 failed across both engines before) |
| `QD_BROWSERS=chromium,webkit pnpm test:browser` | webkit: 14 failed, see below |

## Fixes

1. **The window appeared only after the 3 s fallback.** `markReady` waited for a double rAF before `window_ready`, and
   WKWebView runs no animation frames while its window is hidden, so every launch logged "window_ready not received
   within 3s". A hidden document now lays out and asks to be shown at once (`app.svelte.ts`); WebView2 reports its
   hidden window as visible, so Windows keeps the double rAF. First paint: 3,095 ms → 410–540 ms (debug build).
2. **The window grew on every launch.** tao queues `setSize`/`setPosition` on the main thread on macOS, so
   `set_inner_size_exact` read the old size, took it for a platform overshoot and queued a "correction" (twice the
   target less the old size) after the request: 1440 → 2640 → 3840 px wide. `Geometry::applies_size_at_once` (Windows
   only) gates the check; elsewhere the request is made once and trusted (`placement.rs`, with a queued-window test). A
   saved 1600×900 now comes back as 1600×900 launch after launch.
3. **Cmd+Q skipped the page's save (LEAD 23).** The default menu's Quit calls `terminate:`. On macOS the window layer now
   installs tauri's default menu with that one item replaced by a Cmd+Q item that calls `window::quit`, so the page saves
   and calls `app_quit` as with the tray's Quit. The Dock's Quit and logout still terminate directly.
4. **`cargo test --workspace` did not compile off Windows.** Five xtask tests put `#[path = "../../src/build/…"]` inside an
   inline `mod build`, which resolves through `xtask/tests/build/`, a directory that does not exist; only Windows
   normalises `..` before opening the file. The path now sits on the module (`#[path = "../src/build"] mod build`).
5. **`check_relative_file` accepted `C:/x.db` off Windows** (two normal components there). The manifest is checked on
   every OS, so `:` is refused everywhere.
6. **At 80 % interface size the app icon covered the zoom button.** The webview zooms the title bar but not the traffic
   lights; the 78 px reserve is now divided by the zoom (`titleBarKind(platform, uiScalePct)`).
7. **Font transport `url` on macOS** (the WP6a checklist row): with `QD_FONT_TRANSPORT=url` the qcf_v4 pages, the surah
   headers and the decor faces loaded from `quran://localhost/…` with no `font_bytes` retry, so the macOS arm of
   `platform_font_transport` is now `Url`. The retry as bytes remains for older WebKit (checklist row: macOS 13.3).
8. **Shift+F10 and the Menu key opened no item menu on macOS.** The library rows, search hits, surahs, verse rows and the
   downloads grid open their menu from the `contextmenu` event, which the browser fires for those keys on Windows and
   Linux only. On macOS the shortcuts store now fires it at the focused element when no shortcut takes the key.
9. **The browser tests assumed Windows.** The mock reports the browser's platform, so on a Mac `Mod` is ⌘ and the labels
   are ⌘-style (`⌘B`, `⇧⌘C`), and Home/End do not move a text field's caret there (⌘←/⌘→ do). Eleven chords and the
   label checks now follow `app.isMac`; the Mod+click test runs the store on the browser's platform (Ctrl+click is a
   right-click on macOS).

## Checked and fine

- Onboarding, the qcf_v4 colours (paper and night), the Arabic interface, ⌘K and the other ⌘ labels, the index filter,
  Go to, Copy (`c`: "Copied Al-Baqarah 2:249", after the IPC round trip), settings, zen.
- Recitation into the WAV sink: streaming, caching, the ayah tint and the dock's position; the Now Playing backend
  registered its commands and wrote its artwork without an Objective-C exception.
- Closing the window while reciting asks the first-close question (a sheet); "Keep playing in tray" hides the window
  and the recitation goes on; the Dock's reopen shows it again; after a kill, the dock offers to resume.
- The reading position and the window placement survive a quit; the Edit menu gives text fields Cmd+C/V/A.

## Reviewed, not changed

- **Clipboard after an IPC await:** a static review expected WebKit to refuse `navigator.clipboard.writeText` once the
  user gesture had passed through `quran_copy_text`; in the app the write succeeded.
- **Vibrancy and an explicit theme:** night on a light system gives an even dark chrome, not a muddy one.
- **Traffic lights in zen:** they stay (as in other macOS focus modes) in the window margin; hiding them needs AppKit
  calls from the app crate, a new direct dependency.
- **`quran-desktop:` links:** OS registration is an open product decision (§16); on macOS it would also need
  `RunEvent::Opened`, since links do not arrive as arguments there.

- **WebKit's remaining browser-test failures** are WebKit's macOS focus model, which WKWebView shares: Tab moves only
  between text fields unless System Settings › Keyboard › Keyboard navigation is on (links also need
  `tabFocusesLinks`), and a click does not focus a button. So the skip link, the dialog and sheet Tab traps, the
  popover and stepper focus checks, `:focus-visible` after Tab and the Enter-on-a-button flows fail there; plus two
  sub-pixel tolerances (the Ctrl+wheel anchor, 1.012 against 1) and the frame-budget test under load. None showed in
  the app. Whether the app should turn on `tabFocusesLinks` for keyboard users is a product decision.
- **`MushafPage.swap` fails from a checkout whose path has a space** (as this pass's did): vitest's browser mode does not
  apply its relative `vi.mock`. It passes from a path without one.

## For a person

- A trackpad pinch on the Mushaf: `wheel.ts` expects Ctrl+wheel, which WebKit may deliver as `gesture*` events instead.
- A mouse-wheel notch turns one page (WebKit's notch deltas on macOS may be under `NOTCH_PX`).
- Control Center's Now Playing, the play/pause key, the tray icon in a light and a dark menu bar.
- Dragging the title bar: the pass's synthetic clicks in the drag region resized the window from its top-left corner
  (`performWindowDragWithEvent:` with a synthetic event); a real mouse should move it.
- The rest of the macOS checklist rows: the universal dmg on Intel, macOS 13.3, VoiceOver, the drop guard.
