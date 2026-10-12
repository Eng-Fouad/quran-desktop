# WP13b: release, budgets and cross-OS smoke (integration, tooling fix round 1)

WP13b was never run as a package. The integration's tooling fix engineer built its deliverables (§13.4, §12.6 metric
assertions, §13.6, §14.3 wave 3) on the lead's behalf. What changed and why is summarised in
`docs/deviations/INTEGRATION.md` ("Tooling fix, round 1"); this file holds the decisions and deviations the lead folds
into ARCHITECTURE.md.

## Deliverables

| Deliverable | Where |
|---|---|
| Release pipeline (§13.4) | `.github/workflows/release.yml`, `.github/actions/release-upload/`, `.github/release-notes.md`, `scripts/check-version.mjs` |
| core.db from the private QUL store | `.github/actions/core` (`source: qul`) |
| Installer contents | `scripts/check-bundles.mjs` (CI and release) |
| Budgets (§13.6) | `scripts/size-budget.mjs`; enforced in CI by `.github/actions/size-check` on all three OSes |
| Release upload guard | `scripts/check-artifacts.mjs --release --verified`, policy check `release-uploads` |
| Metric assertions (§12.6, §8.18) | `tests/e2e/metrics/metrics.mjs` (`pnpm shots:app --only metrics`) |
| Manual checklist | `docs/RELEASE_CHECKLIST.md` |
| NSIS back under 8 MiB | `vite/woff2-only.ts` (+ the `check:dist` WOFF check) |

## Deviations and decisions (to fold in)

1. **"MB" in §13.6 means MiB.** `check:dist` (6 MiB) and the CI size check (8 MiB) always read it so; the table should
   say MiB. Every budget lives in one place: `BUDGETS` in `scripts/size-budget.mjs`.
2. **NSIS installer: brought back under the budget, not raised.** The release NSIS build was 8,395,872 B (8.01 MiB,
   7,264 B over). Fontsource's IBM Plex Sans Arabic CSS lists a WOFF 1 fallback after every WOFF2 source; no webview the
   app runs in ever reads it, but Vite emitted the nine files (203 KiB, already compressed, so LZMA cannot shrink them)
   and Tauri embedded them. `vite/woff2-only.ts` drops those `src` entries and the orphaned files at build time, and
   `check:dist` now fails on any WOFF 1 file or `format("woff")` source. Measured on 2026-10-10 (release build, the
   development core.db of 12.5 MB): **8,063,841 B = 7.69 MiB**, 0.31 MiB under the budget. It is 64 KB over 8,000,000 B,
   which is why item 1 matters. The deb, dmg and AppImage were never built here (no Linux or macOS host); CI and
   release.yml now build and enforce them.
3. **CI builds every installer, enforced** (`enforce: 'true'`). The `build` job makes this OS's installers around
   build.rs's 0-byte core.db (a qdc core.db never enters a bundle), checks their contents and enforces the size rows,
   adding the real core.db as each format compresses it: NSIS LZMA (7-Zip or xz), deb gzip -6, dmg zlib -9, AppImage
   gzip -9 (squashfs; approximate). The macOS bundle is universal on pushes to the default branch, as in release.yml,
   and for the runner's architecture otherwise, to keep macOS minutes (10× on private repositories) down.
4. **Linux tray dependency: one manifest line.** tauri-cli 2.12.1 (`interface/rust.rs`) adds
   `libayatana-appindicator3-1` to the deb's Depends and bundles `libayatana-appindicator3.so.1` into the AppImage
   when it sees tauri's `tray-icon` feature. *Corrected in the CI fixes:* it did not see it, because it skips the
   features of a workspace-inherited dependency (`tauri = { workspace = true, … }`, `interface/rust/manifest.rs`), so
   CI's Linux bundles had neither. `src-tauri/Cargo.toml` now has `[features] default = ["tauri/tray-icon"]`, which
   the CLI reads; cargo already had the feature. WP6b's fallback (`linux.deb.depends`, plus `appimage.files` for the
   library) would hard-code `/usr/lib/<triple>/`, which differs between the x64 and arm64 builds, whereas the CLI
   finds it with pkg-config. `check-bundles.mjs` asserts both on every CI run, and fails if a future tauri stops.
