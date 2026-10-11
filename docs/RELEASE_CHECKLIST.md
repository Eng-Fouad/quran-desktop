# Release checklist

The steps a person takes for every release of Quran for Desktop (ARCHITECTURE §12.6, §13.4, §13.6; WP13b). The
pipeline (`.github/workflows/release.yml`) builds, checks and uploads the installers to a **draft** release. Nothing
publishes it except a person who has completed this list. Copy the list into the release's tracking issue and tick it
there.

## 1. Before tagging

### Blockers (any open one stops the release)

- [ ] **Data permission (QUL gate).** Written permission from QUL (Tarteel), and from Quran.Foundation where the data
      originates with it, to distribute a `core.db` built from the QUL layout and glyph exports (FACT §8.1,
      ARCHITECTURE §15.3 item 1, risk R1). Record where the permission is kept and its exact scope (layouts v1/v2/v4,
      glyph codes, the Imla'i text). Until it exists no installer may leave a developer's machine: local builds carry
      the development (qdc) core.db and pass the bundle guard only with `QD_ALLOW_DEV_CORE=1` (private previews), and
      `release.yml` stops at its core step without the QUL secrets.
- [ ] **quran org approval (identity gate).** The github.com/quran maintainers approved, in writing (link the issue or
      discussion here), the release under the Quran.com identity (LEAD.md item 16):
  - the names "Quran" and "Quran for Desktop" (and «قرآن», «قرآن لسطح المكتب»);
  - the identifier `com.quran.labs.desktop`, which is permanent once shipped: it names the data directory, the Windows
    AppUserModelID, the macOS bundle and the MSI/NSIS upgrade identity;
  - the icon (quran_android's mark) and the publisher "Quran for Desktop contributors";
  - where the repository and its releases live (`[workspace.package] repository`, below).
- [ ] **Attribution wording.** The QF Developer Console account exists and About carries the agreed credit text
      (§15.3 item 2).
- [ ] **Decorative fonts.** On-demand download of QCF_SurahHeader, quran-common and sura_names (no licence string) is
      confirmed acceptable, or the `decor` packs leave `src-tauri/resources/catalog.json` and the app keeps its own
      SVG and Unicode fallbacks (§15.3 item 4).
- [ ] **Signing and notarisation.** The signing decision in `docs/deviations/WP13b.md` holds: either this release is
      published as a **pre-release** with the unsigned-install notes of `.github/release-notes.md`, or every item
      below is done. Open work until then:
  - [ ] Windows: an Authenticode certificate in the quran org's name (Azure Trusted Signing, or SignPath Foundation
        for open source), wired as `bundle.windows.signCommand` in a release-only `--config` (SHA-256 digest, RFC 3161
        timestamp). `signtool verify /pa /v` passes on the setup exe and, after installing it, on
        `%LOCALAPPDATA%\Quran\quran-desktop.exe` and `uninstall.exe`.
  - [ ] macOS: a Developer ID Application certificate of the org's team, and the `APPLE_CERTIFICATE`,
        `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific) and
        `APPLE_TEAM_ID` secrets in the environment `release`. The draft's app then passes
        `spctl -a -t exec -vv Quran.app` ("source=Notarized Developer ID") and `xcrun stapler validate Quran.app`.
  - [ ] The release notes lose the unsigned-install section, and the release can be marked "Latest".
  - [ ] Updater (§15.2): still out of v1. It needs its own signing key, so revisit it with the certificates.

### Data, version and secrets

- [ ] Every input in `data/sources/qul/manifest.toml` has its SHA-256 recorded and checked against its QUL resource
      (`data/sources/README.md`, step 4). `pnpm core:qul` passes locally: 18/18 gates.
- [ ] The private store holds a `tar.gz` of exactly those files (flat, no directories). The environment `release` has
      the secrets `QUL_SOURCES_URL` and `QUL_SOURCES_TOKEN`.
- [ ] The version is bumped in `package.json`, `src-tauri/tauri.conf.json` and `[workspace.package]` of
      `Cargo.toml`, and `node scripts/check-version.mjs v<version>` passes.
- [ ] `cargo xtask licenses` leaves `src/lib/about/thirdparty.json` unchanged (the CI drift check is green), and
      About lists every data source, font and recitation source with its licence.
- [ ] The recorded QUL permission's wording is in `QUL_PERMISSION` (`src/lib/about/attributions.ts`) and in
      `data/sources/README.md`, so About no longer says "QUL publishes no licence for this data".
- [ ] `[workspace.package] repository` in `Cargo.toml` is the final public repository (About's "Source code" link,
      `SOURCE_URL`, follows it; a unit test keeps them equal).
- [ ] The deb's Maintainer (the workspace `authors`, "Quran for Desktop contributors") carries the contact e-mail the
      owner chose: Debian requires one.

### Quality gates on the release commit

- [ ] CI is green: the `CI result` check, including `build (…)` on all three OSes. That job builds the installers
      around the placeholder core.db, checks their contents (`scripts/check-bundles.mjs`) and enforces the §13.6
      budgets (`scripts/size-budget.mjs`).
- [ ] **Metrics on a real Windows machine with a GPU**, the window visible and not covered:

      pnpm tauri build --debug --no-bundle
      pnpm shots:app --only metrics --strict
      node scripts/qa/idle-cpu.mjs

  The run must pass: §8.18 frame budgets, CLS 0, no CSP violation, `#qd-v4-palettes` applied, and the §13.6 runtime
  rows (memory and CPU count the app and its WebView2 processes). Then put the table from
  `node scripts/size-budget.mjs --require runtime` in the release's tracking issue (it reads
  `artifacts/shots/app/metrics-report.json`; after the debug build it leaves `dist/` to CI's production build).
- [ ] The visual scenarios pass in the real app: `pnpm shots:app --strict`. A person has looked at the PNGs.
- [ ] The release profile keeps the audio hot path fast:
      `cargo test -p quran-audio --release --test dsp_cpu -- --nocapture` passes. `[profile.release]` builds for size
      (`opt-level = "z"`) except decode, resampling and WSOLA, which stay at opt-level 3; without those overrides the
      chain is about three times slower.

## 2. Tag and build

- [ ] `git tag v<version>` on the release commit, then `git push origin v<version>`.
- [ ] `release.yml` is green. The draft release `v<version>` holds `Quran_<version>_x64-setup.exe`,
      `Quran_<version>_universal.dmg`, `Quran_<version>_amd64.deb` and `Quran_<version>_amd64.AppImage`, each with a
      `.sha256`. Each build job's summary shows the §13.6 table within budget. Windows ships the NSIS installer only:
      an MSI (`pnpm tauri build --bundles msi`, per-machine, English UI) is not a release asset, and its upgrade code
      is pinned in `src-tauri/tauri.windows.conf.json` should one ever be built for a managed deployment.
- [ ] To rehearse without a tag, run `release.yml` from the Actions tab on a branch. It runs the same builds and checks
      and uploads nothing.

## 3. Manual smoke test of the draft's installers

Install each file from the draft release, not a local build. Use a fresh user profile or VM where you can.

### Every OS

- [ ] Install, launch and finish the onboarding. The first page appears without a flash of fallback fonts.
- [ ] Pages render in hafs, qcf_v2 and qcf_v4. Tajweed colours appear in qcf_v4 (the COLR probe passed), or the app
      falls back to qcf_v2 with a notice.
- [ ] Recitation: play, seek, repeat (ayah ×3, range ×2), speed 0.75× and 1.5×. Unplug the output device and switch
      the default device while it plays: playback continues on the new device.
- [ ] Media keys and the system's media controls show "Quran" with the artwork, and the item goes away after stop.
- [ ] Tray: the menu works, closing the window while reciting asks the first-close question, and the answer is kept.
      With nothing playing, × closes the app even with close-to-tray on.
- [ ] Go to 2:255 and close the window at once (×, then again with the taskbar's Close or Alt+F4): the app reopens on
      page 42. While reciting, choose Quit in the tray menu: the dock offers to resume the ayah that was playing. On
      macOS, try Cmd+Q right after a turn too and record whether the page is kept (LEAD 23).
- [ ] Turn network use off while a streamed surah plays, so the next surah fails ("Offline — … isn't downloaded"). Turn
      it on again, then press Play on the dock, a media key or the tray: the recitation continues where it stopped, the
      range unchanged.
- [ ] A second launch focuses the running window (single instance).
- [ ] Size and position are restored after a restart, and maximised and full screen are restored too.
- [ ] The app icon is right in the taskbar or Dock, the window, the tray and the About header. About lists every
      source and licence.
- [ ] Dropping a file or a link from another app onto the window does nothing (no navigation, a "not allowed"
      cursor), and the reader stays where it was. A link inside About opens in the default browser, never in the app.
- [ ] Uninstall removes the app. User data stays where §2.8.3 says it is.
- [ ] Upgrade: install the previous release, use it (a bookmark, a downloaded translation), then install this one over
      it. One "Quran" entry remains in the system's app list, and the bookmark and the download are still there.

### Windows 10 and 11

- [ ] `Quran_<version>_x64-setup.exe` shows the Quran icon in Explorer and in the browser's downloads (not NSIS's
      generic installer icon). Its Properties › Details say "Quran", the version and "© Quran for Desktop
      contributors".
- [ ] The unsigned installer shows SmartScreen's "Windows protected your PC". "More info", then "Run anyway", installs
      it to `%LOCALAPPDATA%\Quran`, and the Start menu has `Quran`.
- [ ] Settings › Apps › Installed apps lists "Quran" with its icon, the version and the publisher "Quran for Desktop
      contributors". Uninstalling from there runs the uninstaller, which carries the Quran icon too; its "Delete the
      application data" box is unticked by default, so the data stays unless it is ticked.
- [ ] Mica in both tints (light and dark themes).
- [ ] Snap Layouts: the flyout opens over the maximise button of `WindowControls`, which shows the hover and pressed
      states.
- [ ] Tray: the menu labels change during playback, and a left click shows the window.
- [ ] The one-time tray notice appears (with Do Not Disturb off).
- [ ] On a machine without WebView2 (a clean VM), the installer's bootstrapper installs it.
- [ ] NVDA with the OneCore Arabic voice reads 1:1–7, 2:255 and 38:24 sensibly (WP8d). Record the result in §12.6.

### macOS 13.3+ (Apple silicon and Intel)

- [ ] The dmg opens and shows Quran and the Applications link. On Apple silicon the ad-hoc signed app opens after
      **System Settings › Privacy & Security › Open Anyway**. It is never reported as "damaged".
- [ ] `codesign -dv --verbose=4 /Applications/Quran.app` shows the identifier `com.quran.labs.desktop` and the
      hardened runtime (`flags=0x10000(runtime)`), signed ad hoc (`Signature=adhoc`) or by the org's Developer ID
      (`Authority=Developer ID Application: …`, `TeamIdentifier`). `codesign --verify --deep --strict` passes.
- [ ] `lipo -archs /Applications/Quran.app/Contents/MacOS/quran-desktop` prints `x86_64 arm64`. The app runs on an
      Intel Mac or under Rosetta (`arch -x86_64`).
- [ ] The Dock icon reopens the window after it was hidden to the tray. The template tray icon reads well in light
      and dark menu bars.
- [ ] Control Center's Now Playing shows the title, reciter, album, artwork and a moving scrubber. The play/pause key
      toggles (`playbackState`), and the item disappears after stop (WP6d).
- [ ] Font transport (WP6a): with a debug build, `QD_FONT_TRANSPORT=url` loads the QCF fonts. If it does, file the
      switch of the macOS arm of `platform_font_transport` to `Url`.
- [ ] VoiceOver with the "Majed" voice reads 1:1–7, 2:255 and 38:24 sensibly (WP8d). Record the result in §12.6.
- [ ] WKWebView has no crash hook (`window::webview2` is Windows only): kill the app's WebContent process (Activity
      Monitor) and note what the user sees. A blank window that needs a restart is a known gap; file it if worse.
