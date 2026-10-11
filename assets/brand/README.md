# Quran brand assets

Owner: WP-Brand (ARCHITECTURE §9.9, amended by docs/deviations/LEAD.md item 16). Every icon is derived from one raster
by `tools/build.mjs`.

## The mark

The app uses the **github.com/quran (Quran.com) identity**: the word قرآن in gold calligraphy on a navy rounded tile.
It is quran_android's new app icon, and the same mark is the github.com/quran organisation avatar.

- **Source:** `source/ic_upcoming_app_icon.webp` (1024 px, lossless WebP with alpha), unmodified, from
  quran/quran_android commit `19f5bde9` ("Add new icon announcement", 2026-10-04). `source/SOURCE.md` has the URL,
  commit, hashes and licence. The build checks the file's SHA-256.
- **Licence:** GPL-3.0 (quran_android). The app is GPL-3.0-or-later (LEAD.md item 16).
- **Attribution:** "Quran.com / quran_android contributors". Credit it, with the licence, in About.
- **Approval:** the project owner approved this identity on 2026-10-10. A **public release** under it needs the approval
  of the quran organisation's maintainers (LEAD.md item 16).

This replaces the first identity (a geometric khatam star with an open book, gold on green), along with its
"geometry only" rule. The mark now is Quranic text, so treat it with care in product decisions, such as where it may
appear and at what size.

| Colour     | Value                 | Where                                                                       |
| ---------- | --------------------- | --------------------------------------------------------------------------- |
| Gold       | `#e2af56`             | the tuned icons (16–64 px): the flat gold of the github.com/quran avatar    |
| Navy       | `#010066` → `#00002c` | the tile: a linear fit of the master's gradient, top to bottom              |
| Master art | see `source/`         | 128 px and up, the ICO's 256 px entry, About: bevelled gold, used unchanged |

## How each size is made

The master's bevel and thin strokes do not survive small sizes, so there are three treatments:

| Size                                    | Treatment                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| 128 px and up, ICO 256, About (256)     | **Master**: the source pixels, Lanczos-3 resampled                                |
| 16–64 px (Windows), 16/32/64 px (macOS) | **Tuned**: the glyph is cut from the master and redrawn on the tile (steps below) |
| Template, UI mark                       | **Silhouette**: the tuned glyph coverage alone, as alpha                          |

The tuned drawing (`design.mjs`, `tunedIcon`):

1. **Cut out the glyph.** Gold has a high red channel. The tile is pure blue, and its bevel highlight is bluish, so
   coverage is `clamp(R / 90) · clamp((R − B + 20) / 40)`. The diacritic dots (the nun's dot and the qaf's pair) are
   separate parts, found as small connected components.
2. **Crop tighter.** The glyph fills 85–90 % of the tile width, up from 75 % in the master, so there is less navy
   padding. Its position was found by searching ⅛-px offsets for the crispest coverage, then checked by eye.
3. **Embolden.** The glyph is offset outwards along its distance field: 10 master px at 16 px, 3 px at 64 px. The dots
   are offset less (thinner at 16–20 px), so they stay separate specks instead of merging into the letters.
4. **Raise contrast.** Coverage is area-sampled, then stretched with levels (for example `[0.2, 0.7] → [0, 1]` at 16 px),
   then given an unsharp mask (σ 0.6–0.8 px).
5. **Paint.** The glyph is painted in the avatar's flat gold on the master's own tile outline and navy gradient, without
   the bevel.

At 16 px the result reads as the mark: madda bar, alif, the qaf's loop, the sweep of the baseline and the dots. It does
not read as a word. From 24 px, قرآن is legible.

## Outputs and consumers

| Output                                                                                           | Made from                                                   | Consumer                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `assets/brand/icon.png` (1024)                                                                   | the source's pixels, exactly (transparent corners kept)     | input of `pnpm tauri icon`                                            |
| `src-tauri/icons/*` (`32x32.png`, `128x128*.png`, `icon.png`, Appx, iOS, Android, base ico/icns) | `pnpm tauri icon assets/brand/icon.png`                     | base `bundle.icon`; Linux: 64, 128, 128@2x, 512 (see Notes)           |
| `src-tauri/icons/windows/icon.ico`: 16/20/24/32/40/48/64 (BMP), 256 (PNG)                        | tuned 16–64, master 256; full-bleed                         | `tauri.windows.conf.json`: exe, window, taskbar, NSIS                 |
| `src-tauri/icons/macos/icon.icns`: `is32`/`il32` + masks, `ic11`–`ic10`                          | Apple grid: tuned 16/32/64, master 128–1024                 | `tauri.macos.conf.json`: bundle, Dock                                 |
| `src-tauri/icons/tray/tray-{16,20,24,32}.png`, `tray.png` (= 32)                                 | the tuned ICO entries                                       | `tray.rs` (Windows by DPI, Linux `tray.png`); Linux window/hicolor    |
| `src-tauri/icons/tray/tray-template.png` (18), `tray-template@2x.png` (36)                       | the glyph silhouette, black + alpha                         | `tray.rs`: macOS menu bar (`icon_as_template`)                        |
| `src-tauri/icons/media/artwork.png` (512, opaque)                                                | the master's interior on its navy gradient, glyph 70 % wide | the OS media session's artwork (embedded by `src-tauri/src/media.rs`) |
| `src/assets/app-icon.svg`                                                                        | SVG wrapper: `<image>` of the 256 px master PNG             | About (64 px), Settings ▸ About, onboarding, FatalScreen              |
| `src/assets/app-icon-small.svg`                                                                  | SVG wrapper: `<image>` of the tuned 32 px PNG               | TitleBar (18 px), anything up to 32 px                                |
| `src/assets/app-mark.svg`                                                                        | `currentColor` rect masked by the 128 px silhouette         | single-colour uses (no consumer yet)                                  |
| `src/assets/star8.svg`                                                                           | copy of `svg/star8.svg` (geometric, hand-written)           | `EmptyState` and other decorations (§9.5)                             |

