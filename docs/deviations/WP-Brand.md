# WP-Brand deviations (app icon and brand assets, §9.9)

Everything is generated from `assets/brand/tools/design.mjs` by `node assets/brand/tools/build.mjs`.
`assets/brand/README.md` is the brand guide: concept, palette, size ladder, files, and how to use them.

## Deviations from ARCHITECTURE.md

1. **Per-OS ICO and ICNS sit beside the `tauri icon` set.**
   - §9.9 asks for two things one source PNG cannot both give, because `tauri icon` derives every file from a single
     PNG:
     - a full-bleed Windows icon with pixel-hinted 16/24 px;
     - an Apple-grid macOS icon (824 px body, 100 px margin).
   - So:
     - `src-tauri/icons/icon.ico` and `src-tauri/icons/icon.icns` stay the plain `pnpm tauri icon assets/brand/icon.png`
       output. This is what the acceptance line checks.
     - The tuned containers are `src-tauri/icons/windows/icon.ico` and `src-tauri/icons/macos/icon.icns`.
     - They take effect through `bundle.icon` in WP6b's `tauri.windows.conf.json` / `tauri.macos.conf.json` (see
       Requests). Tauri merges the platform file into the config for tauri-build (the exe resource), codegen and the
       bundler; checked in tauri-utils 2.10.1 `config/parse.rs` `read_from`.
   - Verified on Windows by building with that override passed as `--config` (no WP6b file touched):
     - `pnpm tauri build --debug --no-bundle --config <json>` succeeds;
     - the exe's 8 `RT_ICON` resources are byte-identical to the 8 ICO entries;
     - `LoadImage(exe, #32512, 16|20|24|32)` returns pixels identical (Δ 0) to the hinted renders.
2. **"Regenerates the committed set without diff": `icon.icns` changes byte order on every run.**
   - tauri-cli 2.12.1 writes its ICNS entries in a random order, apparently from HashMap iteration. The same happens
     with the scaffold's default icon: two runs on one input differ only in `icon.icns`, which has the same entries
     reordered.
   - So no committed `icon.icns` can survive a re-run byte for byte.
   - Measured: after `pnpm tauri icon assets/brand/icon.png`, 61 of 62 files are byte-identical, and `icon.icns` has
     identical entries in another order.
   - `build.mjs --check` compares that file entry by entry.
3. **The `tauri icon` set now includes `64x64.png`, `android/` and `ios/`.** Tauri 2.12 generates them; the scaffold's set
   did not have them. They are kept, because removing them would make the acceptance command produce new files every
   time. They are about 560 KB and are not referenced by `bundle.icon`.
4. **ICO sizes 16/20/24/32/40/48/64/256 instead of 16/24/32/48/256.**
   - 20, 40 and 64 px are the small and large icon sizes at 125 % and 200 % scaling, so Windows picks an exact entry
     instead of resampling.
   - 16–32 px are pixel-hinted drawings (§9.9 asks for 16 and 24). 40 px and up use the master.
   - The window and taskbar icon come from these entries too: on Windows, tauri 2.12.2 loads the default window icon
     from the exe's icon resource at `SM_CXICON` (32/40/48/64 px at 100/125/150/200 %;
     `default_window_icon_from_app_icon_resource` in `tauri/src/image/mod.rs`). So every scale gets an exact entry.
     Verified on a build with the requested Windows override passed as `--config`:
     `Icon.ExtractAssociatedIcon(exe)` returns the hinted 32 px drawing (Δ 0).
   - Below 256 px the entries are 32-bit BMP with an AND mask, as the `ico` crate and Windows' own icons do; 256 px is
     PNG.
5. **Tray.**
   - The template images are 18 and 36 px, not 16/32: tray-icon 0.25.1 draws the macOS tray image at 18 pt height
     (`src/platform_impl/macos/mod.rs:281`), so these sizes map 1:1 on 1× and 2× displays.
   - At 18 px the book cannot be resolved, so the centre is the rub el hizb lozenge. 36 px has the open-book outline.
   - A black template is invisible on Windows' dark taskbar. So Windows and Linux get colour icons:
     `tray-{16,20,24,32}.png`, one per DPI step, and `tray.png` (= 32 px).
6. **Additions beyond §9.9:**
   - **`src/assets/app-icon-small.svg`** (the 32 px hinted drawing): the detailed `app-icon.svg` turns to mush at the
     title bar's 18 CSS px.
   - **`src/assets/app-mark.svg`**: a single-colour mark in `currentColor`.
   - **`src-tauri/icons/media/artwork.png`**: a 512 px opaque square for SMTC / Now Playing / MPRIS. Media UIs crop or
     round artwork themselves, and a tile with transparent corners shows them.
   - **Hinted macOS 16/32 px** (`is32`/`il32`, `ic11`).
