# WP0-GATE (wave-0 exit gate, acting for the lead)

## Fixes made at the gate (wave-0 files only)

1. **Shell grid (`src/App.svelte`, WP0C → WP7c).** `.app-body` is pinned to the `1fr` row (`grid-row: 3`, one
   `minmax(0, 1fr)` column). Before, `StartupBanner` rendering nothing moved the body into an `auto` row and the
   always-rendered `AyahContextMenu` placeholder took the `1fr` row: with a short sidebar panel the body was 412 px tall
   and the placeholder covered y = 452–940 of a 940 px window (WP0E's report, measured again here). Now the body is
   900 px (= window − 40 px title bar) on all seven sidebar tabs.
2. **`AyahContextMenu` placeholder (`src/components/mushaf/AyahContextMenu.svelte`, WP0C → WP11c).** Renders only while
   `ui.contextMenu !== null`, as a fixed box at the pointer (physical `top`/`left` marked `/* physical-ok */`, clamped to
   the viewport, `z-index: var(--z-popover)`), labelled with the ayah reference. This is WP0E's request to WP11c in
   placeholder form; WP11c replaces the component.
3. **`fastrand` in `src-tauri/Cargo.toml` (WP0A; WP0B's request).** §5.13 `memo_test_start` uses it, and it was the
   only `[workspace.dependencies]` entry no member used, so WP2b would have needed a dependency PR after the lock froze.
   `Cargo.lock` changes by one line (`"fastrand"` in quran-desktop's list). `cargo build`/`test`/`tree --workspace
   --locked` pass, so the lock is final.
4. **`scripts/qa/app-driver.mjs` (WP0D → WP13a).**
   - **Console capture.** The webview boots before CDP attaches, so Playwright's `console`/`pageerror` listeners missed
     all boot-time output, and a boot-time exception did not fail the run. The driver now opens its own CDP session
     and enables `Runtime` and `Log`, which replays everything recorded before the attach and then streams the rest.
     That covers console calls, uncaught exceptions, and browser messages such as CSP violations and undecodable fonts.
     The page is not reloaded. Verified on the fresh copy:
     - Without the TTF, the driver now prints the three font warnings; before, it printed nothing.
     - A probe build that throws at boot now exits 1 with "page error: …". The old listeners attached only after that
       exception, so they could not have seen it.
     - A reload-based variant was tried first and dropped: reloading during boot produced spurious "Couldn't find
       callback id" warnings.
   - **Diagnosis when no page is found.** The error now lists the page URLs it saw. On `chrome-error://`, it explains
     that a plain `cargo build` overwrote the tauri-built exe with one that loads devUrl. The gate hit exactly this:
     re-running `cargo build` into `C:\qdt\gate` after `tauri build` turned the next driver run into "no webview page".
5. **`docs/DEVELOPING.md` (WP0D).** Removed the stale "dist/ must exist before any Rust build" (WP0A deviation 4,
   confirmed again on a fresh copy: `cargo build -p quran-desktop --locked` succeeds without `dist/` and without
   `core.db`). Added:
   - the fresh-clone real-app commands;
   - the note that a plain `cargo build` replaces the tauri-built exe with a devUrl exe;
   - a row for the missing Hafs TTF (`fetch-assets` is a WP3c stub).

## Deviations in how the gate ran

- **Ports.** Web shots on 1540–1544 (orchestrator instruction); the spec says 1520.
- **`pnpm bindings:check`.** §5.15 makes an untracked `bindings.ts` fail by design, and the repository has no commit,
  so the line cannot pass as written. The real script was run against a *simulated* commit: a throw-away
  `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` (repo objects as an alternate) held the staged blob, so nothing under
  `.git/` was written. It passes with the current file and fails (exit 1, diff printed) when the staged copy is stale.
- **Fresh clone.** In place, `dist/`, `src-tauri/resources/core.db` and `src-tauri/gen/` were moved aside and
  `CARGO_TARGET_DIR=C:\qdt\gate` was new. The user's open RustRover re-ran `build.rs` into `target/` and recreated the
  core.db placeholder within 30 s. So the fresh-clone lines were also run on a copy of exactly the non-ignored files
  (`C:\qdt\fresh`, `pnpm install --frozen-lockfile --offline`, `CARGO_TARGET_DIR=C:\qdt\fresh-t`). That copy has no
  `dist/`, no `core.db`, no `src-tauri/gen/` and no Hafs TTF.

## Requests and notes

- **Lead:** fold in the wave-0 deviation files (WP0A–WP0E) and the `bindings:check` limitation above. The check
  starts working with the first commit that contains `bindings.ts`.
- **WP3c:** until `cargo xtask fetch-assets` lands, a fresh clone has no `public/fonts/KFGQPC-Hafs-V30.ttf`. The
  consequences:
  - `vite build` notes the unresolved URL.
  - The mock dev server answers the missing font with `index.html`, so Edge warns "Failed to decode downloaded font"
    and `main.ts` warns that `qd-hafs` did not load.
  - The page renders in the Naskh fallback.
- **WP6a (IC1):** the real app boots, shows its window via `window_ready` and renders the FatalScreen "not implemented:
  app_bootstrap" (the §14.2 wave-0 stub). It logs no panic and no console output, and no request fails. The shell
  appears in the real app once `app_bootstrap` is implemented.
- **WP5e / WP4d:** `CachingHttpSource::new` takes a `reqwest::Client`, and src-tauri has no `reqwest`. The suggested
  fix is `PackManager::http_client() -> reqwest::Client` in `manager.rs`. The glue then passes the client without
  naming the crate, `Cargo.lock` stays final, and the pack layer's client (proxy, UA, network gate) is shared.
- **WP4d / WP6a / WP6b:** `tray::set_now_playing` and `media::on_audio_state` take a Wry `AppHandle`, while
  `build_state` is generic (WP0B request, unchanged).
- **WP7a:** `pnpm lint:css` is blocked until `scripts/check-logical-css.mjs` exists. A substitute grep for physical
  properties without `/* physical-ok */` in `src/**/*.{svelte,css}` finds none.
- **WP13a:** the `shots:*` registry is not implemented yet. Console errors are still printed rather than failing the run,
  in both QA scripts (fix 4 only makes boot-time output visible). In the real app, a missing asset also comes back as
  `index.html`, not as a 404.