5. **Runtime rows of §13.6 are measured on the debug build**, the only one with test hooks (D24): an upper bound for the
   release build. Definitions the table lacks:
   - cold start: from just before the process is spawned to the webview's first contentful paint (split into native
     and web parts in the report);
   - idle CPU "≈ 0 %": ≤ 0.5 % of one core for the app and all its WebView2 processes, sampled over 20 s with the
     window visible and nothing playing, in a run without test mode or remote debugging (`scripts/qa/idle-cpu.mjs`):
     the QA hook's frame sampler would otherwise be most of it;
   - RSS: the private working sets of the app and its WebView2 processes (Task Manager's "Memory"). Summing working
     sets counts the WebView2 DLLs once per process (about twice the private figure);
   - playback CPU: the app and all its WebView2 processes, like idle CPU and RSS, averaged over 20 s of al-Fatiha on
     the null sink at 1.0× and at 1.5×. *Changed in integration fix round 2:* this row first counted the app process
     alone (the audio engine), so the webview's per-frame glide and scrubber (≈ 30 % of a core) passed a 3 % gate.
     The app's own share, the share of each WebView2 process (renderer, GPU, browser, utilities) and what drives the
     frames (requestAnimationFrame callbacks per second, running animations) are the row's notes. The report format
     is `qd-metrics-report/2`; `size-budget.mjs` refuses a `/1` report.
   The scenario and `idle-cpu.mjs` record these rows in `artifacts/shots/app/metrics-report.json`; `size-budget.mjs`
   enforces them. The scenario itself fails on §8.18 and §12.6 misses only. *Changed in integration gate 3:* the
   playback CPU windows run with the QA hook's glide sampler off (`__QD_TEST__.sampleFrames(false)`), and the glide's
   frame pacing is sampled in its own 6 s window before each. Since that gate the app requests no animation frame of
   its own while reciting (the player samples at word starts, the glide is a compositor animation, the webview gets
   about 5 ticks a second instead of 30), so the sampler's frame on every vsync would have been most of the window.
   (Before, it added one callback to frames the player's own loop requested anyway: an A/B run then measured no
   difference.)
6. **PageCache ≤ 48 and `measure()` < 3 ms** are not observable from outside the app (no hook or `performance.measure`
   exposes them); their unit tests cover them (`PAGE_CACHE_SIZE`, the LRU tests). A cross-area request adds the cache
   size to `__QD_TEST__`.
7. **tauri-action** `v1.0.0` is pinned at `1deb371b0cd8bd54025b384f1cd735e725c4060f` (2026-06-29). It only builds:
   uploads go through `./.github/actions/release-upload` after `check-artifacts --release`, and the policy check
   refuses any tauri-action input that would upload by itself.
8. **The QUL inputs** come as a flat `tar.gz` of the files named in `data/sources/qul/manifest.toml`
   (`QUL_SOURCES_URL`, bearer `QUL_SOURCES_TOKEN`, environment `release`). The committed manifest is never replaced
   by the archive's, so the build checks every file against the SHA-256 recorded in the repository. The manifest's
   hashes are still empty: recording them is a checklist step.

## Signing (§15.3 item 3, risk R13)

Decision for the first releases (previews), until the quran org provides certificates:

- **macOS: ad-hoc signature with the hardened runtime**, never unsigned. Without a Developer ID, release.yml (and CI)
  export `APPLE_SIGNING_IDENTITY=-`, so tauri-bundler runs `codesign --force -s - --options runtime` on the app.
  An unsigned or linker-signed universal app is reported "damaged" on Apple silicon; an ad-hoc signed one opens after
  **Privacy & Security › Open Anyway**, as the release notes say. `check-bundles.mjs` verifies `codesign --verify
  --deep --strict` and the `runtime` flag. When the org has an Apple Developer ID, adding `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` to the
  `release` environment switches to Developer ID signing and notarisation with no workflow change.
- **Windows: unsigned.** SmartScreen shows "Windows protected your PC" (More info › Run anyway); the release notes say
  so. A public v1 needs Authenticode. Recommended: Azure Trusted Signing or SignPath Foundation (free for open source)
  under the quran org, wired as `bundle.windows.signCommand` in a release-only `--config`. The checklist keeps signing
  as a release blocker until the lead decides. **Wired since 2026-10-12** (below): Azure Artifact Signing signs as soon
  as its secrets exist.
- **Linux:** deb and AppImage are not signed (usual for direct downloads). Every asset is published with a `.sha256`.
  Since 2026-10-12 a GPG key, once configured, signs the AppImages and a `SHA256SUMS` over every asset.
- **Updater:** not in v1 (§15.2: it needs signing keys).

## Measurements (this machine, 2026-10-10)

Windows 11, 32 cores, 120 Hz display; the debug build (`C:\qdt\int-fix1-tooling`); other agents were compiling and
running app tests at the same time, so frame times and CPU are noisy (runs differ by up to 2×).

Six runs of `pnpm shots:app --only metrics` (`metrics-report.json` of the last one, `node scripts/qa/idle-cpu.mjs`,
then `node scripts/size-budget.mjs`):

| Target | Budget | Measured | |
|---|---|---|---|
| NSIS installer | ≤ 8 MiB | 7.69 MiB (8,063,841 B; was 8,395,872 B) | ok |
| Installed footprint (Windows) | ≤ 35 MiB | 25.50 MiB (exe + core.db + catalog.json) | ok |
| `dist/` (production) | ≤ 6 MiB | 3.07 MiB | ok |
| Cold start to first paint | ≤ 800 ms | 811–1,993 ms; last 886 ms = native 310 + web 576 (debug build, remote debugging on) | over |
| Idle CPU (no hooks) | ≤ 0.5 % | 0.23 % of one core (app 0.00 %) | ok |
| Memory, spread + playback | ≤ 350 MiB | private working sets 388–488 MiB; last 454 MiB (app 25 MiB, the rest WebView2) | over |
| Playback CPU 1.0× / 1.5× | ≤ 3 % / ≤ 6 % | app process alone (this round's definition): 0.4–3.3 % / 0.5–4.8 %. App + webview (round 2's, enforced): 68 % / 78 % on a loaded machine; 21–54 % at 1.0× in quieter windows, app 1.5–3.7 % of it | over (round 2) |
| CLS, 20 pages + playback start | 0 | 0.01, all from `div.dock.m-bar` widening 505 → 839 px over 8 frames at playback start | miss |
| Long tasks > 50 ms | none | 8–13: each page turn 61–138 ms, cold jumps 50–98 ms, the jump back to page 1 ≈ 230 ms | miss |
| `qd:page` p95 | < 16 ms | 9.1–19 ms; last 12.3 ms | ok (once 19) |
| Page turn, key → painted, p95 | < 50 ms | 87–119 ms; a typical turn takes 78–88 ms | miss |
| Flip | 1 page / 70 ms, frames ≤ 32 ms | 71–96 ms per page; longest frame 117–200 ms, about 25 frames over 32 ms in 2 s | miss |
| Word glide | ≥ 58 fps, frames ≤ 32 ms | 120 fps (120 Hz display), longest 9 ms | ok |
| QCF FontFaces per style | ≤ 24 | 24 | ok |
| `#qd-v4-palettes` | applied | applied on page 50 (COLR probe passed) | ok |
| CSP violations | none | 0 over the whole run | ok |
| Cold QCF loads in the session | ≥ 5 | 58 (the prefetch downloads the neighbours too) | ok |

Test mode inflates idle CPU: an A/B run of the same build idled at 0.0–0.2 % without `QD_TEST` and 0.4–14 % with it
(the hook's frame sampler requests every animation frame). Hence `idle-cpu.mjs`. The misses are the app's, not the
measurement's; each is filed under "Cross-area" in INTEGRATION.md with what the diagnostics show.

## Not verifiable here

- The macOS and Linux bundles: no macOS or Linux host. CI's `build (macos-latest)` and `build (ubuntu-22.04)` now build
  and check them on every push; the first run will show the dmg, deb and AppImage sizes.
- release.yml end to end: no QUL archive (the permission is still missing) and no GitHub runner here. It parses
  (`act -l`), passes the policy check, and every script it runs is tested.
- NSIS unpacking (`check-bundles.mjs` needs 7-Zip, which this machine lacks; the windows runners have it). Here the
  check reads tauri's `installer.nsi` and the files it packs instead.

## Owner request 2026-10-12: x64 and arm64 everywhere, portable builds, signing, stores

"GitHub CI jobs for deployment on tagging the main branch: installers and portable executables for Windows, Mac and
Linux on x64 and arm64, with code signing, and publishing to the Windows Store, the Apple Store and the Ubuntu Store."

1. **Five build jobs** (`release.yml`): windows-x64, windows-arm64 (cross-compiled on `windows-latest`: Visual Studio's
   ARM64 tools, and clang for `ring` and `aws-lc-sys`, which a local `cargo build --target aarch64-pc-windows-msvc`
   confirmed: an ARM64 PE, machine 0xAA64), macos-universal (one binary for both architectures, as before),
   linux-x64 and linux-arm64 (`ubuntu-22.04-arm`, standard in private repositories since 2026-01; an AppImage cannot
   be cross-built). The 22.04 images retire in April 2027, and the glibc baseline moves with them.
2. **Portable builds** (`scripts/make-portable.mjs`, tested): `Quran_<version>_<arch>_portable.zip` on Windows
   (`Quran/quran-desktop.exe` with `data/` beside it, where the exe's resource directory is; a small zip writer, read
   back by check-artifacts' own reader in the test) and `Quran_<version>_universal.app.zip` on macOS (`ditto`, so the
   signature and the stapled ticket survive). Linux's portable build is the AppImage. The portable exe needs the
   WebView2 runtime and keeps its data in the profile like the installed app; a data-beside-the-exe mode is not
   implemented.
3. **check-bundles** gains `--arch x64|arm64` (every binary's architecture: the PE machine, the ELF machine, lipo's
   slices; the deb's Architecture; tauri's `nsis/<arch>/installer.nsi`; the multiarch appindicator path), the
   `portable` kind (unpacked with Windows' own `tar.exe`, or `ditto` on macOS, and checked like the installers),
   `--signed` (a valid Authenticode signature on the setup and the exe, or a Developer ID on the app) and `--webview`
   (the Store installer's `offlineInstaller`). Tests cover the PE/ELF readers, an arm64 deb and the portable finder.
4. **Signing**, each when its secrets are set: Windows through Azure Artifact Signing (the renamed Trusted Signing;
   `artifact-signing-cli`, tauri's `signCommand` in a CI-only `--config`, object form, so the exe, the NSIS
   uninstaller and the setup are signed); macOS as before, plus notarisation with an App Store Connect API key; GPG for
   the AppImage (`SIGN`, `APPIMAGETOOL_FORCE_SIGN`) and for `SHA256SUMS.asc` (the new `checksums` job). The guarded
   release upload takes no manifest for those text files and skips their `.sha256`.
5. **Stores** (`store.yml`, on `release: published` or by hand), each behind a repository variable and its own
   environment, and none rebuilding anything:
   - Microsoft Store: tauri requires the offline WebView2 runtime there, which breaks the 8 MB NSIS budget, so
     `release.yml` re-bundles a second NSIS installer only when `MS_STORE_ENABLED` is set (`tauri bundle`, no
     rebuild), checks it and attaches it as `*-store-setup.exe`. `store.yml` sends both architectures' public release
     URLs through the msstore CLI (`microsoft/store-submission` is archived; `microsoft-store-apppublisher` installs
     the CLI) and submits for certification. The draft's assets are not public, hence the trigger on publication.
   - Snap Store: the published deb of each architecture, repacked as a strict snap (`snap/snapcraft.yaml`: the gnome
     extension's WebKitGTK, ALSA routed to PulseAudio, slots for MPRIS and the single-instance D-Bus name), released to
     `candidate` by default; a person promotes a checked revision.
   - App Store Connect: the published universal app re-signed with the App Sandbox
     (`src-tauri/macos/AppStore.entitlements`), the provisioning profile and Apple Distribution, packaged by
     `productbuild` (Mac Installer Distribution) and uploaded with `altool`. Re-signing the checked app avoids a second
     build and the QUL secrets in that environment. A person tests it through TestFlight and submits it for review.
6. **Not verifiable here:** no runner, no QUL archive, no certificates or store accounts. The workflows pass the policy
   check and Prettier, and every script they run is tested, but the first tag will be the first real run. Points to
   watch: clang on `windows-latest` for the arm64 crates, `gh` and the snap actions on the arm64 runners, the Store's
   acceptance of GitHub's redirecting asset URLs, the snap's audio and D-Bus slots under strict confinement, and the
   sandboxed app's behaviour (downloads, backup dialogs, single instance, tray). Each has a checklist row.