- [ ] While reciting, hide the window to the tray, then minimise it: in Safari's Web Inspector (a debug build),
      `document.visibilityState` is `hidden` and the Timelines show no animation frames until it is shown again
      (WKWebView follows window occlusion; Windows sets the WebView2 controller's visibility itself).

### Linux: Ubuntu 22.04 (deb) and one other distribution (AppImage)

- [ ] `dpkg-deb -I Quran_<version>_amd64.deb` lists `libayatana-appindicator3-1`, `libwebkit2gtk-4.1-0`,
      `libgtk-3-0` and `libasound2 | libasound2t64` under Depends. CI asserts this too; check it on the release file.
- [ ] `sudo apt install ./Quran_<version>_amd64.deb` installs, and "Quran" appears in the app grid with its icon.
- [ ] The window opens with content (never blank) in a GNOME **Wayland** session and in an **X11** session, and at a
      200 % display scale the page and the chrome are sharp. A blank window on Wayland (seen with some GPU drivers)
      that `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes is filed, not shipped silently.
- [ ] Tray menu on GNOME (with the AppIndicator extension) and on KDE.
- [ ] MPRIS: GNOME Shell's and KDE's media widgets show "Quran" with the app icon while a recitation is loaded, and
      hide it after stop. `playerctl -p quran_desktop metadata` shows the trackid, title, reciter and album. Media
      keys toggle and skip (WP6d).
- [ ] Memorisation hide (blur) on a full spread stays smooth on WebKitGTK. If it misses §8.16's 16 ms per frame, file
      the change of the Linux default to `blank` (WP9b deviation 14).
- [ ] The AppImage runs on a second distribution (for example Fedora) after `chmod +x`.
- [ ] Translations in Bengali, Devanagari and Tamil scripts show the install hint when their fonts are missing (R20).
- [ ] WebKitGTK has no crash hook either: kill the `WebKitWebProcess` and note what the user sees (as on macOS).
- [ ] While reciting, hide the window to the tray, then minimise it: in the WebKitGTK inspector (a debug build,
      `WEBKIT_INSPECTOR_SERVER` or right click › Inspect), `document.visibilityState` is `hidden` and no frames run
      until it is shown again (WebKitGTK follows an unmapped or iconified toplevel). Play over MPRIS after a mid-way
      failure (network off, then on) continues the recitation.

### Audio quality (once per engine change, not per release)

- [ ] R4 listening test: render 3 reciters × 5 speeds with
      `QD_DSP_LISTEN="a.mp3;b.mp3;c.mp3" cargo test -p quran-audio --release --test dsp_listen -- --ignored` and
      listen to the WAV files in `artifacts/dsp-listen/`. A person does this; tests never play audio.

## 4. Publish

- [ ] Replace the first paragraph of the draft's notes with the changes in this version. Keep the install notes for
      unsigned builds while they apply.
- [ ] Download each asset from the draft and check it: `sha256sum -c <file>.sha256`.
- [ ] Publish the draft. Check that the published release's assets download.