7. **Generated sources.**
   - The SVGs are generated from parameters in `design.mjs`, not drawn by hand. That keeps the hinting exact: the
     axis-aligned edges and band widths are integers.
   - `build.mjs` renders them through the installed Edge (playwright-core, `--disable-gpu`, sRGB), so output is
     deterministic: a fresh build is pixel- and byte-identical.
   - It re-encodes PNGs with pngjs (level 9, best filter): the master PNG drops from 364 KB to 222 KB and the icns from
     550 KB to 415 KB.
   - No package.json script, because dependencies are frozen (see Requests).
8. **Weave only from 40 px.**
   - The master interlaces the two squares (over-under) with an engraved centre line.
   - Strict alternation of two squares is chiral. At small sizes, with bands as thick as legibility needs, it reads as
     a pinwheel. So 16–32 px, the template and `star8.svg` draw the two squares plainly overlapping (the classic ۞).
   - At 16–24 px the book is one page block, or uses a paper-toned gutter: two pale blocks above a gold bar read as a
     face.
9. **Colour values.**
   - The master's gold gradient centres on §9.9's `#b08d57`, with sheen tints `#dcbf88` → `#957240`.
   - The hinted sizes use a slightly brighter flat gold (`#dcc08a` → `#b38f58`) so 1 px bands stay legible.
   - `star8.svg` is filled with `#b08d57`. Used as a CSS mask, it takes each theme's `--frame-gold`; §9.2's paper value
     is `#ac8a55`.

## Requests

- **WP6b**:
  - Per-OS bundle icons:
    - `tauri.windows.conf.json`:
      `"bundle": { "icon": ["icons/windows/icon.ico", "icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png"] }`.
      The first `.ico` becomes the exe resource, window icon and NSIS icon.
    - `tauri.macos.conf.json`:
      `"bundle": { "icon": ["icons/macos/icon.icns", "icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png"] }`.
    - Arrays replace whole (§13.5).
  - Tray images:
    - Windows: `tray-{16,20,24,32}.png` by scale factor (16 × scale rounded to 16/20/24/32), e.g. `include_bytes!` of
      all four.
    - Linux: `tray.png`.
    - macOS: `tray-template@2x.png` with `icon_as_template(true)`.
- **WP6c**: optionally embed `src-tauri/icons/media/artwork.png` instead of `icons/128x128@2x.png`. It is square,
  opaque, 512 px, 82 KB, without the tile's transparent corners. It is not in `bundle.icon`, so the path is
  independent of WP6b's configs.
- **WP7b** (`EmptyState`): draw the star as a 48 px element with
  `mask: url(<import of src/assets/star8.svg>) center / contain no-repeat; background: var(--frame-gold)` (plus
  `-webkit-mask` for WebKitGTK/WKWebView), `aria-hidden="true"`. Vite inlines it as a `data:` URL, which §6.4 allows.
- **WP7c** (`TitleBar`): replace the placeholder's inline star with `<img src={appIconSmall} width="18" height="18"
  alt="">`, where `import appIconSmall from '../../assets/app-icon-small.svg'`. `FatalScreen`'s inline star can likewise
  be `star8.svg` masked with `--frame-gold`, or `app-icon.svg`.
- **WP12c** (`AboutView`): the §9.7 header icon is `src/assets/app-icon.svg` at 64 px, alt = `common.appName`.
- **Owner of `index.html` (WP0D → lead)**: the favicon can be the app icon, `<link rel="icon" type="image/svg+xml"
  href="/src/assets/app-icon-small.svg">`. That replaces `data:,`, and Vite fingerprints it in builds.
- **WP-CI**: §9.9's "icon.png differs from the scaffold" check has the hash: the Tauri default `icon.png` is sha256
  `6413bfe9d546e5225fc9256a0ecec48df3a1272ea4bdc91c15b8e000222a95d3`. `src/assets/brand.test.ts` already asserts it in
  `pnpm test`. A CI step could also run `node assets/brand/tools/build.mjs --check --tolerance 8` on the Windows runner
  (it needs Edge or `QD_BROWSER_CHANNEL=bundled`).
- **Lead**:
  - optional scripts `"brand": "node assets/brand/tools/build.mjs"` and `"brand:check": "node assets/brand/tools/build.mjs --check"`;
  - sign-off sheet: `node assets/brand/tools/build.mjs --check --review` → `artifacts/brand/review.png`. It shows the
    master, the macOS icns, the artwork, the menu-bar templates, every Windows ICO entry at real size and ×6 on light
    and dark taskbars, the title bar, the EmptyState star and the About header in all six theme variants (paper, sepia,
    night, black, high contrast light and dark).