Notes:

- **Framing.** Windows icons are full-bleed: the tile reaches the canvas edge. macOS uses the Apple grid: an 824 px
  body on a 1024 canvas, a 100 px margin, and a soft shadow (dy 12, σ 12, 30 %). The tuned macOS sizes inset the body
  by 1, 3 and 6 px. The artwork is square and opaque, because media flyouts crop or round it themselves.
- **The SVG wrappers** keep every import path the components already use. Each embeds a PNG as a `data:` URI at its exact
  pixel size (`<image width="256" height="256">` in a 256 viewBox). CSP allows `data:` images (§6.4).
- **Linux bundle icons.** The files stay the plain `tauri icon` output, so the acceptance command reproduces them; their
  32 px is a Lanczos downsample, softer than the tuned 32 px. `tauri.linux.conf.json` therefore lists the tuned
  `tray/tray-32.png` first, then `tray-16`, `tray-24`, `64x64`, `128x128`, `128x128@2x` and `icon.png` (LEAD.md items
  16 and 18). tauri-codegen makes the first PNG the window icon, and the deb bundler installs one hicolor icon per size,
  so the window icon and the 16/24/32 px launcher icons are the tuned ones. `window.rs`'s config test checks the order
  and that no size repeats. The Linux tray uses the tuned `tray.png`.
- **star8.svg stays geometric.** It is an `EmptyState` decoration, not the mark. Calligraphy as a background ornament
  would be both illegible at 48 px and out of place.

## Using the assets

- **Title bar:** `app-icon-small.svg` at 16–20 CSS px. **About:** `app-icon.svg` at 64 px. The alt text is the app name
  (`common.appName`), or empty when the name is next to it.
- **Single colour (`app-mark.svg`):** tint it with a CSS mask, not as an `<img>`, which draws it black:
  `mask: url(…/app-mark.svg) center / contain no-repeat; background: var(--frame-gold)`, plus `-webkit-mask` for
  WebKitGTK and WKWebView. Inlined into the DOM, it follows `currentColor`.
- **EmptyState star (`star8.svg`):** draw it as a mask in the same way, `aria-hidden`.
- **Tray (WP6b):** Windows picks `tray-{16,20,24,32}.png` from the taskbar DPI. Linux uses `tray.png`. macOS uses
  `tray-template@2x.png` with `icon_as_template(true)`, and `tray-template.png` on 1× displays.

## Regenerate and check

```sh
node assets/brand/tools/build.mjs            # write everything (uses the installed Microsoft Edge, no download)
node assets/brand/tools/build.mjs --check    # rebuild in a temp dir, compare with the committed files
node assets/brand/tools/build.mjs --review   # also write artifacts/brand/review.png (sign-off sheet)
pnpm tauri icon assets/brand/icon.png        # the acceptance command: reproduces src-tauri/icons/* from the master
pnpm exec vitest run --project unit src/assets/brand.test.ts
```

The pipeline (`tools/`):

- `raster.mjs` uses Edge, through playwright-core (channel `msedge`), for two things only:
  - Decoding the WebP. It goes through a WebGL texture upload with premultiplication off, so the result is
    bit-identical to libwebp, including semi-transparent edges.
  - Screenshotting the review sheet.
- `pixels.mjs` does all other pixel work in plain JavaScript on Float64 planes, rounded once at the end: area and
  Lanczos-3 resampling, an exact Euclidean distance transform, Gaussian blur, unsharp mask, levels and compositing. The
  pixels therefore depend only on the source and the parameters, not on the browser build.
- `design.mjs` holds every parameter and drawing.
- `formats.mjs` writes deterministic PNG (pngjs, zlib level 9), ICO and ICNS.

How `--check` compares:

- PNG pixels, including those inside the ICO, the ICNS and the SVG wrappers. The wrapper text must match exactly.
- The `tauri icon` set, byte for byte. The exception is `icon.icns`, compared entry by entry, because tauri-cli 2.12
  writes its entries in a random order.
- Stale files in the pipeline's own directories are reported.

Pass `--tolerance N` to allow a per-channel difference of N. Set `QD_BROWSER_CHANNEL=chrome` (or `bundled`) to use
another browser.
